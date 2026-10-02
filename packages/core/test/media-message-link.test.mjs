import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDb, db, linkReadyMediaToMessage, query, transaction } from "../dist/index.js";

const dbUnavailable = !process.env.DATABASE_URL || process.env.DATABASE_URL.includes("unused:unused");

async function waitForRowLock(pid) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const activity = await query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
    if (activity.rows[0]?.wait_event_type === "Lock") return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("the competing transaction never waited for the media row lock");
}

test("message media links revalidate asset scope and ready-state, serialize with deletion, and remain idempotent", {
  skip: dbUnavailable,
}, async () => {
  let tenantId;
  let otherTenantId;
  let deleteClient;
  let linkClient;
  try {
    const suffix = randomUUID();
    tenantId = (await query("INSERT INTO tenants(name,slug) VALUES('Message media lock test',$1) RETURNING id", [`media-link-${suffix}`])).rows[0].id;
    otherTenantId = (await query("INSERT INTO tenants(name,slug) VALUES('Other media tenant',$1) RETURNING id", [`other-media-link-${suffix}`])).rows[0].id;
    const businessId = (await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Message business','messages') RETURNING id", [tenantId])).rows[0].id;
    const otherBusinessId = (await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Other business','other') RETURNING id", [tenantId])).rows[0].id;
    const channelId = (await query("INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id) VALUES($1,$2,'facebook','Test Page',$3) RETURNING id", [tenantId,businessId,`media-link-page-${suffix}`])).rows[0].id;
    const contactId = (await query("INSERT INTO contacts(tenant_id,business_id,channel_account_id,external_contact_id) VALUES($1,$2,$3,'buyer') RETURNING id", [tenantId,businessId,channelId])).rows[0].id;
    const conversationId = (await query("INSERT INTO conversations(tenant_id,business_id,channel_account_id,contact_id) VALUES($1,$2,$3,$4) RETURNING id", [tenantId,businessId,channelId,contactId])).rows[0].id;
    const messageId = (await query("INSERT INTO messages(tenant_id,business_id,channel_account_id,conversation_id,direction,sender_type,message_type) VALUES($1,$2,$3,$4,'INBOUND','CONTACT','image') RETURNING id", [tenantId,businessId,channelId,conversationId])).rows[0].id;
    const asset = async (owner = tenantId, business = businessId, status = "ready", source = "inbound_message") =>
      (await query("INSERT INTO media_assets(tenant_id,business_id,storage_file_id,mime_type,kind,processing_status,metadata) VALUES($1,$2,$3,'image/jpeg','image',$4,$5::jsonb) RETURNING id", [owner,business,`media-link-file-${randomUUID()}`,status,JSON.stringify({source})])).rows[0].id;
    const input = assetId => ({ tenantId, businessId, messageId, assetId });
    const link = assetId => transaction(client => linkReadyMediaToMessage(client,input(assetId)));

    for (const assetId of [
      await asset(tenantId,businessId,"deleted"),
      await asset(tenantId,businessId,"pending"),
      await asset(tenantId,otherBusinessId),
      await asset(otherTenantId,null),
      await asset(tenantId,businessId,"ready","tenant_export"),
      await asset(tenantId,businessId,"ready","collection_export"),
    ]) await assert.rejects(link(assetId), /unavailable for this message/);

    const sharedAsset = await asset(tenantId,null);
    await link(sharedAsset);
    await link(sharedAsset);
    assert.equal((await query("SELECT media_asset_id FROM message_media WHERE message_id=$1 AND media_asset_id=$2", [messageId,sharedAsset])).rows.length,1);
    await assert.rejects(transaction(client => linkReadyMediaToMessage(client,{...input(sharedAsset),businessId:otherBusinessId})), /unavailable for this message/);

    deleteClient = await db().connect();
    linkClient = await db().connect();
    const deletePid = (await deleteClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const linkPid = (await linkClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

    // Deletion wins: the worker must wait, then reject the newly deleted asset
    // instead of inserting a link based on an earlier ready-state observation.
    const deletedDuringLink = await asset();
    await deleteClient.query("BEGIN");
    await deleteClient.query("SELECT id FROM media_assets WHERE id=$1 FOR UPDATE", [deletedDuringLink]);
    await linkClient.query("BEGIN");
    const blockedLink = linkReadyMediaToMessage(linkClient,input(deletedDuringLink)).then(() => ({linked:true}), error => ({error}));
    await waitForRowLock(linkPid);
    await deleteClient.query("UPDATE media_assets SET processing_status='deleted' WHERE id=$1", [deletedDuringLink]);
    await deleteClient.query("COMMIT");
    const outcome = await blockedLink;
    assert.match(outcome.error?.message || "", /unavailable for this message/);
    await linkClient.query("ROLLBACK");
    assert.equal((await query("SELECT media_asset_id FROM message_media WHERE media_asset_id=$1", [deletedDuringLink])).rows.length,0);

    // Attachment wins: deletion's FOR UPDATE must wait for the linking
    // transaction, then its reference check sees the committed message use.
    const linkedBeforeDelete = await asset();
    await linkClient.query("BEGIN");
    await linkReadyMediaToMessage(linkClient,input(linkedBeforeDelete));
    await deleteClient.query("BEGIN");
    const blockedDelete = deleteClient.query("SELECT id FROM media_assets WHERE id=$1 FOR UPDATE", [linkedBeforeDelete]);
    await waitForRowLock(deletePid);
    await linkClient.query("COMMIT");
    await blockedDelete;
    assert.equal((await deleteClient.query("SELECT media_asset_id FROM message_media WHERE media_asset_id=$1", [linkedBeforeDelete])).rows.length,1);
    await deleteClient.query("ROLLBACK");
    assert.equal((await query("SELECT processing_status FROM media_assets WHERE id=$1", [linkedBeforeDelete])).rows[0].processing_status,"ready");
  } finally {
    await Promise.allSettled([deleteClient?.query("ROLLBACK"),linkClient?.query("ROLLBACK")]);
    deleteClient?.release();
    linkClient?.release();
    if (tenantId) await query("DELETE FROM tenants WHERE id=$1",[tenantId]);
    if (otherTenantId) await query("DELETE FROM tenants WHERE id=$1",[otherTenantId]);
    await closeDb();
  }
});
