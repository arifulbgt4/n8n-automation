# Implementation decisions

This document records implementation choices selected when runtime implementation was authorized.

## Backend/runtime

- Language: TypeScript on Node.js 22+.
- API framework: Fastify 5.x.
- Web applications: the existing Next.js 16 Customer Panel and Super Admin Panel.
- Service layout: separate API and worker services, plus shared config/contracts packages.
- Durable business state remains in PostgreSQL `app_db`.

## PostgreSQL access

- ORM/query layer: Drizzle ORM stable line.
- PostgreSQL driver: `node-postgres`.
- Migrations are version-controlled SQL executed through Drizzle's migrator.
- UUID is the default durable identifier type.
- Timestamps use `timestamptz`.
- Tenant-owned queries must accept explicit tenant context and include a tenant predicate.
- pgvector is required before vector/RAG features are enabled.

## Redis and queues

- Redis client: ioredis.
- Queue runtime: BullMQ 6.x.
- Application keys use `<prefix>:<environment>:<purpose>` namespaces.
- Redis is reconstructable runtime state, never the durable SaaS source of truth.

## Authentication

- Production authentication library: Better Auth 1.7.x, integrated behind the SaaS API/auth boundary.
- Email/password, verification, password reset, session revocation, tenant membership, and elevated Super Admin controls remain governed by the contracts in `03_AUTH_TENANCY_RBAC.md`.
- Super Admin MFA is mandatory before production launch.

## Infrastructure

PostgreSQL, Redis, n8n, Media Storage, reverse proxy/TLS, and host service management remain external pre-provisioned dependencies. This repository only owns clients, application schema/migrations, integration logic, and workflow artifacts.

## n8n version gate

The exact deployed n8n version is not recorded in this repository. Automated n8n API/CLI deployment remains blocked until the deployed runtime reports its exact version and supported management interface. Workflow artifacts may be authored before that point, but they must remain inactive/unverified until import testing succeeds on the deployed version.
