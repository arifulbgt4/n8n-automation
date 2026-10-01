BEGIN;

CREATE TABLE IF NOT EXISTS platform_ai_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  tokens_per_credit numeric(18,6) NOT NULL DEFAULT 1000 CHECK (tokens_per_credit > 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_ai_settings(singleton,tokens_per_credit)
VALUES (true,1000)
ON CONFLICT(singleton) DO NOTHING;

-- Normalize today's already-recorded AI usage to the new global default rate at cutover.
UPDATE usage_events
SET credits=COALESCE(total_tokens,0)::numeric/1000
WHERE task_key IS NOT NULL
  AND occurred_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

-- Preserve the previous monthly credit budget as an equivalent daily allowance.
UPDATE plans
SET limits=COALESCE(limits,'{}'::jsonb)-'monthlyAiTokens'-'monthlyAiCredits',
    active=(key IN ('free','pro')),
    updated_at=now();

UPDATE plans
SET limits=limits||'{"dailyAiCredits":3.333333}'::jsonb,
    features=features||'{"platformManagedAi":true}'::jsonb,
    active=true,
    updated_at=now()
WHERE key='free';

UPDATE plans
SET limits=limits||'{"dailyAiCredits":66.666667}'::jsonb,
    features=features||'{"platformManagedAi":true}'::jsonb,
    active=true,
    updated_at=now()
WHERE key='pro';

UPDATE tenants
SET plan_id=(SELECT id FROM plans WHERE key='free' LIMIT 1),updated_at=now()
WHERE plan_id IS NULL
   OR plan_id NOT IN (SELECT id FROM plans WHERE key IN ('free','pro'));

DELETE FROM tenant_limit_overrides
WHERE key IN ('monthlyAiTokens','monthlyAiCredits');

CREATE INDEX IF NOT EXISTS usage_events_ai_daily_idx
  ON usage_events(tenant_id,occurred_at DESC) WHERE task_key IS NOT NULL;

COMMIT;
