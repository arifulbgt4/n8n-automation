# Local Customer and Super Admin Panels with the VPS API

Use the local Next.js panels through a same-origin `/api` proxy while the SaaS API runs on the VPS at `https://api.openmusk.store`.

## Runtime topology

```text
Browser
  -> Customer Panel http://localhost:3000/api/*
  -> Super Admin  http://localhost:3001/api/*
       -> Next.js server-side API proxy
            -> https://api.openmusk.store/*
                 -> automation-api:4000 on the VPS
                 -> PostgreSQL app_db + Redis
                 -> automation-worker / n8n integration
```

The browser should not call the production API directly during localhost development. Production API sessions use secure cookies. The local proxy keeps browser requests same-origin and, only when explicitly enabled for local development, removes the `Secure` attribute from proxied cookies so they can be stored on HTTP localhost.

## 1. Verify the VPS API

On any machine:

```bash
curl -fsS https://api.openmusk.store/healthz
curl -fsS https://api.openmusk.store/readyz
```

Expected readiness response:

```json
{"status":"ready"}
```

## 2. Verify VPS browser origins

The API CORS configuration must allow the local panels. In the VSM `.env` keep:

```dotenv
AUTOMATION_CUSTOMER_APP_ORIGIN=http://localhost:3000
AUTOMATION_ADMIN_APP_ORIGIN=http://localhost:3001
```

If either value changes on the VPS, recreate the API service after editing `~/srv/.env`:

```bash
cd ~/srv
docker compose up -d --force-recreate automation-api
```

## 3. Configure the Customer Panel on the development machine

Create `customer-panel/.env.local`:

```dotenv
NEXT_PUBLIC_API_URL=/api
API_PROXY_TARGET=https://api.openmusk.store
API_PROXY_INSECURE_COOKIES=true
```

`API_PROXY_TARGET` and `API_PROXY_INSECURE_COOKIES` are server-side Next.js variables. Do not rename them to `NEXT_PUBLIC_*`.

## 4. Configure the Super Admin Panel

Create `super-admin-panel/.env.local`:

```dotenv
NEXT_PUBLIC_API_URL=/api
API_PROXY_TARGET=https://api.openmusk.store
API_PROXY_INSECURE_COOKIES=true
```

## 5. Run only the panels locally

From the repository root:

```bash
npm install --include=dev
npm run dev:customer
```

In another terminal:

```bash
npm run dev:admin
```

Open:

```text
Customer Panel: http://localhost:3000
Super Admin:    http://localhost:3001
```

No local API, PostgreSQL, Redis, worker, or n8n process is required for this mode because those services are running on the VPS.

## 6. Verify the panel proxies

With both panels running:

```bash
curl -fsS http://localhost:3000/api/healthz
curl -fsS http://localhost:3000/api/readyz
curl -fsS http://localhost:3001/api/healthz
curl -fsS http://localhost:3001/api/readyz
```

These requests should return the health state of `https://api.openmusk.store` through the local Next.js proxy.

## 7. Customer account flow

Use `http://localhost:3000` to sign up or sign in. Customer data is written to the VPS `app_db`; the panel itself does not own business data.

## 8. Create the SaaS Super Admin

The VSM Platform Admin account is not the SaaS Super Admin account. Create the SaaS Super Admin against `app_db` on the VPS:

```bash
cd ~/srv

docker compose run --rm --no-deps \
  -e ADMIN_EMAIL='admin@example.com' \
  -e ADMIN_PASSWORD='StrongPassword123' \
  -e ADMIN_NAME='Super Admin' \
  automation-api npm run admin:create
```

The password must be at least 12 characters and contain letters and numbers. The command marks the user verified and grants `SUPER_ADMIN` access. Super Admin authentication is intentionally email + password only; MFA is disabled.

To intentionally reset the password for an existing SaaS Super Admin:

```bash
cd ~/srv

docker compose run --rm --no-deps \
  -e ADMIN_EMAIL='admin@example.com' \
  -e ADMIN_PASSWORD='NewStrongPassword123' \
  -e ADMIN_NAME='Super Admin' \
  -e ADMIN_RESET_PASSWORD=true \
  automation-api npm run admin:create
```

Then sign in at `http://localhost:3001` with the configured email and password.

## 9. n8n routing

The panels use the public HTTPS API endpoint through their proxy. n8n and the n8n execution worker should continue using the private Docker-network endpoint:

```text
SAAS_API_INTERNAL_URL=http://automation-api:4000
```

Do not change n8n to call `https://api.openmusk.store` unless there is a specific cross-host requirement. Same-VPS internal traffic should stay on the Docker network.

## 10. Cookie note when testing both panels

Cookies are scoped to host, not TCP port. `localhost:3000` and `localhost:3001` therefore share the same host cookie namespace. If you need a customer user and a different Super Admin logged in at the same time, use separate browser profiles/incognito contexts.

## 11. Production panel deployment later

When a panel is deployed behind HTTPS instead of localhost:

- keep `NEXT_PUBLIC_API_URL=/api`;
- set `API_PROXY_TARGET=https://api.openmusk.store`;
- remove `API_PROXY_INSECURE_COOKIES=true` (or set it to `false`);
- change the API's allowed Customer/Admin origins to the actual HTTPS panel origins;
- recreate `automation-api` after changing those origins.

Never enable insecure-cookie rewriting for an internet-facing production panel.
