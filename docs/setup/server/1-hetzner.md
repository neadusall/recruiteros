# RecruiterOS, Hetzner + GoDaddy go-live runbook

This hosts everything (marketing site, portal, and the live API) on your own
Hetzner server at https://recruitersos.co with automatic HTTPS.

Architecture: Docker Compose runs two containers, the Next.js app (`app`,
port 3000, internal) and **Caddy** which terminates TLS and reverse-proxies to
it. Caddy gets and renews the Let's Encrypt certificate automatically once DNS
points at the server.

---

## 0. What you need
- A Hetzner Cloud server (Ubuntu 22.04/24.04, the CX22 / 2 vCPU 4 GB tier is
  plenty). Note its public IPv4, e.g. `5.75.x.x`.
- SSH access to it.
- Your GoDaddy account for recruitersos.co.

---

## 1. Point GoDaddy DNS at the server
In GoDaddy, open **My Products → recruitersos.co → DNS → Manage Zones**, and set:

| Type  | Name | Value                | TTL  |
|-------|------|----------------------|------|
| A     | @    | YOUR_SERVER_IPv4     | 600  |
| A     | www  | YOUR_SERVER_IPv4     | 600  |

(If GoDaddy already has parking A records on `@`/`www`, edit them to your IP and
delete the GoDaddy "Domain Forwarding".) DNS usually propagates in 5-30 min.
Check with: `nslookup recruitersos.co`

Optional AAAA records if you use the server's IPv6.

---

## 2. Prep the server (run once, over SSH)
```bash
ssh root@YOUR_SERVER_IPv4

# Docker + compose plugin
curl -fsSL https://get.docker.com | sh
apt-get install -y git

# Firewall: allow SSH + web
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

---

## 3. Get the code on the server
```bash
git clone https://github.com/neadusall/recruiteros.git
cd recruiteros
cp .env.production.example .env.production
nano .env.production
```
In `.env.production` set:
- `RECRUITEROS_SESSION_SECRET` to a long random string: `openssl rand -hex 32`
- `POSTGRES_PASSWORD` to a strong password, e.g. `openssl rand -hex 16`
- `DATABASE_URL` to use that SAME password:
  `postgres://recruiteros:YOUR_PASSWORD@db:5432/recruiteros`
- your `ANTHROPIC_API_KEY` and any channel keys you have

The Postgres `db` service (in docker-compose) gives you durable accounts that
survive restarts. Without `DATABASE_URL` the app still runs but in-memory only.

---

## 4. Launch
```bash
docker compose up -d --build
docker compose logs -f caddy   # watch it obtain the TLS cert (ctrl-c to exit)
```
First boot builds the image (a few minutes). Once DNS resolves to the server,
Caddy issues the certificate automatically.

Visit **https://recruitersos.co** , create an account with a work email, and you
land in a real Command Center backed by the live API. Corporate emails get an
enterprise workspace.

---

## 5. Updating later
```bash
cd recruiteros && git pull && docker compose up -d --build
```

---

## 6. Useful ops
```bash
docker compose ps              # status
docker compose logs -f app     # app logs
docker compose restart app     # restart just the app
docker compose down            # stop everything
```

---

## Notes
- **Data persistence:** durable Postgres is wired in. The `db` service stores a
  snapshot of accounts, workspaces and sessions, so signups survive restarts and
  redeploys (`docker compose up -d --build` keeps the `pg_data` volume).
- **Email sending** (magic links, verification) logs to the container by default
  until you set an SMTP/Resend key. Until then, use email + password sign-in.
- **Secrets** live only in `.env.production` on the server, which is gitignored
  and never pushed.
