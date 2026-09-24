# Local Development Guide

This is the canonical zero-to-running guide for developing n8n Automation SaaS locally.

Production PostgreSQL, Redis, n8n, Media Storage, reverse proxy/TLS, and backups are externally managed. For development, disposable local PostgreSQL + pgvector and Redis instances are supported.

## 1. Local runtime map

| Component | Local address / role |
| --- | --- |
| Customer Panel | http://localhost:3000 |
| Super Admin Panel | http://localhost:3001 |
| Fastify API | http://localhost:4000 |
| BullMQ worker | background process |
| PostgreSQL + pgvector | 127.0.0.1:5432 |
| Redis | 127.0.0.1:6379 |

Optional integrations: n8n, Media Storage, Meta APIs, outbound email webhook, and external AI providers.

PostgreSQL is the durable SaaS source of truth. Redis is transient queue/cache/lock/rate-limit state. n8n orchestrates workflows but does not own business data.

## 2. Prerequisites

Required:

- Git
- Node.js 22+
- npm
- PostgreSQL with pgvector, or Docker
- Redis, or Docker

Recommended:

- Docker Desktop or compatible runtime
- OpenSSL
- an HTTPS tunnel when testing Meta callbacks/webhooks
- TypeScript and ESLint editor support

Verify:

~~~bash
node --version
npm --version
git --version
docker --version
~~~

## 3. Clone and install

~~~bash
git clone git@github.com:arifulbgt4/n8n-automation.git
cd n8n-automation
git checkout master
npm install --include=dev
~~~

The repository uses npm workspaces:

- apps/api
- apps/worker
- packages/core
- customer-panel
- super-admin-panel

The root currently follows the same npm install workflow as CI. Use npm ci only when a root lockfile is intentionally present and maintained.

## 4. Start PostgreSQL + pgvector

Skip this if you already have a compatible local database.

~~~bash
docker run -d \
  --name n8nauto-postgres \
  -e POSTGRES_USER=app_user \
  -e POSTGRES_PASSWORD=app_password \
  -e POSTGRES_DB=app_db \
  -p 5432:5432 \
  -v n8nauto_pgdata:/var/lib/postgresql/data \
  pgvector/pgvector:pg17
~~~

Check:

~~~bash
docker exec n8nauto-postgres pg_isready -U app_user -d app_db
~~~

## 5. Start Redis

~~~bash
docker run -d \
  --name n8nauto-redis \
  -p 6379:6379 \
  -v n8nauto_redisdata:/data \
  redis:7-alpine \
  redis-server --appendonly yes
~~~

Check:

~~~bash
docker exec n8nauto-redis redis-cli ping
~~~

Expected response: PONG.

These containers are developer-owned disposable dependencies, not production infrastructure definitions.

## 6. Create local environment configuration

~~~bash
cp .env.example .env.local
~~~

Generate two strong local values:

~~~bash
openssl rand -hex 32
openssl rand -hex 32
~~~

Use one 64-hex-character value for APP_ENCRYPTION_KEY and another long random value for INTERNAL_SERVICE_AUTH_SECRET.

Recommended local values:

~~~dotenv
DATABASE_URL=postgresql://app_user:app_password@127.0.0.1:5432/app_db
REDIS_URL=redis://127.0.0.1:6379/0
QUEUE_PREFIX=n8nauto:development

APP_ENCRYPTION_KEY=<64-hex-character-secret>
APP_ENCRYPTION_KEY_PREVIOUS=
INTERNAL_SERVICE_AUTH_SECRET=<long-random-secret-at-least-24-characters>

SESSION_COOKIE_NAME=n8nauto_session
SESSION_TTL_DAYS=30
CSRF_HEADER_NAME=x-csrf-token

CUSTOMER_APP_ORIGIN=http://localhost:3000
ADMIN_APP_ORIGIN=http://localhost:3001
API_PUBLIC_ORIGIN=http://localhost:4000

EMAIL_DELIVERY_WEBHOOK_URL=
EMAIL_FROM=no-reply@example.com

MEDIA_BASE_URL=
MEDIA_API_KEY=
MEDIA_ADMIN_TOKEN=

N8N_TURN_WEBHOOK_URL=
N8N_TRAINING_WEBHOOK_URL=
N8N_HEALTH_WEBHOOK_URL=
N8N_WORKFLOW_BUNDLE_VERSION=2.0.0

# Used only by the n8n process when the final modular bundle is enabled.
N8N_INTERNAL_WEBHOOK_BASE_URL=

META_APP_ID=
META_OAUTH_REDIRECT_URI=http://localhost:4000/v1/channels/meta/oauth/callback
META_GRAPH_API_VERSION=v23.0
META_VERIFY_TOKEN=
META_APP_SECRET=

AGGREGATION_WINDOW_MS=4500
AGGREGATION_MAX_MESSAGES=20
AGGREGATION_MAX_BYTES=4194304
OUTBOUND_DEFAULT_RATE_PER_MINUTE=30
OUTBOUND_DEFAULT_BURST=5
WORKER_CONCURRENCY=10
EMBEDDING_DIMENSIONS=1536

LOG_LEVEL=info
NODE_ENV=development
~~~

Backend-required values are DATABASE_URL, REDIS_URL, APP_ENCRYPTION_KEY, and INTERNAL_SERVICE_AUTH_SECRET. APP_ENCRYPTION_KEY must be exactly 32 bytes represented as 64 hexadecimal characters. INTERNAL_SERVICE_AUTH_SECRET must be at least 24 characters.

`N8N_INTERNAL_WEBHOOK_BASE_URL` is not consumed by the application schema; it is an n8n-runtime variable used by bundle `2.0.0` for private workflow-to-workflow calls.

### Environment loading behavior

The API and worker do not automatically read the repository root .env.local file. Export it into every backend shell:

~~~bash
set -a
source .env.local
set +a
~~~

Run the same commands before migrations, tests, admin bootstrap, n8n deployment scripts, or secret rotation when those commands need application configuration.

The Next.js panels default to http://localhost:4000 and do not require local env files for the standard setup.

If the API URL differs, create customer-panel/.env.local and super-admin-panel/.env.local:

~~~dotenv
NEXT_PUBLIC_API_URL=http://localhost:4000
~~~

## 7. Build the shared core package

API and worker import the compiled packages/core output.

Run once before backend startup:

~~~bash
npm run build:core
~~~

When modifying packages/core, keep a watcher running:

~~~bash
npm run build -w @n8n-automation/core -- --watch
~~~

If API/worker do not pick up a rebuilt shared module, restart those processes.

## 8. Apply database migrations

~~~bash
set -a
source .env.local
set +a

npm run db:status
npm run db:migrate
npm run db:status
~~~

The migration runner records applied SQL files in schema_migrations.

The initial schema enables pgcrypto and vector. The database user therefore needs extension permissions. The recommended pgvector/pgvector:pg17 image satisfies the local vector requirement.

## 9. Run the complete development stack

Use separate terminals.

### Terminal A: core watcher

~~~bash
npm run build -w @n8n-automation/core -- --watch
~~~

### Terminal B: API

~~~bash
set -a
source .env.local
set +a
npm run dev:api
~~~

API listens on port 4000 unless PORT is overridden.

### Terminal C: worker

~~~bash
set -a
source .env.local
set +a
npm run dev:worker
~~~

### Terminal D: Customer Panel

~~~bash
npm run dev:customer
~~~

Open http://localhost:3000.

### Terminal E: Super Admin Panel

~~~bash
npm run dev:admin
~~~

Open http://localhost:3001.

## 10. Verify health

Liveness:

~~~bash
curl http://localhost:4000/healthz
~~~

Expected:

~~~json
{"status":"ok","service":"api","version":"1.0.0"}
~~~

Database + Redis readiness:

~~~bash
curl http://localhost:4000/readyz
~~~

Expected:

~~~json
{"status":"ready"}
~~~

If healthz succeeds and readyz fails, check PostgreSQL and Redis first.

## 11. Create a normal tenant account

Open the Customer Panel and sign up with email, password, user name, and organization name.

If EMAIL_DELIVERY_WEBHOOK_URL is blank in development, the API logs the verification email text and verification URL to stdout instead of sending it. Use that URL/token for local verification.

## 12. Create a local Super Admin

After migrations:

~~~bash
set -a
source .env.local
set +a

export ADMIN_EMAIL=admin@example.com
export ADMIN_PASSWORD='StrongLocalPassword123'
export ADMIN_NAME='Local Super Admin'

npm run admin:create
~~~

The password must be at least 12 characters and contain letters and numbers.

The command creates or upgrades the account to SUPER_ADMIN. The admin model requires MFA enrollment.

To intentionally reset an existing local admin password:

~~~bash
export ADMIN_RESET_PASSWORD=true
npm run admin:create
~~~

Never use password reset/bootstrap casually against shared or production databases.

## 13. Optional n8n integration

Workflow source is under `automation/n8n`. Bundle `2.0.0` contains the seven final modular workflows. Read `docs/22_N8N_WORKFLOW_USAGE.md` before activating them.

Repository-only validation:

~~~bash
npm run validate:n8n
npm run n8n:plan
~~~

For an authorized/disposable n8n runtime:

~~~bash
export N8N_API_URL='https://your-n8n.example'
export N8N_API_KEY='...'
export SAAS_API_INTERNAL_URL='http://api-address-reachable-by-n8n:4000'
export INTERNAL_SERVICE_AUTH_SECRET='same-secret-used-by-api'

npm run n8n:deploy
~~~

On the n8n process itself also configure:

~~~text
SAAS_API_INTERNAL_URL=<API reachable from n8n>
INTERNAL_SERVICE_AUTH_SECRET=<same shared secret>
N8N_INTERNAL_WEBHOOK_BASE_URL=<private n8n webhook base>
N8N_WORKFLOW_BUNDLE_VERSION=2.0.0
~~~

Only activate after checking webhook/schedule conflicts:

~~~bash
npm run n8n:deploy:activate
~~~

When bundle `2.0.0` is active, application/worker settings point to the public n8n endpoints:

~~~text
N8N_TURN_WEBHOOK_URL=https://<n8n-host>/webhook/saas-turn
N8N_TRAINING_WEBHOOK_URL=https://<n8n-host>/webhook/saas-training
N8N_HEALTH_WEBHOOK_URL=https://<n8n-host>/webhook/saas-health
~~~

`saas-turn` and `saas-training` require the shared bearer secret. Raw Meta callbacks continue to use the SaaS API `/webhooks/meta` endpoint and must not be pointed at n8n.

Never commit n8n API keys, customer data, production credential IDs, or provider secrets into workflow JSON.

## 14. Optional Media Storage integration

To test media features:

~~~dotenv
MEDIA_BASE_URL=https://media-service.example
MEDIA_API_KEY=...
MEDIA_ADMIN_TOKEN=...
~~~

Credentials must remain server-side. Never expose them through NEXT_PUBLIC variables.

Without Media Storage configuration, the core application can run, but media operations that require the external service will not be fully functional.

## 15. Optional Meta integration

For Facebook, Instagram, or WhatsApp OAuth/webhook testing, configure the META variables in .env.local.

Real callback testing normally requires a public HTTPS endpoint. Tunnel local API port 4000 and make META_OAUTH_REDIRECT_URI exactly match the callback registered in the Meta application.

Never commit app secrets, access tokens, page tokens, WhatsApp tokens, or webhook secrets.

## 16. Optional email integration

EMAIL_DELIVERY_WEBHOOK_URL can point to an HTTP service that accepts:

~~~json
{
  "from": "no-reply@example.com",
  "to": "user@example.com",
  "subject": "Example",
  "text": "..."
}
~~~

When it is blank and NODE_ENV is not production, email content is logged to API stdout.

## 17. AI provider development

Tenant/provider API keys are configured through server-side application flows and stored encrypted. Do not place tenant AI keys in browser variables or source code.

Provider work must preserve BYOK/platform-owned separation, usage/cost capture, tenant limits, fallback behavior, and SSRF protection for configurable endpoints.

## 18. Common commands

~~~bash
npm run build:core
npm run build:api
npm run build:worker
npm run build:apps
npm run build

npm run typecheck
npm run test
npm run lint

npm run db:status
npm run db:migrate

npm run validate:n8n
npm run n8n:plan
~~~

CI-equivalent local validation with PostgreSQL/Redis running and env exported:

~~~bash
npm run db:migrate
npm run validate:n8n
npm run typecheck
npm run test
npm run build
~~~

GitHub Actions performs these same major stages with isolated pgvector/PostgreSQL and Redis services.

## 19. Inspect the local database

~~~bash
docker exec -it n8nauto-postgres psql -U app_user -d app_db
~~~

Useful SQL:

~~~sql
\dt
SELECT version, applied_at FROM schema_migrations ORDER BY version;
SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','vector');
SELECT id, email, status FROM users ORDER BY created_at DESC LIMIT 20;
SELECT id, name, slug, status FROM tenants ORDER BY created_at DESC LIMIT 20;
~~~

Manual row edits are not a normal application workflow and must not be used as a substitute for APIs/migrations in production.

## 20. Reset disposable local data

Warning: this deletes the local development database and Redis data.

~~~bash
docker rm -f n8nauto-postgres n8nauto-redis
docker volume rm n8nauto_pgdata n8nauto_redisdata
~~~

Recreate containers and rerun migrations afterward.

Never run these commands against shared or production services.

## 21. Troubleshooting

### Environment validation fails

Reload .env.local:

~~~bash
set -a
source .env.local
set +a
~~~

Check APP_ENCRYPTION_KEY length, INTERNAL_SERVICE_AUTH_SECRET length, and URL syntax.

### Shared core package cannot be resolved

~~~bash
npm run build:core
~~~

### PostgreSQL connection refused

~~~bash
docker ps
docker logs n8nauto-postgres
docker exec n8nauto-postgres pg_isready -U app_user -d app_db
~~~

### vector extension unavailable

Use PostgreSQL with pgvector installed. Recommended local image: pgvector/pgvector:pg17.

### Redis connection refused

~~~bash
docker ps
docker logs n8nauto-redis
docker exec n8nauto-redis redis-cli ping
~~~

### Admin panel port conflict

Use:

~~~bash
npm run dev:admin
~~~

The root script pins Super Admin to port 3001.

### CORS failure

Keep browser origins aligned exactly with:

~~~dotenv
CUSTOMER_APP_ORIGIN=http://localhost:3000
ADMIN_APP_ORIGIN=http://localhost:3001
~~~

Avoid mixing localhost and 127.0.0.1 between configured browser origins unless all related configuration is updated consistently.

### CSRF_INVALID on a browser mutation

Authenticate through the panel so the CSRF token is stored, or supply the current CSRF header when directly testing authenticated mutation endpoints.

### Verification email never arrives

With no email webhook in development, read the verification URL from API logs.

### Media operations fail

Configure MEDIA_BASE_URL and appropriate server-side credentials.

### Meta OAuth/webhook fails

Check public HTTPS reachability, exact callback URL, Graph API version, loaded app credentials, verify token, and signature configuration.

### n8n turn workflow stops at authorization

Ensure the worker and n8n runtime use the same `INTERNAL_SERVICE_AUTH_SECRET`. The worker sends `Authorization: Bearer <secret>` to `saas-turn`.

### Internal n8n workflow returns connection refused/404

Check `N8N_INTERNAL_WEBHOOK_BASE_URL`, private routing, and activation of workflows 02/03/04. It must point to the n8n webhook base, not the n8n management `/api/v1` endpoint.

### Queue jobs fail because of custom IDs

Use the shared core enqueue/BullMQ job-ID helper. Keep application idempotency keys stable and do not invent raw BullMQ custom IDs independently.

## 22. Local development invariants

During development:

- PostgreSQL remains the durable business store.
- n8n internal DB remains separate from app_db.
- Redis remains reconstructable.
- Google Sheets is not a source of truth.
- authorization is enforced server-side.
- dynamic customer data uses controlled schema metadata + JSONB.
- secrets remain encrypted/referenced server-side.
- async mutations are retry-safe and idempotent.
- workflow JSON remains sanitized and version controlled.
- docs change with implementation contracts.

See `../CONTRIBUTING.md` for contribution and review standards and `22_N8N_WORKFLOW_USAGE.md` for the complete final workflow operating guide.
