CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  slug varchar(180) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_uidx ON tenants(slug);

CREATE TABLE IF NOT EXISTS tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(24) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_memberships_tenant_user_uidx
  ON tenant_memberships(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS tenant_memberships_user_idx ON tenant_memberships(user_id);

CREATE TABLE IF NOT EXISTS tenant_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email varchar(320) NOT NULL,
  role varchar(24) NOT NULL,
  token_hash varchar(64) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  expires_at timestamptz NOT NULL,
  invited_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_invitations_token_hash_uidx
  ON tenant_invitations(token_hash);
CREATE INDEX IF NOT EXISTS tenant_invitations_tenant_email_idx
  ON tenant_invitations(tenant_id, email);

CREATE TABLE IF NOT EXISTS business_membership_restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES tenant_memberships(id) ON DELETE CASCADE,
  business_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS business_membership_restrictions_uidx
  ON business_membership_restrictions(membership_id, business_id);

CREATE TABLE IF NOT EXISTS platform_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(32) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_admins_user_uidx ON platform_admins(user_id);
