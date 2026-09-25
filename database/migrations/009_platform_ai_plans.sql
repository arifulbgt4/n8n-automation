BEGIN;

CREATE TABLE platform_ai_provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openai','anthropic','gemini','openai_compatible')),
  encrypted_api_key text NOT NULL,
  key_hint text,
  base_url text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid','disabled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_ai_model_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_connection_id uuid NOT NULL REFERENCES platform_ai_provider_connections(id) ON DELETE CASCADE,
  task_key text NOT NULL CHECK (task_key IN ('DEFAULT_CHAT','INTENT_CLASSIFICATION','IMAGE_ANALYSIS','AUDIO_TRANSCRIPTION','STRUCTURED_EXTRACTION','PROMPT_SYNTHESIS','EMBEDDINGS')),
  model text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  input_credits_per_1k_tokens numeric(18,6) NOT NULL DEFAULT 1,
  output_credits_per_1k_tokens numeric(18,6) NOT NULL DEFAULT 1,
  request_credits numeric(18,6) NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_connection_id, task_key, model)
);
CREATE INDEX platform_ai_model_routes_task_idx ON platform_ai_model_routes(task_key, active, priority, created_at DESC);

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS input_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credits numeric(18,6) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS usage_events_ai_month_idx ON usage_events(tenant_id, occurred_at DESC) WHERE task_key IS NOT NULL;

INSERT INTO plans(key,name,active,features,limits,price_metadata)
VALUES
  ('free','Free',true,'{"platformManagedAi":true}'::jsonb,'{"monthlyAiTokens":100000,"monthlyAiCredits":100}'::jsonb,'{}'::jsonb),
  ('pro','Pro',true,'{"platformManagedAi":true}'::jsonb,'{"monthlyAiTokens":2000000,"monthlyAiCredits":2000}'::jsonb,'{}'::jsonb)
ON CONFLICT(key) DO UPDATE SET
  features=plans.features||EXCLUDED.features,
  limits=EXCLUDED.limits||plans.limits,
  updated_at=now();

-- Existing workspaces without a package, and legacy Starter workspaces, become Free.
UPDATE tenants
SET plan_id=(SELECT id FROM plans WHERE key='free'),updated_at=now()
WHERE plan_id IS NULL
   OR plan_id=(SELECT id FROM plans WHERE key='starter' LIMIT 1);

-- Keep signup backward-compatible until the legacy Starter lookup is removed from application code:
-- any NULL/legacy Starter plan selected on INSERT is normalized to Free at the database boundary.
CREATE OR REPLACE FUNCTION normalize_tenant_default_plan() RETURNS trigger AS $$
DECLARE
  free_plan_id uuid;
  starter_plan_id uuid;
BEGIN
  SELECT id INTO free_plan_id FROM plans WHERE key='free' LIMIT 1;
  SELECT id INTO starter_plan_id FROM plans WHERE key='starter' LIMIT 1;
  IF NEW.plan_id IS NULL OR (starter_plan_id IS NOT NULL AND NEW.plan_id=starter_plan_id) THEN
    NEW.plan_id:=free_plan_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenants_default_free_plan ON tenants;
CREATE TRIGGER tenants_default_free_plan
BEFORE INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION normalize_tenant_default_plan();

UPDATE plans SET active=false,updated_at=now() WHERE key='starter';

COMMIT;
