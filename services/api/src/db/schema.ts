import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from "drizzle-orm/pg-core";

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const authUsers = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt,
    updatedAt
  },
  (table) => [uniqueIndex("users_email_uidx").on(table.email)]
);

export const authSessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    createdAt,
    updatedAt
  },
  (table) => [
    uniqueIndex("sessions_token_uidx").on(table.token),
    index("sessions_user_idx").on(table.userId)
  ]
);

export const authAccounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt,
    updatedAt
  },
  (table) => [
    uniqueIndex("accounts_provider_account_uidx").on(table.providerId, table.accountId),
    index("accounts_user_idx").on(table.userId)
  ]
);

export const authVerifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt,
    updatedAt
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)]
);

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 160 }).notNull(),
    slug: varchar("slug", { length: 180 }).notNull(),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"),
    createdAt,
    updatedAt
  },
  (table) => [uniqueIndex("tenants_slug_uidx").on(table.slug)]
);

export const tenantMemberships = pgTable(
  "tenant_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 24 }).notNull(),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"),
    createdAt,
    updatedAt
  },
  (table) => [
    uniqueIndex("tenant_memberships_tenant_user_uidx").on(table.tenantId, table.userId),
    index("tenant_memberships_user_idx").on(table.userId)
  ]
);

export const tenantInvitations = pgTable(
  "tenant_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }).notNull(),
    role: varchar("role", { length: 24 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 24 }).notNull().default("PENDING"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    invitedByUserId: uuid("invited_by_user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt,
    updatedAt
  },
  (table) => [
    uniqueIndex("tenant_invitations_token_hash_uidx").on(table.tokenHash),
    index("tenant_invitations_tenant_email_idx").on(table.tenantId, table.email)
  ]
);

export const businessMembershipRestrictions = pgTable(
  "business_membership_restrictions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    membershipId: uuid("membership_id").notNull().references(() => tenantMemberships.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").notNull(),
    createdAt
  },
  (table) => [
    uniqueIndex("business_membership_restrictions_uidx").on(table.membershipId, table.businessId)
  ]
);

export const platformAdmins = pgTable(
  "platform_admins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 32 }).notNull(),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"),
    createdAt,
    updatedAt
  },
  (table) => [uniqueIndex("platform_admins_user_uidx").on(table.userId)]
);


export const businesses = pgTable(
  "businesses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 180 }).notNull(),
    businessTypeHint: varchar("business_type_hint", { length: 80 }),
    timezone: varchar("timezone", { length: 80 }).notNull().default("UTC"),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    locale: varchar("locale", { length: 32 }).notNull().default("en"),
    status: varchar("status", { length: 24 }).notNull().default("ACTIVE"),
    settings: jsonb("settings").notNull().default({}),
    createdAt,
    updatedAt
  },
  (table) => [
    index("businesses_tenant_status_idx").on(table.tenantId, table.status)
  ]
);

export const channelAccounts = pgTable(
  "channel_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 24 }).notNull(),
    name: varchar("name", { length: 180 }).notNull(),
    externalAccountId: varchar("external_account_id", { length: 255 }).notNull(),
    externalPublicId: varchar("external_public_id", { length: 255 }),
    apiVersion: varchar("api_version", { length: 40 }),
    connectionStatus: varchar("connection_status", { length: 32 }).notNull().default("PENDING"),
    active: boolean("active").notNull().default(false),
    settings: jsonb("settings").notNull().default({}),
    lastHealthStatus: varchar("last_health_status", { length: 32 }),
    lastHealthCheckedAt: timestamp("last_health_checked_at", { withTimezone: true }),
    lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 120 }),
    createdAt,
    updatedAt
  },
  (table) => [
    uniqueIndex("channel_accounts_platform_external_uidx").on(
      table.platform,
      table.externalAccountId
    ),
    index("channel_accounts_tenant_business_idx").on(table.tenantId, table.businessId),
    index("channel_accounts_status_idx").on(table.connectionStatus, table.active)
  ]
);

export const channelCredentials = pgTable(
  "channel_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    channelAccountId: uuid("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    credentialType: varchar("credential_type", { length: 80 }).notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: varchar("iv", { length: 32 }).notNull(),
    authTag: varchar("auth_tag", { length: 32 }).notNull(),
    keyVersion: varchar("key_version", { length: 32 }).notNull().default("v1"),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
    updatedAt
  },
  (table) => [
    uniqueIndex("channel_credentials_account_type_uidx").on(
      table.channelAccountId,
      table.credentialType
    ),
    index("channel_credentials_tenant_idx").on(table.tenantId)
  ]
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id"),
    aggregateType: varchar("aggregate_type", { length: 80 }).notNull(),
    aggregateId: uuid("aggregate_id"),
    eventType: varchar("event_type", { length: 120 }).notNull(),
    payload: jsonb("payload").notNull(),
    status: varchar("status", { length: 24 }).notNull().default("PENDING"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt
  },
  (table) => [
    index("outbox_events_status_available_idx").on(table.status, table.availableAt),
    index("outbox_events_tenant_created_idx").on(table.tenantId, table.createdAt)
  ]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id"),
    actorUserId: uuid("actor_user_id"),
    actorType: varchar("actor_type", { length: 32 }).notNull(),
    action: varchar("action", { length: 160 }).notNull(),
    resourceType: varchar("resource_type", { length: 100 }),
    resourceId: text("resource_id"),
    correlationId: varchar("correlation_id", { length: 120 }).notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt
  },
  (table) => [
    index("audit_events_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("audit_events_correlation_idx").on(table.correlationId)
  ]
);

export const automationDeployments = pgTable(
  "automation_deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environment: varchar("environment", { length: 40 }).notNull(),
    bundleVersion: varchar("bundle_version", { length: 80 }).notNull(),
    workflowKey: varchar("workflow_key", { length: 120 }).notNull(),
    workflowVersion: varchar("workflow_version", { length: 80 }).notNull(),
    n8nWorkflowId: varchar("n8n_workflow_id", { length: 120 }),
    apiContractVersion: varchar("api_contract_version", { length: 80 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt,
    updatedAt
  },
  (table) => [
    index("automation_deployments_env_bundle_idx").on(
      table.environment,
      table.bundleVersion
    )
  ]
);
