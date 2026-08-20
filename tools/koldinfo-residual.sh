#!/bin/sh
# RecruiterOS · KoldInfo residual finder tick — see /tools/koldinfo-residual.mjs.
# Runs inside the app image on the compose network so no secret leaves the box.
set -eu
exec docker run --rm --network recruiteros_default \
  -v /opt/recruiteros/tools:/tools:ro \
  -v /opt/recruiteros/mpc-out:/out \
  --env-file /opt/recruiteros/.env.production \
  --entrypoint node recruiteros-app /tools/koldinfo-residual.mjs
