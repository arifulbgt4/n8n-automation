BEGIN;

-- A person can use the same email address in both product surfaces, but the
-- credentials, sessions and password-reset tokens must remain independent.
-- `users` stays the canonical person/tenant record; auth_credentials is the
-- surface-specific login record.
CREATE TABLE IF NOT EXISTS auth_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  realm text NOT NULL CHECK (realm IN ('customer','admin')),
  email text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm, email),
  UNIQUE (user_id, realm)
);
CREATE INDEX IF NOT EXISTS auth_credentials_user_idx ON auth_credentials(user_id, realm);

-- Existing tenant users begin as customer credentials. Existing platform
-- admins also receive an independent admin credential with the legacy hash so
-- the migration does not lock anyone out; subsequent changes are realm-scoped.
INSERT INTO auth_credentials(user_id, realm, email, password_hash)
SELECT id, 'customer', email, password_hash
  FROM users
 WHERE EXISTS (SELECT 1 FROM tenant_memberships tm WHERE tm.user_id=users.id)
ON CONFLICT (user_id, realm) DO NOTHING;

INSERT INTO auth_credentials(user_id, realm, email, password_hash)
SELECT u.id, 'admin', u.email, u.password_hash
  FROM users u
  JOIN platform_admins pa ON pa.user_id=u.id
ON CONFLICT (user_id, realm) DO NOTHING;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS auth_realm text NOT NULL DEFAULT 'customer';
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_auth_realm_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_auth_realm_check CHECK (auth_realm IN ('customer','admin'));
CREATE INDEX IF NOT EXISTS sessions_realm_idx ON sessions(user_id, auth_realm, expires_at DESC);

ALTER TABLE email_verification_tokens
  ADD COLUMN IF NOT EXISTS auth_realm text NOT NULL DEFAULT 'customer';
ALTER TABLE email_verification_tokens DROP CONSTRAINT IF EXISTS email_verification_tokens_auth_realm_check;
ALTER TABLE email_verification_tokens
  ADD CONSTRAINT email_verification_tokens_auth_realm_check CHECK (auth_realm IN ('customer','admin'));

ALTER TABLE password_reset_tokens
  ADD COLUMN IF NOT EXISTS auth_realm text NOT NULL DEFAULT 'customer';
ALTER TABLE password_reset_tokens DROP CONSTRAINT IF EXISTS password_reset_tokens_auth_realm_check;
ALTER TABLE password_reset_tokens
  ADD CONSTRAINT password_reset_tokens_auth_realm_check CHECK (auth_realm IN ('customer','admin'));
CREATE INDEX IF NOT EXISTS password_reset_tokens_realm_idx ON password_reset_tokens(user_id, auth_realm, expires_at DESC);

-- Force all browsers to establish a realm-specific session after the rollout;
-- otherwise a pre-migration session would have an ambiguous audience.
UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL;

COMMIT;
