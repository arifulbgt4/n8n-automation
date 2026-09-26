BEGIN;

-- The current product policy does not require MFA for Super Admin access.
-- Clear legacy enrollment state so old credentials cannot trigger an MFA
-- challenge if a stale client or database flag is encountered during rollout.
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
