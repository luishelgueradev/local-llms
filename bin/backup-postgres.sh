#!/usr/bin/env bash
# bin/backup-postgres.sh — OPS-02: publish the newest pg-backup-sidecar dump to
# an off-host restic repository, then enforce retention via `restic forget --prune`.
#
# Purpose:
#   The Phase 5 pg-backup sidecar writes daily `router-YYYY-MM-DDTHH.dump` files
#   to ${HOST_DATA_ROOT}/postgres-backups/ with 7-day on-host retention. Those
#   dumps live on the SAME host as the database — a single disk failure loses
#   both. This script closes that gap by publishing the newest dump to an
#   operator-provided off-host restic repository (sftp / local-path / b2 / rest).
#
# Why restic and not rclone (CONTEXT §Specifics line 74):
#   - Restic encrypts at rest by default (AES-256 + Poly1305). BACKUP_RESTIC_PASSWORD
#     doubles as the encryption key. No separate `crypt` backend dance.
#   - Restic's `forget --keep-daily/weekly/monthly --prune` is a one-line retention
#     policy. Rclone retention requires custom scripting.
#   - Restic supports both LAN destinations (sftp, rest-server, local) AND cloud
#     storage (b2, s3, gcs, azure) with the same CLI — operator can change
#     destinations without changing this script.
#
# !! CRITICAL — LOSING `BACKUP_RESTIC_PASSWORD` MEANS LOSING THE BACKUPS !!
#   Restic encrypts every snapshot with a key derived from this password. There
#   is NO recovery path: lose the password and the off-host repo is irretrievable
#   noise. Store the password in a password manager OUTSIDE the host filesystem.
#   (T-09-I-03 mitigation — see threat model in 09-02-PLAN.md.)
#
# Host crontab integration recipe (run daily at HH:30 — ~30 min after the
# pg-backup sidecar's daily dump lands on disk):
#
#   MAILTO=ops@example.com
#   30 4 * * * cd /path/to/local-llms && bash bin/backup-postgres.sh >> /var/log/local-llms-backup.log 2>&1
#
#   The log file should be chmod 600 (owned by the operator) so the restic
#   output (which never contains the password — see Safety below) is not
#   world-readable in case other diagnostics leak around it.
#
# CLI surface:
#   bash bin/backup-postgres.sh           # one-shot publish (no flags)
#   bash bin/backup-postgres.sh -h        # help
#   bash bin/backup-postgres.sh --help    # help
#
# Exit codes:
#   0  Off-host backup published successfully (forget+prune may have WARNED but
#      the backup itself landed).
#   1  Pre-flight failure (restic missing, env missing, no dumps, etc.) OR the
#      restic backup invocation failed with a non-zero exit. Diagnostic on stderr.
#
# Safety (T-09-I-02 mitigations):
#   - `BACKUP_RESTIC_PASSWORD` is passed to restic via the `RESTIC_PASSWORD` env
#     var, NEVER via argv (no `ps` exposure).
#   - This script does NOT `set -x` and does NOT echo the password into any log.
#   - restic itself does not log the password value either.
#
# Read-only consumer guarantee:
#   This script NEVER touches the on-host ${HOST_DATA_ROOT}/postgres-backups/
#   directory beyond `ls -t | head -1` to pick the newest dump. The Phase 5
#   sidecar's `find -mtime +7 -delete` is the canonical on-host retention;
#   this script's `forget --prune` is the off-host retention.
#
# References:
#   - bin/restore-drill.sh:1-48 — canonical script-shape template (header,
#     env extraction, FAILURES counter, exit codes).
#   - .planning/phases/09-operations-hardening/09-CONTEXT.md §Specifics line 74.
#   - .planning/phases/09-operations-hardening/09-02-PLAN.md (this script's plan).
#
# Deferrals (NOT a Plan 09-02 deliverable):
#   - Multi-destination backup (NAS + S3 in parallel) — CONTEXT §Deferred line 83.
#   - Encrypted `.env` at rest — CONTEXT §Deferred line 85.
#   - Grafana freshness panel ("last successful off-host backup age") — operator
#     adds a `restic snapshots --json | jq` panel later if desired.

set -uo pipefail

# Locate repo root + worktree paths (mirror restore-drill.sh:52-53).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

# Failure tracking — Pattern G (PATTERNS.md §G). The backup itself is the
# load-bearing operation; `forget --prune` failures are surfaced via FAILURES
# but do NOT flip the final exit code unless the backup also failed.
FAILURES=0
fail() { echo "[backup-postgres] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
warn() { echo "[backup-postgres] WARN: $*" >&2; }
pass() { echo "[backup-postgres] PASS: $*"; }
info() { echo "[backup-postgres] $*"; }

# ─── CLI ─────────────────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
Usage: bin/backup-postgres.sh [-h | --help]

Publishes the NEWEST router-*.dump file under ${HOST_DATA_ROOT}/postgres-backups/
to the off-host restic repository configured via BACKUP_RESTIC_REPO +
BACKUP_RESTIC_PASSWORD in .env, then enforces retention via `restic forget --prune`.

Required env (read from .env or caller env — caller wins):
  BACKUP_RESTIC_REPO        Restic repo URI. Examples:
                              sftp:backup-host:/srv/restic-repos/local-llms
                              /mnt/external-hdd/restic-repos/local-llms
                              b2:my-bucket:/local-llms
                              rest:https://rest-server.lan/local-llms
  BACKUP_RESTIC_PASSWORD    Restic repo password (encryption key — LOSING THIS
                            MEANS LOSING THE BACKUPS).

Optional env:
  BACKUP_KEEP_POLICY        Override retention policy. Default (when empty):
                              --keep-daily 7 --keep-weekly 4 --keep-monthly 6
                            Example override:
                              BACKUP_KEEP_POLICY="--keep-daily 30 --keep-monthly 24"

Pre-step (operator runs ONCE, before the first run of this script):
  restic -r "$BACKUP_RESTIC_REPO" init

Recommended host crontab entry (run daily at HH:30):
  30 4 * * * cd /path/to/local-llms && bash bin/backup-postgres.sh \
            >> /var/log/local-llms-backup.log 2>&1

Exit codes:
  0  Backup published (retention may have WARNED but backup landed).
  1  Pre-flight failure OR restic backup failed.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[backup-postgres] ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# ─── Pre-flight: restic on PATH ──────────────────────────────────────────────
if ! command -v restic >/dev/null 2>&1; then
  fail "restic is not on PATH. Install on Debian/Ubuntu: sudo apt install restic"
  echo "[backup-postgres]        Or download a static binary from https://restic.net/" >&2
  exit 1
fi

# ─── Env extraction: caller env wins; .env fallback via grep|cut|sed ─────────
# Mirrors bin/restore-drill.sh:120-138 — extracts a SINGLE variable without
# `source .env` (avoids leaking unrelated secrets into the restic subprocess).
extract_env_var() {
  local key="$1"
  grep -E "^${key}=" "${REPO_ROOT}/.env" 2>/dev/null \
    | tail -1 \
    | cut -d= -f2- \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

if [[ -z "${BACKUP_RESTIC_REPO:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  BACKUP_RESTIC_REPO=$(extract_env_var BACKUP_RESTIC_REPO)
fi

if [[ -z "${BACKUP_RESTIC_PASSWORD:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  BACKUP_RESTIC_PASSWORD=$(extract_env_var BACKUP_RESTIC_PASSWORD)
fi

if [[ -z "${BACKUP_KEEP_POLICY:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  BACKUP_KEEP_POLICY=$(extract_env_var BACKUP_KEEP_POLICY)
fi

if [[ -z "${HOST_DATA_ROOT:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  HOST_DATA_ROOT=$(extract_env_var HOST_DATA_ROOT)
fi
HOST_DATA_ROOT="${HOST_DATA_ROOT:-/srv/local-llms}"

# ─── Pre-flight: required env vars present + sane ────────────────────────────
if [[ -z "${BACKUP_RESTIC_REPO:-}" ]]; then
  fail "off-host backup not configured — BACKUP_RESTIC_REPO is empty."
  echo "[backup-postgres]        Set it in ${REPO_ROOT}/.env (see .env.example for examples)." >&2
  echo "[backup-postgres]        Then initialize the repo ONCE:" >&2
  echo "[backup-postgres]          restic -r \"\$BACKUP_RESTIC_REPO\" init" >&2
  exit 1
fi

if [[ -z "${BACKUP_RESTIC_PASSWORD:-}" ]]; then
  fail "off-host backup not configured — BACKUP_RESTIC_PASSWORD is empty."
  echo "[backup-postgres]        Set it in ${REPO_ROOT}/.env (see .env.example)." >&2
  echo "[backup-postgres]        Generate one with: openssl rand -hex 32" >&2
  echo "[backup-postgres]        LOSING THIS PASSWORD MEANS LOSING THE BACKUPS." >&2
  exit 1
fi

# Cheap sanity gate: restic accepts any non-empty password, but a 1-char password
# is almost certainly an operator typo. 16 chars is the lowest reasonable bar;
# the README + .env.example recommend `openssl rand -hex 32` (64 chars).
if [[ ${#BACKUP_RESTIC_PASSWORD} -lt 16 ]]; then
  fail "BACKUP_RESTIC_PASSWORD is shorter than 16 characters — almost certainly a typo or placeholder."
  echo "[backup-postgres]        Generate a strong one with: openssl rand -hex 32" >&2
  exit 1
fi

# ─── Pre-flight: backup directory + at least one dump file ───────────────────
BACKUP_DIR="${HOST_DATA_ROOT}/postgres-backups"

if [[ ! -d "${BACKUP_DIR}" ]]; then
  fail "backup directory does not exist: ${BACKUP_DIR}"
  echo "[backup-postgres]        Bring the pg-backup sidecar up first:" >&2
  echo "[backup-postgres]          docker compose up -d pg-backup" >&2
  echo "[backup-postgres]        Then wait for the first daily dump, or trigger one ad-hoc:" >&2
  echo "[backup-postgres]          docker compose exec -T pg-backup sh -c '" >&2
  echo "[backup-postgres]            pg_dump -h postgres -U app -d router --format=custom -f /backups/router-test.dump'" >&2
  exit 1
fi

# Pick newest dump (ls -t = newest first; head -1).
LATEST=$(ls -t "${BACKUP_DIR}"/router-*.dump 2>/dev/null | head -1)

if [[ -z "${LATEST}" ]] || [[ ! -f "${LATEST}" ]]; then
  fail "no router-*.dump files found under ${BACKUP_DIR}/"
  echo "[backup-postgres]        Run \`docker compose up -d pg-backup\` and wait 24h for the first daily dump," >&2
  echo "[backup-postgres]        OR trigger an ad-hoc dump:" >&2
  echo "[backup-postgres]          docker compose exec -T pg-backup sh -c '" >&2
  echo "[backup-postgres]            pg_dump -h postgres -U app -d router --format=custom -f /backups/router-test.dump'" >&2
  exit 1
fi

DUMP_SIZE=$(stat -c '%s' "${LATEST}" 2>/dev/null || stat -f '%z' "${LATEST}" 2>/dev/null || echo 'unknown')
HOSTNAME_SHORT=$(hostname -s 2>/dev/null || hostname || echo 'unknown')

# ─── Banner ──────────────────────────────────────────────────────────────────
echo ""
echo "[backup-postgres] ============================================================"
echo "[backup-postgres]  OFF-HOST PUBLISH — restic backup + forget --prune"
echo "[backup-postgres] ============================================================"
echo "[backup-postgres]  Dump file : ${LATEST}"
echo "[backup-postgres]  Dump size : ${DUMP_SIZE} bytes"
echo "[backup-postgres]  Hostname  : ${HOSTNAME_SHORT}"
echo "[backup-postgres]  Restic URI: ${BACKUP_RESTIC_REPO}"
echo "[backup-postgres] ============================================================"
echo ""

# ─── Step 1: restic backup ───────────────────────────────────────────────────
# Password flows via env (RESTIC_PASSWORD) — NEVER via argv. Capture stdout +
# stderr to a temp file so we can extract the snapshot id on success and dump
# the last lines on failure. restic itself never logs the password.
BACKUP_LOG=$(mktemp -t backup-postgres-backup.XXXXXX)
# Ensure log cleanup even on early exit (the password is NOT in the log, but
# the log filename otherwise leaks across tmp invocations).
trap 'rm -f "${BACKUP_LOG:-}" "${FORGET_LOG:-}" 2>/dev/null || true' EXIT

info "Step 1: restic backup..."
if ! RESTIC_PASSWORD="${BACKUP_RESTIC_PASSWORD}" restic \
    -r "${BACKUP_RESTIC_REPO}" \
    backup \
    --tag local-llms \
    --tag postgres \
    --tag "${HOSTNAME_SHORT}" \
    --host "${HOSTNAME_SHORT}" \
    "${LATEST}" > "${BACKUP_LOG}" 2>&1; then
  echo "[backup-postgres] restic backup log (last 20 lines):" >&2
  tail -20 "${BACKUP_LOG}" >&2 || true
  fail "restic backup failed (see log lines above)"
  exit 1
fi

# Parse snapshot id from restic's stdout. Example line:
#   "snapshot abcd1234 saved"
SNAPSHOT_ID=$(grep -oE 'snapshot [a-f0-9]+ saved' "${BACKUP_LOG}" | awk '{print $2}' | head -1)
if [[ -z "${SNAPSHOT_ID}" ]]; then
  # The backup succeeded but the message format may have changed across restic
  # versions. Surface as WARN, do not fail.
  warn "restic backup succeeded but snapshot id was not parseable from output"
  SNAPSHOT_ID="<unparseable>"
fi
pass "restic backup OK — snapshot id: ${SNAPSHOT_ID}"

# ─── Step 2: retention policy (forget --prune) ───────────────────────────────
# BACKUP_KEEP_POLICY override is intentional verbatim splat — operator
# explicitly opted in to that policy string. Default policy is baked into the
# script so a typo in .env doesn't silently no-op retention.
#
# WR-05: validate the override shape BEFORE splatting it into restic's argv.
# The accepted grammar is a whitespace-separated sequence of
#   --keep-(last|hourly|daily|weekly|monthly|yearly) <positive-integer>
# pairs. Anything else (e.g. `--keep-tag x; rm -rf /`, typos like
# `--keep-daily seven`, or unrelated flags) is rejected before reaching
# restic. This does not constrain operators to a fixed set of values, but
# it does eliminate the worst footguns (unknown flags being interpreted
# as paths, typo'd numbers silently weakening retention, etc.).
if [[ -n "${BACKUP_KEEP_POLICY:-}" ]]; then
  # Validate as pairs. Use `read -ra` so that consecutive whitespace is
  # collapsed and quoted segments are split correctly under default IFS.
  # shellcheck disable=SC2206  # intentional word-splitting of validated input
  POLICY_TOKENS=( ${BACKUP_KEEP_POLICY} )
  POLICY_COUNT=${#POLICY_TOKENS[@]}
  if (( POLICY_COUNT == 0 )) || (( POLICY_COUNT % 2 != 0 )); then
    fail "BACKUP_KEEP_POLICY must be an even number of whitespace-separated tokens (got ${POLICY_COUNT}: '${BACKUP_KEEP_POLICY}')."
    echo "[backup-postgres]        Expected shape: --keep-<class> <N> [--keep-<class> <N> ...]" >&2
    echo "[backup-postgres]        Valid classes : last hourly daily weekly monthly yearly" >&2
    exit 1
  fi
  for (( pi = 0; pi < POLICY_COUNT; pi += 2 )); do
    flag="${POLICY_TOKENS[$pi]}"
    val="${POLICY_TOKENS[$((pi + 1))]}"
    if ! [[ "${flag}" =~ ^--keep-(last|hourly|daily|weekly|monthly|yearly)$ ]]; then
      fail "BACKUP_KEEP_POLICY contains invalid flag '${flag}' — must be --keep-{last,hourly,daily,weekly,monthly,yearly}."
      exit 1
    fi
    if ! [[ "${val}" =~ ^[1-9][0-9]*$ ]]; then
      fail "BACKUP_KEEP_POLICY: flag '${flag}' must be followed by a positive integer (got '${val}')."
      exit 1
    fi
  done
  info "Step 2: restic forget (operator-overridden policy: ${BACKUP_KEEP_POLICY}) --prune ..."
  # shellcheck disable=SC2086  # intentional word-splitting of validated policy
  FORGET_ARGS=( ${BACKUP_KEEP_POLICY} --prune )
else
  info "Step 2: restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune ..."
  FORGET_ARGS=( --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune )
fi

FORGET_LOG=$(mktemp -t backup-postgres-forget.XXXXXX)
if ! RESTIC_PASSWORD="${BACKUP_RESTIC_PASSWORD}" restic \
    -r "${BACKUP_RESTIC_REPO}" \
    forget \
    --tag local-llms \
    --tag postgres \
    --host "${HOSTNAME_SHORT}" \
    "${FORGET_ARGS[@]}" > "${FORGET_LOG}" 2>&1; then
  echo "[backup-postgres] restic forget log (last 20 lines):" >&2
  tail -20 "${FORGET_LOG}" >&2 || true
  warn "restic forget --prune failed — backup itself succeeded, but retention not enforced this run."
  warn "Investigate (e.g. lock contention with a parallel backup). Retention will catch up on the next run."
  fail "forget --prune non-zero"
else
  pass "restic forget --prune OK"
fi

# ─── Final summary ───────────────────────────────────────────────────────────
echo ""
echo "[backup-postgres] ============================================================"
if [[ "${FAILURES}" -eq 0 ]]; then
  echo "[backup-postgres]  PASS — off-host backup published + retention enforced."
  echo "[backup-postgres]  Dump file   : ${LATEST}"
  echo "[backup-postgres]  Dump size   : ${DUMP_SIZE} bytes"
  echo "[backup-postgres]  Snapshot id : ${SNAPSHOT_ID}"
  echo "[backup-postgres]  Retention   : ${BACKUP_KEEP_POLICY:-default (7d / 4w / 6m)}"
  echo "[backup-postgres] ============================================================"
  echo ""
  exit 0
else
  echo "[backup-postgres]  PARTIAL — backup landed but ${FAILURES} retention step(s) failed."
  echo "[backup-postgres]  Snapshot id : ${SNAPSHOT_ID}"
  echo "[backup-postgres]  Inspect with: restic -r \"\$BACKUP_RESTIC_REPO\" snapshots --tag postgres"
  echo "[backup-postgres] ============================================================"
  echo ""
  # Retention failure is a WARN-not-FAIL — backup itself succeeded.
  # Exit 0 so crontab does not spam on a transient prune hiccup.
  exit 0
fi
