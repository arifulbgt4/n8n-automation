CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  aggregate_type varchar(80) NOT NULL,
  aggregate_id uuid,
  event_type varchar(120) NOT NULL,
  payload jsonb NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_events_status_available_idx
  ON outbox_events(status, available_at);
CREATE INDEX IF NOT EXISTS outbox_events_tenant_created_idx
  ON outbox_events(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  actor_user_id uuid,
  actor_type varchar(32) NOT NULL,
  action varchar(160) NOT NULL,
  resource_type varchar(100),
  resource_id text,
  correlation_id varchar(120) NOT NULL,
  ip_address varchar(64),
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_tenant_created_idx
  ON audit_events(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS audit_events_correlation_idx
  ON audit_events(correlation_id);

CREATE TABLE IF NOT EXISTS automation_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment varchar(40) NOT NULL,
  bundle_version varchar(80) NOT NULL,
  workflow_key varchar(120) NOT NULL,
  workflow_version varchar(80) NOT NULL,
  n8n_workflow_id varchar(120),
  api_contract_version varchar(80) NOT NULL,
  status varchar(32) NOT NULL,
  deployed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_deployments_env_bundle_idx
  ON automation_deployments(environment, bundle_version);
