BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','suspended','disabled')),
  email_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_token char(64) NOT NULL,
  ip inet,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id, expires_at DESC);

CREATE TABLE email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_admins (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'SUPER_ADMIN' CHECK (role IN ('SUPER_ADMIN','SUPPORT_ADMIN','BILLING_ADMIN','READONLY_ADMIN')),
  mfa_required boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleting','deleted')),
  plan_id uuid REFERENCES plans(id) ON DELETE SET NULL,
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('OWNER','ADMIN','STAFF','VIEWER')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','suspended')),
  business_scope uuid[] NULL,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON tenant_memberships(user_id, status);

CREATE TABLE tenant_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id),
  status text NOT NULL DEFAULT 'active',
  provider text,
  provider_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_tenant_idx ON tenant_subscriptions(tenant_id, status);

CREATE TABLE tenant_limit_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key text NOT NULL,
  value numeric NOT NULL,
  reason text,
  expires_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  business_type_hint text,
  timezone text NOT NULL DEFAULT 'UTC',
  currency char(3) NOT NULL DEFAULT 'USD',
  locale text NOT NULL DEFAULT 'en',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);
CREATE INDEX businesses_tenant_idx ON businesses(tenant_id, status);

CREATE TABLE channel_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('facebook','instagram','whatsapp')),
  name text NOT NULL,
  external_account_id text NOT NULL,
  public_identifier text,
  connection_status text NOT NULL DEFAULT 'connected' CHECK (connection_status IN ('connected','degraded','disconnected','pending')),
  graph_api_version text,
  default_agent_profile_id uuid,
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  last_webhook_at timestamptz,
  last_delivery_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_account_id)
);
CREATE INDEX channel_accounts_business_idx ON channel_accounts(tenant_id, business_id, active);

CREATE TABLE channel_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  credential_type text NOT NULL,
  encrypted_value text NOT NULL,
  key_hint text,
  expires_at timestamptz,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_account_id, credential_type)
);

CREATE TABLE channel_limit_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  key text NOT NULL,
  value numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_account_id, key)
);

CREATE TABLE collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  key text NOT NULL,
  purpose text,
  is_transactional_source boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  schema_version integer NOT NULL DEFAULT 1,
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, key)
);
CREATE INDEX collections_business_idx ON collections(tenant_id, business_id, status);

CREATE TABLE collection_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL,
  type text NOT NULL CHECK (type IN ('text','long_text','integer','decimal','currency','boolean','date','datetime','email','phone','url','single_select','multi_select','media','relation','json')),
  required boolean NOT NULL DEFAULT false,
  unique_within_collection boolean NOT NULL DEFAULT false,
  searchable boolean NOT NULL DEFAULT false,
  filterable boolean NOT NULL DEFAULT false,
  sortable boolean NOT NULL DEFAULT false,
  ai_visible boolean NOT NULL DEFAULT true,
  default_value_json jsonb,
  validation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  options_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, key)
);
CREATE INDEX collection_fields_order_idx ON collection_fields(collection_id, display_order);

CREATE TABLE collection_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  title text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','hidden','archived','deleted')),
  data_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collection_items_collection_idx ON collection_items(tenant_id, collection_id, status, updated_at DESC);
CREATE INDEX collection_items_json_idx ON collection_items USING gin(data_jsonb jsonb_path_ops);

CREATE TABLE collection_channel_links (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, channel_account_id)
);

CREATE TABLE collection_item_channel_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  collection_item_id uuid NOT NULL REFERENCES collection_items(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  override_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_item_id, channel_account_id)
);

CREATE TABLE tenant_media_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  external_media_user_id text,
  encrypted_api_key text,
  key_hint text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled','error')),
  quota_bytes bigint,
  used_bytes bigint,
  last_health_check_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  storage_provider text NOT NULL DEFAULT 'media_service',
  storage_file_id text NOT NULL,
  storage_user_id text,
  original_name text,
  mime_type text NOT NULL,
  kind text,
  size_bytes bigint NOT NULL DEFAULT 0,
  width integer,
  height integer,
  duration_ms bigint,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  content_hash text,
  public_url text,
  processing_status text NOT NULL DEFAULT 'ready' CHECK (processing_status IN ('pending','ready','error','deleted')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, storage_file_id)
);
CREATE INDEX media_assets_tenant_idx ON media_assets(tenant_id, created_at DESC);
CREATE INDEX media_assets_hash_idx ON media_assets(tenant_id, content_hash) WHERE content_hash IS NOT NULL;

CREATE TABLE collection_item_media (
  collection_item_id uuid NOT NULL REFERENCES collection_items(id) ON DELETE CASCADE,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'gallery',
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_item_id, media_asset_id)
);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  external_contact_id text NOT NULL,
  display_name text,
  phone text,
  email text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_account_id, external_contact_id)
);

CREATE TABLE agent_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  capabilities text[] NOT NULL DEFAULT '{}',
  behavior_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','draft','archived')),
  active_prompt_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_profiles_business_idx ON agent_profiles(tenant_id, business_id, status);
ALTER TABLE channel_accounts ADD CONSTRAINT channel_default_agent_fk FOREIGN KEY (default_agent_profile_id) REFERENCES agent_profiles(id) ON DELETE SET NULL;

CREATE TABLE agent_channel_links (
  agent_profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_profile_id, channel_account_id)
);

CREATE TABLE agent_collection_links (
  agent_profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_profile_id, collection_id)
);

CREATE TABLE prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  version integer NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','training','template','migration')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','candidate','active','archived','rejected')),
  sections_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  assembled_prompt text,
  base_version_id uuid REFERENCES prompt_versions(id) ON DELETE SET NULL,
  training_job_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  published_by uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_profile_id, version)
);
ALTER TABLE agent_profiles ADD CONSTRAINT agent_active_prompt_fk FOREIGN KEY (active_prompt_version_id) REFERENCES prompt_versions(id) ON DELETE SET NULL;

CREATE TABLE ai_provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openai','anthropic','gemini','openai_compatible')),
  ownership_mode text NOT NULL DEFAULT 'BYOK' CHECK (ownership_mode IN ('BYOK','PLATFORM')),
  encrypted_api_key text,
  key_hint text,
  base_url text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid','disabled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_model_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  agent_profile_id uuid REFERENCES agent_profiles(id) ON DELETE CASCADE,
  channel_account_id uuid REFERENCES channel_accounts(id) ON DELETE CASCADE,
  provider_connection_id uuid NOT NULL REFERENCES ai_provider_connections(id) ON DELETE CASCADE,
  task_key text NOT NULL,
  model text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_model_resolve_idx ON ai_model_configs(tenant_id, business_id, agent_profile_id, channel_account_id, task_key, active);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'AI' CHECK (mode IN ('AI','HUMAN','PAUSED')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','archived')),
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  agent_profile_id uuid REFERENCES agent_profiles(id) ON DELETE SET NULL,
  state_version bigint NOT NULL DEFAULT 1,
  last_message_at timestamptz,
  last_turn_at timestamptz,
  escalation_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_inbox_idx ON conversations(tenant_id, business_id, status, last_message_at DESC);

CREATE TABLE conversation_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  speaker text NOT NULL CHECK (speaker IN ('CONTACT','AI','HUMAN','SYSTEM','TRAINER')),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('collecting','ready','processing','processed','failed')),
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX turns_conversation_idx ON conversation_turns(conversation_id, created_at DESC);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id uuid REFERENCES conversation_turns(id) ON DELETE SET NULL,
  platform_message_id text,
  platform_event_id text,
  direction text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  sender_type text NOT NULL CHECK (sender_type IN ('CONTACT','AI','HUMAN','SYSTEM','TRAINER')),
  message_type text NOT NULL,
  text_content text,
  provider_timestamp timestamptz,
  delivery_status text,
  reply_to_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_platform_unique ON messages(channel_account_id, platform_message_id) WHERE platform_message_id IS NOT NULL;
CREATE UNIQUE INDEX messages_event_unique ON messages(channel_account_id, platform_event_id) WHERE platform_event_id IS NOT NULL;
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at DESC);

CREATE TABLE message_media (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, media_asset_id)
);

CREATE TABLE channel_media_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  platform text NOT NULL,
  remote_media_id text NOT NULL,
  status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','stale','invalid')),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  failure_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (media_asset_id, channel_account_id, platform)
);

CREATE TABLE trainer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel_account_id uuid REFERENCES channel_accounts(id) ON DELETE CASCADE,
  agent_profile_id uuid REFERENCES agent_profiles(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('facebook_user','whatsapp_number','instagram_user','panel_simulator')),
  identifier_hash text,
  encrypted_identifier text,
  label text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trainer_identity_lookup_idx ON trainer_identities(tenant_id, channel_account_id, type, identifier_hash, active);

CREATE TABLE training_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE training_examples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  training_session_id uuid REFERENCES training_sessions(id) ON DELETE CASCADE,
  agent_profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  source text NOT NULL,
  input_text text,
  ideal_response text NOT NULL,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  labels text[] NOT NULL DEFAULT '{}',
  approval_status text NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending','approved','rejected')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE training_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  base_prompt_version_id uuid REFERENCES prompt_versions(id) ON DELETE SET NULL,
  candidate_prompt_version_id uuid REFERENCES prompt_versions(id) ON DELETE SET NULL,
  model_config_id uuid REFERENCES ai_model_configs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  evaluation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE TABLE knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_profile_id uuid REFERENCES agent_profiles(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  content text,
  media_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  source_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','indexing','ready','error','archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  source_version integer NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  embedding vector(1536),
  embedding_model text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_version, chunk_index)
);
CREATE INDEX knowledge_chunks_scope_idx ON knowledge_chunks(tenant_id, business_id, active);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel_account_id uuid REFERENCES channel_accounts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  order_number text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  currency char(3) NOT NULL,
  subtotal numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL DEFAULT 0,
  customer_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  delivery_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  payment_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'ai',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, order_number)
);
CREATE INDEX orders_business_idx ON orders(tenant_id, business_id, created_at DESC);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  collection_item_id uuid REFERENCES collection_items(id) ON DELETE SET NULL,
  title_snapshot text NOT NULL,
  sku_snapshot text,
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL DEFAULT 0,
  attributes_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel_account_id uuid REFERENCES channel_accounts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  collection_item_id uuid REFERENCES collection_items(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  timezone text NOT NULL,
  customer_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookings_business_time_idx ON bookings(tenant_id, business_id, starts_at);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel_account_id uuid REFERENCES channel_accounts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  stage text NOT NULL DEFAULT 'new',
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  interest text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE followup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_profile_id uuid REFERENCES agent_profiles(id) ON DELETE SET NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','queued','sent','cancelled','failed')),
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX followup_due_idx ON followup_jobs(status, due_at);

CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  channel_account_id uuid REFERENCES channel_accounts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit text,
  provider text,
  model text,
  task_key text,
  estimated_cost numeric(18,8),
  actual_cost numeric(18,8),
  correlation_id text,
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX usage_idempotency_unique ON usage_events(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX usage_events_scope_time_idx ON usage_events(tenant_id, business_id, channel_account_id, occurred_at DESC);

CREATE TABLE usage_rollups (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid,
  channel_account_id uuid,
  bucket_start timestamptz NOT NULL,
  bucket_size text NOT NULL,
  event_type text NOT NULL,
  quantity numeric NOT NULL,
  estimated_cost numeric(18,8) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, business_id, channel_account_id, bucket_start, bucket_size, event_type)
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'user',
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  safe_diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  user_agent text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_idx ON audit_logs(tenant_id, created_at DESC);

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope text NOT NULL,
  key text NOT NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (tenant_id, scope, key)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  resource_type text,
  resource_id text,
  correlation_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatching','dispatched','failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox_events(status, next_attempt_at, created_at);

-- Useful uniqueness for one active prompt per agent is enforced transactionally by the application.
-- Vector index is added after meaningful data volume because pgvector index strategy depends on measured workload.

INSERT INTO plans (key, name, features, limits)
VALUES (
  'starter',
  'Starter',
  '{"byok":true,"training":true,"customCollections":true}'::jsonb,
  '{"businesses":3,"channels":10,"messagesPerMonth":50000,"aiTurnsPerMonth":10000,"mediaStorageBytes":5368709120,"maxImagesPerResponse":5}'::jsonb
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
