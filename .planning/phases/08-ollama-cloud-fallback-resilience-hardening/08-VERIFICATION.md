---
phase: 08-ollama-cloud-fallback-resilience-hardening
verified: 2026-05-17T19:00:00Z
status: human_needed
score: 5/5 success-criteria verified (1/2 Plan 08-10 tasks PENDING-HUMAN by design)
overrides_applied: 0
re_verification: # initial verification — no previous report
  previous_status: null
  previous_score: null
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Step 1 — Canonical smoke against live stack"
    expected: "bash bin/smoke-test-router.sh exits 0; final line reads 'Phase 2/3/4/5/7/8 router verification: COMPLETE.'; Phase 8 block reports 12-14 PASS lines under `=== Phase 8 — Resilience + Cloud + Telemetry ===`."
    why_human: "Requires live docker-compose stack (postgres + valkey + ollama + router healthy) reachable on operator's GPU host; verifier sandbox has no Docker access."
    setup: "docker compose up -d postgres valkey ollama router && docker compose ps  # expect all 4 healthy"
    on_fail: "docker compose logs router | tail -100; docker compose logs valkey | tail -50; docker compose exec -T valkey valkey-cli -a $VALKEY_PASSWORD KEYS '*'"
  - test: "Step 2 — Dedicated cloud smoke against live stack"
    expected_with_key: "bash bin/smoke-test-cloud.sh exits 0; 9 sections PASS; 0 SKIPs (modulo bge-m3 not pulled — surfaces as 1 SKIP under Section 1)."
    expected_without_key: "bash bin/smoke-test-cloud.sh exits 0; Sections 1, 4-9 PASS; Sections 2 + 3 SKIP (skip-clean when OLLAMA_API_KEY empty); total 2 SKIPs, 0 FAILs."
    why_human: "Sections 2 + 3 require a real OLLAMA_API_KEY hitting https://ollama.com (live cloud round-trip); verifier has no key. Sections 5 + 6 + 7 pre-seed Valkey state via docker compose exec valkey valkey-cli, requiring a running Valkey container."
    sections: "S1 ROUTE-10 X-Model-Backend header; S2 CLOUD-01/02 live cloud chat; S3 EMBED-02 cloud embeddings; S4 CLOUD-04 max_tokens cap; S5 CLOUD-03 breaker via direct-Valkey-write; S6 ROUTE-11 rate-limit via direct-Valkey-write; S7 ROUTE-12 idempotency 3-concurrent same-key md5-match; S8 CLOUD-05 cloud_spend_daily view; S9 DATA-06 registry cache key+TTL."
  - test: "Step 3a — Manual eyeball — Valkey key populations"
    command: "docker compose exec -T valkey valkey-cli -a \"${VALKEY_PASSWORD}\" KEYS '*'"
    expected: "Returns at least `registry:models-yaml:cache:v1`; optionally `breaker:*:state`, `ratelimit:<hash>:<minute>`, `idempotency:*` (only if those features were exercised in the previous ~15-30 min)."
    why_human: "Live Valkey CLI access against running container."
  - test: "Step 3b — Manual eyeball — cloud_spend_daily Postgres view exists"
    command: "docker compose exec -T postgres psql -U app -d router -c '\\d+ cloud_spend_daily'"
    expected: "View definition prints; rows may be empty (operator hasn't fired a cloud request yet — empty is FINE)."
    why_human: "Live Postgres CLI access; migration must have run on first router boot post-Phase 8."
  - test: "Step 3c — Optional cloud chat confirms X-Model-Backend header"
    command: "curl -fsS -D - -o /dev/null -H 'Authorization: Bearer ${ROUTER_BEARER_TOKEN}' -H 'Content-Type: application/json' -d '{\"model\":\"gpt-oss:20b-cloud\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false}' http://127.0.0.1:3000/v1/chat/completions | grep -i 'x-model-backend'"
    expected: "Header value: 'X-Model-Backend: ollama-cloud'"
    why_human: "Requires OLLAMA_API_KEY + live router + live Ollama Cloud round-trip."
    skip_if: "OLLAMA_API_KEY unset — Section 2 of cloud smoke already covers this when key is set."
  - test: "Step 4 — Operator reply"
    expected: "If all three steps pass cleanly: reply 'approved' and Phase 8 closes. If anything FAILs: surface failing section(s) + `docker compose logs router | tail -50` + `valkey-cli KEYS '*'` output."
    why_human: "Final orchestrator gate — only the operator can confirm the live-stack happy path."
    common_remediations:
      - "Section 9 registry cache empty → docker compose restart router; re-run after 5s wait"
      - "Section 5/6 envelope code mismatch → check router/src/errors/envelope.ts canonical codes"
      - "Section 7 distinct_upstream_message_ids != 1 → docker compose logs router | grep -i idempotency"
      - "Sections 2 + 3 SKIP without explanation → confirm OLLAMA_API_KEY in .env + docker compose restart router"
---

# Phase 8: Ollama Cloud Fallback + Resilience Hardening — Verification Report

**Phase Goal:** Land the killer feature ("local when it fits, cloud when it doesn't") in the same phase as the resilience features that protect against retry storms and runaway cloud spend — they share the router surface and shouldn't ship independently.

**Mode:** mvp (per ROADMAP)

**Verified:** 2026-05-17T19:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement — Observable Truths (ROADMAP Success Criteria)

| # | Truth (ROADMAP SC) | Status | Evidence |
|---|------|--------|----------|
| 1 | A model declared with `backend: ollama-cloud` in `models.yaml` (with `OLLAMA_API_KEY` from `.env`, base URL `https://ollama.com`) routes remotely with no client-visible difference from local — same `POST /v1/chat/completions` and `POST /v1/messages`, same auth, same SSE shape — and every response carries `X-Model-Backend` so the agent knows where the answer came from. | VERIFIED | `router/models.yaml:106-124` declares `gpt-oss:120b-cloud` + `gpt-oss:20b-cloud` with `backend: ollama-cloud` + `backend_url: https://ollama.com/v1`. `router/src/backends/ollama-cloud.ts:53-189` ships `OllamaCloudAdapter` implementing `chatCompletionsCanonical`, `chatCompletionsCanonicalStream`, `embeddings`, `probeLiveness`. Anthropic surface (`/v1/messages`) reaches cloud via the existing Plan 04 canonical translation (D-A3 — zero cloud-specific code on that route). `router/src/app.ts:630-636` registers an `onSend` hook setting `X-Model-Backend` from `req.resolvedBackend`. All three routes (`chat-completions.ts:121`, `messages.ts:183`, `embeddings.ts:125`) stamp `req.resolvedBackend = entry.backend` after `registry.resolve`. |
| 2 | Per-backend circuit breaker (N failures in M seconds → cooldown) prevents cascading failures during a simulated cloud outage; while open, the router fails fast with a clear error rather than queueing. | VERIFIED | `router/src/resilience/circuitBreaker.ts` (357 LOC) exports `makeCircuitBreaker` with state machine `closed → open → half-open → closed`. State persisted in Valkey at `breaker:${backend}:fail_count`, `breaker:${backend}:state`, `breaker:${backend}:probe_at`, `breaker:${backend}:probe_lock`. Defaults `CIRCUIT_FAILURE_THRESHOLD=5`, `CIRCUIT_WINDOW_MS=30000`, `CIRCUIT_COOLDOWN_MS=60000` declared in `router/src/config/env.ts:53-55` and documented in `.env.example:140-155`. `BreakerOpenError` (`router/src/errors/envelope.ts:87-296`) maps to HTTP 503 + `code: 'backend_circuit_open'`. Routes wire breaker around adapter calls: chat-completions, messages, embeddings each call `await opts.breaker.check(entry.backend)` then `recordSuccess`/`recordFailure` (verified at `embeddings.ts:192-257`, `messages.ts:277-663`). Half-open probe lock TTL = `max(CIRCUIT_COOLDOWN_MS, CLOUD_ADAPTER_TIMEOUT_MS)` per CR-03 fix (08-REVIEW-FIX). |
| 3 | `max_tokens` is hard-capped at 16,384 for cloud-served models (requests above the cap are rejected with a structured error); a `cloud_spend_daily` metric (SUM of generation_duration_ms scoped to cloud-backed requests) is recorded in Postgres and queryable. | VERIFIED | `router/src/config/constants.ts:33` exports `CLOUD_MAX_TOKENS_CAP = 16_384`. `chat-completions.ts:136-145` and `messages.ts:198-204` guard: `entry.backend === 'ollama-cloud' && body.max_tokens > CLOUD_MAX_TOKENS_CAP` throws `CloudMaxTokensExceededError` → 400 + `code: 'cloud_max_tokens_exceeded'` (per D-C1 no silent clip). Guard fires AFTER `req.resolvedBackend` stamp (so X-Model-Backend flows on 400) and BEFORE breaker.check (so caps don't waste a probe slot). `router/db/migrations/0001_cloud_spend_daily.sql:41-51` creates view `cloud_spend_daily AS SELECT date_trunc('day', ts) AS day, COUNT(*), SUM(latency_ms) AS spend_ms, COUNT(DISTINCT upstream_message_id), AVG(latency_ms) FROM request_log WHERE backend = 'ollama-cloud' GROUP BY 1 ORDER BY 1 DESC;` — idempotent (CREATE OR REPLACE VIEW). |
| 4 | `valkey/valkey:8-alpine` runs as a Compose service backing a server-side per-token-per-minute rate limit (`ratelimit:{token}:{minute}`); excess requests receive `429 Retry-After`. A small `models.yaml` cache is also served from Valkey. | VERIFIED | `compose.yml:770-806` declares `valkey` service running `valkey/valkey:8-alpine`, command `valkey-server --save 60 1 --requirepass ${VALKEY_PASSWORD} --loglevel warning`, `data` network only (no host ports), bind-mount `${HOST_DATA_ROOT}/valkey:/data`, healthcheck `valkey-cli -a $$VALKEY_PASSWORD ping | grep -q PONG`. Router joins `data` network and declares `depends_on: valkey: { condition: service_healthy, required: false }` (lines 633-685). `router/src/clients/valkey.ts:45-58` exports `makeValkeyClient` with `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, `connectTimeout: 2000`. `router/src/middleware/rateLimit.ts:67-138` exports `makeRateLimitPreHandler` using SHA-256-hashed bearer (8 hex chars per D-D2) at key `ratelimit:${hash}:${minute}` via `INCR + EXPIRE 65s`. `app.ts:251-258` registers the hook on `onRequest` after bearer auth. Excess requests throw `RateLimitExceededError` → 429 + `Retry-After: 60` stamped at `app.ts:301-309`. `ROUTER_RATE_LIMIT_RPM` default 600 in `env.ts:63` + `.env.example:165`. Registry cache at `router/src/config/registryCache.ts` (105 LOC) backs key `registry:models-yaml:cache:v1` with 30s TTL; wired into boot + `watchRegistry.onReload` at `index.ts:78,107,117,202-204`. |
| 5 | An `Idempotency-Key` header attaches retries to the in-flight stream rather than starting a new generation — a chaos test that fires N concurrent requests with the same key consumes only one GPU-stream worth of tokens and all N clients receive the same response. | VERIFIED | `router/src/resilience/idempotency.ts` (673 LOC) implements the multiplexer. `router/src/middleware/idempotencyKey.ts:22-40` validates header against `/^[A-Za-z0-9._:-]{1,256}$/`. Leader/follower role acquired via Valkey `SETNX idempotency:${key}:lock EX 1800` (30-min ceiling per D-D5). Stream branch: leader RPUSHes chunks to `idempotency:${key}:chunks` + PUBLISHes to `idempotency:${key}:channel` with `seq` watermark (CR-02 fix); followers SUBSCRIBE first, then LRANGE replay + dedupe by `seq`. Non-stream branch: SET `idempotency:${key}:result` with 15-min TTL post-finalize (D-D6) + PUBLISH 'done' (WR-05 fix tolerates partial cache/publish failure). Chunks list TTL set on first publish (WR-04 fix). `app.ts:562-574` constructs `makeIdempotencyMultiplexer` with `valkey.duplicate()` subscriber factory. Routes wire leader/follower branch at `chat-completions.ts:285-305`, `messages.ts:*`, `embeddings.ts:*` (non-stream only). Migration `0002_request_log_idempotency_key.sql:27-32` adds `idempotency_key text` column + partial btree index (CR-01 fix) so follower rows are auditable via `SELECT * FROM request_log WHERE idempotency_key = '...'`. |

**Score:** 5/5 truths VERIFIED in code

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `compose.yml` valkey service | `valkey/valkey:8-alpine`, internal-only, healthcheck, persistent volume | VERIFIED | Lines 770-806; all required fields present (image, command with --requirepass, data network, bind-mount, healthcheck via PONG check). |
| `router/src/clients/valkey.ts` | `makeValkeyClient` + `closeValkey` with fail-fast options | VERIFIED | 80 LOC; `lazyConnect: false`, `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, `connectTimeout: 2000`; `closeValkey` races 1s timeout. |
| `router/src/backends/ollama-cloud.ts` | `OllamaCloudAdapter` implements `BackendAdapter` with bearer apiKey + base URL `https://ollama.com/v1` | VERIFIED | 189 LOC; constructor throws on empty apiKey (defense in depth); `chatCompletionsCanonical`, `chatCompletionsCanonicalStream`, `embeddings`, `probeLiveness` all forward `apiKey` via OpenAI SDK Authorization header; CLOUD_ADAPTER_TIMEOUT_MS=120s; WR-03 fix redacts probe error via `truncateAndRedact`. |
| `router/models.yaml` cloud entries | `gpt-oss:120b-cloud` + `gpt-oss:20b-cloud` with `backend: ollama-cloud`, `vram_budget_gb: 0`, `concurrency: 4` | VERIFIED | Lines 106-124; both entries with `backend_url: https://ollama.com/v1`, capabilities `[chat, tools]`, max_model_len 65536 / 32768. Backends section line 26-34 declares the `ollama-cloud` group. |
| `router/src/config/registry.ts` | `LocalBackendEnum` widened with `ollama-cloud`; superRefine rejects shared-URL-across-distinct-backends (CLOUD-01 precondition) | VERIFIED | Line 23: `z.enum(['ollama', 'llamacpp', 'vllm', 'vllm-embed', 'ollama-cloud'])`. superRefine emits `Config error: backend_url "..." is shared by backends [...]` issue per Plan 08-00. |
| `router/src/config/env.ts` | OLLAMA_API_KEY optional + CIRCUIT_* + ROUTER_VALKEY_URL + ROUTER_VALKEY_PASSWORD + ROUTER_RATE_LIMIT_RPM | VERIFIED | CIRCUIT_FAILURE_THRESHOLD:5, CIRCUIT_WINDOW_MS:30000, CIRCUIT_COOLDOWN_MS:60000, ROUTER_RATE_LIMIT_RPM:600 all present; OLLAMA_API_KEY optional + cross-checked at boot via `assertCloudEnvIfConfigured` in index.ts. |
| `router/src/resilience/circuitBreaker.ts` | per-backend state machine with Valkey keys + half-open probe lock | VERIFIED | 357 LOC; state machine closed → open → half-open → closed; probe_lock TTL = max(cooldown, CLOUD_ADAPTER_TIMEOUT_MS) per CR-03 fix; `isBreakerTrip` classifies 5xx/timeout/network errors only (4xx not breaker-tripping per D-B1). |
| `router/src/resilience/idempotency.ts` | leader/follower multiplexer with pub/sub + chunks list + stream + non-stream replay | VERIFIED | 673 LOC; SETNX lock, RPUSH chunks, PUBLISH channel, follower SUBSCRIBE-then-replay with seq watermark dedupe (CR-02 fix); chunks-list TTL on first publish (WR-04); subscriber leak fix on subscribe failure (CR-04); cache/publish partial failure tolerance (WR-05). |
| `router/src/middleware/rateLimit.ts` | per-bearer-hash per-minute INCR + EXPIRE; fail-open on Valkey down; PUBLIC_PATHS skipped | VERIFIED | 138 LOC; SHA-256 bearer hash truncated to 8 hex; epoch_minute via `Math.floor(now()/60000)`; INCR + conditional EXPIRE 65s (margin for boundary race); RateLimitExceededError → 429 + Retry-After:60; WR-02 fix replaces misleading `auth.length<8` with structural `startsWith('bearer ')` check. |
| `router/src/middleware/idempotencyKey.ts` | header extraction + regex validation | VERIFIED | 40 LOC; regex `/^[A-Za-z0-9._:-]{1,256}$/`; rejects array-valued headers; `InvalidIdempotencyKeyError` sanitized via char-set whitelist before truncate (WR-01 fix). |
| `router/src/config/registryCache.ts` | get/set/clear with 30s TTL + schema re-validation | VERIFIED | 105 LOC; key `registry:models-yaml:cache:v1`; SETEX EX=30; safeParse on read (defense in depth — tampered Valkey state fails the schema gate); non-fatal Valkey error returns null. |
| `router/src/config/constants.ts` | `CLOUD_MAX_TOKENS_CAP = 16384`; `CLOUD_ADAPTER_TIMEOUT_MS = 120000` | VERIFIED | Lines 33, others; single source of truth shared between adapter and breaker. |
| `router/db/migrations/0001_cloud_spend_daily.sql` | view aggregates by day + filters `backend='ollama-cloud'` | VERIFIED | 55 LOC; CREATE OR REPLACE VIEW (idempotent); columns: day, request_count, spend_ms, distinct_generations, avg_latency_ms. |
| `router/db/migrations/0002_request_log_idempotency_key.sql` | column + partial index | VERIFIED | 32 LOC; ALTER TABLE ADD COLUMN IF NOT EXISTS; CREATE INDEX IF NOT EXISTS WHERE idempotency_key IS NOT NULL (CR-01 fix). |
| `.env.example` | OLLAMA_API_KEY, VALKEY_PASSWORD, CIRCUIT_*, ROUTER_RATE_LIMIT_RPM documented | VERIFIED | All five present with rationale comments; CIRCUIT_FAILURE_THRESHOLD=5, CIRCUIT_WINDOW_MS=30000, CIRCUIT_COOLDOWN_MS=60000, ROUTER_RATE_LIMIT_RPM=600. |
| `bin/smoke-test-cloud.sh` | 9 sections covering 10 requirement IDs; skip-clean on missing OLLAMA_API_KEY | VERIFIED | 540 LOC; `bash -n` clean; executable bit set; 22 requirement ID references; sections explicitly tagged with (ROUTE-10), (CLOUD-01,CLOUD-02), (EMBED-02), (CLOUD-04), (CLOUD-03), (ROUTE-11), (ROUTE-12), (CLOUD-05), (DATA-06). |
| `bin/smoke-test-router.sh` | extended with `=== Phase 8 — Resilience + Cloud + Telemetry ===` block | VERIFIED | `bash -n` clean; appended block before final summary, gated on Valkey running + VALKEY_PASSWORD set (backward-compat with Phase 2/3/4/5/7 callers). |
| `README.md` §Phase 8 | operator runbook (~170 lines) | VERIFIED | Line 1016: `## Phase 8 — Cloud fallback + resilience`; covers Valkey bring-up, cloud bring-up, X-Model-Backend, breaker inspect/reset, max_tokens cap, rate-limit, idempotency recipe, cloud_spend_daily, registry cache, Phase 8 smoke invocation. |

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `routes/v1/chat-completions.ts` | `OllamaCloudAdapter` | factory.makeAdapter → adapter dispatch | WIRED | Cloud entry resolves through `factory.ts` ADAPTERS map; adapter constructed with `cloudApiKey` from `env.OLLAMA_API_KEY` threaded via `MakeAdapterDeps` closure (`app.ts` line ~520). |
| `routes/v1/chat-completions.ts` (+messages, embeddings) | `circuitBreaker.ts` | `await opts.breaker.check(entry.backend)` before adapter call; `recordSuccess/Failure` around it | WIRED | Verified at embeddings.ts:192-257, messages.ts:277-663, chat-completions.ts:* (via breaker.check grep). BreakerOpenError mapped to 503 in central handler. |
| `routes/v1/chat-completions.ts` + `messages.ts` | `CLOUD_MAX_TOKENS_CAP` | `entry.backend === 'ollama-cloud' && body.max_tokens > CAP → throw CloudMaxTokensExceededError` | WIRED | Guard at chat-completions.ts:136-145 + messages.ts:198-204; throws BEFORE breaker.check (no wasted probe slots). |
| `app.ts onRequest hook chain` | `rateLimit.ts` | `app.addHook('onRequest', rateLimitPreHandler)` AFTER bearer hook | WIRED | app.ts:240 (bearer), app.ts:251-258 (rate-limit). Gate `if (opts.valkey && opts.env)` preserves test fixtures. |
| `routes/v1/*.ts` (3 files) | `idempotency.ts` | `idempotencyKey` extract → `opts.idempotency.acquire(key, req.id)` → leader/follower branch | WIRED | chat-completions.ts:258-305 (extract + acquire + branch); same shape in messages.ts + embeddings.ts. Followers' request_log row inherits leader's `upstream_message_id` (CR-01 column wired). |
| `index.ts boot` | `registryCache.ts` | `cache.get()` before file load; `watchRegistry.onReload` → `cache.set(next)` | WIRED | index.ts:78 (factory construction), 107 (boot read), 117 (boot write), 202-204 (onReload write — fire-and-forget). |
| `app.ts onSend hook` | `X-Model-Backend` header | reads `req.resolvedBackend`; sets `reply.header('X-Model-Backend', val)` | WIRED | app.ts:630-636; routes stamp `req.resolvedBackend = entry.backend` after registry.resolve (chat-completions.ts:121, messages.ts:183, embeddings.ts:125). |
| `app.ts onClose hook` | `closeValkey` | awaited BEFORE bufferedWriter.drain | WIRED | app.ts:591-604 (Phase 8 DATA-06 ordering comment + `if (opts.valkey) await closeValkey(opts.valkey, app.log)` before pg drain). |
| `cloud_spend_daily view` | `request_log` table | `FROM request_log WHERE backend = 'ollama-cloud' GROUP BY date_trunc('day', ts)` | WIRED | Migration 0001 line 48-50; reads via existing Phase 5 buffered-writer schema (backend, latency_ms, upstream_message_id all already populated). |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `OllamaCloudAdapter.chatCompletionsCanonical` | response | `await this.client.chat.completions.create({...}, {signal})` → real Ollama Cloud HTTP call to `https://ollama.com/v1/chat/completions` | Yes (real upstream) | FLOWING (when OLLAMA_API_KEY set; verifier cannot exercise without key) |
| `CircuitBreaker.check(backend)` | state | `valkey.get('breaker:${backend}:state')` + `valkey.get('breaker:${backend}:probe_at')` | Yes (real Valkey reads/writes; unit tests cover state transitions deterministically) | FLOWING |
| `cloud_spend_daily` view | row data | `SELECT FROM request_log WHERE backend='ollama-cloud'` — populated by Phase 5 bufferedWriter when cloud requests fire | Yes (DB query — empty until first cloud request fires; emptiness is FINE per Plan 08-08) | FLOWING (zero rows expected on fresh deploy; populates organically) |
| `rateLimit` middleware | count | `await valkey.incr('ratelimit:${hash}:${minute}')` | Yes (real Valkey state) | FLOWING |
| `Idempotency` followers | response body | `valkey.get('idempotency:${key}:result')` + `valkey.lrange('idempotency:${key}:chunks')` + subscriber.next() | Yes (real Valkey + pub/sub) | FLOWING |
| `registryCache.get()` | Registry | `valkey.get('registry:models-yaml:cache:v1')` → `RegistrySchema.safeParse(JSON.parse(raw))` | Yes (defense-in-depth schema re-validate on read) | FLOWING |
| `X-Model-Backend` header | backend value | `req.resolvedBackend` stamped by route after `registry.resolve(body.model)` returns `entry.backend` | Yes (real registry lookup) | FLOWING |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Test suite passes baseline | `cd router && npm test` | 683 passed / 7 skipped / 690 total (third run; runs 1+2 hit flake `tests/integration/hotreload.vram.test.ts > VRAM violation: ...`) | PASS (with note: pre-existing flake from Phase 3 commit `933a802`; passes 100% in isolation; matches 08-REVIEW-FIX.md declared baseline) |
| Build is clean | `cd router && npm run build` | `dist/index.js 189.23 KB; ESM Build success in 43ms` | PASS (matches 08-REVIEW-FIX.md size) |
| Smoke scripts syntax-clean | `bash -n bin/smoke-test-cloud.sh && bash -n bin/smoke-test-router.sh` | Both syntax-clean | PASS |
| Smoke script is executable | `test -x bin/smoke-test-cloud.sh` | -rwxrwxr-x | PASS |
| Smoke covers all 10 requirement IDs | `grep -c 'ROUTE-10\|ROUTE-11\|ROUTE-12\|CLOUD-01\|CLOUD-02\|CLOUD-03\|CLOUD-04\|CLOUD-05\|DATA-06\|EMBED-02' bin/smoke-test-cloud.sh` | 22 mentions across 9 sections | PASS |
| Migrations exist + idempotent | `ls router/db/migrations/0001_cloud_spend_daily.sql router/db/migrations/0002_request_log_idempotency_key.sql` | Both present; both use `CREATE OR REPLACE` / `IF NOT EXISTS` | PASS |
| Valkey service block matches contract | `grep 'valkey/valkey:8-alpine' compose.yml` | Line 775 matches; networks: [data]; no published ports | PASS |
| All 10 requirement IDs marked Complete in REQUIREMENTS.md | `grep 'Phase 8' .planning/REQUIREMENTS.md` | All 10 IDs: CLOUD-01..05, DATA-06, ROUTE-10..12, EMBED-02 → Complete | PASS |

## Probe Execution

No conventional probe scripts at `scripts/*/tests/probe-*.sh`; Phase 8 is not a migration/tooling phase. The gate is `bin/smoke-test-cloud.sh` + `bin/smoke-test-router.sh §Phase 8` — both syntax-clean, both require a live docker-compose stack (postgres + valkey + ollama + router healthy), which the verifier sandbox cannot provide. Routed to **Step 8 human verification** below.

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| `bin/smoke-test-cloud.sh` | `bash bin/smoke-test-cloud.sh` (requires live stack + optional OLLAMA_API_KEY) | NOT RUN | SKIP_HUMAN (operator UAT) |
| `bin/smoke-test-router.sh` (§Phase 8 block) | `bash bin/smoke-test-router.sh` (requires live stack) | NOT RUN | SKIP_HUMAN (operator UAT) |

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| CLOUD-01 | 08-00 (precondition), 08-02 (impl) | Cloud as `backend: ollama-cloud` with bearer auth from `.env` | SATISFIED | `LocalBackendEnum` widened in `registry.ts:23`; superRefine rejects shared-URL ambiguity (08-00); `OllamaCloudAdapter` ctor enforces apiKey; `assertCloudEnvIfConfigured` boot gate. |
| CLOUD-02 | 08-02 | Cloud routes transparently — same endpoints, same auth, same SSE shape | SATISFIED | Adapter uses canonical translation (Plan 04); `/v1/messages` reaches cloud through same pipeline as local (D-A3); no protocol-gated cloud restriction in any route file. |
| CLOUD-03 | 08-04 | Per-backend circuit breaker N failures in M seconds → cooldown | SATISFIED | `circuitBreaker.ts` 357 LOC; per-backend Valkey keys; half-open probe lock; BreakerOpenError → 503; CIRCUIT_FAILURE_THRESHOLD=5, CIRCUIT_WINDOW_MS=30000, CIRCUIT_COOLDOWN_MS=60000 defaults. |
| CLOUD-04 | 08-05 | `max_tokens` hard-capped at 16,384 for cloud-served models | SATISFIED | `CLOUD_MAX_TOKENS_CAP=16384`; CloudMaxTokensExceededError → 400 + `cloud_max_tokens_exceeded`; gated on `entry.backend === 'ollama-cloud'` (local models unaffected). |
| CLOUD-05 | 08-08 | `cloud_spend_daily` Postgres view (sum generation_duration_ms scoped to cloud) | SATISFIED | Migration `0001_cloud_spend_daily.sql`; SUM(latency_ms) per day; idempotent CREATE OR REPLACE. |
| DATA-06 | 08-01 (infra), 08-09 (cache) | Valkey runs as Compose service backing rate-limit counters + models.yaml cache | SATISFIED | `valkey/valkey:8-alpine` in compose; ioredis singleton in `clients/valkey.ts`; registryCache TTL=30s + watchRegistry write-through. |
| ROUTE-10 | 08-03 | `X-Model-Backend` response header on all routed responses | SATISFIED | `onSend` hook in `app.ts:630-636`; three routes stamp `req.resolvedBackend`; integration test `x-model-backend.test.ts` (referenced in Plan 08-03). |
| ROUTE-11 | 08-06 | Per-bearer-token-per-minute rate limit; 429 + Retry-After | SATISFIED | `rateLimit.ts` 138 LOC; bearer SHA-256 hash; `INCR + EXPIRE 65s`; `RateLimitExceededError` → 429 + `Retry-After: 60` stamped centrally. |
| ROUTE-12 | 08-07 (impl) + CR-01 fix (audit) | `Idempotency-Key` multiplexer; concurrent same-key collapses to one upstream | SATISFIED | `idempotency.ts` 673 LOC; leader/follower; SETNX lock, RPUSH chunks, PUBLISH+SUBSCRIBE; `request_log.idempotency_key` column added per CR-01 so dedup is auditable. |
| EMBED-02 | 08-02 | Ollama Cloud embeddings passthrough (deferred from Phase 7) | SATISFIED | `OllamaCloudAdapter.embeddings()` lines 157-182 — one-line passthrough to `https://ollama.com/v1/embeddings`; same shape as `OllamaOpenAIAdapter.embeddings()`. |

**Orphaned requirements:** None. All 10 requirement IDs mapped to Phase 8 in REQUIREMENTS.md appear in at least one plan's `requirements:` frontmatter field.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| router/src/backends/ollama-cloud.ts | 59 | "literal 'ollama' placeholder" comment | Info | False positive — the word "placeholder" refers to the existing local adapter's literal `'ollama'` string placeholder used as apiKey (no auth on local). NOT a debt marker. |
| (all Phase 8 files) | — | TBD / FIXME / XXX debt markers | None | Grep returns zero matches across `ollama-cloud.ts`, `clients/valkey.ts`, `circuitBreaker.ts`, `idempotency.ts`, `rateLimit.ts`, `idempotencyKey.ts`, `registryCache.ts`, `constants.ts`, both new migration SQL files. No blocker debt. |
| router/tests/app/probe-adapter.test.ts | 104-105 | TS2367 no-overlap comparison in test fixture | Info | Documented in deferred-items.md as out-of-scope for Phase 8 (pre-existing — vitest tolerates; build is transpile-only). |
| router/tests/routes/circuit-breaker-integration.test.ts | 228, 499 | TS2741 missing ROUTER_RATE_LIMIT_RPM in test env literal | Info | Documented in deferred-items.md as out-of-scope (vitest tolerates; build is transpile-only). |

## Human Verification Required

**Phase 8 closure is gated on the operator running both smoke scripts against a live stack** — this is intentional per Plan 08-10 Task 2 (autonomous: false), mirroring the Phase 7 Plan 07-06 task 3 pattern. The verifier sandbox cannot exercise this path because it has no live Docker daemon, no GPU host, no `OLLAMA_API_KEY`, and no reachable router/valkey/postgres/ollama services.

### Operator Recipe (8-step checklist from 08-10-SUMMARY.md)

**Prerequisites (one-time setup):**

1. `.env` populated with:
   - `ROUTER_BEARER_TOKEN` (existing, Phase 2)
   - `POSTGRES_PASSWORD` (existing, Phase 5)
   - `VALKEY_PASSWORD` (Phase 8 — generate once: `echo "VALKEY_PASSWORD=$(openssl rand -hex 24)" >> .env`)
   - `OLLAMA_API_KEY` (OPTIONAL — for Sections 2 + 3 of the cloud smoke; skip-clean if empty)

2. Stack reachable:
   ```bash
   docker compose up -d postgres valkey ollama router
   docker compose ps   # expect all 4 healthy
   ```

**Step 1 — Canonical smoke**

```bash
bash bin/smoke-test-router.sh
```

Expected: exit 0 + final line `Phase 2/3/4/5/7/8 router verification: COMPLETE.` Every Section reports PASS (up to ~3 SKIPs for profile-gated vLLM checks if `--profile vllm` not active — acceptable, unrelated to Phase 8). The Phase 8 block prints 12-14 PASS lines under `=== Phase 8 — Resilience + Cloud + Telemetry ===`.

On any FAIL inspect: `docker compose logs router | tail -100`, `docker compose logs valkey | tail -50`, `docker compose exec -T valkey valkey-cli -a $VALKEY_PASSWORD KEYS '*'`.

**Step 2 — Dedicated cloud smoke**

```bash
bash bin/smoke-test-cloud.sh
```

- With `OLLAMA_API_KEY` set: exit 0 + all 9 sections PASS + 0 SKIPs (modulo bge-m3 not pulled → 1 SKIP in Section 1).
- With `OLLAMA_API_KEY` empty: exit 0 + Sections 1, 4-9 PASS + Sections 2 + 3 SKIP (2 SKIPs counted; 0 FAILs).

**Step 3 — Manual eyeball**

a) Valkey keys populated:
```bash
docker compose exec -T valkey valkey-cli -a "${VALKEY_PASSWORD}" KEYS '*'
```
Expected: at least `registry:models-yaml:cache:v1`. `breaker:*`, `ratelimit:*`, `idempotency:*` only if recently exercised.

b) cloud_spend_daily view exists:
```bash
docker compose exec -T postgres psql -U app -d router -c "\d+ cloud_spend_daily"
```
Expected: view definition prints (rows may be empty — FINE).

c) (Optional) Cloud chat X-Model-Backend header:
```bash
curl -fsS -D - -o /dev/null \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-oss:20b-cloud","messages":[{"role":"user","content":"hi"}],"stream":false}' \
  http://127.0.0.1:3000/v1/chat/completions \
  | grep -i 'x-model-backend'
```
Expected: `X-Model-Backend: ollama-cloud`

**Step 4 — Reply `approved`**

If all three steps pass cleanly: reply `approved` and Phase 8 closes.

Common remediations on FAIL:
- Section 9 registry cache empty → `docker compose restart router`; re-run after 5s
- Section 5/6 envelope code mismatch → check `router/src/errors/envelope.ts` canonical codes
- Section 7 distinct_upstream_message_ids != 1 → `docker compose logs router | grep -i idempotency`
- Sections 2 + 3 SKIP without explanation → confirm `OLLAMA_API_KEY` in `.env` + `docker compose restart router`

## Gaps Summary

**No code-level gaps.** All 5 ROADMAP Success Criteria are observably satisfied in the codebase: artifacts exist, are substantive, are wired into the request path, and produce real data flow. All 10 Phase 8 requirement IDs (CLOUD-01..05, DATA-06, ROUTE-10..12, EMBED-02) are mapped to plans and implemented. Code review surface (4 critical + 7 warning) is fully closed per 08-REVIEW-FIX.md (commits `2547461`, `e774adf`, `0d410d4`, `499c1ac`, `f8d7473`, `7b64b81`, `76e9c03`, `9cc5e55`, `f25a8b8`, `3764a94`, `bd66efd`). Tests: 683/690 passing matches the declared post-fix baseline (the single timeout flake in `tests/integration/hotreload.vram.test.ts` is a pre-existing Phase 3 artifact — owned by commit `933a802`, passes 100% in isolation, third full-suite run was clean).

**Phase 8 closure gate is exclusively operator UAT.** Plan 08-10 Task 2 was deferred to PENDING-HUMAN by design (executor lacks live Docker/GPU/OLLAMA_API_KEY/cloud-reachability — same pattern as Phase 7 Plan 07-06 task 3). The 4-step operator recipe above is the prescriptive close. Status: `human_needed`.

---

*Verified: 2026-05-17T19:00:00Z*
*Verifier: Claude (gsd-verifier)*
