CREATE TABLE IF NOT EXISTS businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name varchar(180) NOT NULL,
  business_type_hint varchar(80),
  timezone varchar(80) NOT NULL DEFAULT 'UTC',
  currency varchar(3) NOT NULL DEFAULT 'USD',
  locale varchar(32) NOT NULL DEFAULT 'en',
  status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS businesses_tenant_status_idx ON businesses(tenant_id, status);

CREATE TABLE IF NOT EXISTS channel_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform varchar(24) NOT NULL,
  name varchar(180) NOT NULL,
  external_account_id varchar(255) NOT NULL,
  external_public_id varchar(255),
  api_version varchar(40),
  connection_status varchar(32) NOT NULL DEFAULT 'PENDING',
  active boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_health_status varchar(32),
  last_health_checked_at timestamptz,
  last_webhook_at timestamptz,
  last_outbound_at timestamptz,
  last_error_code varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_accounts_platform_external_uidx
  ON channel_accounts(platform, external_account_id);
CREATE INDEX IF NOT EXISTS channel_accounts_tenant_business_idx
  ON channel_accounts(tenant_id, business_id);
CREATE INDEX IF NOT EXISTS channel_accounts_status_idx
  ON channel_accounts(connection_status, active);

CREATE TABLE IF NOT EXISTS channel_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  credential_type varchar(80) NOT NULL,
  ciphertext text NOT NULL,
  iv varchar(32) NOT NULL,
  auth_tag varchar(32) NOT NULL,
  key_version varchar(32) NOT NULL DEFAULT 'v1',
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_credentials_account_type_uidx
  ON channel_credentials(channel_account_id, credential_type);
CREATE INDEX IF NOT EXISTS channel_credentials_tenant_idx ON channel_credentials(tenant_id);
