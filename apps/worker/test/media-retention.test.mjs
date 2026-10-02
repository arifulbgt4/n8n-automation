import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDb, db, query, resetEnvForTests } from "@n8n-automation/core";
import { deleteRetainedMediaAsset } from "../src/media-retention.ts";

const databaseAvailable = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("unused:unused");

test("retention rechecks media references under lock before deleting storage", { skip: !databaseAvailable }, async () => {
  const suffix = randomUUID();
  const originalFetch = globalThis.fetch;
  const originalMediaBaseUrl = process.env.MEDIA_BASE_URL;
  const originalMediaApiKey = process.env.MEDIA_API_KEY;
  const deletedStorageFiles = [];
  let tenantId;
  let attachmentClient;
  try {
    process.env.MEDIA_BASE_URL = "https://media-retention.example.test";
    process.env.MEDIA_API_KEY = "synthetic-retention-key";
    resetEnvForTests();
    tenantId = (await query("INSERT INTO tenants(name,slug) VALUES('Media retention test',$1) RETURNING id", [`media-retention-${suffix}`])).rows[0].id;
    const businessId = (await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Retention shop','shop') RETURNING id", [tenantId])).rows[0].id;
    const collectionId = (await query("INSERT INTO collections(tenant_id,business_id,name,key) VALUES($1,$2,'Retention catalog',$3) RETURNING id", [tenantId,businessId,`retention-${suffix}`])).rows[0].id;
    const itemId = (await query("INSERT INTO collection_items(tenant_id,business_id,collection_id,title,data_jsonb) VALUES($1,$2,$3,'Used image','{}') RETURNING id", [tenantId,businessId,collectionId])).rows[0].id;
    const makeOldAsset = async (name) => (await query(`INSERT INTO media_assets(tenant_id,business_id,storage_file_id,storage_user_id,mime_type,kind,processing_status,created_at)
      VALUES($1,$2,$3,NULL,'image/jpeg','image','ready',now()-interval '10 days') RETURNING id`, [tenantId,businessId,`${name}-${suffix}`])).rows[0].id;

    const unreferenced = await makeOldAsset("unreferenced");
    const linked = await makeOldAsset("linked");
    await query("INSERT INTO collection_item_media(collection_item_id,media_asset_id,tenant_id) VALUES($1,$2,$3)", [itemId,linked,tenantId]);
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).origin,"https://media-retention.example.test");
      assert.equal(init.method,"DELETE");
      deletedStorageFiles.push(new URL(String(url)).pathname.split("/").at(-1));
      return new Response(null,{status:204});
    };

    assert.equal(await deleteRetainedMediaAsset({tenantId,assetId:linked,mediaDays:1,mediaBaseUrl:process.env.MEDIA_BASE_URL}),false);
    assert.equal((await query("SELECT processing_status FROM media_assets WHERE id=$1",[linked])).rows[0].processing_status,"ready");
    assert.deepEqual(deletedStorageFiles,[],"referenced bytes stay in Media Storage");
    assert.equal(await deleteRetainedMediaAsset({tenantId,assetId:unreferenced,mediaDays:1,mediaBaseUrl:process.env.MEDIA_BASE_URL}),true);
    assert.equal((await query("SELECT processing_status FROM media_assets WHERE id=$1",[unreferenced])).rows[0].processing_status,"deleted");
    assert.deepEqual(deletedStorageFiles,[`unreferenced-${suffix}`]);

    const attachedDuringWait = await makeOldAsset("concurrent");
    attachmentClient = await db().connect();
    const attachPid = (await attachmentClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await attachmentClient.query("BEGIN");
    await attachmentClient.query("SELECT id FROM media_assets WHERE id=$1 FOR KEY SHARE",[attachedDuringWait]);
    const attaching = attachmentClient.query("INSERT INTO collection_item_media(collection_item_id,media_asset_id,tenant_id) VALUES($1,$2,$3)",[itemId,attachedDuringWait,tenantId]);
    await attaching;
    const retention = deleteRetainedMediaAsset({tenantId,assetId:attachedDuringWait,mediaDays:1,mediaBaseUrl:process.env.MEDIA_BASE_URL});
    for (let attempt=0; ; attempt++) {
      const wait = await query("SELECT 1 FROM pg_stat_activity WHERE application_name='n8n-automation-saas' AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%' AND pid<>$1",[attachPid]);
      if (wait.rows.length) break;
      assert.ok(attempt<100,"retention must wait for a concurrent media attachment");
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await attachmentClient.query("COMMIT");
    assert.equal(await retention,false,"the locked retention check sees the newly committed gallery link");
    assert.equal((await query("SELECT processing_status FROM media_assets WHERE id=$1",[attachedDuringWait])).rows[0].processing_status,"ready");
    assert.ok(!deletedStorageFiles.includes(`concurrent-${suffix}`));
  } finally {
    await attachmentClient?.query("ROLLBACK").catch(()=>undefined);
    attachmentClient?.release();
    globalThis.fetch = originalFetch;
    if (originalMediaBaseUrl === undefined) delete process.env.MEDIA_BASE_URL; else process.env.MEDIA_BASE_URL=originalMediaBaseUrl;
    if (originalMediaApiKey === undefined) delete process.env.MEDIA_API_KEY; else process.env.MEDIA_API_KEY=originalMediaApiKey;
    resetEnvForTests();
    if (tenantId) await query("DELETE FROM tenants WHERE id=$1",[tenantId]);
    await closeDb();
  }
});
