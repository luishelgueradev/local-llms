#!/usr/bin/env bash
# bin/disk-alert.sh — single-shot disk-usage threshold check (OPS-03)
#
# Purpose:
#   Compute current disk usage for ${HOST_DATA_ROOT} via `df -P` and compare
#   against ${DISK_ALERT_THRESHOLD_PCT} (default 80). On every invocation, emit
#   exactly ONE structured single-line log statement to stdout:
#
#     [disk-alert] LEVEL=INFO target=<path> used_pct=<n> threshold_pct=<n> \
#                  fs=<device> ts=<ISO8601> hostname=<host>
#     [disk-alert] LEVEL=WARN target=<path> used_pct=<n> threshold_pct=<n> \
#                  fs=<device> ts=<ISO8601> hostname=<host>
#
#   The structured key=value shape is grep-friendly + journalctl-friendly +
#   a natural Loki/Promtail label source for a future log-pipeline phase.
#
#   On WARN, if ${NTFY_URL} is non-empty, POST a one-line alert message:
#     "Disk usage <PCT>% on <HOSTNAME> (<HOST_DATA_ROOT>); threshold <THRESH>%"
#   via `curl --fail -sS --max-time 10`. The curl is BEST-EFFORT — failure
#   does NOT fail the script (the structured log is the canonical alert sink).
#   When curl fails, a SECONDARY log line is emitted with `curl_exit=<n>` +
#   `url_host=<host-only>` (NEVER the full NTFY_URL — T-09-I-05).
#
# Crontab integration (host-side; NOT a Compose service):
#   # /etc/crontab or `crontab -e` — every 15 minutes is the recommended cadence
#   */15 * * * * cd /path/to/local-llms && bash bin/disk-alert.sh \
#       >> /var/log/local-llms-disk.log 2>&1
#
#   MAILTO-only-on-breach variant (cron mails ONLY when grep matches):
#     MAILTO=admin@host
#     */15 * * * * cd /path/to/local-llms && bash bin/disk-alert.sh \
#         | grep -E '^\[disk-alert\] LEVEL=WARN'
#
# CLI:
#   bin/disk-alert.sh                 # default — read DISK_ALERT_THRESHOLD_PCT from .env
#   bin/disk-alert.sh --threshold N   # one-shot override (1..99) — does NOT mutate .env
#   bin/disk-alert.sh -h | --help     # this help
#
# Exit codes:
#   0  Always — regardless of INFO vs WARN; regardless of curl-hook outcome.
#   1  Script-level error only:
#        - HOST_DATA_ROOT missing or not an existing directory
#        - DISK_ALERT_THRESHOLD_PCT not an integer 1..99
#        - `df` or `awk` unavailable in PATH
#        - df returned unparseable output (e.g. "-" for pseudo-filesystems)
#
# What this script INTENTIONALLY does NOT do (v2 territory):
#   - Alertmanager / Grafana-alert integration (REQUIREMENTS.md ALERT-01; v2)
#     — CONTEXT §Deferred line 84. Stdout log + optional HTTP hook is the
#     simpler path that meets SC3 ("fires visibly") per CONTEXT
#     D-claude-discretion line 32.
#   - Auto-remediation (calling the GC script or rm -rf anything). The
#     script ALERTS; the operator REMEDIATES. The OPS-01 GC tool requires a `GC`
#     confirmation phrase by design — auto-running it would violate that
#     destructive-op contract. See README §Operations §Disk-usage alert
#     for the remediation pointer list.
#   - Inode-usage check (rare failure mode on a model-storage volume).
#   - Per-subdirectory breakdown (operator runs `du -sh ${HOST_DATA_ROOT}/*`
#     manually if needed).
#   - Trend / rate-of-fill alerts (need time-series — punt to Prometheus +
#     Grafana panel in a future phase).
#   - Hysteresis / cooldown to avoid alert spam (the 15-min cron cadence is
#     the de-facto cooldown — at most 4 alerts/hour).
#   - Falling back to `/` when HOST_DATA_ROOT is missing — better to fail
#     loudly than to monitor the wrong mount (T-09-D).
#
# Safety properties:
#   - Never `set -x` (would leak NTFY_URL on trace output — T-09-I-05).
#   - Full NTFY_URL value never echoed; only the URL host (sed-extracted) appears
#     in the secondary curl-failure log line.
#   - `curl --fail --max-time 10` bounds the network wait + treats 4xx/5xx as
#     failures so they trigger the secondary log line (T-09-D-04 mitigation).
#   - Read-only operation — no filesystem writes other than stdout.
#
# Structured-log-line spec (contract for future log consumers):
#   Key=value, space-separated, single line per invocation. Keys (in order):
#     LEVEL          INFO | WARN
#     target         The directory path checked (HOST_DATA_ROOT).
#     used_pct       Integer 0..100.
#     threshold_pct  Integer 1..99 (current threshold in effect).
#     fs             The filesystem / device backing target (df col 1).
#     ts             ISO8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ).
#     hostname       Short hostname (`hostname -s`).
#
# References:
#   - .planning/REQUIREMENTS.md → OPS-03.
#   - .planning/phases/09-operations-hardening/09-CONTEXT.md §Specifics line 39
#     (DISK_ALERT_THRESHOLD_PCT=80 default + optional NTFY_URL).
#   - bin/restore-drill.sh — shell-idiom + env-extraction reference.
#   - bin/preflight-gpu.sh — FAILURES counter pattern + sectioned output.

set -uo pipefail

# Locate repo root for .env extraction.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

# ─── CLI ─────────────────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
Usage: bin/disk-alert.sh [--threshold N] [-h | --help]

  --threshold N       Override DISK_ALERT_THRESHOLD_PCT for this run (1..99).
                      Does NOT mutate .env.
  -h | --help         This help.

Behavior:
  Reads HOST_DATA_ROOT + DISK_ALERT_THRESHOLD_PCT (default 80) + optional
  NTFY_URL from the caller environment, falling back to .env.
  Emits a single structured log line on stdout:
    [disk-alert] LEVEL={INFO|WARN} target=... used_pct=... threshold_pct=...
                 fs=... ts=... hostname=...
  On WARN AND when NTFY_URL is non-empty, POSTs a one-liner via curl.

Recommended cadence: every 15 minutes from host crontab. See script header
for the full crontab recipe (plain-log + MAILTO-only-on-breach variants).
USAGE
}

THRESHOLD_OVERRIDE=""

# ─── Internal: URL → host-only extractor (CR-01 fix) ─────────────────────────
# Pure function — given an NTFY_URL string, prints the host-only portion to
# stdout. Two adversarial cases the original sed pattern leaked:
#   1) URL without a scheme prefix → sed returned the input unchanged →
#      the whole "host/topic" landed in the log line (topic == credential).
#   2) URL with userinfo (user:pass@host) → the host capture included the
#      userinfo segment → basic-auth credentials in the log line.
# This function returns "<no-scheme-configured>" for case (1) and strips
# userinfo for case (2). Exercised by `--self-test-url-host`.
extract_url_host() {
  local url="$1"
  if [[ "${url}" =~ ^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+ ]]; then
    printf '%s' "${url}" \
      | sed -E 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' \
      | sed -E 's|^[^/@]*@||' \
      | sed -E 's|/.*$||'
  else
    printf '<no-scheme-configured>'
  fi
}

# ─── Internal: regression-locking self-test for extract_url_host ─────────────
# `bin/disk-alert.sh --self-test-url-host` runs a handful of canned
# inputs through extract_url_host and asserts each maps to the expected
# host-only string. Exit 0 on PASS, exit 1 (with diff) on FAIL.
# This lock-in prevents future regressions of CR-01.
self_test_url_host() {
  local rc=0
  local cases=(
    "https://ntfy.sh/secret-topic|ntfy.sh"
    "http://ntfy.sh/topic|ntfy.sh"
    "https://user:pass@ntfy.example.com/topic|ntfy.example.com"
    "https://user@ntfy.example.com/topic|ntfy.example.com"
    "ntfy.sh/secret-topic-abc123|<no-scheme-configured>"
    "/just/a/path|<no-scheme-configured>"
    "https://ntfy.example.com:8443/topic|ntfy.example.com:8443"
  )
  for tc in "${cases[@]}"; do
    local input="${tc%%|*}"
    local expected="${tc#*|}"
    local actual
    actual="$(extract_url_host "${input}")"
    if [[ "${actual}" == "${expected}" ]]; then
      echo "[disk-alert] PASS extract_url_host('${input}') = '${actual}'"
    else
      echo "[disk-alert] FAIL extract_url_host('${input}')" >&2
      echo "[disk-alert]   expected: '${expected}'" >&2
      echo "[disk-alert]   actual:   '${actual}'" >&2
      rc=1
    fi
  done
  return ${rc}
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --threshold)
      if [[ $# -lt 2 ]]; then
        echo "[disk-alert] ERROR: --threshold requires a value (1..99)." >&2
        usage >&2
        exit 1
      fi
      THRESHOLD_OVERRIDE="$2"
      shift 2
      ;;
    --threshold=*)
      THRESHOLD_OVERRIDE="${1#*=}"
      shift
      ;;
    --self-test-url-host)
      self_test_url_host
      exit $?
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[disk-alert] ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# ─── Pre-flight: required POSIX tools ────────────────────────────────────────
if ! command -v df >/dev/null 2>&1; then
  echo "[disk-alert] ERROR: \`df\` not found in PATH." >&2
  exit 1
fi
if ! command -v awk >/dev/null 2>&1; then
  echo "[disk-alert] ERROR: \`awk\` not found in PATH." >&2
  exit 1
fi

# ─── Env resolution: HOST_DATA_ROOT (caller env wins; .env fallback) ─────────
# Per-variable grep|cut|sed extraction mirrors bin/restore-drill.sh:120-138
# (no `source .env` — avoids leaking unrelated secrets to subprocess env).
if [[ -z "${HOST_DATA_ROOT:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  HOST_DATA_ROOT=$(
    grep -E '^HOST_DATA_ROOT=' "${REPO_ROOT}/.env" \
      | tail -1 \
      | cut -d= -f2- \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
  )
fi
HOST_DATA_ROOT="${HOST_DATA_ROOT:-}"

if [[ -z "${HOST_DATA_ROOT}" ]]; then
  echo "[disk-alert] FAIL target_missing target= reason=HOST_DATA_ROOT_unset" >&2
  exit 1
fi

if [[ ! -d "${HOST_DATA_ROOT}" ]]; then
  # NEVER fall back to `/` (T-09-D — wrong-target alert is worse than no alert).
  echo "[disk-alert] FAIL target_missing target=${HOST_DATA_ROOT} reason=not_a_directory" >&2
  exit 1
fi

# ─── Env resolution: DISK_ALERT_THRESHOLD_PCT ────────────────────────────────
if [[ -z "${DISK_ALERT_THRESHOLD_PCT:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  DISK_ALERT_THRESHOLD_PCT=$(
    grep -E '^DISK_ALERT_THRESHOLD_PCT=' "${REPO_ROOT}/.env" \
      | tail -1 \
      | cut -d= -f2- \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
  )
fi
DISK_ALERT_THRESHOLD_PCT="${DISK_ALERT_THRESHOLD_PCT:-80}"

# --threshold CLI override takes precedence over env + .env.
if [[ -n "${THRESHOLD_OVERRIDE}" ]]; then
  DISK_ALERT_THRESHOLD_PCT="${THRESHOLD_OVERRIDE}"
fi

# Assert integer in [1, 99]. Out-of-range is a script-level error.
if ! [[ "${DISK_ALERT_THRESHOLD_PCT}" =~ ^[0-9]+$ ]]; then
  echo "[disk-alert] ERROR: DISK_ALERT_THRESHOLD_PCT must be an integer in 1..99 (got: '${DISK_ALERT_THRESHOLD_PCT}')." >&2
  exit 1
fi
if [[ "${DISK_ALERT_THRESHOLD_PCT}" -lt 1 ]] || [[ "${DISK_ALERT_THRESHOLD_PCT}" -gt 99 ]]; then
  echo "[disk-alert] ERROR: DISK_ALERT_THRESHOLD_PCT must be in 1..99 (got: ${DISK_ALERT_THRESHOLD_PCT})." >&2
  exit 1
fi

# ─── Env resolution: NTFY_URL (optional — empty default disables hook) ───────
if [[ -z "${NTFY_URL:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  NTFY_URL=$(
    grep -E '^NTFY_URL=' "${REPO_ROOT}/.env" \
      | tail -1 \
      | cut -d= -f2- \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
  )
fi
NTFY_URL="${NTFY_URL:-}"

# ─── Compute disk usage: df -P parse ─────────────────────────────────────────
# `df -P` is intentional (not plain `df`): GNU df without `-P` may emit a
# multi-line row for long device names, breaking the awk row-shape assumption.
# POSIX `-P` guarantees one row per filesystem in a fixed-column layout.
DF_OUTPUT=$(df -P "${HOST_DATA_ROOT}" 2>/dev/null || true)
if [[ -z "${DF_OUTPUT}" ]]; then
  echo "[disk-alert] ERROR: \`df -P ${HOST_DATA_ROOT}\` produced no output." >&2
  exit 1
fi

# Row 2 is the data row. Col 1 = Filesystem; Col 5 = Capacity (e.g. "53%").
# Strip the trailing %, then emit "<pct> <fs>" for the shell to read.
PARSED=$(echo "${DF_OUTPUT}" | awk 'NR==2 { gsub("%","",$5); print $5, $1 }')
if [[ -z "${PARSED}" ]]; then
  echo "[disk-alert] ERROR: failed to parse \`df -P\` output:" >&2
  echo "${DF_OUTPUT}" >&2
  exit 1
fi

USED_PCT="${PARSED%% *}"
FS="${PARSED#* }"

# Sanity: USED_PCT must be an integer 0..100. df can emit "-" for some
# pseudo-filesystems — dump the raw df output + exit 1 so the operator can
# diagnose (rather than silently emitting a meaningless log line).
if ! [[ "${USED_PCT}" =~ ^[0-9]+$ ]]; then
  echo "[disk-alert] ERROR: df returned non-numeric usage '${USED_PCT}' for ${HOST_DATA_ROOT}." >&2
  echo "[disk-alert]        Raw df -P output:" >&2
  echo "${DF_OUTPUT}" >&2
  exit 1
fi
if [[ "${USED_PCT}" -lt 0 ]] || [[ "${USED_PCT}" -gt 100 ]]; then
  echo "[disk-alert] ERROR: df returned out-of-range usage '${USED_PCT}%' for ${HOST_DATA_ROOT}." >&2
  exit 1
fi

# ─── Format + emit structured log line ───────────────────────────────────────
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HOSTNAME_SHORT=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "unknown")

if [[ "${USED_PCT}" -ge "${DISK_ALERT_THRESHOLD_PCT}" ]]; then
  LEVEL="WARN"
else
  LEVEL="INFO"
fi

printf '[disk-alert] LEVEL=%s target=%s used_pct=%s threshold_pct=%s fs=%s ts=%s hostname=%s\n' \
  "${LEVEL}" \
  "${HOST_DATA_ROOT}" \
  "${USED_PCT}" \
  "${DISK_ALERT_THRESHOLD_PCT}" \
  "${FS}" \
  "${TS}" \
  "${HOSTNAME_SHORT}"

# ─── Optional HTTP push hook (only on WARN; only if NTFY_URL non-empty) ──────
# Body is plain text — compatible with ntfy.sh, Discord webhooks, Slack
# incoming webhooks (Slack may render as quoted text — acceptable for v1).
# NEVER include the full NTFY_URL in any log line — the URL itself may be a
# private-topic credential (T-09-I-05).
if [[ "${LEVEL}" == "WARN" ]] && [[ -n "${NTFY_URL}" ]]; then
  MSG="Disk usage ${USED_PCT}% on ${HOSTNAME_SHORT} (${HOST_DATA_ROOT}); threshold ${DISK_ALERT_THRESHOLD_PCT}%"

  # `--fail` treats 4xx/5xx as errors so they reach the secondary log line.
  # `--max-time 10` bounds the wait — a hung receiver cannot block the cron slot
  # for more than 10 seconds (T-09-D-04 mitigation).
  set +e
  curl --fail -sS --max-time 10 \
    -H 'Title: local-llms disk alert' \
    -H 'Priority: high' \
    -H 'Tags: warning,disk' \
    -d "${MSG}" \
    "${NTFY_URL}" >/dev/null 2>&1
  CURL_EXIT=$?
  set -e

  if [[ "${CURL_EXIT}" -ne 0 ]]; then
    # Host-only extraction via extract_url_host (CR-01). The function
    # returns "<no-scheme-configured>" for malformed URLs (no `scheme://`
    # prefix) instead of returning the raw input — preserves T-09-I-05.
    # It also strips any `userinfo@` segment so basic-auth credentials
    # embedded in NTFY_URL never reach the log line.
    URL_HOST="$(extract_url_host "${NTFY_URL}")"
    printf '[disk-alert] LEVEL=WARN hook=ntfy curl_exit=%s url_host=%s ts=%s hostname=%s\n' \
      "${CURL_EXIT}" \
      "${URL_HOST}" \
      "${TS}" \
      "${HOSTNAME_SHORT}"
  fi
fi

exit 0
