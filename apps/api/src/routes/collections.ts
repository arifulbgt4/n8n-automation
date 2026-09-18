import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enqueue, query, QUEUES, randomToken, transaction } from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requireTenant, slugify } from "../lib.js";

const fieldType = z.enum(["text","long_text","integer","decimal","currency","boolean","date","datetime","email","phone","url","single_select","multi_select","media","relation","json"]);
const fieldInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  label: z.string().trim().min(1).max(120),
  type: fieldType,
  required: z.boolean().default(false),
  uniqueWithinCollection: z.boolean().default(false),
  searchable: z.boolean().default(false),
  filterable: z.boolean().default(false),
  sortable: z.boolean().default(false),
  aiVisible: z.boolean().default(true),
  defaultValue: z.unknown().optional(),
  validation: z.record(z.string(), z.unknown()).default({}),
  options: z.record(z.string(), z.unknown()).default({}),
  displayOrder: z.number().int().min(0).default(0),
});

type FieldRow = {
  key: string;
  label: string;
  type: z.infer<typeof fieldType>;
  required: boolean;
  unique_within_collection: boolean;
  validation_json: Record<string, unknown>;
  options_json: Record<string, unknown>;
};

function validateFieldValue(field: FieldRow, value: unknown) {
  if (value === undefined || value === null || value === "") {
    if (field.required) throw new ApiError(400, "FIELD_REQUIRED", `${field.label} is required.`, { field: field.key });
    return;
  }
  const invalid = () => { throw new ApiError(400, "FIELD_INVALID", `${field.label} has an invalid value.`, { field: field.key, type: field.type }); };
  switch (field.type) {
    case "text": case "long_text": case "email": case "phone": case "url": case "currency":
      if (typeof value !== "string" && field.type !== "currency") invalid();
      break;
    case "integer": if (!Number.isInteger(value)) invalid(); break;
    case "decimal": if (typeof value !== "number" || !Number.isFinite(value)) invalid(); break;
    case "boolean": if (typeof value !== "boolean") invalid(); break;
    case "date": case "datetime": if (typeof value !== "string" || Number.isNaN(Date.parse(value))) invalid(); break;
    case "single_select": {
      if (typeof value !== "string") invalid();
      const allowed = Array.isArray(field.options_json?.values) ? field.options_json.values : null;
      if (allowed && !allowed.includes(value)) invalid();
      break;
    }
    case "multi_select": {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalid();
      const allowed = Array.isArray(field.options_json?.values) ? field.options_json.values : null;
      if (allowed && value.some((item) => !allowed.includes(item))) invalid();
      break;
    }
    case "media": if (!Array.isArray(value) && typeof value !== "string") invalid(); break;
    case "relation": if (typeof value !== "string" && !Array.isArray(value)) invalid(); break;
    case "json": break;
  }
  const validation = field.validation_json || {};
  if (typeof value === "string") {
    if (typeof validation.minLength === "number" && value.length < validation.minLength) invalid();
    if (typeof validation.maxLength === "number" && value.length > validation.maxLength) invalid();
  }
  if (typeof value === "number") {
    if (typeof validation.min === "number" && value < validation.min) invalid();
    if (typeof validation.max === "number" && value > validation.max) invalid();
  }
}

async function loadCollection(tenantId: string, collectionId: string) {
  const result = await query("SELECT * FROM collections WHERE id=$1 AND tenant_id=$2", [collectionId, tenantId]);
  if (!result.rows[0]) throw new ApiError(404, "COLLECTION_NOT_FOUND", "Collection not found.");
  return result.rows[0];
}

async function validateItem(tenantId: string, collectionId: string, data: Record<string, unknown>, currentItemId?: string) {
  const fieldsResult = await query<FieldRow>(`
    SELECT key,label,type,required,unique_within_collection,validation_json,options_json
    FROM collection_fields WHERE collection_id=$1 AND tenant_id=$2 ORDER BY display_order,id
  `, [collectionId, tenantId]);
  const fields = fieldsResult.rows;
  const allowed = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) throw new ApiError(400, "UNKNOWN_FIELD", `Unknown field: ${key}`, { field: key });
  }
  for (const field of fields) {
    const value = data[field.key];
    validateFieldValue(field, value);
    if (field.unique_within_collection && value !== undefined && value !== null && value !== "") {
      const duplicate = await query(`
        SELECT id FROM collection_items
        WHERE tenant_id=$1 AND collection_id=$2 AND status <> 'deleted'
          AND data_jsonb -> $3 = $4::jsonb
          AND ($5::uuid IS NULL OR id<>$5)
        LIMIT 1
      `, [tenantId, collectionId, field.key, JSON.stringify(value), currentItemId ?? null]);
      if (duplicate.rowCount) throw new ApiError(409, "FIELD_NOT_UNIQUE", `${field.label} must be unique.`, { field: field.key });
    }
  }
}

const templates: Record<string, Array<z.input<typeof fieldInput>>> = {
  product: [
    { key: "name", label: "Product Name", type: "text", required: true, searchable: true, sortable: true, displayOrder: 0 },
    { key: "price", label: "Price", type: "currency", filterable: true, sortable: true, displayOrder: 1 },
    { key: "description", label: "Description", type: "long_text", searchable: true, displayOrder: 2 },
    { key: "stock_qty", label: "Stock Qty", type: "decimal", filterable: true, sortable: true, displayOrder: 3 },
    { key: "category", label: "Category", type: "text", searchable: true, filterable: true, displayOrder: 4 },
    { key: "images", label: "Images", type: "media", displayOrder: 5 },
  ],
  service: [
    { key: "name", label: "Service Name", type: "text", required: true, searchable: true, displayOrder: 0 },
    { key: "fee", label: "Fee", type: "currency", filterable: true, displayOrder: 1 },
    { key: "duration_minutes", label: "Duration (minutes)", type: "integer", filterable: true, displayOrder: 2 },
    { key: "description", label: "Description", type: "long_text", searchable: true, displayOrder: 3 },
    { key: "images", label: "Images", type: "media", displayOrder: 4 },
  ],
  property: [
    { key: "name", label: "Property Name", type: "text", required: true, searchable: true, displayOrder: 0 },
    { key: "location", label: "Location", type: "text", searchable: true, filterable: true, displayOrder: 1 },
    { key: "price", label: "Price/Rent", type: "currency", filterable: true, displayOrder: 2 },
    { key: "bedrooms", label: "Bedrooms", type: "integer", filterable: true, displayOrder: 3 },
    { key: "area", label: "Area", type: "text", filterable: true, displayOrder: 4 },
    { key: "images", label: "Images", type: "media", displayOrder: 5 },
  ],
  blank: [],
};

export async function collectionRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/collections", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, params.tenantId);
    const scope = context.membershipRole === "OWNER" ? null : context.businessScope ?? null;
    const q = z.object({ businessId: z.string().uuid().optional() }).parse(request.query);
    const result = await query(`
      SELECT c.*,
        (SELECT count(*)::int FROM collection_fields f WHERE f.collection_id=c.id) AS field_count,
        (SELECT count(*)::int FROM collection_items i WHERE i.collection_id=c.id AND i.status<>'deleted') AS item_count,
        (SELECT count(*)::int FROM collection_channel_links l WHERE l.collection_id=c.id AND l.active=true) AS channel_count
      FROM collections c
      WHERE c.tenant_id=$1 AND c.status<>'archived' AND ($2::uuid IS NULL OR c.business_id=$2)
        AND ($3::uuid[] IS NULL OR c.business_id=ANY($3::uuid[]))
      ORDER BY c.created_at DESC
    `, [params.tenantId, q.businessId ?? null, scope]);
    reply.send({ collections: result.rows });
  });

  app.post("/v1/tenants/:tenantId/collections", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const input = z.object({
      businessId: z.string().uuid(),
      name: z.string().trim().min(1).max(160),
      key: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).optional(),
      purpose: z.string().trim().max(80).optional(),
      transactional: z.boolean().default(false),
      template: z.enum(["product", "service", "property", "blank"]).default("blank"),
      fields: z.array(fieldInput).optional(),
    }).parse(request.body);
    await requireBusinessAccess(request, params.tenantId, input.businessId, ["OWNER","ADMIN","STAFF"]);
    const business = await query("SELECT id FROM businesses WHERE id=$1 AND tenant_id=$2", [input.businessId, params.tenantId]);
    if (!business.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
    const key = input.key ?? slugify(input.name).replace(/-/g, "_").slice(0, 63);
    const fields = (input.fields ?? templates[input.template]).map((field) => fieldInput.parse(field));
    const collection = await transaction(async (client) => {
      const created = await client.query(`
        INSERT INTO collections(tenant_id,business_id,name,key,purpose,is_transactional_source)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [params.tenantId, input.businessId, input.name, key, input.purpose ?? input.template, input.transactional]);
      for (const field of fields) {
        await client.query(`
          INSERT INTO collection_fields(tenant_id,collection_id,key,label,type,required,unique_within_collection,searchable,filterable,sortable,ai_visible,default_value_json,validation_json,options_json,display_order)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15)
        `, [params.tenantId, created.rows[0].id, field.key, field.label, field.type, field.required, field.uniqueWithinCollection, field.searchable, field.filterable, field.sortable, field.aiVisible, field.defaultValue === undefined ? null : JSON.stringify(field.defaultValue), JSON.stringify(field.validation), JSON.stringify(field.options), field.displayOrder]);
      }
      return created.rows[0];
    });
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: input.businessId, action: "COLLECTION_CREATED", resourceType: "collection", resourceId: collection.id, safeDiff: { name: input.name, template: input.template }, request });
    reply.code(201).send({ collection });
  });

  app.get("/v1/tenants/:tenantId/collections/:collectionId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), collectionId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId);
    const collection = await loadCollection(params.tenantId, params.collectionId);
    await requireBusinessAccess(request, params.tenantId, collection.business_id);
    const fields = await query("SELECT * FROM collection_fields WHERE collection_id=$1 ORDER BY display_order,id", [params.collectionId]);
    const channels = await query(`
      SELECT ca.id,ca.platform,ca.name,ca.external_account_id,l.settings_json
      FROM collection_channel_links l JOIN channel_accounts ca ON ca.id=l.channel_account_id
      WHERE l.collection_id=$1 AND l.active=true
    `, [params.collectionId]);
    reply.send({ collection, fields: fields.rows, channels: channels.rows });
  });

  app.post("/v1/tenants/:tenantId/collections/:collectionId/fields", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), collectionId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const collection = await loadCollection(params.tenantId, params.collectionId);
    await requireBusinessAccess(request, params.tenantId, collection.business_id);
    const input = fieldInput.parse(request.body);
    const result = await transaction(async (client) => {
      const inserted = await client.query(`
        INSERT INTO collection_fields(tenant_id,collection_id,key,label,type,required,unique_within_collection,searchable,filterable,sortable,ai_visible,default_value_json,validation_json,options_json,display_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15)
        RETURNING *
      `, [params.tenantId, params.collectionId, input.key, input.label, input.type, input.required, input.uniqueWithinCollection, input.searchable, input.filterable, input.sortable, input.aiVisible, input.defaultValue === undefined ? null : JSON.stringify(input.defaultValue), JSON.stringify(input.validation), JSON.stringify(input.options), input.displayOrder]);
      await client.query("UPDATE collections SET schema_version=schema_version+1,updated_at=now() WHERE id=$1", [params.collectionId]);
      return inserted.rows[0];
    });
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: collection.business_id, action: "COLLECTION_FIELD_CREATED", resourceType: "collection_field", resourceId: result.id, safeDiff: { key: input.key, type: input.type }, request });
    reply.code(201).send({ field: result });
  });

  app.patch("/v1/tenants/:tenantId/collections/:collectionId/fields/:fieldId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), collectionId: z.string().uuid(), fieldId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const collection = await loadCollection(params.tenantId, params.collectionId);
    await requireBusinessAccess(request, params.tenantId, collection.business_id);
    const input = fieldInput.partial().parse(request.body);
    const current = await query("SELECT * FROM collection_fields WHERE id=$1 AND collection_id=$2", [params.fieldId, params.collectionId]);
    if (!current.rows[0]) throw new ApiError(404, "FIELD_NOT_FOUND", "Field not found.");
    const merged = fieldInput.parse({
      key: input.key ?? current.rows[0].key,
      label: input.label ?? current.rows[0].label,
      type: input.type ?? current.rows[0].type,
      required: input.required ?? current.rows[0].required,
      uniqueWithinCollection: input.uniqueWithinCollection ?? current.rows[0].unique_within_collection,
      searchable: input.searchable ?? current.rows[0].searchable,
      filterable: input.filterable ?? current.rows[0].filterable,
      sortable: input.sortable ?? current.rows[0].sortable,
      aiVisible: input.aiVisible ?? current.rows[0].ai_visible,
      defaultValue: input.defaultValue ?? current.rows[0].default_value_json,
      validation: input.validation ?? current.rows[0].validation_json,
      options: input.options ?? current.rows[0].options_json,
      displayOrder: input.displayOrder ?? current.rows[0].display_order,
    });
    const result = await transaction(async (client) => {
      const updated = await client.query(`
        UPDATE collection_fields SET key=$3,label=$4,type=$5,required=$6,unique_within_collection=$7,
          searchable=$8,filterable=$9,sortable=$10,ai_visible=$11,default_value_json=$12::jsonb,
          validation_json=$13::jsonb,options_json=$14::jsonb,display_order=$15,updated_at=now()
        WHERE id=$1 AND collection_id=$2 RETURNING *
      `, [params.fieldId, params.collectionId, merged.key, merged.label, merged.type, merged.required, merged.uniqueWithinCollection, merged.searchable, merged.filterable, merged.sortable, merged.aiVisible, merged.defaultValue === undefined ? null : JSON.stringify(merged.defaultValue), JSON.stringify(merged.validation), JSON.stringify(merged.options), merged.displayOrder]);
      await client.query("UPDATE collections SET schema_version=schema_version+1,updated_at=now() WHERE id=$1", [params.collectionId]);
      return updated.rows[0];
    });
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: collection.business_id, action: "COLLECTION_FIELD_UPDATED", resourceType: "collection_field", resourceId: params.fieldId, safeDiff: input, request });
    reply.send({ field: result });
  });

  app.get("/v1/tenants/:tenantId/collections/:collectionId/items", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), collectionId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId);
    const collection = await loadCollection(params.tenantId, params.collectionId);
    await requireBusinessAccess(request, params.tenantId, collection.business_id);
    const q = z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    const result = await query(`
      SELECT i.*,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'url',m.public_url,'mimeType',m.mime_type,'role',cim.role,'order',cim.display_order) ORDER BY cim.display_order)
                  FROM collection_item_media cim JOIN media_assets m ON m.id=cim.media_asset_id
                  WHERE cim.collection_item_id=i.id),'[]'::jsonb) AS media
      FROM collection_items i
      WHERE i.tenant_id=$1 AND i.collection_id=$2 AND i.status<>'deleted'
        AND ($3::text IS NULL OR i.title ILIKE '%'||$3||'%' OR i.data_jsonb::text ILIKE '%'||$3||'%')
      ORDER BY i.updated_at DESC LIMIT $4 OFFSET $5
    `, [params.tenantId, params.collectionId, q.q ?? null, q.limit, q.offset]);
    const count = await query<{ count: string }>("SELECT count(*) FROM collection_items WHERE tenant_id=$1 AND collection_id=$2 AND status<>'deleted'", [params.tenantId, params.collectionId]);
    reply.send({ items: result.rows, total: Number(count.rows[0]?.count ?? 0), limit: q.limit, offset: q.offset });
  });

  app.post("/v1/tenants/:tenantId/collections/:collectionId/items", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), collectionId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const collection = await loadCollection(params.tenantId, params.collectionId);
    await requireBusinessAccess(request, params.tenantId, collection.business_id);
    const input = z.object({ title: z.string().trim().max(240).optional(), status: z.enum(["active", "hidden", "archived"]).default("active"), data: z.record(z.string(), z.unknown()) }).parse(request.body);
    await validateItem(params.tenantId, params.collectionId, input.data);
    const result = await query(`
      INSERT INTO collection_items(tenant_id,business_id,collection_id,title,status,data_jsonb)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *
    `, [params.tenantId, collection.business_id, params.collectionId, input.title ?? null, input.status, JSON.stringify(input.data)]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: collection.business_id, action: "COLLECTION_ITEM_CREATED", resourceType: "collection_item", resourceId: result.rows[0].id, safeDiff: { title: input.title }, request });
    reply.code(201).send({ item: result.rows[0] });
  });

  app.patch("/v1/tenants/:tenantId/collections/:collectionId/items/:itemId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), collectionId: z.string().uuid(), itemId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const collection = await loadCollection(params.tenantId, params.collectionId);
    await requireBusinessAccess(request, params.tenantId, collection.business_id);
    const input = z.object({ title: z.string().trim().max(240).nullable().optional(), status: z.enum(["active", "hidden", "archived"]).optional(), data: z.record(z.string(), z.unknown()).optional() }).parse(request.body);
    const current = await query<{ data_jsonb: Record<string, unknown> }>("SELECT data_jsonb FROM collection_items WHERE id=$1 AND collection_id=$2 AND tenant_id=$3 AND status<>'deleted'", [params.itemId, params.collectionId, params.tenantId]);
    if (!current.rows[0]) throw new ApiError(404, "ITEM_NOT_FOUND", "Item not found.");
    const data = input.data ? { ...current.rows[0].data_jsonb, ...input.data } : current.rows[0].data_jsonb;
    await validateItem(params.tenantId, params.collectionId, data, params.itemId);
    const result = await query(`
      UPDATE collection_items SET title=CASE WHEN $4::boolean THEN $5 ELSE title END,status=COALESCE($6,status),data_jsonb=$7::jsonb,updated_at=now()
      WHERE id=$1 AND collection_id=$2 AND tenant_id=$3 RETURNING *
    `, [params.itemId, params.collectionId, params.tenantId, Object.prototype.hasOwnProperty.call(input, "title"), input.title ?? null, input.status ?? null, JSON.stringify(data)]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: collection.business_id, action: "COLLECTION_ITEM_UPDATED", resourceType: "collection_item", resourceId: params.itemId, safeDiff: { changedKeys: input.data ? Object.keys(input.data) : [], status: input.status }, request });
    reply.send({ item: result.rows[0] });
  });

  app.delete("/v1/tenants/:tenantId/collections/:collectionId/items/:itemId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), collectionId: z.string().uuid(), itemId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const collection = await loadCollection(params.tenantId, params.collectionId);
    await requireBusinessAccess(request, params.tenantId, collection.business_id);
    const result = await query("UPDATE collection_items SET status='deleted',updated_at=now() WHERE id=$1 AND collection_id=$2 AND tenant_id=$3 RETURNING id", [params.itemId, params.collectionId, params.tenantId]);
    if (!result.rows[0]) throw new ApiError(404, "ITEM_NOT_FOUND", "Item not found.");
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: collection.business_id, action: "COLLECTION_ITEM_DELETED", resourceType: "collection_item", resourceId: params.itemId, request });
    reply.send({ ok: true });
  });

  app.post("/v1/tenants/:tenantId/collections/:collectionId/import", async (request, reply) => {
    const params = z.object({ tenantId:z.string().uuid(),collectionId:z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request,params.tenantId,["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const collection = await loadCollection(params.tenantId,params.collectionId);
    await requireBusinessAccess(request,params.tenantId,collection.business_id,["OWNER","ADMIN","STAFF"]);
    const input = z.object({ items:z.array(z.object({title:z.string().trim().max(240).optional(),data:z.record(z.string(),z.unknown())})).min(1).max(500) }).parse(request.body);
    for (const item of input.items) await validateItem(params.tenantId,params.collectionId,item.data);
    const record = await query<any>(`
      INSERT INTO job_records(tenant_id,business_id,type,input_json,created_by)
      VALUES ($1,$2,'collection_import',$3::jsonb,$4) RETURNING id,status,created_at
    `,[params.tenantId,collection.business_id,JSON.stringify({collectionId:params.collectionId,items:input.items}),principal.userId]);
    const jobId=`bulk:${record.rows[0].id}`;
    await enqueue(QUEUES.bulk,{jobId,jobType:"COLLECTION_IMPORT",tenantId:params.tenantId,businessId:collection.business_id,correlationId:jobId,idempotencyKey:jobId,createdAt:new Date().toISOString(),payload:{jobRecordId:record.rows[0].id}});
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:collection.business_id,action:"COLLECTION_IMPORT_QUEUED",resourceType:"job_record",resourceId:record.rows[0].id,safeDiff:{collectionId:params.collectionId,count:input.items.length},request});
    reply.code(202).send({job:record.rows[0]});
  });

  app.post("/v1/tenants/:tenantId/collections/:collectionId/export", async (request, reply) => {
    const params = z.object({ tenantId:z.string().uuid(),collectionId:z.string().uuid() }).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,params.tenantId);
    const collection=await loadCollection(params.tenantId,params.collectionId);
    await requireBusinessAccess(request,params.tenantId,collection.business_id);
    requireCsrf(request);
    const record=await query<any>(`
      INSERT INTO job_records(tenant_id,business_id,type,input_json,created_by)
      VALUES ($1,$2,'collection_export',$3::jsonb,$4) RETURNING id,status,created_at
    `,[params.tenantId,collection.business_id,JSON.stringify({collectionId:params.collectionId}),principal.userId]);
    const jobId=`bulk:${record.rows[0].id}`;
    await enqueue(QUEUES.bulk,{jobId,jobType:"COLLECTION_EXPORT",tenantId:params.tenantId,businessId:collection.business_id,correlationId:jobId,idempotencyKey:jobId,createdAt:new Date().toISOString(),payload:{jobRecordId:record.rows[0].id}});
    reply.code(202).send({job:record.rows[0]});
  });

  app.get("/v1/tenants/:tenantId/jobs/:jobId", async (request, reply) => {
    const params=z.object({tenantId:z.string().uuid(),jobId:z.string().uuid()}).parse(request.params);
    await requireTenant(request,params.tenantId);
    const result=await query<any>("SELECT id,business_id,type,status,progress,result_json,error_json,started_at,completed_at,created_at,updated_at FROM job_records WHERE id=$1 AND tenant_id=$2",[params.jobId,params.tenantId]);
    if(!result.rows[0]) throw new ApiError(404,"JOB_NOT_FOUND","Job not found.");
    if(result.rows[0].business_id) await requireBusinessAccess(request,params.tenantId,result.rows[0].business_id);
    reply.send({job:result.rows[0]});
  });

  app.get("/v1/tenants/:tenantId/collections/:collectionId/items/:itemId/overrides", async (request, reply) => {
    const params=z.object({tenantId:z.string().uuid(),collectionId:z.string().uuid(),itemId:z.string().uuid()}).parse(request.params);
    await requireTenant(request,params.tenantId);
    const collection=await loadCollection(params.tenantId,params.collectionId);
    await requireBusinessAccess(request,params.tenantId,collection.business_id);
    const result=await query(`
      SELECT o.*,ca.platform,ca.name AS channel_name
      FROM collection_item_channel_overrides o JOIN channel_accounts ca ON ca.id=o.channel_account_id
      WHERE o.tenant_id=$1 AND o.collection_item_id=$2 ORDER BY ca.platform,ca.name
    `,[params.tenantId,params.itemId]);
    reply.send({overrides:result.rows});
  });

  app.put("/v1/tenants/:tenantId/collections/:collectionId/items/:itemId/overrides/:channelId", async (request, reply) => {
    const params=z.object({tenantId:z.string().uuid(),collectionId:z.string().uuid(),itemId:z.string().uuid(),channelId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,params.tenantId,["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const collection=await loadCollection(params.tenantId,params.collectionId);
    await requireBusinessAccess(request,params.tenantId,collection.business_id,["OWNER","ADMIN","STAFF"]);
    const [item,channel]=await Promise.all([
      query("SELECT id FROM collection_items WHERE id=$1 AND collection_id=$2 AND tenant_id=$3 AND status<>'deleted'",[params.itemId,params.collectionId,params.tenantId]),
      query("SELECT id FROM channel_accounts WHERE id=$1 AND tenant_id=$2 AND business_id=$3",[params.channelId,params.tenantId,collection.business_id])
    ]);
    if(!item.rows[0]||!channel.rows[0]) throw new ApiError(400,"OVERRIDE_SCOPE_INVALID","Item or channel is outside this collection/business.");
    const input=z.object({override:z.record(z.string(),z.unknown())}).parse(request.body);
    const result=await query<any>(`
      INSERT INTO collection_item_channel_overrides(tenant_id,collection_item_id,channel_account_id,override_json)
      VALUES ($1,$2,$3,$4::jsonb)
      ON CONFLICT(collection_item_id,channel_account_id) DO UPDATE SET override_json=EXCLUDED.override_json,updated_at=now()
      RETURNING *
    `,[params.tenantId,params.itemId,params.channelId,JSON.stringify(input.override)]);
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:collection.business_id,action:"COLLECTION_ITEM_CHANNEL_OVERRIDE_UPDATED",resourceType:"collection_item",resourceId:params.itemId,safeDiff:{channelId:params.channelId,keys:Object.keys(input.override)},request});
    reply.send({override:result.rows[0]});
  });

  app.put("/v1/tenants/:tenantId/collections/:collectionId/channels", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), collectionId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const collection = await loadCollection(params.tenantId, params.collectionId);
    await requireBusinessAccess(request, params.tenantId, collection.business_id);
    const input = z.object({ channelIds: z.array(z.string().uuid()).max(100) }).parse(request.body);
    await transaction(async (client) => {
      await client.query("DELETE FROM collection_channel_links WHERE collection_id=$1", [params.collectionId]);
      for (const channelId of input.channelIds) {
        const channel = await client.query("SELECT id FROM channel_accounts WHERE id=$1 AND tenant_id=$2 AND business_id=$3", [channelId, params.tenantId, collection.business_id]);
        if (!channel.rows[0]) throw new ApiError(400, "CHANNEL_SCOPE_INVALID", "A selected channel does not belong to this business.");
        await client.query("INSERT INTO collection_channel_links(collection_id,channel_account_id,tenant_id) VALUES ($1,$2,$3)", [params.collectionId, channelId, params.tenantId]);
      }
    });
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: collection.business_id, action: "COLLECTION_CHANNELS_UPDATED", resourceType: "collection", resourceId: params.collectionId, safeDiff: { channelIds: input.channelIds }, request });
    reply.send({ ok: true });
  });
}
