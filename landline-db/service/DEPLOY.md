# LandlineDB live service deploy (isolated, zero impact on the main app)

Serves the phone database at `https://recruitersos.co/client/data`, backed by an
isolated `landlinedb` Postgres database. Runs as its own container on the
`recruiteros_default` network; the main app is never rebuilt or touched.

## One-time

1. Database already created:
   `docker exec recruiteros-db-1 psql -U recruiteros -c "CREATE DATABASE landlinedb"`

2. Copy this folder to the box and the data export next to it:
   `scp -r service ros:/opt/landlinedb/`
   `scp records.json.gz ros:/opt/landlinedb/service/data/` (gunzip on the box)

3. Build + load + run:
   ```
   cd /opt/landlinedb/service
   docker build -t landlinedb-svc .
   # load data (one-off container on the db network)
   docker run --rm --network recruiteros_default -v "$PWD/data":/app/data \
     -e LANDLINEDB_URL="postgres://recruiteros:$PGPW@db:5432/landlinedb" \
     landlinedb-svc node loader.mjs /app/data/records.json
   # run the service
   docker run -d --name landlinedb-svc --restart unless-stopped \
     --network recruiteros_default \
     -e LANDLINEDB_URL="postgres://recruiteros:$PGPW@db:5432/landlinedb" \
     -e BASE_PATH=/client/data \
     landlinedb-svc
   ```
   (PGPW = the POSTGRES_PASSWORD from the db container env.)

4. Route the path in the Caddyfile inside the `recruitersos.co` site block,
   BEFORE the catch-all `handle { reverse_proxy app:3000 }`:
   ```
   handle /client/data* {
     reverse_proxy landlinedb-svc:8090
   }
   ```
   Then: `docker exec recruiteros-caddy-1 caddy reload --config /etc/caddy/Caddyfile`
   (graceful, no downtime).

## Grow the data later
Re-run the ingestion pull locally, gzip records.json, scp, and re-run the loader
container (idempotent: ON CONFLICT DO NOTHING). Stats cache refreshes within 60s.
