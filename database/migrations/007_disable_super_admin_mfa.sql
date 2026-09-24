BEGIN;

ALTER TABLE platform_admins
  ALTER COLUMN mfa_required SET DEFAULT false;

UPDATE platform_admins
   SET mfa_required=false,
       mfa_enabled=false,
       mfa_secret_encrypted=NULL,
       recovery_code_hashes='{}',
       updated_at=now()
 WHERE mfa_required=true
    OR mfa_enabled=true
    OR mfa_secret_encrypted IS NOT NULL
    OR cardinality(recovery_code_hashes) > 0;

UPDATE sessions
   SET mfa_verified_at=NULL
 WHERE mfa_verified_at IS NOT NULL;

DELETE FROM admin_mfa_challenges;

COMMIT;
