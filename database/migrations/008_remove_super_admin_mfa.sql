BEGIN;

DROP TABLE IF EXISTS admin_mfa_challenges;

ALTER TABLE sessions
  DROP COLUMN IF EXISTS mfa_verified_at;

ALTER TABLE platform_admins
  DROP COLUMN IF EXISTS mfa_required,
  DROP COLUMN IF EXISTS mfa_secret_encrypted,
  DROP COLUMN IF EXISTS mfa_enabled,
  DROP COLUMN IF EXISTS recovery_code_hashes;

COMMIT;
