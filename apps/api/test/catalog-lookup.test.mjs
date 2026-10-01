import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379/0";
process.env.APP_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.INTERNAL_SERVICE_AUTH_SECRET ||= "catalog-test-internal-service-secret";

const { closeDb, db } = await import("@n8n-automation/core");
const { findRelevantItems, isCatalogBrowseRequest, isCatalogMediaRequest, isSpecificCatalogMediaRequest } = await import("../src/catalog-lookup.ts");

test("recognizes general catalog questions without treating specific price questions as browsing", () => {
  for (const text of [
    "তোমাদের কাছে কি কি প্রোডাক্ট আছে?",
    "আপনাদের পণ্যের তালিকা দেখান",
    "What products do you have?",
    "Show me your catalog",
    "ki ki product acy?",
    "apnader kache ki ki product ache?",
    "products ki ki ache?",
  ]) assert.equal(isCatalogBrowseRequest(text), true, text);
  for (const text of ["Tangail suti saree এর দাম কত?", "What is the price of Tangail saree?", "Tangail product price koto?"]) {
    assert.equal(isCatalogBrowseRequest(text), false, text);
  }
});

test("recognizes Bengali, English, and Banglish catalog image requests", () => {
  for (const text of [
    "টাঙ্গাইল শাড়ির ছবি দেখাও",
    "প্রোডাক্টের ছবিগুলো পাঠান",
    "Show me the product photos",
    "Tangail saree er chobi dao",
    "product chobi dekhaw",
  ]) assert.equal(isCatalogMediaRequest(text),true,text);
  for (const text of ["Tangail saree price koto?","What products do you have?"]) {
    assert.equal(isCatalogMediaRequest(text),false,text);
  }
  assert.equal(isSpecificCatalogMediaRequest("Tangail saree er chobi dao"),true);
  assert.equal(isSpecificCatalogMediaRequest("product chobi dekhaw"),false);
  assert.equal(isSpecificCatalogMediaRequest("chobi acy?"),false);
  assert.equal(isSpecificCatalogMediaRequest("Do you have product images?"),false);
});

test("catalog lookup uses only active products linked to this agent, channel, tenant, and business", {
  skip: !process.env.DATABASE_URL || process.env.DATABASE_URL.includes("unused:unused"),
}, async () => {
  const client = await db().connect();
  await client.query("BEGIN");
  try {
    const suffix = randomUUID();
    const tenantId = (await client.query("INSERT INTO tenants(name,slug) VALUES('Catalog lookup test',$1) RETURNING id", [`catalog-${suffix}`])).rows[0].id;
    const otherTenantId = (await client.query("INSERT INTO tenants(name,slug) VALUES('Other catalog tenant',$1) RETURNING id", [`other-catalog-${suffix}`])).rows[0].id;
    const businessId = (await client.query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Saree shop','saree-shop') RETURNING id", [tenantId])).rows[0].id;
    const otherBusinessId = (await client.query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Other shop','other-shop') RETURNING id", [tenantId])).rows[0].id;
    const otherTenantBusinessId = (await client.query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Other tenant shop','other-shop') RETURNING id", [otherTenantId])).rows[0].id;
    const agentId = (await client.query("INSERT INTO agent_profiles(tenant_id,business_id,name) VALUES($1,$2,'Saree agent') RETURNING id", [tenantId,businessId])).rows[0].id;
    const channelId = (await client.query("INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id) VALUES($1,$2,'facebook','Saree Page',$3) RETURNING id", [tenantId,businessId,`catalog-page-${suffix}`])).rows[0].id;
    const otherChannelId = (await client.query("INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id) VALUES($1,$2,'facebook','Unlinked Page',$3) RETURNING id", [tenantId,businessId,`other-catalog-page-${suffix}`])).rows[0].id;

    const collection = async (ownerTenant, ownerBusiness, key, status = "active", purpose = "products") =>
      (await client.query("INSERT INTO collections(tenant_id,business_id,name,key,purpose,status) VALUES($1,$2,$3,$3,$4,$5) RETURNING id", [ownerTenant,ownerBusiness,key,purpose,status])).rows[0].id;
    const item = async (ownerTenant, ownerBusiness, collectionId, title, status = "active", data = {}) =>
      (await client.query("INSERT INTO collection_items(tenant_id,business_id,collection_id,title,status,data_jsonb) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id", [ownerTenant,ownerBusiness,collectionId,title,status,JSON.stringify(data)])).rows[0].id;
    const link = async (collectionId, ownerTenant = tenantId, { agent = true, channel = true, active = true } = {}) => {
      if (agent) await client.query("INSERT INTO agent_collection_links(tenant_id,agent_profile_id,collection_id) VALUES($1,$2,$3)", [ownerTenant,agentId,collectionId]);
      if (channel) await client.query("INSERT INTO collection_channel_links(tenant_id,channel_account_id,collection_id,active) VALUES($1,$2,$3,$4)", [ownerTenant,channelId,collectionId,active]);
    };

    const visibleCollection = await collection(tenantId,businessId,"Visible sarees");
    await link(visibleCollection);
    for (const [key,type,aiVisible] of [
      ["price","currency",true],
      ["stock_qty","integer",true],
      ["description","long_text",true],
      ["internal_margin","decimal",false],
    ]) await client.query("INSERT INTO collection_fields(tenant_id,collection_id,key,label,type,ai_visible) VALUES($1,$2,$3,$3,$4,$5)", [tenantId,visibleCollection,key,type,aiVisible]);
    const tangailId = await item(tenantId,businessId,visibleCollection,"Tangail suti saree","active",{price:899,stock_qty:3,description:"Cotton saree",internal_margin:"secret-margin-value"});
    const scarfId = await item(tenantId,businessId,visibleCollection,"Cotton scarf","active",{price:499,description:"This product is light"});
    const tangailAssetId = (await client.query(`INSERT INTO media_assets(
      tenant_id,business_id,storage_file_id,original_name,mime_type,kind,processing_status
    ) VALUES($1,$2,$3,'tangail.jpg','image/jpeg','image','ready') RETURNING id`,
      [tenantId,businessId,`catalog-test-${suffix}`])).rows[0].id;
    await client.query(`INSERT INTO collection_item_media(
      collection_item_id,media_asset_id,tenant_id,role,display_order
    ) VALUES($1,$2,$3,'primary',0)`,[tangailId,tangailAssetId,tenantId]);
    await client.query("INSERT INTO collection_item_channel_overrides(tenant_id,collection_item_id,channel_account_id,override_json) VALUES($1,$2,$3,$4::jsonb)", [tenantId,tangailId,channelId,JSON.stringify({price:799,internal_margin:"channel-secret-margin"})]);
    await item(tenantId,businessId,visibleCollection,"Hidden product","hidden");
    await item(tenantId,businessId,visibleCollection,"Archived product","archived");

    const agentOnly = await collection(tenantId,businessId,"Agent only");
    await link(agentOnly,tenantId,{channel:false});
    await item(tenantId,businessId,agentOnly,"Agent-only product");
    const channelOnly = await collection(tenantId,businessId,"Channel only");
    await link(channelOnly,tenantId,{agent:false});
    await item(tenantId,businessId,channelOnly,"Channel-only product");
    const inactiveLink = await collection(tenantId,businessId,"Inactive channel link");
    await link(inactiveLink,tenantId,{active:false});
    await item(tenantId,businessId,inactiveLink,"Inactive-link product");
    const archivedCollection = await collection(tenantId,businessId,"Archived collection","archived");
    await link(archivedCollection);
    await item(tenantId,businessId,archivedCollection,"Archived-collection product");
    const otherBusinessCollection = await collection(tenantId,otherBusinessId,"Other business products");
    await link(otherBusinessCollection);
    await item(tenantId,otherBusinessId,otherBusinessCollection,"Cross-business product");
    const otherTenantCollection = await collection(otherTenantId,otherTenantBusinessId,"Other tenant products");
    await link(otherTenantCollection,otherTenantId);
    await item(otherTenantId,otherTenantBusinessId,otherTenantCollection,"Cross-tenant product");

    const lookup = (channel, text) => findRelevantItems(tenantId,businessId,agentId,channel,text,(sql,values) => client.query(sql,values));
    const browse = await lookup(channelId,"তোমাদের কাছে কি কি প্রোডাক্ট আছে?");
    assert.deepEqual(new Set(browse.map(row => row.id)),new Set([tangailId,scarfId]));
    const banglishBrowse = await lookup(channelId,"ki ki product acy?");
    assert.deepEqual(new Set(banglishBrowse.map(row => row.id)),new Set([tangailId,scarfId]));
    assert.equal(browse.find(row => row.id === tangailId).data_jsonb.price,799);
    assert.equal(browse.find(row => row.id === tangailId).data_jsonb.internal_margin,undefined);
    assert.deepEqual(browse.find(row => row.id === tangailId).media,[{
      assetId:tangailAssetId,
      kind:"image",
      mimeType:"image/jpeg",
      role:"primary",
      displayOrder:0,
    }]);
    assert.deepEqual(browse.find(row => row.id === scarfId).media,[]);
    assert.equal((await lookup(channelId,"Tangail suti saree দাম কত?")).map(row => row.id).join(),tangailId);
    assert.equal((await lookup(channelId,"Tangail suti saree er chobi dao")).map(row => row.id).join(),tangailId);
    assert.deepEqual(new Set((await lookup(channelId,"product chobi dekhaw")).map(row => row.id)),new Set([tangailId,scarfId]));
    assert.deepEqual(await lookup(channelId,"channel-secret-margin"),[]);
    assert.deepEqual(await lookup(channelId,"Return policy কী?"),[]);
    assert.deepEqual(await lookup(otherChannelId,"What products do you have?"),[]);
    assert.deepEqual(await findRelevantItems(tenantId,businessId,null,channelId,"What products do you have?",(sql,values) => client.query(sql,values)),[]);

    for (let index=0;index<21;index++) await item(tenantId,businessId,visibleCollection,`Extra product ${index}`);
    const bounded = await lookup(channelId,"Show me your catalog");
    assert.equal(bounded.length,20);
    assert.equal(new Set(bounded.map(row => row.id)).size,20);
    assert.ok(bounded.every(row => row.collection_id === visibleCollection));

    const hiddenTitleCollection = await collection(tenantId,businessId,"Hidden name catalog");
    await link(hiddenTitleCollection);
    await client.query("INSERT INTO collection_fields(tenant_id,collection_id,key,label,type,ai_visible) VALUES($1,$2,'name','Name','text',false),($1,$2,'price','Price','currency',true)", [tenantId,hiddenTitleCollection]);
    const hiddenTitleId = await item(tenantId,businessId,hiddenTitleCollection,"Private sample name","active",{name:"Private sample name",price:120});
    const withHiddenTitle = await lookup(channelId,"What products do you have?");
    const hiddenTitleRow = withHiddenTitle.find(row => row.id === hiddenTitleId);
    assert.ok(hiddenTitleRow);
    assert.equal(hiddenTitleRow.title,null);
    assert.deepEqual(hiddenTitleRow.data_jsonb,{price:120});
    assert.deepEqual(await lookup(channelId,"Private sample name"),[]);

    const services = await collection(tenantId,businessId,"Services","active","service");
    await link(services);
    await client.query("UPDATE agent_collection_links SET priority=100 WHERE agent_profile_id=$1 AND collection_id=$2", [agentId,services]);
    for (let index=0;index<25;index++) await item(tenantId,businessId,services,`Service ${index}`);
    const productBrowse = await lookup(channelId,"তোমাদের কাছে কি কি প্রোডাক্ট আছে?");
    assert.equal(productBrowse.length,20);
    assert.ok(productBrowse.every(row => row.purpose === "products"));
    assert.ok(productBrowse.some(row => row.collection_id === visibleCollection));
    const generalBrowse = await lookup(channelId,"Show me your catalog");
    assert.equal(generalBrowse.length,20);
    assert.ok(generalBrowse.every(row => row.collection_id === services));
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await closeDb();
  }
});
