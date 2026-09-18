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
