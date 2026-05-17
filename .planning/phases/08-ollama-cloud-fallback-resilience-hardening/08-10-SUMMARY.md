---
phase: 08-ollama-cloud-fallback-resilience-hardening
plan: 10
subsystem: testing
tags: [smoke, human-verify, phase-closure, integration, ollama-cloud, valkey, idempotency, circuit-breaker, rate-limit]

requires:
  - phase: 08-00..08-09
    provides: 10 implemented Phase 8 requirement IDs (CLOUD-01..05, DATA-06, ROUTE-10..12, EMBED-02) with unit + integration tests against mocked Valkey/adapters
provides:
  - bin/smoke-test-cloud.sh — live smoke (9 sections; 10 requirement IDs) with skip-clean for OLLAMA_API_KEY-gated sections
  - bin/smoke-test-router.sh extended with `=== Phase 8 — Resilience + Cloud + Telemetry ===` block (7 sections, mirrors local-only assertions)
  - .env.example documents CIRCUIT_* + ROUTER_RATE_LIMIT_RPM with rationale
  - README.md §Phase 8 operator runbook (Valkey bring-up, cloud bring-up, X-Model-Backend, breaker inspect/reset, max_tokens cap, rate-limit inspect, idempotency recipe, cloud_spend_daily query, registry cache inspect)
  - Phase 8 human-verify checkpoint recipe (PENDING-HUMAN below)
affects: [Phase 9 — operational runbooks; future plans that touch Valkey/Postgres state]

tech-stack:
  added: []
  patterns:
    - "Direct-Valkey state pre-seeding for resilience smokes — pre-seed breaker:<backend>:state='open' + ratelimit:<hash>:<minute>=RPM+1 so the smoke trips assertions in O(1) requests instead of bursting (which would otherwise take 30s+ at default RPM=600 and would not be deterministic for breaker thresholds)."
    - "Skip-clean idiom for OLLAMA_API_KEY-gated sections — empty key → SKIP (counted, exit 0 allowed); failure on live path → FAIL (counted, exit 1)."
    - "Single-variable .env grep helper (read_env_var) — never `set -a; source .env` (which would leak unrelated secrets into every subprocess), parallels smoke-test-router.sh WR-05 mitigation."

key-files:
  created:
    - bin/smoke-test-cloud.sh
    - .planning/phases/08-ollama-cloud-fallback-resilience-hardening/08-10-SUMMARY.md
  modified:
    - bin/smoke-test-router.sh
    - .env.example
    - README.md

key-decisions:
  - "Direct-Valkey state writes for breaker (Section 5) + rate-limit (Section 6) rather than burst loops — keeps the smoke deterministic and fast (one curl per assertion) regardless of CIRCUIT_FAILURE_THRESHOLD / ROUTER_RATE_LIMIT_RPM tuning."
  - "Sections 2 + 3 (live cloud chat + embeddings) SKIP-clean when OLLAMA_API_KEY is empty rather than FAIL — supports the canonical 'local-only verification mode' an operator runs without a cloud key set."
  - "Phase 8 block appended to bin/smoke-test-router.sh is gated on Valkey running + VALKEY_PASSWORD set — preserves backward compatibility with the Phase 2/3/4/5/7 callers from prior plans (they still get clean PASS)."
  - "Task 2 deferred to PENDING-HUMAN — the executor runs without live OLLAMA_API_KEY, without GPU host, without Docker stack reachability. Same pattern as Phase 7 Plan 07-06 task 3."

patterns-established:
  - "Pre-seeded resilience smoke — write breaker/rate-limit state into Valkey then issue ONE request to trip the envelope check. Avoids burst-loops, matches Plan 08-04/08-06 internal-state shapes."
  - "Idempotent-Key dedup verification — md5sum of 3 concurrent responses + SQL projection `COUNT(*) + COUNT(DISTINCT upstream_message_id) = (3, 1)` on request_log filtered by idempotency_key."

requirements-completed:
  - CLOUD-01
  - CLOUD-02
  - CLOUD-03
  - CLOUD-04
  - CLOUD-05
  - DATA-06
  - ROUTE-10
  - ROUTE-11
  - ROUTE-12
  - EMBED-02

duration: ~30min
completed: 2026-05-17
---

# Phase 8 Plan 10: Phase 8 Smoke + Human-Verify Checkpoint Summary

**Live smoke script (bin/smoke-test-cloud.sh, 9 sections, all 10 Phase 8 requirement IDs) + canonical smoke extension + .env.example/README §Phase 8 runbook. Task 2 (operator-eyes verification on live stack) PENDING-HUMAN — recipe below.**

## Performance

- **Duration:** ~30 min (executor time only; operator verification adds ~5-15 min)
- **Started:** 2026-05-17T17:40Z (approximate)
- **Completed (Task 1):** 2026-05-17T17:58Z
- **Tasks:** 1/2 auto-tasks complete; 1/2 PENDING-HUMAN
- **Files modified:** 4 (1 created — `bin/smoke-test-cloud.sh`; 3 modified — `bin/smoke-test-router.sh`, `.env.example`, `README.md`)

## Accomplishments

- **bin/smoke-test-cloud.sh** — 540 LOC, 9 sections, syntax-clean (`bash -n`), executable bit set. Covers every Phase 8 requirement ID:
  - **Section 1 (ROUTE-10):** `X-Model-Backend` header present on `/v1/chat/completions`, `/v1/messages`, `/v1/embeddings` responses.
  - **Section 2 (CLOUD-01, CLOUD-02):** Live `gpt-oss:20b-cloud` chat returns 200 + non-empty `.choices[0].message.content` + `X-Model-Backend: ollama-cloud`. **Skip-clean** when `OLLAMA_API_KEY` empty.
  - **Section 3 (EMBED-02):** Live cloud-embeddings round-trip. **Skip-clean** when `OLLAMA_API_KEY` empty OR no cloud-embed entry in `models.yaml`.
  - **Section 4 (CLOUD-04):** `max_tokens=16385` returns 400 + `code=cloud_max_tokens_exceeded`; boundary check on `max_tokens=16384` confirms the cap is exclusive of CAP+1, not CAP.
  - **Section 5 (CLOUD-03):** Direct-Valkey write opens the breaker (`breaker:ollama-cloud:state=open` + `breaker:ollama-cloud:probe_at=now+60s`); cloud request returns 503 + `code=backend_circuit_open` + `Retry-After: <numeric>`; cleanup deletes the keys.
  - **Section 6 (ROUTE-11):** Pre-seed `ratelimit:<hash>:<minute>=RPM+1` after issuing one warmup request to materialize the key; next request returns 429 + `code=rate_limit_exceeded` + `Retry-After: <numeric>`.
  - **Section 7 (ROUTE-12):** Three concurrent `/v1/chat/completions` with the same `Idempotency-Key` return byte-identical bodies (md5 match); `request_log` projection over `idempotency_key=$KEY` yields `3 rows, 1 distinct upstream_message_id`.
  - **Section 8 (CLOUD-05):** `pg_views::viewname='cloud_spend_daily'` exists; `SELECT COUNT(*) FROM cloud_spend_daily` is queryable (0 rows OK).
  - **Section 9 (DATA-06):** `valkey-cli GET registry:models-yaml:cache:v1` returns JSON-shaped non-empty blob; TTL ∈ [1, 30]. If empty, surfaces as SKIP with the `docker compose restart router` remediation (per Plan 08-09 SUMMARY's operational notes).

- **bin/smoke-test-router.sh extension** — appended a `=== Phase 8 — Resilience + Cloud + Telemetry ===` block before the final summary. Mirrors Sections 1, 4, 5, 6, 7, 8, 9 of the dedicated cloud smoke (skips 2 + 3 which require live cloud). Gated on Valkey running + VALKEY_PASSWORD set, so older Phase 2/5/7 callers still see clean PASS. Final summary now reads "Phase 2/3/4/5/7/8 router verification: COMPLETE."

- **.env.example** — added a `CIRCUIT_*` block (`CIRCUIT_FAILURE_THRESHOLD=5`, `CIRCUIT_WINDOW_MS=30000`, `CIRCUIT_COOLDOWN_MS=60000`) and a `ROUTER_RATE_LIMIT_RPM=600` block, both with per-variable rationale comments matching Plan 08-04 / D-B2 and Plan 08-06 / D-D3.

- **README.md** — added §Phase 8 (~170 lines). Covers: Valkey bring-up + `VALKEY_PASSWORD` generation; cloud model bring-up (`OLLAMA_API_KEY` recipe + `gpt-oss:20b-cloud` smoke curl); `X-Model-Backend` header verification with `curl -D -`; circuit-breaker inspection + manual reset via `valkey-cli`; `max_tokens` cap demonstration; rate-limit counter inspection; idempotency-key recipe with 3 concurrent retries + `request_log` projection check; `cloud_spend_daily` operator query; registry-cache `GET` + `TTL` inspection; Phase 8 smoke invocation recipes.

## Task Commits

1. **Task 1: Create smoke + extend canonical + .env + README** — `1732b2c` (feat)
2. **Task 2: Phase 8 final human-verify** — **PENDING-HUMAN** (no commit; gates phase closure)

**Plan metadata commit:** (this SUMMARY + STATE/ROADMAP updates) — see final commit.

## Files Created/Modified

- `bin/smoke-test-cloud.sh` (NEW, 540 LOC, exec) — dedicated Phase 8 live smoke.
- `bin/smoke-test-router.sh` (MODIFIED, +290 LOC) — `=== Phase 8 ===` block before final summary.
- `.env.example` (MODIFIED, +30 LOC) — CIRCUIT_* + ROUTER_RATE_LIMIT_RPM block after Phase 7.
- `README.md` (MODIFIED, +175 LOC) — §Phase 8 between §Phase 7 and §Anti-patterns.
- `.planning/phases/08-ollama-cloud-fallback-resilience-hardening/08-10-SUMMARY.md` (NEW, this file).

## Decisions Made

- **Direct-Valkey state pre-seeding for Sections 5 + 6** (vs burst loops). At `ROUTER_RATE_LIMIT_RPM=600` (the default), a 601-request burst takes ~30s wall-clock and requires synchronization to detect the exact 601st response. Pre-seeding the counter to `RPM+1` with one curl is deterministic and fast (single request). Same pattern for the breaker (write `state=open` + `probe_at=now+60s` instead of streaming 5 forced 5xx responses through the router). Both patterns directly exercise the read-side check the router does on the request boundary — the assertions are equivalent to the burst path because both rely on the same Valkey key shape.
- **Skip-clean for OLLAMA_API_KEY-gated sections.** An operator running without a cloud key gets a smoke that exits 0 (with 2 SKIPs counted) — the "local-only verification mode" the plan documents as the default. Setting the key flips those 2 SKIPs to PASS without changing any other section.
- **Phase 8 block gated on Valkey availability** in `smoke-test-router.sh`. Older callers (Phase 2/5/7 contributors invoking the canonical smoke before Valkey was deployed) still get PASS — the block emits a single SKIP and the final exit code is 0. This avoids breaking the Phase 5 smoke that lives in older test logs.
- **Task 2 deferred to PENDING-HUMAN** per the orchestrator's autonomous: false handling — the executor has no live `OLLAMA_API_KEY`, no GPU host, no Docker stack reachability, so the operator must run both smoke scripts against the live stack and reply `approved`.

## Deviations from Plan

None — Task 1 executed exactly as the plan's `<interfaces>` template specified. The plan flagged two complementary strategies for Sections 5 + 6 (direct-Valkey write OR burst loop); I chose direct-Valkey writes for both per the operational-cost reasoning above. The plan documents this as the preferred path ("uses Valkey-CLI to manipulate breaker state directly" — must_haves.truths line 1).

Section 9 (registry cache) was implemented as the plan specified but with one additional safety net: if the key is empty at smoke time, surface as **SKIP** (not FAIL) with the `docker compose restart router` remediation hint. Plan 08-09 SUMMARY's "Operational notes for Plan 08-10 smoke" documents that the cache populates on router boot; an operator running the smoke against a freshly-deployed stack before the first boot-time populate completes would see an empty key, and a SKIP+hint is the correct UX there.

## Issues Encountered

None during Task 1 execution. The script-side and documentation-side work is fully self-contained against the existing Plan 08-00..08-09 surface (already exists in tree, 683 tests passing).

## User Setup Required — Task 2 Human-Verify Recipe (PENDING)

**This is the gate to Phase 8 closure.** The operator runs the following commands on the live stack and replies `approved` (or surfaces failures for re-execution). Same shape as Phase 7 Plan 07-06 task 3.

### Prerequisites (one-time)

1. `.env` populated with:
   - `ROUTER_BEARER_TOKEN` (existing, Phase 2)
   - `POSTGRES_PASSWORD` (existing, Phase 5)
   - `VALKEY_PASSWORD` (Phase 8 — generate once: `echo "VALKEY_PASSWORD=$(openssl rand -hex 24)" >> .env`)
   - `OLLAMA_API_KEY` (optional — for Sections 2 + 3 of the cloud smoke. Skip-clean if empty.)

2. Stack reachable:
   ```bash
   docker compose up -d postgres valkey ollama router
   docker compose ps   # expect all 4 healthy
   ```

### Step 1 — Canonical smoke

```bash
bash bin/smoke-test-router.sh
```

**Expected result:** exit code 0 + final line `Phase 2/3/4/5/7/8 router verification: COMPLETE.` Every Section reports PASS (with up to ~3 SKIPs for profile-gated vLLM checks if the `--profile vllm` is not active — these are unrelated to Phase 8 and acceptable).

The Phase 8 block prints 12-14 PASS lines under `=== Phase 8 — Resilience + Cloud + Telemetry ===`. If any FAIL appears in that block, inspect:
- `docker compose logs router | tail -100`
- `docker compose logs valkey | tail -50`
- `docker compose exec -T valkey valkey-cli -a $VALKEY_PASSWORD KEYS '*'`

### Step 2 — Dedicated cloud smoke

```bash
bash bin/smoke-test-cloud.sh
```

**Expected with `OLLAMA_API_KEY` set:** exit 0 + all 9 sections PASS + 0 SKIPs (modulo `bge-m3` not being pulled — that surfaces as 1 SKIP under Section 1).

**Expected with `OLLAMA_API_KEY` empty:** exit 0 + Sections 1, 4-9 PASS + Sections 2 + 3 SKIP (total: 2 SKIPs counted; no FAILs).

### Step 3 — Manual eyeball

```bash
# (a) Confirm Valkey is populated with all four expected key families.
docker compose exec -T valkey valkey-cli -a "${VALKEY_PASSWORD}" KEYS '*'
# Expected entries (some may be absent if not exercised this run):
#   registry:models-yaml:cache:v1
#   breaker:*:state, breaker:*:fail_count, breaker:*:probe_at   (only if breaker fired in last 60s)
#   ratelimit:<hash>:<minute>                                     (only if a request has hit the limit recently)
#   idempotency:*                                                 (only if Section 7 ran < 30 min ago)

# (b) Confirm cloud_spend_daily view exists.
docker compose exec -T postgres psql -U app -d router \
  -c "\d+ cloud_spend_daily"
# Expected: view definition prints (rows may be empty if no cloud requests fired yet — empty result is FINE).

# (c) Optional — if OLLAMA_API_KEY is set, fire one cloud chat and confirm X-Model-Backend.
curl -fsS -D - -o /dev/null \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-oss:20b-cloud","messages":[{"role":"user","content":"hi"}],"stream":false}' \
  http://127.0.0.1:3000/v1/chat/completions \
  | grep -i 'x-model-backend'
# Expected: X-Model-Backend: ollama-cloud
```

### Step 4 — Reply `approved`

If all three steps pass cleanly: reply `approved` and Phase 8 closes.

If anything FAILs: surface the failing section(s), `docker compose logs router | tail -50`, and the relevant `valkey-cli KEYS '*'` output. Common remediations:

- **Section 9 registry cache empty:** `docker compose restart router`; re-run the smoke after a 5-second wait.
- **Section 5 / 6 envelope code mismatch:** check `router/src/errors/envelope.ts` for the canonical error codes — these are pinned in Plan 08-04/08-06.
- **Section 7 distinct_upstream_message_ids != 1:** the idempotency mux's leader/follower role assignment may have failed. Inspect `docker compose logs router | grep -i idempotency`.
- **Sections 2 + 3 SKIP without explanation:** confirm `OLLAMA_API_KEY` is in `.env` and the router was restarted after adding it (`docker compose restart router`).

## Next Phase Readiness

- **Phase 8 closure:** gated on operator's `approved` for Task 2.
- **Phase 9 (operational hardening):** ready to start after Phase 8 closes. Out-of-scope items deferred from Phase 8 (OPS-01 `bin/gc-models.sh`, OPS-02 off-host backup destination, OPS-03 disk-usage alerts, OPS-04 bearer token rotation runbook) are the Phase 9 surface.
- **Phase 7 carry-over:** Plan 07-06 task 3 still PENDING-HUMAN (operator approval on RTX 5060 Ti host). Operator running the Phase 8 canonical smoke implicitly exercises some of Phase 7's surface — both checkpoints may close in the same operator session.

## Self-Check: PASSED

Files created/modified verified present:
- `bin/smoke-test-cloud.sh` — FOUND (executable, syntax-clean)
- `bin/smoke-test-router.sh` — MODIFIED (Phase 8 block present, syntax-clean)
- `.env.example` — MODIFIED (`CIRCUIT_FAILURE_THRESHOLD=5` + `ROUTER_RATE_LIMIT_RPM=600` present)
- `README.md` — MODIFIED (`## Phase 8 — Cloud fallback` heading present)

Commits verified present in `git log`:
- `1732b2c` — Task 1 commit (feat(08-10))

Plan automated `<verify>` block (test -x, all greps, both `bash -n`): **ALL PASS** (run pre-commit).

---
*Phase: 08-ollama-cloud-fallback-resilience-hardening*
*Completed: 2026-05-17 (Task 1); Task 2 PENDING-HUMAN*
