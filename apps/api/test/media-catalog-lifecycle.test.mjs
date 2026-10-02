import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { closeDb, db, query, resetEnvForTests, sha256 } from "@n8n-automation/core";
import { collectionRoutes } from "../src/routes/collections.ts";
import { collectionMediaRoutes } from "../src/routes/collection-media.ts";
import { mediaRoutes } from "../src/routes/media.ts";
import { ApiError, jsonError } from "../src/lib.ts";

const databaseAvailable = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("unused:unused");

test("catalog deletion releases unused images while protecting live catalog and message references", { skip: !databaseAvailable }, async (t) => {
  const app = Fastify();
  const suffix = randomUUID();
  const originalFetch = globalThis.fetch;
  const originalMediaOrigin = process.env.MEDIA_BASE_URL;
  const originalMediaKey = process.env.MEDIA_API_KEY;
  const storageDeletes = [];
  let tenantId;
  let userId;
  try {
    // All storage calls are intercepted. This test never accesses provider files.
    process.env.MEDIA_BASE_URL = "http://media-lifecycle.example.test";
    process.env.MEDIA_API_KEY = "synthetic-media-lifecycle-key";
    resetEnvForTests();
    await app.register(cookie);
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ApiError) return reply.code(error.statusCode).send(jsonError(error, request));
      reply.code(500).send({ error: { code: "TEST_UNHANDLED", message: error.message } });
    });
    await collectionRoutes(app);
    await collectionMediaRoutes(app);
    await mediaRoutes(app);
    await app.ready();
    userId = (await query("INSERT INTO users(email,password_hash) VALUES($1,'test-hash') RETURNING id", [`media-lifecycle-${suffix}@example.test`])).rows[0].id;
    tenantId = (await query("INSERT INTO tenants(name,slug) VALUES('Media lifecycle test',$1) RETURNING id", [`media-lifecycle-${suffix}`])).rows[0].id;
    const businessId = (await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Image shop','main') RETURNING id", [tenantId])).rows[0].id;
    await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [tenantId, userId]);
    const token = randomUUID();
    const csrf = randomUUID();
    await query("INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [userId, sha256(token), sha256(csrf)]);
    const headers = { cookie: `n8nauto_session=${token}`, "x-csrf-token": csrf };
    const base = `/v1/tenants/${tenantId}`;
    const makeCollection = async () => (await query("INSERT INTO collections(tenant_id,business_id,name,key) VALUES($1,$2,'Image collection',$3) RETURNING id", [tenantId, businessId, randomUUID()])).rows[0].id;
    const makeItem = async (collectionId, status = "active") => (await query("INSERT INTO collection_items(tenant_id,business_id,collection_id,title,status,data_jsonb) VALUES($1,$2,$3,'Catalog image item',$4,'{}') RETURNING id", [tenantId, businessId, collectionId, status])).rows[0].id;
    const makeAsset = async () => (await query("INSERT INTO media_assets(tenant_id,business_id,storage_file_id,mime_type,kind,size_bytes,original_name) VALUES($1,$2,$3,'image/png','image',100,'test.png') RETURNING id", [tenantId, businessId, randomUUID()])).rows[0].id;
    const request = (method, url, body) => app.inject({ method, url: base + url, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
    const link = async (collectionId, itemId, assetIds) => {
      const response = await request("PUT", `/collections/${collectionId}/items/${itemId}/media`, { mediaAssetIds: assetIds });
      assert.equal(response.statusCode, 200, response.body);
    };
    const assetState = async assetId => (await query("SELECT processing_status FROM media_assets WHERE id=$1", [assetId])).rows[0].processing_status;
    const references = async assetId => {
      const response = await request("GET", "/media?limit=200");
      assert.equal(response.statusCode, 200, response.body);
      return response.json().assets.find(asset => asset.id === assetId)?.reference_count;
    };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "http://media-lifecycle.example.test");
      assert.equal(init.method, "DELETE");
      const storageId = decodeURIComponent(url.pathname.split("/").at(-1));
      const asset = (await query("SELECT id FROM media_assets WHERE storage_file_id=$1 AND tenant_id=$2", [storageId, tenantId])).rows[0];
      assert.ok(asset, "the remote file must belong to this isolated test tenant");
      const catalogRefs = await query(`SELECT 1 FROM collection_item_media cim
        JOIN collection_items i ON i.id=cim.collection_item_id
        JOIN collections c ON c.id=i.collection_id
        WHERE cim.media_asset_id=$1 AND i.status<>'deleted' AND c.status<>'archived'`, [asset.id]);
      const messageRefs = await query("SELECT 1 FROM message_media WHERE media_asset_id=$1", [asset.id]);
      assert.equal(catalogRefs.rows.length, 0, "storage deletion must never run for a live catalog reference");
      assert.equal(messageRefs.rows.length, 0, "storage deletion must never run for conversation media");
      storageDeletes.push(asset.id);
      return new Response(null, { status: 204 });
    };

    await t.test("item DELETE detaches its gallery without deleting storage, then explicit media DELETE works", async () => {
      const collectionId = await makeCollection();
      const itemId = await makeItem(collectionId);
      const assetId = await makeAsset();
      await link(collectionId, itemId, [assetId]);
      const items = await request("GET", `/collections/${collectionId}/items`);
      assert.equal(items.json().items[0].media[0].id, assetId, "the list supplies the selected image to the panel");
      const collections = await request("GET", "/collections");
      assert.equal(collections.json().collections.find(row => row.id === collectionId).preview_image.id, assetId);
      const removed = await request("DELETE", `/collections/${collectionId}/items/${itemId}`);
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal(await assetState(assetId), "ready");
      assert.equal(await references(assetId), 0, "the UI can reach its deletion confirmation");
      assert.ok(!storageDeletes.includes(assetId));
      const deleted = await request("DELETE", `/media/${assetId}`);
      assert.equal(deleted.statusCode, 200, deleted.body);
      assert.equal(await assetState(assetId), "deleted");
      assert.ok(storageDeletes.includes(assetId));
    });

    await t.test("shared images remain protected until the last live collection is archived", async () => {
      const firstCollection = await makeCollection();
      const secondCollection = await makeCollection();
      const firstItem = await makeItem(firstCollection);
      const secondItem = await makeItem(secondCollection);
      const assetId = await makeAsset();
      await link(firstCollection, firstItem, [assetId]);
      await link(secondCollection, secondItem, [assetId]);
      assert.equal((await request("DELETE", `/collections/${firstCollection}/items/${firstItem}`)).statusCode, 200);
      assert.equal(await references(assetId), 1);
      const blocked = await request("DELETE", `/media/${assetId}`);
      assert.equal(blocked.statusCode, 409, blocked.body);
      assert.ok(!storageDeletes.includes(assetId));
      assert.equal(await assetState(assetId), "ready");
      assert.equal((await request("DELETE", `/collections/${secondCollection}`)).statusCode, 200);
      assert.equal(await references(assetId), 0);
      assert.ok(!storageDeletes.includes(assetId), "collection archival does not delete storage automatically");
      assert.equal((await query("SELECT status FROM collection_items WHERE id=$1", [secondItem])).rows[0].status, "active", "historical catalog records remain available to the backend");
      assert.equal((await request("DELETE", `/media/${assetId}`)).statusCode, 200);
    });

    await t.test("conversation references still block media DELETE after catalog deletion", async () => {
      const collectionId = await makeCollection();
      const itemId = await makeItem(collectionId);
      const assetId = await makeAsset();
      await link(collectionId, itemId, [assetId]);
      const channelId = (await query("INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id) VALUES($1,$2,'facebook','Test Page',$3) RETURNING id", [tenantId, businessId, randomUUID()])).rows[0].id;
      const contactId = (await query("INSERT INTO contacts(tenant_id,business_id,channel_account_id,external_contact_id) VALUES($1,$2,$3,'test-buyer') RETURNING id", [tenantId, businessId, channelId])).rows[0].id;
      const conversationId = (await query("INSERT INTO conversations(tenant_id,business_id,channel_account_id,contact_id) VALUES($1,$2,$3,$4) RETURNING id", [tenantId, businessId, channelId, contactId])).rows[0].id;
      const messageId = (await query("INSERT INTO messages(tenant_id,business_id,channel_account_id,conversation_id,direction,sender_type,message_type) VALUES($1,$2,$3,$4,'OUTBOUND','AI','image') RETURNING id", [tenantId, businessId, channelId, conversationId])).rows[0].id;
      await query("INSERT INTO message_media(message_id,media_asset_id,tenant_id) VALUES($1,$2,$3)", [messageId, assetId, tenantId]);
      assert.equal((await request("DELETE", `/collections/${collectionId}`)).statusCode, 200);
      assert.equal(await references(assetId), 1);
      const blocked = await request("DELETE", `/media/${assetId}`);
      assert.equal(blocked.statusCode, 409, blocked.body);
      assert.equal((await query("SELECT 1 FROM message_media WHERE message_id=$1 AND media_asset_id=$2", [messageId, assetId])).rows.length, 1);
      assert.ok(!storageDeletes.includes(assetId));
    });

    await t.test("older deleted-item and archived-collection links are ignored in the UI and pruned on explicit deletion", async () => {
      for (const obsoleteReason of ["deleted-item", "archived-collection"]) {
        const collectionId = await makeCollection();
        const itemId = await makeItem(collectionId);
        const assetId = await makeAsset();
        await link(collectionId, itemId, [assetId]);
        // Model rows left behind by the old soft-delete implementation.
        if (obsoleteReason === "deleted-item") await query("UPDATE collection_items SET status='deleted' WHERE id=$1", [itemId]);
        else await query("UPDATE collections SET status='archived' WHERE id=$1", [collectionId]);
        assert.equal((await query("SELECT 1 FROM collection_item_media WHERE collection_item_id=$1", [itemId])).rows.length, 1);
        assert.equal(await references(assetId), 0);
        const deleted = await request("DELETE", `/media/${assetId}`);
        assert.equal(deleted.statusCode, 200, deleted.body);
        assert.equal((await query("SELECT 1 FROM collection_item_media WHERE media_asset_id=$1", [assetId])).rows.length, 0);
        assert.equal(await assetState(assetId), "deleted");
      }
    });

    await t.test("hidden and archived items in an active collection are still live references", async () => {
      for (const status of ["hidden", "archived"]) {
        const collectionId = await makeCollection();
        const itemId = await makeItem(collectionId, status);
        const assetId = await makeAsset();
        await link(collectionId, itemId, [assetId]);
        assert.equal(await references(assetId), 1);
        assert.equal((await request("DELETE", `/media/${assetId}`)).statusCode, 409);
        assert.ok(!storageDeletes.includes(assetId));
      }
    });

    await t.test("neither gallery PUT nor legacy POST can relink deleted items, archived collections, or deleted assets", async () => {
      const collectionId = await makeCollection();
      const itemId = await makeItem(collectionId);
      const liveItemId = await makeItem(collectionId);
      const assetId = await makeAsset();
      assert.equal((await request("DELETE", `/collections/${collectionId}/items/${itemId}`)).statusCode, 200);
      for (const method of ["PUT", "POST"]) {
        const body = method === "PUT" ? { mediaAssetIds: [assetId] } : { assetId };
        assert.equal((await request(method, `/collections/${collectionId}/items/${itemId}/media`, body)).statusCode, 404);
      }
      assert.equal((await request("DELETE", `/media/${assetId}`)).statusCode, 200);
      for (const method of ["PUT", "POST"]) {
        const body = method === "PUT" ? { mediaAssetIds: [assetId] } : { assetId };
        assert.equal((await request(method, `/collections/${collectionId}/items/${liveItemId}/media`, body)).statusCode, method === "PUT" ? 400 : 404);
      }
      const archiveAsset = await makeAsset();
      assert.equal((await request("DELETE", `/collections/${collectionId}`)).statusCode, 200);
      for (const method of ["PUT", "POST"]) {
        const body = method === "PUT" ? { mediaAssetIds: [archiveAsset] } : { assetId: archiveAsset };
        assert.equal((await request(method, `/collections/${collectionId}/items/${liveItemId}/media`, body)).statusCode, 404);
      }
    });

    await t.test("gallery attachment and catalog deletion serialize without recreating links", async () => {
      for (const method of ["PUT", "POST"]) {
        for (const deletion of ["item", "collection"]) {
          const collectionId = await makeCollection();
          const itemId = await makeItem(collectionId);
          const assetId = await makeAsset();
          const blockingClient = await db().connect();
          try {
            await blockingClient.query("BEGIN");
            await blockingClient.query("SELECT id FROM media_assets WHERE id=$1 FOR UPDATE", [assetId]);
            const attaching = request(method, `/collections/${collectionId}/items/${itemId}/media`, method === "PUT" ? { mediaAssetIds: [assetId] } : { assetId });
            for (let attempt = 0; ; attempt++) {
              const blocked = await query("SELECT 1 FROM pg_stat_activity WHERE application_name='n8n-automation-saas' AND wait_event_type='Lock' AND query LIKE '%media_assets%FOR UPDATE%' AND query NOT LIKE '%pg_stat_activity%'");
              if (blocked.rows.length) break;
              assert.ok(attempt < 100, "media attachment did not acquire its collection lock");
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            const deleting = request("DELETE", deletion === "item" ? `/collections/${collectionId}/items/${itemId}` : `/collections/${collectionId}`);
            for (let attempt = 0; ; attempt++) {
              const blocked = await query("SELECT 1 FROM pg_stat_activity WHERE application_name='n8n-automation-saas' AND wait_event_type='Lock' AND query LIKE '%collections%' AND query NOT LIKE '%pg_stat_activity%'");
              if (blocked.rows.length) break;
              assert.ok(attempt < 100, "catalog deletion did not wait for its collection lock");
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            await blockingClient.query("COMMIT");
            const attached = await attaching;
            assert.equal(attached.statusCode, 200, attached.body);
            const removed = await deleting;
            assert.equal(removed.statusCode, 200, removed.body);
            assert.equal(await references(assetId), 0);
            assert.equal((await query("SELECT 1 FROM collection_item_media WHERE collection_item_id=$1", [itemId])).rows.length, 0);
            assert.ok(!storageDeletes.includes(assetId));
          } finally {
            await blockingClient.query("ROLLBACK");
            blockingClient.release();
          }
        }
      }
    });

    await t.test("an attach waiting on media DELETE revalidates ready state after the asset lock is released", async () => {
      const collectionId = await makeCollection();
      const itemId = await makeItem(collectionId);
      const assetId = await makeAsset();
      const blockingClient = await db().connect();
      try {
        await blockingClient.query("BEGIN");
        await blockingClient.query("SELECT id FROM media_assets WHERE id=$1 FOR UPDATE", [assetId]);
        const attaching = request("PUT", `/collections/${collectionId}/items/${itemId}/media`, { mediaAssetIds: [assetId] });
        // Wait for the API session to reach its asset lock, without relying on
        // an arbitrary sleep to prove which operation won the race.
        for (let attempt = 0; ; attempt++) {
          const blocked = await query("SELECT 1 FROM pg_stat_activity WHERE application_name='n8n-automation-saas' AND wait_event_type='Lock' AND query LIKE '%ORDER BY id FOR UPDATE%' AND query NOT LIKE '%pg_stat_activity%'");
          if (blocked.rows.length) break;
          assert.ok(attempt < 100, "gallery update did not reach the expected lock");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        await blockingClient.query("UPDATE media_assets SET processing_status='deleted' WHERE id=$1", [assetId]);
        await blockingClient.query("COMMIT");
        const rejected = await attaching;
        assert.equal(rejected.statusCode, 400, rejected.body);
        assert.equal((await query("SELECT 1 FROM collection_item_media WHERE collection_item_id=$1", [itemId])).rows.length, 0);
      } finally {
        await blockingClient.query("ROLLBACK");
        blockingClient.release();
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMediaOrigin === undefined) delete process.env.MEDIA_BASE_URL; else process.env.MEDIA_BASE_URL = originalMediaOrigin;
    if (originalMediaKey === undefined) delete process.env.MEDIA_API_KEY; else process.env.MEDIA_API_KEY = originalMediaKey;
    resetEnvForTests();
    await app.close();
    if (tenantId) await query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    if (userId) await query("DELETE FROM users WHERE id=$1", [userId]);
    await closeDb();
  }
});
