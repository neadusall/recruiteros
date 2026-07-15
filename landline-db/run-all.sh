#!/bin/sh
# LandlineDB ingestion runner. Runs on the ros box inside a disposable node container:
#   cd /opt/recruiteros/landline-db
#   docker run --rm -v "$PWD":/w -w /w --network recruiteros_default \
#     -e LANDLINEDB_URL="postgres://recruiteros:$POSTGRES_PASSWORD@db:5432/landlinedb" \
#     node:22-alpine sh run-all.sh [quick|full]
# "quick" skips NPPES (the 10GB file). Default: quick.
set -e
MODE="${1:-quick}"

[ -d node_modules/pg ] || npm install --no-audit --no-fund
apk add --no-cache curl unzip >/dev/null 2>&1 || true

node ingest/setup.mjs

echo "== state + CMS facility sources (fast) =="
node ingest/socrata.mjs wa_lni
node ingest/socrata.mjs or_ccb
node ingest/socrata.mjs tx_hhsc_childcare
node ingest/cms.mjs facilities
node ingest/nces.mjs

echo "== big sources =="
node ingest/socrata.mjs tx_tdlr
node ingest/cms.mjs pos
node ingest/fmcsa.mjs
node ingest/cms.mjs dac

if [ "$MODE" = "full" ]; then
  echo "== NPPES (very large: ~1.1GB zip, ~10GB csv) =="
  ZIPURL=$(curl -sA "Mozilla/5.0 (LandlineDB; neadusall@gmail.com)" https://download.cms.gov/nppes/NPI_Files.html \
    | grep -oE 'NPPES_Data_Dissemination_[A-Za-z]+_[0-9]{4}_V2\.zip' | head -1)
  curl -sSL -A "Mozilla/5.0 (LandlineDB; neadusall@gmail.com)" -o /tmp/nppes.zip "https://download.cms.gov/nppes/$ZIPURL"
  unzip -o -d /tmp/nppes /tmp/nppes.zip 'npidata_pfile_*.csv' -x '*FileHeader*'
  node ingest/nppes.mjs "$(ls /tmp/nppes/npidata_pfile_*.csv | head -1)"
  rm -rf /tmp/nppes /tmp/nppes.zip
fi

echo "== done =="
