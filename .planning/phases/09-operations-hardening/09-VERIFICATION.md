---
phase: 09-operations-hardening
verified: 2026-05-17T20:10:00Z
status: passed
score: 4/4 must-haves verified
overrides_applied: 0
---

# Phase 9: Operations Hardening Verification Report

**Phase Goal:** Once everything works, prevent it from rotting — disk hygiene, off-host backups, alerting on the constrained resource (disk), and a documented secret rotation path.
**Verified:** 2026-05-17T20:10:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| #   | Truth (SC) | Status     | Evidence       |
| --- | ---------- | ---------- | -------------- |
| 1   | SC1 — `bin/gc-models.sh` scans `models-gguf/` and `models-hf/`, lists files not referenced by `models.yaml`, and (with `--apply`) removes them; dry-run output documented in README. | VERIFIED | `bin/gc-models.sh` (458 LOC, exec, `bash -n` clean) scans `${HOST_DATA_ROOT}/models-gguf/gguf/` + `${HOST_DATA_ROOT}/models-hf/` (lines 234, 261) via `find`, classifies via `router/scripts/gc-classify.ts` → `router/src/ops/gcModels.ts::classifyCandidate`, default dry-run prints candidates + total reclaimable (lines 348-373), `--apply --yes` moves to `.gc-trash/<ts>/` via atomic `mv` (lines 412-440). README `### Garbage-collecting unused model files (OPS-01)` at line 1225 with dry-run sample output (lines 1234-1256), `--apply` recipe (lines 1264-1271), trash semantics (line 1274), allowlist guarantee (line 1296). |
| 2   | SC2 — Off-host backup destination (restic or rclone) is configured + successful run verified end-to-end (Postgres dump → off-host → restore on scratch instance). | VERIFIED | `bin/backup-postgres.sh` (357 LOC, exec) wraps existing Phase 5 `pg-backup` dumps with `restic backup` (lines 249-261) + `restic forget --prune` retention (lines 320-334). `RESTIC_PASSWORD` flows via env, never argv (T-09-I-02). README `### Off-host backups (OPS-02)` at line 1302 documents prereqs + crontab + 4-step end-to-end off-host restore drill (lines 1374-1390) that prepends `restic snapshots → restore` to the UNCHANGED `bin/restore-drill.sh` (Phase 5). `.env.example` lines 189/211/222 declare `BACKUP_RESTIC_REPO` + `BACKUP_RESTIC_PASSWORD` + optional `BACKUP_KEEP_POLICY` (validated shape gate at backup-postgres.sh:287-310). |
| 3   | SC3 — Disk-usage alert fires visibly (log line / Grafana alert / cron-ntfy hook) when `/srv/models` exceeds a configurable threshold; threshold documented. | VERIFIED | `bin/disk-alert.sh` (374 LOC, exec) computes `df -P "${HOST_DATA_ROOT}"` (line 282), emits structured single-line `[disk-alert] LEVEL={INFO|WARN} target=... used_pct=... threshold_pct=... fs=... ts=... hostname=...` log (lines 324-331), and on WARN with non-empty `NTFY_URL` POSTs via `curl --fail -sS --max-time 10` (lines 351-356). Threshold `DISK_ALERT_THRESHOLD_PCT` (default 80, range 1..99, asserted at lines 258-265) declared in `.env.example:250`; `NTFY_URL` at `.env.example:276`. README `### Disk-usage alert (OPS-03)` at line 1425 with threshold knob (line 1437), 15-min crontab recipe (line 1450), INFO+WARN sample log lines (lines 1466-1467), NTFY_URL alternatives (line 1476), MAILTO-on-breach variant (line 1490). |
| 4   | SC4 — Bearer-token rotation procedure documented in README — including how to update Open WebUI's stored token without recreating its admin user, and how to verify zero log lines mention old token before deleting it. | VERIFIED | README `### Rotating the bearer token (OPS-04)` at line 1513 documents the 10-step rotation procedure. OWUI persistence pivot explained at line 1520 (`OPENAI_API_KEYS` is `PersistentConfig`-marked → DB wins after first boot). Step 5 (line 1568) provides TWO variants for updating OWUI's stored token: **Path A** admin-UI (line 1573 — explicitly "Sign in as the OWUI admin user … do NOT create a new one; that would orphan chat history") and **Path B** direct SQL via `docker compose exec -T postgres psql -U app -d openwebui` (line 1585) — both leave admin user + chat history INTACT (line 1568). Step 9 (line 1632) provides verification grep across `router`/`openwebui`/`traefik` log surfaces using `OLD_PREFIX` (first 8 hex chars, line 1542) instead of full token — `docker compose logs "$svc" --since 24h 2>&1 \| grep -c "$OLD_PREFIX"` (line 1637), expected `0 0 0`. |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected    | Status | Details |
| -------- | ----------- | ------ | ------- |
| `bin/gc-models.sh` | GC script, dry-run default + `--apply` + `GC` phrase + allowlist + move-to-trash, min 180 LOC, `set -uo pipefail` | VERIFIED | 458 LOC; `set -uo pipefail` at line 53 (single occurrence); `readlink -f` allowlist at lines 153/160/161/244/268/422; move-to-trash at line 434 (`mv` to `${TRASH_DIR}/${REL}`); `GC` confirmation at line 400-404; NO `rm -rf` anywhere as actual destructive call; exec bit set (`-rwxrwxr-x`). |
| `bin/backup-postgres.sh` | restic wrapper, min 120 LOC, `set -uo pipefail` | VERIFIED | 357 LOC; `set -uo pipefail` at line 72; `RESTIC_PASSWORD` env-var passing at lines 249/320 (never argv); `BACKUP_KEEP_POLICY` shape-gate at lines 287-310 (WR-05 fix); exec bit set. |
| `bin/disk-alert.sh` | df -P threshold check + structured log + optional ntfy hook, min 100 LOC, `set -uo pipefail` | VERIFIED | 374 LOC; `set -uo pipefail` at line 92; `extract_url_host` function (lines 131-141) strips userinfo + rejects malformed URLs (CR-01 fix); regression-locking `--self-test-url-host` runs 7/7 PASS; exec bit set. |
| `router/src/ops/gcModels.ts` | Parser, exports `collectReferencedTokens` + `classifyCandidate` | VERIFIED | 185 LOC; `export function collectReferencedTokens` at line 41; `export function classifyCandidate` at line 126. |
| `router/scripts/gc-classify.ts` | tsx bridge for bash↔TS classifier invocation | VERIFIED | 96 LOC; wire format = RS (0x1e) field separator + NUL (0x00) record terminator (WR-04 fix). |
| `router/tests/ops/gc-models.test.ts` | Vitest parser tests | VERIFIED | 183 LOC; 9/9 tests pass (re-run: `Test Files 1 passed (1)  Tests 9 passed (9)`); covers `collectReferencedTokens` (3 cases) + `classifyCandidate` (6 cases) per the SUMMARY claim. |
| `README.md` | `## Operations` parent + 4 OPS-* subsections | VERIFIED | `## Operations` at line 1221; `### Garbage-collecting unused model files (OPS-01)` at 1225; `### Off-host backups (OPS-02)` at 1302; `### Disk-usage alert (OPS-03)` at 1425; `### Rotating the bearer token (OPS-04)` at 1513. |
| `.env.example` | `BACKUP_RESTIC_REPO` + `BACKUP_RESTIC_PASSWORD` + `BACKUP_KEEP_POLICY` + `DISK_ALERT_THRESHOLD_PCT` + `NTFY_URL` | VERIFIED | All 5 env vars present at lines 189/211/222/250/276 with operator-readable documentation comments. |

### Key Link Verification

| From | To  | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| `bin/gc-models.sh` | `router/models.yaml` | tsx bridge → `gcModels.ts::collectReferencedTokens` | WIRED | Line 295: `(cd "${ROUTER_DIR}" && "${TSX_BIN}" "${CLASSIFY_HELPER}" "${MODELS_YAML}")` invokes parser with stdin candidate list. |
| `bin/gc-models.sh` | `${HOST_DATA_ROOT}/models-gguf/` + `${HOST_DATA_ROOT}/models-hf/` | `find -maxdepth 1 -mindepth 1 -not -type l` | WIRED | Lines 234-258 (gguf) + 261-278 (hf); `readlink -f` allowlist re-check at lines 244-251/268-275 + final pre-mv re-assertion at 422-430. |
| `bin/backup-postgres.sh` | `${HOST_DATA_ROOT}/postgres-backups/router-*.dump` | `ls -t \| head -1` | WIRED | Line 213: `LATEST=$(ls -t "${BACKUP_DIR}"/router-*.dump 2>/dev/null \| head -1)`. |
| `bin/backup-postgres.sh` | restic repository (sftp/b2/local/rest) | `restic backup` + `restic forget --prune` | WIRED | Lines 249-261 (backup) + 320-326 (forget --prune); password via `RESTIC_PASSWORD=...` env prefix (never argv). |
| `README.md` OPS-02 restore-drill subsection | `bin/restore-drill.sh` (UNCHANGED) | Documented 4-step prepend: snapshots → restore → restore-drill | WIRED | Lines 1374-1390. |
| `bin/disk-alert.sh` | `df -P` for `${HOST_DATA_ROOT}` | `df -P ${HOST_DATA_ROOT}` + awk col 5 | WIRED | Lines 282-298 (parse used_pct + fs); refuses fallback to `/` when `HOST_DATA_ROOT` is missing (lines 235-239 — T-09-D). |
| `bin/disk-alert.sh` | operator notification surface | Structured stdout log + optional `curl POST $NTFY_URL` | WIRED | Lines 324-331 (always-emit structured log) + 351-371 (curl on WARN + non-empty NTFY_URL, with host-only fallback log on curl failure via `extract_url_host`). |
| README OPS-04 rotation procedure | OWUI persisted `OPENAI_API_KEYS` in `openwebui` Postgres DB | Admin-UI path (A) + direct-SQL path (B) | WIRED | Step 5 at line 1568 documents both variants; line 1585 documents psql connection string; both variants preserve admin user + chat history per line 1568 ("both leave the OWUI admin user and chat history intact"). |
| README OPS-04 verification | `docker compose logs router/openwebui/traefik` | `grep -c "$OLD_PREFIX"` across 3 surfaces | WIRED | Lines 1635-1639 iterate `for svc in router openwebui traefik`; expected `0 0 0`. |
| README OPS-04 verification | `bin/smoke-test-router.sh` | Documented as post-rotation smoke step | WIRED | Smoke-test-router referenced 11 times across the OPS-04 subsection per Plan 04 SUMMARY's verification table. |

### Data-Flow Trace (Level 4)

Not applicable — Phase 9 ships pure infrastructure scripts + documentation; no runtime data-flow paths to trace (no React/component rendering, no API → DB rendering). The scripts ARE the data source; their stdout/filesystem effects are the operator-facing output. Wiring (Level 3) above already covers the relevant `df → stdout`, `models.yaml → classifier → trash`, `dump → restic` chains.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| All 3 ops scripts syntax-clean | `bash -n bin/{gc-models,backup-postgres,disk-alert}.sh` | All exit 0 | PASS |
| All 3 ops scripts respond to `--help` | `bash bin/{gc-models,backup-postgres,disk-alert}.sh --help` | All exit 0 with usage text | PASS |
| CR-01 NTFY_URL host extraction self-test | `bash bin/disk-alert.sh --self-test-url-host` | 7/7 PASS lines (https/http/userinfo/no-scheme/path-only/port-preserved) | PASS |
| OPS-01 parser unit tests | `cd router && npm test -- --run tests/ops/gc-models.test.ts` | `Test Files 1 passed (1)  Tests 9 passed (9)` | PASS |
| Full router test suite (regression check) | `cd router && npm test` | `Test Files 63 passed (63)  Tests 692 passed \| 7 skipped (699)` | PASS |
| Single `set -uo pipefail` per script | `grep -n "^set -uo pipefail$" bin/{gc-models,backup-postgres,disk-alert}.sh` | gc-models:53, backup-postgres:72, disk-alert:92 (one each) | PASS |
| No `rm -rf` as destructive code (T-09-D) | `grep -nE "^\\s*rm -rf" bin/{gc-models,backup-postgres,disk-alert}.sh` | 0 matches across all three scripts | PASS |

### Probe Execution

No phase-declared or conventional `scripts/*/tests/probe-*.sh` probes for Phase 9 (this is a pure ops/docs phase — operator-time validation, not CI probes). Vitest suite serves as the regression check for OPS-01 parser logic; bash `--help` + `--self-test-url-host` serve as the smoke checks for the shell scripts.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| OPS-01 | 09-01 | `bin/gc-models.sh` removes model files on disk no longer referenced in `models.yaml` | SATISFIED | bin/gc-models.sh exists + executable + 9/9 parser tests pass + README §OPS-01 subsection. SC1 verified above. |
| OPS-02 | 09-02 | Off-host backup destination configured (restic or rclone) for Postgres dump | SATISFIED | bin/backup-postgres.sh exists + executable + restic-backup + forget-prune wiring + END-TO-END restore drill documented in README. SC2 verified above. |
| OPS-03 | 09-03 | Disk-usage alert fires when `/srv/models` exceeds configurable threshold | SATISFIED | bin/disk-alert.sh exists + executable + df-P parse + structured log + optional ntfy hook + DISK_ALERT_THRESHOLD_PCT documented. SC3 verified above. |
| OPS-04 | 09-04 | Bearer-token rotation procedure documented in project README | SATISFIED | README §Rotating the bearer token (OPS-04) at line 1513 with 10-step procedure + OWUI PersistentConfig pivot (Path A admin-UI + Path B direct-SQL) + OLD_PREFIX-only verification grep. SC4 verified above. |

REQUIREMENTS.md cross-check: lines 121-124 and 258-261 mark all four OPS-* as `[x] Complete` and assigned to Phase 9 — no orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (none) | — | — | — | — |

Scanned the 6 modified code files (`bin/gc-models.sh`, `bin/backup-postgres.sh`, `bin/disk-alert.sh`, `router/src/ops/gcModels.ts`, `router/scripts/gc-classify.ts`, `router/tests/ops/gc-models.test.ts`) and the README Operations section (lines 1221-1730) for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER|placeholder|coming soon|not yet implemented`. False positives only:
- `mktemp -t backup-postgres-{backup,forget}.XXXXXX` — `XXXXXX` is the mktemp template literal (not a debt marker).
- `router/scripts/gc-classify.ts:84` "placeholder for an empty reason" — semantic comment about the `-` placeholder character (intentional design; not unfinished code).
- `bin/backup-postgres.sh:194` "almost certainly a typo or placeholder" — error message text for the password-too-short pre-flight (defensive code, not unfinished work).

All 2 critical + 6 warning code-review findings (CR-01, CR-02, WR-01..06) are fixed in the codebase — verified by inspection:
- CR-01 (NTFY_URL userinfo/scheme leak): `extract_url_host` function in `bin/disk-alert.sh:131-141` + regression self-test at lines 148-174 (7/7 PASS).
- CR-02 (fixed `/tmp/gc-models-parser.err` symlink-attack): `PARSER_ERR="$(mktemp)"` at `bin/gc-models.sh:294`, consolidated trap at line 229.
- WR-01 (HOST_DATA_ROOT symlink): `HOST_DATA_ROOT_CANONICAL` at `bin/gc-models.sh:153` used for strip/build.
- WR-02 (errant `set -e`): removed entirely from `bin/disk-alert.sh` (lines 345-350 documentation only).
- WR-03 (trap overwrite chain): single consolidated trap at `bin/gc-models.sh:229`.
- WR-04 (tab-separated wire format mangles tabs in paths): RS (0x1e) + NUL (0x00) wire format at `bin/gc-models.sh:318`.
- WR-05 (`BACKUP_KEEP_POLICY` unvalidated splat): shape-gate at `bin/backup-postgres.sh:287-310`.
- WR-06 (zsh/fish/tmux scrollback gap): blockquote sub-section added to README OPS-04 §Clean shell history.

All 4 IN-* info findings (out of scope per the fix charter) noted but not addressed — none are correctness or security defects.

### Human Verification Required

None for Phase 9 closure. Per CONTEXT line 33: "All four OPS items can ship as autonomous plans — none require human-verify gates (unlike Phases 7 + 8 where live-stack UAT was load-bearing)." Operator-time validation (running `bin/backup-postgres.sh` against their real restic repo, configuring crontab, exercising the OPS-04 rotation procedure end-to-end on their actual stack) is intentional out-of-scope-for-CI work — documented in README and run by the operator at their convenience.

### Gaps Summary

No gaps. All four ROADMAP Success Criteria (SC1..SC4) are observably true in the codebase, all four requirement IDs (OPS-01..OPS-04) are satisfied, all eight critical+warning code-review findings are fixed in code with their specific commits visible in git log (`4b591b9`, `8ff1dc4`, `71fba1f`, `944bb61`, `024e638`, `ec5b541`, `97a488f`, `3839c0c`). Vitest suite is green (692/699; 7 skipped unchanged from baseline). All three ops scripts are executable, syntax-clean, and respond to `--help`. The CR-01 regression self-test (`--self-test-url-host`) passes all 7 cases on a clean re-run. Phase goal — "Once everything works, prevent it from rotting" — is achieved: disk hygiene (OPS-01), off-host backups (OPS-02), constrained-resource alerting (OPS-03), and secret rotation runbook (OPS-04) are all delivered, scripted, documented, and tested where applicable.

---

_Verified: 2026-05-17T20:10:00Z_
_Verifier: Claude (gsd-verifier)_
