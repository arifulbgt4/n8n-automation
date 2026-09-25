BEGIN;

-- Media protection is package-scoped. These are editable operational defaults,
-- not commercial pricing commitments.
UPDATE plans
SET limits = limits || '{
  "maxImageMegapixels": 10,
  "maxImageAssets": 100,
  "maxImageBytes": 10485760,
  "mediaStorageBytes": 536870912
}'::jsonb,
updated_at = now()
WHERE key = 'free';

UPDATE plans
SET limits = limits || '{
  "maxImageMegapixels": 10,
  "maxImageAssets": 300,
  "maxImageBytes": 10485760,
  "mediaStorageBytes": 2147483648
}'::jsonb,
updated_at = now()
WHERE key = 'pro';

-- Existing reusable catalog images should count toward the package image quota.
-- Future direct customer uploads are marked in media_assets.metadata by the API.
UPDATE media_assets m
SET metadata = COALESCE(m.metadata, '{}'::jsonb) || '{"origin":"customer_upload"}'::jsonb
WHERE m.processing_status <> 'deleted'
  AND m.mime_type LIKE 'image/%'
  AND EXISTS (
    SELECT 1 FROM collection_item_media cim WHERE cim.media_asset_id = m.id
  );

CREATE INDEX IF NOT EXISTS media_assets_tenant_active_idx
  ON media_assets(tenant_id, processing_status);

COMMIT;
