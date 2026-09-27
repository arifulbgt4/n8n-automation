BEGIN;

-- Media files remain tenant-owned in the SaaS database, while one application
-- Media Storage account backs all new uploads. Keep every tenant at or below
-- 512 MiB regardless of older plan defaults or overrides.
UPDATE plans
SET limits = jsonb_set(
  limits,
  '{mediaStorageBytes}',
  to_jsonb(LEAST(COALESCE((limits->>'mediaStorageBytes')::bigint, 536870912), 536870912))
), updated_at = now()
WHERE COALESCE((limits->>'mediaStorageBytes')::bigint, 536870912) > 536870912;

UPDATE tenant_limit_overrides
SET value = 536870912
WHERE key = 'mediaStorageBytes' AND value > 536870912;

-- Application prechecks improve the error message, but only a database lock
-- protects the quota if an upload outlives its Redis lease or another writer
-- inserts media concurrently.
CREATE OR REPLACE FUNCTION enforce_tenant_media_storage_quota() RETURNS trigger AS $$
DECLARE
  allowed_bytes bigint;
  used_bytes numeric;
BEGIN
  IF NEW.processing_status = 'deleted' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 0));

  SELECT LEAST(
    536870912::bigint,
    GREATEST(0::bigint, COALESCE(
      (SELECT o.value::bigint FROM tenant_limit_overrides o
       WHERE o.tenant_id=t.id AND o.key='mediaStorageBytes'
         AND (o.expires_at IS NULL OR o.expires_at>now()) LIMIT 1),
      (p.limits->>'mediaStorageBytes')::bigint,
      536870912::bigint
    ))
  ) INTO allowed_bytes
  FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id
  WHERE t.id=NEW.tenant_id;

  SELECT COALESCE(sum(size_bytes),0) INTO used_bytes
  FROM media_assets
  WHERE tenant_id=NEW.tenant_id AND processing_status<>'deleted' AND id<>NEW.id;

  IF allowed_bytes IS NOT NULL AND used_bytes + NEW.size_bytes > allowed_bytes THEN
    RAISE EXCEPTION 'Workspace media storage quota exceeded' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER media_assets_tenant_quota
BEFORE INSERT OR UPDATE OF tenant_id,size_bytes,processing_status ON media_assets
FOR EACH ROW EXECUTE FUNCTION enforce_tenant_media_storage_quota();

COMMIT;
