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

## 2. Configure and verify VPS browser origins

The API CORS configuration must allow the deployed HTTPS panels. In the VSM `.env` use the public panel origins as the primary URLs. These URLs also appear in customer verification, invitation, and password-reset links. Keep localhost in the additional allowlists only if you use local panels against the VPS API:

```dotenv
AUTOMATION_CUSTOMER_APP_ORIGIN=https://app.openmusk.store
AUTOMATION_ADMIN_APP_ORIGIN=https://saas-admin.openmusk.store
AUTOMATION_CUSTOMER_APP_ALLOWED_ORIGINS=http://localhost:3000
AUTOMATION_ADMIN_APP_ALLOWED_ORIGINS=http://localhost:3001
```

After changing these values, recreate only the API service:

```bash
cd ~/srv
docker compose up -d --no-deps --force-recreate automation-api
```

From this repository, run the public auth smoke check after deployment:

```bash
npm run smoke:public-auth
```

It sends Origin-bearing preflight requests through both public panel proxies and one synthetic invalid customer sign-in. Success requires the sign-in route to return `401 INVALID_CREDENTIALS`, rather than a CORS `500`; no account is created and no email is sent. To check another environment, set `CUSTOMER_PANEL_URL` and `ADMIN_PANEL_URL` to its panel URLs before running the command. Password-reset delivery still requires a configured email provider; this smoke check does not verify inbox delivery.

## Production email delivery

Configure either `AUTOMATION_RESEND_API_KEY` or `AUTOMATION_EMAIL_DELIVERY_WEBHOOK_URL` in the VPS `~/srv/.env`, plus `AUTOMATION_EMAIL_FROM` with a sender authorized by the provider. Keep provider credentials in that private environment file and recreate `automation-api` after changing them. With neither provider configured, production signup, password-reset requests, verification resends, and team invitations return `503` before creating accounts or delivery tokens; sign-in remains available. A successful provider API response confirms acceptance by the provider, not delivery to an inbox. Verify inbox delivery with an authorized test recipient before declaring these flows operational.

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

The password must be at least 12 characters and contain letters and numbers. The command marks the user verified and grants `SUPER_ADMIN` access. The current Super Admin deployment uses password-only sign-in; no MFA enrollment or challenge is required.

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

## 11. Production panel configuration

When a panel is deployed behind HTTPS instead of localhost:

- keep `NEXT_PUBLIC_API_URL=/api`;
- set `API_PROXY_TARGET=https://api.openmusk.store`;
- remove `API_PROXY_INSECURE_COOKIES=true` (or set it to `false`);
- set the API's primary Customer/Admin origins to the actual HTTPS panel origins, as shown in section 2;
- recreate `automation-api` after changing those origins.

Never enable insecure-cookie rewriting for an internet-facing production panel.
