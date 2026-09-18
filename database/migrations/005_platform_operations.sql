BEGIN;

CREATE TABLE IF NOT EXISTS automation_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL,
  bundle_version text NOT NULL,
  api_contract_version text NOT NULL DEFAULT '1',
  workflow_key text NOT NULL,
  workflow_name text NOT NULL,
  n8n_workflow_id text NOT NULL,
  logical_version text,
  active boolean NOT NULL DEFAULT false,
  deployment_status text NOT NULL DEFAULT 'deployed' CHECK (deployment_status IN ('planned','deployed','active','inactive','failed','rolled_back')),
  previous_deployment_id uuid REFERENCES automation_deployments(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  deployed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  deployed_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  UNIQUE(environment,workflow_key,bundle_version)
);
CREATE INDEX IF NOT EXISTS automation_deployments_env_idx ON automation_deployments(environment,deployed_at DESC);

CREATE TABLE IF NOT EXISTS ai_model_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model text NOT NULL,
  display_name text,
  capabilities text[] NOT NULL DEFAULT '{}',
  context_window integer,
  max_output_tokens integer,
  pricing_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,model)
);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  capabilities text[] NOT NULL DEFAULT '{}',
  sections_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS followup_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_profile_id uuid REFERENCES agent_profiles(id) ON DELETE CASCADE,
  channel_account_id uuid REFERENCES channel_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  delay_minutes integer NOT NULL DEFAULT 60 CHECK (delay_minutes > 0),
  max_window_hours numeric NOT NULL DEFAULT 23 CHECK (max_window_hours > 0),
  message_template text,
  rules_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS followup_policies_scope_idx ON followup_policies(tenant_id,business_id,active);

CREATE TABLE IF NOT EXISTS quota_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key text NOT NULL,
  threshold_percent numeric NOT NULL CHECK (threshold_percent > 0 AND threshold_percent <= 100),
  channel text NOT NULL DEFAULT 'in_app',
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  last_triggered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,key,threshold_percent,channel)
);

CREATE TABLE IF NOT EXISTS plan_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  billing_interval text NOT NULL CHECK (billing_interval IN ('month','year','one_time')),
  currency text NOT NULL DEFAULT 'USD',
  unit_amount numeric NOT NULL DEFAULT 0,
  provider text,
  external_price_id text,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id,billing_interval,currency)
);

CREATE TABLE IF NOT EXISTS retention_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_days integer,
  media_days integer,
  audit_days integer,
  training_days integer,
  hard_delete_after_days integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
