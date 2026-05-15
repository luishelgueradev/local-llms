#!/usr/bin/env bash
# bin/restore-drill.sh — DESTRUCTIVE: drops + recreates the `router` database
# from a pg_dump custom-format file produced by the Phase 5 pg-backup sidecar.
#
# WARNING — DATA LOSS:
#   This script DROPS the entire `router` database (request_log + usage_daily
#   + drizzle migration metadata) and recreates it from a `pg_dump --format=custom`
#   file. Any rows written AFTER the dump was taken WILL BE LOST. Do not run
#   this against a live production router without a fresh dump and an explicit
#   reason — the script refuses to proceed without --yes OR the interactive
#   `RESTORE` confirmation phrase.
#
# Usage:
#   bin/restore-drill.sh <dump-filename>             # interactive confirm
#   bin/restore-drill.sh --yes <dump-filename>       # non-interactive
#   bin/restore-drill.sh <dump-filename> --yes       # equivalent
#   bin/restore-drill.sh -h | --help                 # this help
#
#   <dump-filename> is a path RELATIVE to ${HOST_DATA_ROOT}/postgres-backups/
#   (the bind-mount the pg-backup sidecar writes to). Example:
#     bin/restore-drill.sh router-2026-05-14T12.dump
#
# Steps performed:
#   1. Validate the dump file exists on the host bind mount.
#   2. Terminate active sessions against the `router` database.
#   3. DROP DATABASE router (if exists) → CREATE DATABASE router OWNER app.
#   4. CREATE EXTENSION IF NOT EXISTS pgcrypto (Plan 05-01 / D-B8 — gen_random_uuid()).
#   5. pg_restore --dbname=router --username=app /backups/<dump>.
#   6. Sanity SELECT COUNT(*) FROM request_log; must return a numeric.
#
# Phase deferrals:
#   - request_log retention is unbounded in v1; Phase 9 may add partitioning
#     when actual volume warrants (CONTEXT §Specifics line 287).
#   - Off-host backup destination — Phase 9 OPS-02.
#
# References:
#   - .planning/phases/05-postgres-observability-seam/05-CONTEXT.md
#     §"Claude's Discretion — Restore drill script" lines 169–170.
#   - .planning/phases/05-postgres-observability-seam/05-RESEARCH.md
#     §"Code Examples — Restore drill script skeleton" lines 776–807.
#   - PATTERNS.md §G — Pattern G shell idiom: track failures via counter
#     (NOT `set -e`; mirrors preflight-gpu.sh:44–45 + smoke-test-router.sh:35).
#
# Exit codes:
#   0  Restore + sanity SELECT succeeded.
#   1  Pre-flight failure (missing args, dump file missing, postgres unhealthy)
#      OR confirmation refused OR a step failed mid-restore.

set -uo pipefail

# Locate repo root + worktree paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

# Failure tracking — Pattern G (PATTERNS.md §G)
FAILURES=0
fail() { echo "[restore-drill] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "[restore-drill] PASS: $*"; }

# ─── CLI ─────────────────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
Usage: bin/restore-drill.sh [--yes] <dump-filename>

  <dump-filename>     Filename under ${HOST_DATA_ROOT}/postgres-backups/.
                      Example: router-2026-05-14T12.dump
  --yes               Skip interactive confirmation (still DESTRUCTIVE).
  -h | --help         This help.

DESTRUCTIVE: drops + recreates the `router` database. Data written after the
dump was taken will be lost. See script header for full warning.

Phase 9 (OPS-02) will move backups off-host; Phase 9+ may add request_log
partitioning when volume warrants (currently unbounded — v1 deferral).
USAGE
}

YES=0
DUMP_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "[restore-drill] ERROR: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -z "${DUMP_FILE}" ]]; then
        DUMP_FILE="$1"
      else
        echo "[restore-drill] ERROR: unexpected positional argument: $1" >&2
        usage >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "${DUMP_FILE}" ]]; then
  echo "[restore-drill] ERROR: missing required <dump-filename> argument." >&2
  echo "" >&2
  usage >&2
  exit 1
fi

# ─── Env resolution: POSTGRES_PASSWORD + HOST_DATA_ROOT (Pattern G) ──────────
# Caller env wins; otherwise extract a single variable from .env without sourcing
# the entire file (avoids leaking other secrets into the script's environment).
# Mirrors smoke-test-router.sh:86–97.
if [[ -z "${POSTGRES_PASSWORD:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  POSTGRES_PASSWORD=$(
    grep -E '^POSTGRES_PASSWORD=' "${REPO_ROOT}/.env" \
      | tail -1 \
      | cut -d= -f2- \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
  )
  export POSTGRES_PASSWORD
fi

if [[ -z "${HOST_DATA_ROOT:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  HOST_DATA_ROOT=$(
    grep -E '^HOST_DATA_ROOT=' "${REPO_ROOT}/.env" \
      | tail -1 \
      | cut -d= -f2- \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
  )
fi
HOST_DATA_ROOT="${HOST_DATA_ROOT:-/srv/local-llms}"

if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
  echo "[restore-drill] ERROR: POSTGRES_PASSWORD is not set." >&2
  echo "[restore-drill]        Export it in the shell or set it in ${REPO_ROOT}/.env" >&2
  exit 1
fi

# ─── Sanity: dump file exists on the host bind mount ─────────────────────────
BACKUP_DIR="${HOST_DATA_ROOT}/postgres-backups"
DUMP_PATH="${BACKUP_DIR}/${DUMP_FILE}"

if [[ ! -d "${BACKUP_DIR}" ]]; then
  echo "[restore-drill] ERROR: backup directory does not exist: ${BACKUP_DIR}" >&2
  echo "[restore-drill]        If this is a first-run setup, create it:" >&2
  echo "[restore-drill]          mkdir -p \"${BACKUP_DIR}\"" >&2
  echo "[restore-drill]        Then bring up the pg-backup sidecar:" >&2
  echo "[restore-drill]          docker compose up -d pg-backup" >&2
  exit 1
fi

if [[ ! -f "${DUMP_PATH}" ]]; then
  echo "[restore-drill] ERROR: dump file not found: ${DUMP_PATH}" >&2
  echo "" >&2
  echo "Available dumps in ${BACKUP_DIR}:" >&2
  if ls -1 "${BACKUP_DIR}"/router-*.dump 2>/dev/null; then
    :
  else
    echo "  (none — run \`docker compose up -d pg-backup\` and wait for the first daily dump,"  >&2
    echo "   or create one manually:"  >&2
    echo "     docker compose exec -T pg-backup sh -c '"  >&2
    echo "       pg_dump -h postgres -U app -d router --format=custom -f /backups/router-test.dump'"  >&2
    echo "  )" >&2
  fi
  exit 1
fi

# ─── Confirmation gate (destructive operation safety) ────────────────────────
echo ""
echo "[restore-drill] ============================================================"
echo "[restore-drill]  DESTRUCTIVE OPERATION — DROP + RESTORE 'router' database"
echo "[restore-drill] ============================================================"
echo "[restore-drill]  Dump file : ${DUMP_PATH}"
echo "[restore-drill]  Dump size : $(stat -c '%s bytes' "${DUMP_PATH}" 2>/dev/null || stat -f '%z bytes' "${DUMP_PATH}" 2>/dev/null || echo 'unknown')"
echo "[restore-drill]  Backup dir: ${BACKUP_DIR}"
echo "[restore-drill] ============================================================"
echo ""

if [[ "${YES}" != "1" ]]; then
  echo "[restore-drill] WARNING: this will DROP and recreate the 'router' database."
  echo "[restore-drill]          All rows written AFTER the dump was taken will be lost."
  echo ""
  read -r -p "Type 'RESTORE' to proceed (anything else aborts): " CONFIRM
  if [[ "${CONFIRM}" != "RESTORE" ]]; then
    echo "[restore-drill] aborted — confirmation not provided."
    exit 1
  fi
fi

# ─── Pre-flight: postgres service running + healthy ──────────────────────────
cd "${REPO_ROOT}"

echo ""
echo "[restore-drill] Pre-flight: postgres service must be running..."
if ! docker compose ps --services --filter status=running 2>/dev/null | grep -q '^postgres$'; then
  fail "postgres service is not running. Run: docker compose up -d postgres"
  exit 1
fi
pass "postgres service is running"

# Wait up to 30s for postgres to be healthy enough for psql commands.
echo "[restore-drill] Pre-flight: waiting for postgres healthcheck..."
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U app -d postgres -h 127.0.0.1 >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! docker compose exec -T postgres pg_isready -U app -d postgres -h 127.0.0.1 >/dev/null 2>&1; then
  fail "postgres did not become ready within 30s. Check: docker compose logs postgres"
  exit 1
fi
pass "postgres is ready (pg_isready -U app -d postgres)"

# ─── Step 1: terminate active sessions on the router database ────────────────
# Plan 01 used POSTGRES_USER=app (Approach A) — the official postgres image
# entrypoint creates `app` as the SUPERUSER when POSTGRES_USER is set (per the
# postgres docker image docs). So `-U app -d postgres` has all permissions
# (DROP DATABASE / CREATE DATABASE / pg_terminate_backend).
#
# Connect as `-U app -d postgres` (not `-d router`) because DROP DATABASE
# requires being connected to a different db.
echo ""
echo "[restore-drill] Step 1: terminating active sessions on router database..."
if ! docker compose exec -T postgres psql -U app -d postgres -v ON_ERROR_STOP=1 -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = 'router' AND pid <> pg_backend_pid();
" >/dev/null 2>&1; then
  fail "could not terminate active sessions on router database"
  exit 1
fi
pass "active sessions terminated"

# ─── Step 2: DROP + CREATE the router database ───────────────────────────────
# WITH (FORCE) is mandatory (PG 13+): without it, the router's pg.Pool can
# reconnect in the millisecond gap between Step 1's pg_terminate and this DROP,
# leaving the router DB in an inaccessible state (`invalid` per pg_database) or
# even crashing a backend process. WITH (FORCE) terminates lingering connections
# atomically with the DROP — Step 1's pg_terminate is now belt-and-suspenders
# for the legible failure path; this is the load-bearing safety.
echo ""
echo "[restore-drill] Step 2: DROP DATABASE IF EXISTS router WITH (FORCE) ..."
if ! docker compose exec -T postgres psql -U app -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS router WITH (FORCE);" >/dev/null 2>&1; then
  fail "DROP DATABASE router failed"
  exit 1
fi
pass "DROP DATABASE router succeeded"

echo "[restore-drill] Step 3: CREATE DATABASE router OWNER app ..."
if ! docker compose exec -T postgres psql -U app -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE router OWNER app;" >/dev/null 2>&1; then
  fail "CREATE DATABASE router failed"
  exit 1
fi
pass "CREATE DATABASE router succeeded"

# ─── Step 3: CREATE EXTENSION pgcrypto ──────────────────────────────────────
# DROP DATABASE wipes extension state. pg_restore --format=custom DOES restore
# the extension itself if the dump was taken with default options, BUT we
# pre-create it as a belt-and-suspenders measure mirroring Plan 01's initdb
# (D-B8 — gen_random_uuid() depends on pgcrypto).
echo ""
echo "[restore-drill] Step 4: CREATE EXTENSION IF NOT EXISTS pgcrypto ..."
if ! docker compose exec -T postgres psql -U app -d router -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null 2>&1; then
  fail "CREATE EXTENSION pgcrypto failed"
  exit 1
fi
pass "pgcrypto extension present"

# ─── Step 4: pg_restore from the mounted dump ────────────────────────────────
# The pg-backup sidecar mounts ${HOST_DATA_ROOT}/postgres-backups → /backups,
# but the postgres SERVICE does NOT mount /backups (only pg-backup does). We
# need pg_restore to run inside a container that has BOTH the dump file mounted
# AND can reach the postgres server.
#
# Two options:
#  (a) `docker compose exec -T pg-backup pg_restore -h postgres ...`  ← pg-backup HAS /backups + can reach postgres
#  (b) `docker compose exec -T postgres pg_restore /tmp/router.dump` ← would need a docker cp first
#
# Option (a) is cleaner — pg-backup already has the right mounts + image
# (same postgres:17-alpine, so pg_restore version matches the server).
echo ""
echo "[restore-drill] Step 5: pg_restore --dbname=router --username=app /backups/${DUMP_FILE} ..."
echo "[restore-drill]         (running inside the pg-backup sidecar — has /backups mounted)"
if ! docker compose ps --services --filter status=running 2>/dev/null | grep -q '^pg-backup$'; then
  echo "[restore-drill] pg-backup service is not running — bringing it up for restore..."
  docker compose up -d pg-backup >/dev/null 2>&1 || true
  sleep 2
fi

# pg_restore returns non-zero for benign "object already exists" warnings on a
# fresh DB if the dump includes ownership/grant statements that conflict. The
# --clean + --if-exists flags are NOT used here because we just created the
# DB fresh — there's nothing to clean. Failures here are real errors.
if ! docker compose exec -T pg-backup pg_restore \
    --host=postgres \
    --username=app \
    --dbname=router \
    --no-owner \
    --no-privileges \
    "/backups/${DUMP_FILE}" 2>&1 | tee /tmp/restore-drill.log >/dev/null; then
  # pg_restore may emit warnings even on success — check the exit status of pg_restore
  # itself (which is what the if above evaluates). On a real failure, dump the log.
  echo "[restore-drill] pg_restore log (last 20 lines):" >&2
  tail -20 /tmp/restore-drill.log >&2 || true
  fail "pg_restore failed"
  exit 1
fi
pass "pg_restore completed"
rm -f /tmp/restore-drill.log

# ─── Step 5: sanity SELECT — request_log must be queryable ───────────────────
echo ""
echo "[restore-drill] Step 6: sanity SELECT COUNT(*) FROM request_log ..."
ROWS=$(docker compose exec -T postgres psql -U app -d router -tAc "SELECT COUNT(*) FROM request_log" 2>/dev/null | tr -d '[:space:]')
echo "[restore-drill]         request_log row count = ${ROWS}"

if [[ ! "${ROWS}" =~ ^[0-9]+$ ]]; then
  fail "sanity SELECT did not return a numeric row count: '${ROWS}'"
  exit 1
fi
pass "request_log row count = ${ROWS} (numeric — schema + data restored)"

# ─── Final ───────────────────────────────────────────────────────────────────
echo ""
echo "[restore-drill] ============================================================"
if [[ "${FAILURES}" -eq 0 ]]; then
  echo "[restore-drill]  PASS — restore drill completed without error."
  echo "[restore-drill]  router database restored from ${DUMP_FILE}"
  echo "[restore-drill]  request_log rows: ${ROWS}"
  echo "[restore-drill] ============================================================"
  echo ""
  exit 0
else
  echo "[restore-drill]  FAIL — ${FAILURES} step(s) did not pass."
  echo "[restore-drill]  See log lines above + docker compose logs postgres pg-backup."
  echo "[restore-drill] ============================================================"
  echo ""
  exit 1
fi
