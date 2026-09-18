import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
};

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
    createdAt: timestamps.createdAt
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
    createdAt: timestamps.createdAt
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
    ...timestamps
  },
  (table) => [
    index("automation_deployments_env_bundle_idx").on(
      table.environment,
      table.bundleVersion
    )
  ]
);
