export type UUID = string;

export type TenantContext = Readonly<{
  tenantId: UUID;
  actorUserId?: UUID;
  businessId?: UUID;
  correlationId: string;
}>;

export type JobEnvelope<TPayload = unknown> = Readonly<{
  version: 1;
  jobId: UUID;
  type: string;
  tenantId?: UUID;
  businessId?: UUID;
  correlationId: string;
  idempotencyKey?: string;
  createdAt: string;
  payload: TPayload;
}>;

export type DependencyHealth = Readonly<{
  ok: boolean;
  latencyMs?: number;
  message?: string;
}>;

export type ReadinessReport = Readonly<{
  ok: boolean;
  service: string;
  version: string;
  dependencies: Record<string, DependencyHealth>;
}>;
