BEGIN;

-- Migration 008 removed the first MFA implementation. Reintroduce the
-- security contract in a forward-only migration so existing databases and
-- clean installs converge on the same protected Super Admin state.
ALTER TABLE platform_admins
  ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mfa_secret_encrypted text,
  ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recovery_code_hashes text[] NOT NULL DEFAULT '{}';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS admin_mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_mfa_challenges_user_idx
  ON admin_mfa_challenges(user_id, expires_at DESC);

-- Keep the role vocabulary aligned with the documented platform-admin model.
ALTER TABLE platform_admins DROP CONSTRAINT IF EXISTS platform_admins_role_check;
ALTER TABLE platform_admins
  ADD CONSTRAINT platform_admins_role_check
  CHECK (role IN ('SUPER_ADMIN','SUPPORT_ADMIN','BILLING_ADMIN','OPS_ADMIN','READONLY_ADMIN'));

-- Existing active administrators must explicitly enroll before privileged use.
UPDATE platform_admins
   SET mfa_required=true,
       updated_at=now()
 WHERE active=true;

COMMIT;
