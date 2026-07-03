# Email Sending — ACS platform cutover

`#setup/email` (the portal "Email Sending" panel) now **embeds the RecruitersOS
Mail platform** (Azure Communication Services) instead of the old self-hosted
Postal UI. The panel iframes `window.RECRUITEROS_MAIL_URL` (default
`https://mail.recruitersos.co`). Until that host is deployed, the panel shows a
"not reachable yet" note.

This file is the runbook to stand up that backend and make the panel live. It is
intentionally **not** applied to the live `docker-compose.yml` / `Caddyfile` yet —
a failed mail-service build there would block the whole-site deploy. Apply the
snippets below once you have ACS creds and can test the build on the box.

> Mail platform source: separate repo `neadusall/recruitersos-mail`
> (NestJS API + Next dashboard + Prisma + BullMQ). Local: `C:\Users\nead0\recruitersos-mail`.

---

## 0. Inputs required (feed these in)

| Var | Where from | Required |
|-----|-----------|----------|
| `ACS_CONNECTION_STRING` | Azure → Communication Service → Keys | **yes** |
| verified sending domain(s) | ACS Email → Provision domains | **yes** |
| sender addresses | you choose (e.g. `ryan@…`) | **yes** |
| `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET/SUBSCRIPTION_ID/RESOURCE_GROUP/EMAIL_SERVICE_NAME` | service principal (only for auto-provisioning domains) | optional |
| inbound provider + `INBOUND_MX_HOST` + `INBOUND_WEBHOOK_SECRET` | Mailgun/Postmark/SES (replies) | recommended |
| `EVENT_GRID_WEBHOOK_SECRET` | you choose; set on the Event Grid sub | recommended |
| tracking subdomain (CNAME) | DNS | optional |

Plus: **DNS A record** `mail.recruitersos.co` → the keeper box.

---

## 1. Add the mail platform as a submodule

```bash
git submodule add https://github.com/neadusall/recruitersos-mail.git recruitersos-mail
git submodule update --init --recursive
```

## 2. Reuse the existing Postgres, add Redis — `docker-compose.yml` services

Create the mail database in the existing `db` service once:

```bash
docker compose exec db psql -U <pguser> -c "CREATE DATABASE recruitersos_mail;"
```

Add these services (BullMQ needs Redis; the stack has none today):

```yaml
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes: [ redis_data:/data ]

  mail-api:
    build: ./recruitersos-mail/apps/api
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://<pguser>:<pgpass>@db:5432/recruitersos_mail?schema=public
      REDIS_HOST: redis
      REDIS_PORT: "6379"
      ACS_CONNECTION_STRING: ${ACS_CONNECTION_STRING}
      APP_BASE_URL: https://mailapi.recruitersos.co
      INBOUND_WEBHOOK_SECRET: ${INBOUND_WEBHOOK_SECRET}
      EVENT_GRID_WEBHOOK_SECRET: ${EVENT_GRID_WEBHOOK_SECRET}
      WORKER_MODE: inline
    depends_on: [ db, redis ]
    command: sh -c "npx prisma db push --skip-generate && node dist/main.js"
    expose: [ "4000" ]

  mail-web:
    build:
      context: ./recruitersos-mail/apps/web
      args:
        NEXT_PUBLIC_API_BASE_URL: https://mailapi.recruitersos.co
    restart: unless-stopped
    environment:
      NEXT_PUBLIC_API_BASE_URL: https://mailapi.recruitersos.co
    depends_on: [ mail-api ]
    expose: [ "3000" ]
```

Add to the bottom `volumes:` map: `redis_data:`

> The browser calls the mail API directly, so `NEXT_PUBLIC_API_BASE_URL` must be
> the **public** API host (`mailapi.recruitersos.co`), not the internal name.

## 3. Caddy — add two named blocks (`Caddyfile`)

```
mail.recruitersos.co {
	encode zstd gzip
	reverse_proxy mail-web:3000
}
mailapi.recruitersos.co {
	encode zstd gzip
	reverse_proxy mail-api:4000
}
```

(Both more specific than the catch-all, so they win. Certs issue automatically
once the A-records point at the box.)

## 4. Deploy + seed

```bash
./auto-deploy.sh          # or your normal deploy
# first boot runs `prisma db push`; then seed defaults:
docker compose exec mail-api node -e "require('child_process').execSync('npx prisma db seed',{stdio:'inherit'})" \
  || docker compose exec mail-api npx ts-node prisma/seed.ts
```

## 5. Verify

- `https://mailapi.recruitersos.co/api/setup/preflight` → tier `mvp` (or `automated`).
- `POST https://mailapi.recruitersos.co/api/setup/test-send` → live ACS test email.
- Open the portal → **#setup/email** → the embedded mail app loads (no "not reachable" note).
- Import a verified domain + sender via the embedded **Setup** wizard, then send.

## 6. Replies + Event Grid (after the above)

- Point sending-domain **MX** at the inbound provider; route its webhook to
  `https://mailapi.recruitersos.co/api/webhooks/inbound-email` (`?code=<INBOUND_WEBHOOK_SECRET>`).
- Azure → ACS → **Events** → web-hook subscription to
  `https://mailapi.recruitersos.co/api/webhooks/azure-email-events` (`?code=<EVENT_GRID_WEBHOOK_SECRET>`).

---

## Rollback

The old Postal panel is one revert away — `git revert` the commit that replaced
`renderSending` in `assets/js/command.js`. The Postal backend (`/api/sending` +
`lib/sending/*`) was left fully intact (analytics, Hire-Signals tracking, and the
Response pipeline still depend on it), so reverting the UI restores it instantly.
