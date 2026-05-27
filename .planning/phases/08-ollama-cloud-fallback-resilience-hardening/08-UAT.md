---
status: complete
phase: 08-ollama-cloud-fallback-resilience-hardening
source: [08-00-SUMMARY.md, 08-01-SUMMARY.md, 08-02-SUMMARY.md, 08-03-SUMMARY.md, 08-04-SUMMARY.md, 08-05-SUMMARY.md, 08-06-SUMMARY.md, 08-07-SUMMARY.md, 08-08-SUMMARY.md, 08-09-SUMMARY.md, 08-10-SUMMARY.md]
started: 2026-05-27T00:00:00Z
updated: 2026-05-27T12:35:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: |
  Run: docker compose restart router && sleep 6 && curl -s http://127.0.0.1:3210/readyz; echo
  Then: docker compose logs router --since 40s | grep -iE 'migrat|listen|error|cache'
  Router comes back healthy, /readyz returns a ready/ok JSON (200), boot logs show
  migrations applied (incl. 0001_cloud_spend_daily) and the server listening, with no errors.
result: issue
reported: "Cold-start core passes (migrate_ok, server listening, 12 models, ollama+cloud+postgres alive; /readyz not_ready is expected — GPU backends intentionally down). BUT on router restart the boot-path registry cache get AND set both failed: 'Stream isn't writeable and enableOfflineQueue options is false' → warm cache miss → loaded from file → cache set failed (non-fatal). DATA-06 warm cache not populated on cold start; same 'Stream isn't writeable' ioredis race class as the idempotency bug fixed in 1737bd3, on the registryCache boot path."
severity: minor

### 2. X-Model-Backend response header (ROUTE-10)
expected: |
  Run: curl -is http://127.0.0.1:3210/v1/chat/completions \
    -H "Authorization: Bearer $ROUTER_BEARER_TOKEN" -H "Content-Type: application/json" \
    -d '{"model":"llama3.2:3b-instruct-q4_K_M","messages":[{"role":"user","content":"hi"}],"max_tokens":4}' | grep -i x-model-backend
  Response carries header `X-Model-Backend: ollama` (the local backend that served it).
result: pass

### 3. Ollama Cloud chat round-trip (CLOUD-01 / CLOUD-02)
expected: |
  Run: curl -is http://127.0.0.1:3210/v1/chat/completions \
    -H "Authorization: Bearer $ROUTER_BEARER_TOKEN" -H "Content-Type: application/json" \
    -d '{"model":"gpt-oss:20b-cloud","messages":[{"role":"user","content":"Say only the word OK"}],"max_tokens":8}'
  Returns 200 with non-empty assistant content AND header `X-Model-Backend: ollama-cloud`.
  The client never had to know the request left the box — transparent cloud fallback.
result: pass
note: "200 + x-model-backend: ollama-cloud confirmed. max_tokens:8 yielded empty content/finish=length (gpt-oss reasoning tokens ate the tiny budget — model artifact, not router); max_tokens:256 returned content='OK' finish=stop."

### 4. Cloud max_tokens cap → 400 (CLOUD-04)
expected: |
  Run: curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3210/v1/chat/completions \
    -H "Authorization: Bearer $ROUTER_BEARER_TOKEN" -H "Content-Type: application/json" \
    -d '{"model":"gpt-oss:20b-cloud","messages":[{"role":"user","content":"hi"}],"max_tokens":99999}'
  Returns HTTP 400 (NOT silently clipped). Body has error.code = "cloud_max_tokens_exceeded".
  Cap is the global 16384 ceiling; the client is told its request was rejected, never quietly modified.
result: pass

### 5. Resilience trio — breaker + rate limit + idempotency (CLOUD-03 / ROUTE-11 / ROUTE-12)
expected: |
  Run: bash bin/smoke-test-cloud.sh   (reads ROUTER_BEARER_TOKEN + VALKEY_PASSWORD from .env)
  Section 5 (breaker): pre-seeds breaker:ollama-cloud:state=open → cloud request gets 503 +
    error.code "backend_circuit_open" + numeric Retry-After. Local backend unaffected.
  Section 6 (rate limit): over-budget counter → 429 + error.code "rate_limit_exceeded" + Retry-After: 60.
  Section 7 (idempotency): 3 concurrent same-Idempotency-Key requests return byte-identical bodies;
    request_log shows 3 rows sharing 1 upstream_message_id (followers reused the leader's generation).
  All three sections report PASS; script exits 0.
result: pass
note: "Run with ROUTER_URL=http://127.0.0.1:3210 (script default 3000 is the in-container port). Overall '✓ Phase 8 smoke PASS'. S5/S6/S7 all PASS. Also cross-validated: S1 X-Model-Backend (chat/messages/embeddings), S2 cloud chat 'OK', S4 max_tokens cap incl. 16384 boundary, S8 cloud_spend_daily exists (COUNT=4). S3 EMBED-02 SKIP (no cloud embed entry). S9 registry cache SKIP — key empty, confirms Test 1 boot-race finding."

### 6. cloud_spend_daily Postgres view (CLOUD-05)
expected: |
  Run: docker compose exec -T postgres psql -U app -d router -c "SELECT * FROM cloud_spend_daily;"
  The view exists and returns per-day aggregation of cloud-backend latency (spend_ms) — rows appear
  for days where ollama-cloud was used (Test 3 should produce today's row). No error about a missing relation.
result: pass
note: "View richer than spec (adds request_count, distinct_generations, avg_latency_ms). 4 rows incl. today (2026-05-27: 11 req, 7948ms, avg 723ms). Observation: distinct_generations=0 on all rows (upstream_message_id appears unpopulated for cloud rows) — core spend tracking works; flagged for awareness, not logged as a gap."

### 7. Valkey warm registry cache (DATA-06)
expected: |
  Run: docker compose exec -T valkey valkey-cli -a "$VALKEY_PASSWORD" --no-auth-warning GET registry:models-yaml:cache:v1 >/dev/null && \
       docker compose exec -T valkey valkey-cli -a "$VALKEY_PASSWORD" --no-auth-warning TTL registry:models-yaml:cache:v1
  Key registry:models-yaml:cache:v1 is present and TTL returns a value ≤ 30 (seconds). The registry
  is served read-through from Valkey, not re-parsed from disk on every request.
result: issue
reported: "Steady-state cache absent: EXISTS=0 / TTL=-2 even after dozens of requests across Tests 2-6 + full smoke run. Only boot-path and watcher onReload call set(); request path uses in-memory registry.get() and never repopulates on miss. Boot set fails (Test 1 race) → cache stays empty until a models.yaml change. touch models.yaml repopulated it (EXISTS=1, TTL=15). Router fully functional via in-memory fallback, but DATA-06 Valkey warm cache is dead in normal operation. Sub-notes: TTL=15 after fresh EX 30 set is unexpected; 30s TTL is marginal for restart-survival since restarts exceed 30s."
severity: minor

### 8. Cloud embeddings passthrough (EMBED-02)
expected: |
  EMBED-02 shipped as a one-line passthrough in OllamaCloudAdapter.embeddings(), but no cloud
  embedding model is declared in router/models.yaml (skip-by-design per 08-VERIFICATION). Unless you
  add a cloud embed entry, this is expected to be SKIPPED — reply "skip" if there's no cloud embed model to hit.
result: skipped
reason: "Skip-by-design. No cloud embedding model in models.yaml; Ollama Cloud catalog is chat-focused (gpt-oss). bge-m3 fits local VRAM so cloud embeddings have no use case in this single-host stack. Passthrough code shipped (one-liner mirroring local Ollama embeddings adapter); /v1/embeddings X-Model-Backend validated locally (smoke S1). DEFERRED: if a cloud embed model is ever needed, add a models.yaml entry (backend: ollama-cloud, capabilities: [embeddings]) and re-run smoke S3."

## Summary

total: 8
passed: 5
issues: 2
pending: 0
skipped: 1
blocked: 0

## Gaps

- truth: "On cold start, the Valkey warm registry cache (registry:models-yaml:cache:v1, DATA-06) is populated so the registry is served from cache rather than re-parsed from disk."
  status: failed
  reason: "User reported: boot-path registry cache get AND set both failed at router restart — 'Stream isn't writeable and enableOfflineQueue options is false'. Router fell back to file (fail-open, non-fatal), so warm cache was not populated on cold start and the failed set means it won't self-heal until re-triggered. Same 'Stream isn't writeable' ioredis-not-ready race as the idempotency bug fixed in commit 1737bd3, on the registryCache boot path in buildApp."
  severity: minor
  test: 1
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""

- truth: "DATA-06: registry:models-yaml:cache:v1 is served read-through from Valkey (present with TTL <= 30s) during normal operation, not re-parsed from disk every request."
  status: failed
  reason: "User reported: cache key absent (EXISTS=0/TTL=-2) in steady state even after many requests + full smoke run. set() is only called on boot path and watcher onReload; the request path reads an in-memory registry.get() snapshot and never repopulates the Valkey cache on miss. Combined with the failed boot set (Test 1 race), the warm cache stays empty until a models.yaml change (touch repopulated it: EXISTS=1, TTL=15). Router stays functional via in-memory fallback, so the Valkey warm-cache optimization is defeated in normal operation. Sub-notes: TTL=15 immediately after a fresh EX 30 set is unexpected; 30s TTL is marginal for a restart-survival cache."
  severity: minor
  test: 7
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""
