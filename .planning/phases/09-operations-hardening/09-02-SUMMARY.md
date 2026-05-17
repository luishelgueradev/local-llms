---
phase: 09-operations-hardening
plan: 02
subsystem: infra
tags: [ops, backup, restic, postgres, off-host, dr, crontab]

# Dependency graph
requires:
  - phase: 05-postgres-observability-seam
    provides: "pg-backup sidecar producing daily ${HOST_DATA_ROOT}/postgres-backups/router-*.dump files + bin/restore-drill.sh as the canonical script-shape template"
provides:
  - "bin/backup-postgres.sh — host-side wrapper publishing newest pg-dump to off-host restic repo with retention enforcement"
  - "BACKUP_RESTIC_REPO + BACKUP_RESTIC_PASSWORD + optional BACKUP_KEEP_POLICY env contract in .env.example"
  - "README §Operations §Off-host backups (OPS-02) subsection — prereqs + host crontab recipe + off-host restore drill that extends Phase 5"
  - "Phase 5 §Known limitations 'Backups are on-host' bullet closes when OPS-02 is configured"
affects: ["09-03 (disk-usage alert may grow a freshness-check on off-host snapshots later)", "09-04 (bearer rotation README references operator-managed secret patterns established here)"]

# Tech tracking
tech-stack:
  added: ["restic (host-installed, not containerized)"]
  patterns:
    - "Host-crontab integration pattern: script invoked from host crontab (NOT a Compose sidecar) — keeps the off-host credential out of the container layer (T-09-I mitigation)"
    - "Caller-env-wins + per-variable grep|cut|sed extraction from .env (mirrors bin/restore-drill.sh:120-138) — avoids `source .env` leaking unrelated secrets to subprocess"
    - "Backup vs retention exit-code split: backup failures exit 1; retention-only failures WARN but exit 0 — partial success > crontab spam on transient prune lock contention"

key-files:
  created:
    - "bin/backup-postgres.sh"
    - ".planning/phases/09-operations-hardening/09-02-SUMMARY.md"
  modified:
    - ".env.example (Phase 9 off-host backup section appended; HOST_DATA_ROOT Phase 5 comment updated to present-tense)"
    - "README.md (new §Off-host backups (OPS-02) under §Operations; Phase 5 §Known limitations bullet updated)"

key-decisions:
  - "restic over rclone (CONTEXT §Specifics line 74) — AES-256 encryption built in; one-line retention via `forget --prune`; same CLI for LAN + cloud destinations."
  - "Password via RESTIC_PASSWORD env var, never argv (T-09-I-02) — no `ps` exposure. Script does not `set -x` and never echoes the password."
  - "Host crontab pattern (not Compose sidecar) — off-host credential stays out of the container layer; operator owns the crontab entry + log file permissions."
  - "Retention default 7d/4w/6m baked into the script; BACKUP_KEEP_POLICY is an intentional verbatim splat override (operator explicitly opted in)."
  - "Backup-vs-retention exit code split: retention failures WARN but exit 0; only the actual backup invocation flips exit code."
  - "Restore drill extension is README-only — bin/restore-drill.sh (Phase 5 Plan 03) is UNCHANGED. The restic restore step is prepended in documentation per CONTEXT §Specifics line 75."

patterns-established:
  - "Off-host backup wrapper shape: host-side bash script (bin/*.sh) consuming a Compose-emitted artifact and republishing it to an operator-provided destination, with caller-env-wins config and an exit-code policy that distinguishes load-bearing from retention failures."
  - "Operator-managed secret pattern: a critical secret (BACKUP_RESTIC_PASSWORD) lives in .env for runtime convenience but the recovery copy lives in a password manager outside the host filesystem — documented explicitly so the disaster-recovery target is not co-located with the encryption key."

requirements-completed: [OPS-02]

# Metrics
duration: 22min
completed: 2026-05-17
---

# Phase 9 Plan 02: Off-host backups (OPS-02) Summary

**Host-side restic wrapper that publishes the pg-backup sidecar's daily Postgres dumps to an operator-provided off-host destination (sftp / local-path / b2 / rest) with `forget --prune` retention — closes the Phase 5 "backups are on-host" limitation.**

## Performance

- **Duration:** ~22 min
- **Tasks:** 3
- **Files modified:** 3 (1 created, 2 edited)
- **Commits:** 3 task commits (1 feat + 2 docs)

## Accomplishments

- `bin/backup-postgres.sh` (executable, 325 lines): picks newest `router-*.dump` via `ls -t | head -1`, publishes to restic with `--tag local-llms --tag postgres --tag <hostname>`, then enforces retention via `restic forget --prune`. Fire-and-forget; idempotent (restic's content-addressed storage dedups identical content across runs).
- `.env.example` gains a Phase 9 off-host backup section with `BACKUP_RESTIC_REPO` + `BACKUP_RESTIC_PASSWORD` + optional `BACKUP_KEEP_POLICY`, full operator-readable documentation (sample URIs, password generation recipe, the LOSING-THIS-MEANS-LOSING-THE-BACKUPS warning).
- `README.md` gains `### Off-host backups (OPS-02)` under `## Operations`: prereqs, host crontab recipe (`30 4 * * * cd /path/to/local-llms && bash bin/backup-postgres.sh >> /var/log/local-llms-backup.log 2>&1`), retention policy explanation, four-step off-host restore drill that extends Phase 5 (`restic snapshots --tag postgres` → pick id → `restic restore <id> --target ${HOST_DATA_ROOT}/postgres-backups/` → `bin/restore-drill.sh <dump>`), security note on password storage, NOT-backed-up scope.
- Phase 5 §"Known limitations" `Backups are on-host.` bullet replaced with `Backups are on-host until OPS-02 is configured.` + link to the new subsection. The limitation closes when the operator wires the env vars + crontab.

## Task Commits

1. **Task 1: bin/backup-postgres.sh — restic wrapper for off-host pg-dump publish** — `b3715dd` (feat)
2. **Task 2: .env.example — Phase 9 off-host backup env contract** — `bd5978b` (docs)
3. **Task 3: README §Operations §Off-host backups (OPS-02) + Phase 5 limitation closes** — `5f6bd4d` (docs)

## CLI Surface

`bin/backup-postgres.sh` exposes no flags beyond `-h | --help`. The script is a single-shot publish — `restic` itself has `--dry-run`, but a dry-run of a publish is rarely useful (operator can `restic snapshots --tag postgres` after to verify).

```bash
bash bin/backup-postgres.sh           # one-shot publish (no flags)
bash bin/backup-postgres.sh -h        # help
bash bin/backup-postgres.sh --help    # help
```

Exit codes:

- `0` — Backup published (retention may have WARNED but the backup itself landed).
- `1` — Pre-flight failure (restic missing, env missing, no dumps, password too short) OR the restic backup invocation failed.

## Env-var Contract

| Variable | Required? | Purpose |
|----------|-----------|---------|
| `BACKUP_RESTIC_REPO` | yes (empty → script exits 1 with "off-host backup not configured") | Restic repo URI. Examples: `sftp:backup-host:/srv/restic-repos/local-llms`, `/mnt/external-hdd/restic-repos/local-llms`, `b2:my-bucket:/local-llms`, `rest:https://rest-server.lan/local-llms`. |
| `BACKUP_RESTIC_PASSWORD` | yes (≥ 16 chars; recommended `openssl rand -hex 32`) | Restic encryption key. LOSING THIS = LOSING THE BACKUPS. Storage recommendation: password manager OUTSIDE the host filesystem. |
| `BACKUP_KEEP_POLICY` | optional (empty → script default) | Operator override of the retention policy. Default: `--keep-daily 7 --keep-weekly 4 --keep-monthly 6`. Override example: `--keep-daily 30 --keep-monthly 24`. Splatted verbatim into restic argv. |

## Recommended Crontab Entry

```cron
# /etc/crontab or `crontab -e` — HOST crontab, NOT inside a container.
# HH:30 = 30 min after the pg-backup sidecar's daily dump.
MAILTO=ops@example.com
30 4 * * * cd /path/to/local-llms && bash bin/backup-postgres.sh \
           >> /var/log/local-llms-backup.log 2>&1
```

Log file should be `chmod 600` (operator-owned). The script never prints the password, but other host diagnostics piped into the same log could leak around it.

## Off-host Restore Drill (4-step recipe)

The on-host `bin/restore-drill.sh` is UNCHANGED. Off-host restore prepends a `restic restore` step:

1. `restic -r "$BACKUP_RESTIC_REPO" snapshots --tag postgres` → list snapshots.
2. Pick the snapshot id (e.g. `abcd1234`).
3. `restic -r "$BACKUP_RESTIC_REPO" restore abcd1234 --target "${HOST_DATA_ROOT}/postgres-backups/"` → unpack into the host bind mount. (Restic preserves absolute paths — the README documents the `mv` to flatten the nested directory before step 4.)
4. `bin/restore-drill.sh router-2026-05-14T12.dump` → hand off to the existing Phase 5 drop+restore recipe.

## Security caveat — `BACKUP_RESTIC_PASSWORD` storage (T-09-I-03)

The off-host backup destination IS the disaster-recovery target — assume it can be compromised independently of the live host. Restic's AES-256 encryption means a destination compromise alone yields noise. BUT an attacker with `.env` read access on the live host can decrypt the off-host snapshots.

Recommendation (documented in README + `.env.example` comments): store `BACKUP_RESTIC_PASSWORD` in a password manager OUTSIDE the host filesystem. The `.env` file is the convenience copy — losing the live host should not lose the password.

## Decisions Made

- **restic over rclone** (CONTEXT §Specifics line 74) — encryption built in; one-line retention policy.
- **Password via env var, never argv** (T-09-I-02 mitigation) — `RESTIC_PASSWORD=…` prefix, no `ps` exposure.
- **Host crontab over Compose sidecar** — keeps the off-host credential out of the container layer.
- **Retention failures WARN, do not fail the script** — backup itself landing is the load-bearing operation; transient prune lock contention should not spam crontab.
- **Restore drill extension is README-only** — `bin/restore-drill.sh` (Phase 5 Plan 03) is UNCHANGED. The restic-restore step is documented as a prepend.

## Deviations from Plan

None — plan executed exactly as written. All three task verification gates passed on first run.

## Issues Encountered

None.

## User Setup Required

The plan declared `user_setup` for restic — operator must:

1. Install restic on the host: `sudo apt install restic` (Debian/Ubuntu) OR download from <https://restic.net/>.
2. Set `BACKUP_RESTIC_REPO` + `BACKUP_RESTIC_PASSWORD` in `.env`.
3. Initialize the restic repo ONCE: `restic -r "$BACKUP_RESTIC_REPO" init` (interactive password prompt).
4. Add the recommended crontab entry (see above).

The script bails with a clear, actionable diagnostic if any of these are missing. No USER-SETUP.md was generated separately — the README §Off-host backups (OPS-02) subsection covers the full operator surface end-to-end.

## Explicit Non-goals Carried Forward to v2

- **Multi-destination backup** (e.g. local NAS + cloud S3 in parallel) — CONTEXT §Deferred line 83.
- **Encrypted `.env` at rest** via sops / age / vault — CONTEXT §Deferred line 85.
- **Grafana panel for "last successful off-host backup age"** — operator-deferred; add a `restic snapshots --json | jq` panel later if desired.
- **Automated `BACKUP_RESTIC_PASSWORD` rotation** — operator-managed (rotate by initializing a fresh repo + re-publishing). No in-stack secret-rotation tooling per CONTEXT §Deferred line 86.
- **Filesystem-state backup of `${HOST_DATA_ROOT}/openwebui/`** — only the OWUI Postgres DB is in the pg-dump; uploaded files + temp cache are not. v2 may add.
- **Models-volume backup** (`models-gguf/`, `models-hf/`) — explicitly out of scope per REQUIREMENTS.md §"Out of Scope" line 169 (models are re-downloadable).
- **Valkey backup** — cache only; nothing in there outlives a restart.

## Next Phase Readiness

OPS-02 closes. Next plans in Phase 9:

- **09-03 (OPS-03)** — Disk-usage alert. Independent of OPS-02; may grow a freshness-check on off-host snapshots later but that is not a 09-03 deliverable.
- **09-04 (OPS-04)** — Rotating the bearer token. Independent.

## Self-Check: PASSED

- `bin/backup-postgres.sh` exists (`a/u+x`, 325 lines) ✓
- `.planning/phases/09-operations-hardening/09-02-SUMMARY.md` exists ✓
- Commit `b3715dd` (feat 09-02 — backup-postgres.sh) exists ✓
- Commit `bd5978b` (docs 09-02 — .env.example) exists ✓
- Commit `5f6bd4d` (docs 09-02 — README) exists ✓
- All `<verification>` gates from PLAN.md pass (script syntax-clean, executable, restic backup + forget --prune present, password never echoed, no `set -x`, env-example has both BACKUP_RESTIC_* vars, README has the OPS-02 subsection)

---
*Phase: 09-operations-hardening*
*Completed: 2026-05-17*
