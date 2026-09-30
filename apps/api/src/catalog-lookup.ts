import { query } from "@n8n-automation/core";

type CatalogItem = {
  id: string;
  collection_id: string;
  title: string | null;
  data_jsonb: Record<string, unknown>;
  collection_name: string;
  purpose: string | null;
};

type CatalogQuery = (sql: string, values: unknown[]) => Promise<{ rows: CatalogItem[] }>;

// Browse questions need a short current catalog, even though their generic words
// are unlikely to match a product title or description.
export function isCatalogBrowseRequest(text: string): boolean {
  const normalized = text.toLowerCase().normalize("NFC");
  return /(?:কি\s*কি|কী\s*কী|কোন\s*কোন)\s*(?:প্রোডাক্ট|পণ্য|পন্য|জিনিস|আইটেম)|(?:প্রোডাক্ট|পণ্য|পন্য|জিনিস|আইটেম)(?:গুলো|গুলি|সমূহ)?\s*(?:কি\s*কি|কী\s*কী|তালিকা|লিস্ট)|(?:প্রোডাক্ট|পণ্য|পন্য|ক্যাটালগ|কালেকশন)(?:গুলোর|গুলো|গুলি|সমূহ|ের)?\s*(?:তালিকা|লিস্ট|দেখা[নও]?)|\b(?:what|which)\s+(?:are\s+)?(?:your\s+)?(?:available\s+)?(?:products?|items?)\b|\b(?:show|list|browse)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:products?|items?|catalog(?:ue)?)\b|\b(?:products?|items?)\s+list\b/i.test(normalized);
}

export async function findRelevantItems(
  tenantId: string,
  businessId: string,
  agentId: string | null,
  channelId: string,
  text: string,
  runQuery: CatalogQuery = (sql, values) => query<CatalogItem>(sql, values),
): Promise<CatalogItem[]> {
  if (!agentId || !text.trim()) return [];

  const browse = isCatalogBrowseRequest(text);
  const productBrowse = browse && /(?:প্রোডাক্ট|পণ্য|পন্য)|\bproducts?\b/i.test(text);
  const words = browse ? [] : (text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])
    .filter((word) => word.length >= 3).slice(0, 8);
  if (!browse && !words.length) return [];

  const result = await runQuery(`
    SELECT i.id,i.collection_id,safe.title,visible.data_jsonb,
      c.name AS collection_name,c.purpose
    FROM collection_items i
    JOIN collections c ON c.id=i.collection_id AND c.tenant_id=$1 AND c.business_id=$2 AND c.status='active'
    JOIN agent_collection_links acl ON acl.collection_id=c.id AND acl.agent_profile_id=$3 AND acl.tenant_id=$1
    JOIN agent_profiles a ON a.id=acl.agent_profile_id AND a.tenant_id=$1 AND a.business_id=$2 AND a.status='active'
    JOIN collection_channel_links ccl ON ccl.collection_id=c.id AND ccl.channel_account_id=$4
      AND ccl.tenant_id=$1 AND ccl.active=true
    JOIN channel_accounts ca ON ca.id=ccl.channel_account_id AND ca.tenant_id=$1 AND ca.business_id=$2 AND ca.active=true
    LEFT JOIN collection_item_channel_overrides cio ON cio.collection_item_id=i.id
      AND cio.channel_account_id=$4 AND cio.tenant_id=$1
    CROSS JOIN LATERAL (
      SELECT i.data_jsonb || COALESCE(cio.override_json,'{}'::jsonb) AS data_jsonb
    ) effective
    CROSS JOIN LATERAL (
      SELECT COALESCE(jsonb_object_agg(f.key,effective.data_jsonb->f.key),'{}'::jsonb) AS data_jsonb
      FROM collection_fields f
      WHERE f.collection_id=c.id AND f.tenant_id=$1 AND f.ai_visible=true
        AND effective.data_jsonb ? f.key
    ) visible
    CROSS JOIN LATERAL (
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM collection_fields hidden
        WHERE hidden.collection_id=c.id AND hidden.tenant_id=$1 AND hidden.ai_visible=false
          AND (hidden.key IN ('name','title') OR i.title=i.data_jsonb->>hidden.key
            OR i.title=effective.data_jsonb->>hidden.key)
      ) THEN NULL ELSE i.title END AS title
    ) safe
    WHERE i.tenant_id=$1 AND i.business_id=$2 AND i.status='active'
      AND ($8::boolean=false OR lower(COALESCE(c.purpose,'blank')) IN
        ('product','products','catalog','inventory','custom','blank'))
      AND ($5::boolean OR safe.title ILIKE '%'||$6||'%' OR
        visible.data_jsonb::text ILIKE '%'||$6||'%' OR EXISTS (
          SELECT 1 FROM unnest($7::text[]) w WHERE length(w)>=3 AND
            (safe.title ILIKE '%'||w||'%' OR
             visible.data_jsonb::text ILIKE '%'||w||'%')
        ))
    ORDER BY CASE WHEN $8::boolean AND lower(COALESCE(c.purpose,'')) IN ('product','products') THEN 0 ELSE 1 END,
      acl.priority DESC,i.updated_at DESC,i.id
    LIMIT 20
  `, [tenantId, businessId, agentId, channelId, browse, words.join(" "), words, productBrowse]);
  return result.rows;
}
