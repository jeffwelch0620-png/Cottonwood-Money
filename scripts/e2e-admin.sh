#!/usr/bin/env bash
# Fresh database → migrate + seed demo tenant → API + built console → Playwright flows → clean up.
# Needs: Postgres (PG_BASE_URL superuser) and Playwright with Chromium.
# Note: Next.js bakes the /v1 rewrite destination (API_URL) into the build, so the console is built here.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_URL=${PG_BASE_URL:-postgres://postgres:postgres@localhost:5432}
DB=ledger_e2e
OUT=$(mktemp -d)
export SUPABASE_JWT_SECRET=e2e-jwt-secret-at-least-32-bytes-long-xx
psql "$BASE_URL/postgres" -qc "drop database if exists $DB with (force)" -c "create database $DB"
DATABASE_URL="$BASE_URL/$DB" SEED_OUT="$OUT/tokens.json" npx tsx scripts/dev-seed.ts
(cd apps/admin && API_URL=http://localhost:3901 npx next build > "$OUT/build.log" 2>&1)
# Each server is started with setsid, so its PID is also its process-group ID; cleanup kills
# exactly those two groups (tsx/next children included) and nothing else.
DATABASE_URL="$BASE_URL/$DB" PORT=3901 setsid npx tsx apps/api/main.ts > "$OUT/api.log" 2>&1 & API=$!
API_URL=http://localhost:3901 setsid bash -c 'cd apps/admin && exec npx next start -p 3902' > "$OUT/admin.log" 2>&1 & ADMIN=$!
trap 'kill -- -"$API" -"$ADMIN" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf -o /dev/null localhost:3902/login && curl -sf -o /dev/null localhost:3901/health && break; sleep 1; done
E2E_TOKENS="$OUT/tokens.json" E2E_OUT="$OUT" E2E_BASE=http://localhost:3902 node apps/admin/e2e/flows.cjs
echo "screenshots and logs: $OUT"
