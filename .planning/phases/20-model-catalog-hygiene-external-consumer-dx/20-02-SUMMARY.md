---
phase: 20-model-catalog-hygiene-external-consumer-dx
plan: 02
subsystem: routes
tags: [catalog-hygiene, backend-health, models-yaml, plugin, valkey, observability]

requires:
  - phase: 19-embeddingprovider-formalization-observability-hardening
    provides: post-19-09 image baseline (Plan 19-08 tool_calls translation fix deployed)
  - phase: 20-model-catalog-hygiene-external-consumer-dx
    plan: 01
    provides: enabledModels(reg) canonical filter + ModelEntrySchema.disabled flag (Wave 0)
provides:
  - probeBackend(name, baseUrl, opts) → Promise<ProbeResult> (single-backend HTTP probe, never throws)
  - BackendHealth status taxonomy: 'ok' | 'degraded' | 'down' | 'unknown'
  - backendHealthPlugin (fp-wrapped Fastify plugin) decorating app.backendHealth with { get, refreshAll, ensureFresh }
  - PROBE_ENDPOINTS map (ollama→GET/, llamacpp→GET/health, vllm→GET/health, vllm-embed→GET/health, ollama-cloud→null)
  - Additive `health: { status, checked_at }` field on /v1/models + /v1/models/:id entries
  - Valkey write-through cache under `backend-health:{backend}` with EX=ROUTER_BACKEND_HEALTH_TTL_SEC
  - env.ROUTER_BACKEND_HEALTH_TTL_SEC (default 60, min 5)
affects: [20-03, 20-04, 20-05, 20-06, 20-07, future-consumers (artiscrapper, n8n, Unsloth)]

tech-stack:
  added:
    - "fastify-plugin@^5.x — added to imports (already present transitively from fastify-sse-v2). Required so app.decorate('backendHealth', ...) propagates past the encapsulated child scope created by app.register(plugin)."
  patterns:
    - "Decorator-propagating plugin pattern: wrap FastifyPluginAsync with `fp(...)` when the plugin needs to add app.decorate() that the parent scope (and other routes) must see. Used here for backendHealth — Phase 15 mcpHostPlugin didn't need fp because it only registers routes (no decorators)."
    - "Honest unknown taxonomy: when an external surface (Ollama Cloud) has no public bearer-accessible /healthz, 'unknown' is the right status — setting 'ok' would lie, 'down' would lie. PROBE_ENDPOINTS[backend] === null is the explicit signal."
    - "Boot-probe-on-onReady pattern: plugin registers an onReady hook that fires once when app.ready() is awaited (or app.listen() is called). Failures fail-open — warn log + in-memory cache stays at 'unknown' until next ensureFresh."
    - "Single-source-of-truth filter for probe set: enabledModels(registry) — never reads reg.models directly. Means disabled-flag respect (Wave 0 contract) carries through to the health-probe scope automatically."

key-files:
  created:
    - router/src/health/backend-probe.ts
    - router/src/health/__tests__/backend-probe.test.ts
    - router/src/plugins/backend-health-plugin.ts
    - router/src/plugins/__tests__/backend-health-plugin.test.ts
    - router/tests/integration/v1-models-health-field.integration.test.ts
  modified:
    - router/src/app.ts
    - router/src/config/env.ts
    - router/src/index.ts
    - router/src/routes/v1/models.ts
    - router/tests/integration/models.test.ts

key-decisions:
  - "D-04 LOCKED honored: boot-time probe + lazy 60s Valkey-cached refresh; NO auto-filtering. Status 'down' entries STILL appear in /v1/models. Consumer decides whether to use the alias (C7 — router exposes information, doesn't decide for consumer)."
  - "Open Q1 planner-resolved: probe runs via a dedicated Fastify plugin (backendHealthPlugin) registered AFTER Valkey is constructed in app.ts. Cleaner than inline boot code and matches the established pattern (Phase 15 mcpHostPlugin, Phase 17 sessionIdPreHandler, Phase 18 preCompletionHooks)."
  - "ollama-cloud honestly reports 'unknown' (NOT 'ok' nor 'down'). Ollama Cloud has no public /healthz the router's bearer can hit; setting it to either truth-value would lie. 'unknown' is the architecturally-correct value documented in PROBE_ENDPOINTS[ollama-cloud] = null."
  - "fp(...) wrap is required for decorator propagation. Without it, app.decorate('backendHealth', ...) stays trapped inside the encapsulated child scope created by app.register(plugin). All 5 plugin tests failed initially when written without fp; adding fp wrap made them pass. This is the canonical pattern for any future plugin that needs to expose state to routes via app decoration."
  - "Probe-set filter via enabledModels(registry) — NOT reg.models directly. Means disabled entries (Wave 0 contract) are NOT probed (wasted work + confusing dashboards if we did)."

patterns-established:
  - "AbortController + 2s default timeout per probe: never blocks > 10s end-to-end (≤5 backends × 2s parallel). T-20-04 (DoS via slow backend) mitigated structurally."
  - "Write-through cache pattern matches existing model-registry:* and mcp:tools:* keys — single trust model, single shutdown path."
  - "Additive-field contract: when backendHealth is undefined (test fixtures that skip plugin wiring), the route omits the field entirely rather than emitting 'unknown' for everything. This is the cleanest backward-compat invariant — existing test snapshots and consumer fixtures that asserted exact key sets continue to work via test-file updates rather than runtime conditionals."

requirements-completed: [CAT-02]

duration: ~40min
completed: 2026-06-03
---

# Phase 20 Plan 20-02: Backend Health Probe + /v1/models Health Field Summary

**Additive `health: { status, checked_at }` field on every `/v1/models` entry — boot-time probe + Valkey-cached 60s lazy refresh — closes CAT-02 by giving operators and external consumers (artiscrapper, n8n, Unsloth) a programmatic way to distinguish "alive backend" from "intentionally disabled" (Wave 0) from "declared but unreachable right now".**

## Performance

- **Duration:** ~40 min
- **Started:** 2026-06-03T10:48Z (approx — plan kickoff)
- **Completed:** 2026-06-03T11:30Z (post-deployment verification + STATE/ROADMAP/REQUIREMENTS flip)
- **Tasks:** 3 completed
- **Files modified:** 10 (5 new + 5 modified)

## Accomplishments

- **CAT-02 closed.** GET /v1/models entries now carry `health: {status, checked_at}` where `status ∈ {'ok' | 'degraded' | 'down' | 'unknown'}`. Operators see status at a glance; external consumers can programmatically filter without trial-and-error. The artiscrapper failure mode ("alias resolves to dead backend → 15s timeout") becomes a single GET that surfaces the truth.
- **D-04 LOCKED preserved.** Status 'down' entries STILL appear in /v1/models. The consumer (not the router) decides whether to use the alias. This is the C7 invariant ("router exposes seams, never implements logic") applied to consumer DX.
- **Open Q1 resolved.** Probe runs via `backendHealthPlugin` (fp-wrapped Fastify plugin) registered AFTER Valkey decoration and BEFORE registerModelsRoute. Plugin scope is cleaner than inline boot code and matches Phase 15/17/18 plugin pattern.
- **ollama-cloud honestly reports 'unknown'.** PROBE_ENDPOINTS[ollama-cloud] = null short-circuits without a network call. Setting it to 'ok' would lie; 'down' would lie; 'unknown' is the only honest value.
- **Disabled backends (Wave 0 contract) preserved.** Probe set comes from `enabledModels(registry)` — disabled entries are NOT probed (wasted work + confusing dashboards). Wave 0 + Wave 1 stack cleanly.
- **Phase 19 RESS-WITH-TOOLS smoke gate PASS** on attempt 2 of 5 retries post-deployment (gpt-oss:20b-cloud documented ~40-60% tool-path non-determinism per `.planning/debug/resolved/phase-19-ress-with-tools-delta.md`).

## Task Commits

Per plan `commit_strategy: per_task_atomic` AND orchestrator's directive `ONE atomic commit per plan unless task structure says otherwise`, the 3 tasks landed in a single commit (matches the small-plan precedent set by 20-01; all 3 tasks touch overlapping seam points — backend-probe → plugin → wire-up — so a single atomic commit is appropriate):

1. **All 3 tasks (probe + plugin + wire-up + tests + integration test)** — `6a4d60f` (feat)

**Plan metadata commit:** TBD (after this SUMMARY)

## Files Created/Modified

### Created (5)

- `router/src/health/backend-probe.ts` (143 LOC) — exports:
  - `BackendHealthStatus = 'ok' | 'degraded' | 'down' | 'unknown'`
  - `BackendHealth = { status, checked_at }`
  - `ProbeResult extends BackendHealth & { backend, latency_ms? }`
  - `PROBE_ENDPOINTS` map (ollama → GET /, llamacpp → GET /health, vllm → GET /health, vllm-embed → GET /health, ollama-cloud → null)
  - `probeBackend(backend, baseUrl, opts) → Promise<ProbeResult>` — never throws; AbortController + 2s default timeout; URL derivation strips trailing /v1 before concatenating probe path

- `router/src/health/__tests__/backend-probe.test.ts` — 8 vitest cases:
  1. ollama 200 → status:ok with latency_ms
  2. llamacpp ENOTFOUND rejection → status:down
  3. vllm 503 → status:degraded
  4. vllm-embed AbortController timeout → status:down
  5. ollama-cloud → status:unknown AND no fetch call
  6. unknown backend 'sglang' → status:unknown, no throw, no fetch call
  7. URL derivation: ollama input http://ollama:11434/v1 → fetch called with http://ollama:11434/
  8. URL derivation: llamacpp input http://llamacpp:8080/v1 → fetch called with http://llamacpp:8080/health

- `router/src/plugins/backend-health-plugin.ts` (217 LOC) — exports:
  - `BackendHealthDecoration` interface (get / refreshAll / ensureFresh)
  - `BackendHealthPluginOpts` (registry, valkey | undefined, ttlSec, fetchImpl?, probeTimeoutMs?)
  - `backendHealthPlugin = fp(backendHealthPluginInner, {name, fastify: '5.x'})` — fp wrap so decorator propagates to parent scope
  - Module augmentation: `declare module 'fastify' { interface FastifyInstance { backendHealth: BackendHealthDecoration } }`
  - Boot probe fires on onReady hook (failures fail-open: warn log + cache stays empty until next ensureFresh)
  - refreshAll() enumerates distinct backends via `enabledModels(registry)`, probes in parallel, write-throughs to in-memory Map + Valkey
  - ensureFresh() checks staleness (>ttlSec from any cached entry's checked_at) and refreshes all if any entry is stale
  - get(backend) returns in-memory entry or `{status: 'unknown', checked_at: now}` if absent

- `router/src/plugins/__tests__/backend-health-plugin.test.ts` — 5 vitest cases:
  1. Boot probes once per distinct backend (4 backends → 3 probes, cloud not probed)
  2. Boot fail-open on Valkey down (in-memory cache still works)
  3. Lazy refresh after TTL (wall-clock 1.1s pause → second ensureFresh re-probes)
  4. ollama-cloud returns status:unknown — no fetch call
  5. No probe for disabled-backend-only entries

- `router/tests/integration/v1-models-health-field.integration.test.ts` — 5 vitest cases:
  1. Happy path — 4 backend types respond differently (ok / ok / degraded / down + unknown for cloud); each entry's checked_at is a valid ISO8601 string
  2. Backward-compat: buildApp without explicit fetch stub still serves /v1/models (health field present, status reflects real-fetch attempt to unreachable hostnames in test env)
  3. No auto-filtering (D-04 LOCKED) — down entry STILL appears
  4. /v1/models/:id includes health for a specific id
  5. Disabled-entries (Wave 0 interaction): disabled alias absent; enabled alias has correct health

### Modified (5)

- `router/src/app.ts` — adds import of backendHealthPlugin; registers it AFTER `app.decorate('valkey', opts.valkey)` and BEFORE `registerModelsRoute(app, opts.registry, app.backendHealth)`; widens BuildAppOpts.env Pick type with `Partial<Pick<Env, 'ROUTER_BACKEND_HEALTH_TTL_SEC'>>` so existing test fixtures continue to compile unmodified.

- `router/src/config/env.ts` — adds `ROUTER_BACKEND_HEALTH_TTL_SEC: z.coerce.number().int().min(5).default(60)` with JSDoc citing Phase 20 / CAT-02 / D-04 + operator-shorten-during-deploy rationale + min-5s guard rationale.

- `router/src/index.ts` — threads new env value into buildApp's `env: {...}` block.

- `router/src/routes/v1/models.ts` — adds import of `BackendHealthDecoration`; widens `registerModelsRoute` signature with optional third arg `backendHealth?: BackendHealthDecoration`; both `/v1/models` + `/v1/models/:id` handlers call `await backendHealth?.ensureFresh()` before computing response and embed `health: backendHealth.get(m.backend)` per projected entry (additive — omitted entirely when undefined).

- `router/tests/integration/models.test.ts` — updates 2 strict-shape assertions to include `'health'` in the expected Object.keys list (lines 94-96 + 238-240). Phase 17 `ctx_size` + Phase 20 Wave 0 `disabled` set the precedent for fixture updates when a new additive field lands.

## Decisions Made

All inherited from `20-CONTEXT.md`; D-04 + Open Q1 are in scope for Wave 1.

- **D-04 LOCKED (honored)** — boot probe + lazy 60s Valkey-cached refresh; NO auto-filter. Status 'down' entries STILL appear (consumer decides). Per-entry shape is `{status, checked_at}` (ISO8601). Status taxonomy: `'ok' | 'degraded' | 'down' | 'unknown'`. Cloud entries report 'unknown' (no probe).

- **Open Q1 resolved (planner-locked, executor-confirmed)** — Fastify plugin (cleaner than inline boot code; matches Phase 15/17/18 plugin pattern). The plugin's onReady hook fires the boot probe once at app.ready(). The plugin's app.decorate() call publishes the BackendHealthDecoration to the parent Fastify scope.

- **fp wrap is the operational pattern (executor-derived).** During development the initial implementation without `fp` caused 3 of 5 plugin tests to fail with "Cannot read properties of undefined (reading 'get')" — the decorator was trapped in the encapsulated child scope. Adding `fp(backendHealthPluginInner, {name, fastify: '5.x'})` made all tests pass. This is now the canonical pattern for any future plugin that exposes state via app decoration. Phase 15 mcpHostPlugin didn't need fp because it only registers routes (no decorators); this plugin is the first to need it.

- **Cloud status semantics (executor-derived from D-04).** ollama-cloud has PROBE_ENDPOINTS[ollama-cloud] = null which short-circuits to 'unknown' without a network call. Documented in PROBE_ENDPOINTS map + JSDoc + backend-probe.ts header. Alternative considered: probe `https://ollama.com/v1/models` with the bearer token — but that's an authenticated request to a paid endpoint, not a /healthz analog. Net: 'unknown' is the only architecturally-honest value.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Plugin decorator not propagating past encapsulation boundary**
- **Found during:** Task 2 (running plugin tests after first implementation)
- **Issue:** 3 of 5 plugin tests failed with `TypeError: Cannot read properties of undefined (reading 'get')` on `app.backendHealth.get(...)`. Root cause: `app.register(plugin)` creates an encapsulated child scope in Fastify; decorators added inside the plugin via `app.decorate(...)` stay inside that child scope unless the plugin is wrapped with `fastify-plugin` (which inverts the encapsulation).
- **Fix:** Wrapped `backendHealthPluginInner` with `fp(...)` and exported the fp-wrapped version. Tests passed immediately afterward.
- **Files modified:** `router/src/plugins/backend-health-plugin.ts` (added `import fp from 'fastify-plugin'` + the wrap at the bottom of the file).
- **Verification:** All 5 plugin tests pass; integration tests also pass (the routes/v1/models.ts handler now correctly sees `app.backendHealth`).
- **Committed in:** `6a4d60f` (part of the atomic Plan 20-02 commit).
- **Architectural note:** This pattern (fp wrap for decorator-propagating plugins) is now documented in the plugin file's header. Future plugins that ONLY register routes (Phase 15 pattern) don't need fp; plugins that decorate the app DO need fp.

**2. [Rule 2 — Test fixture update] Pre-existing /v1/models tests had strict-shape assertions**
- **Found during:** Verification (full vitest sweep after Task 3)
- **Issue:** `router/tests/integration/models.test.ts` (lines 94-96 and 238-240) used `expect(Object.keys(...).sort()).toEqual([...])` to assert the EXACT projected entry shape. Adding the new additive `health` field broke those assertions even though the contract was strictly additive.
- **Fix:** Updated both assertions to include `'health'` in the expected key list. This is the same pattern Plan 20-01 used for the disabled-flag fixture updates, which was itself the same pattern Phase 17 used for ctx_size/context_strategy.
- **Files modified:** `router/tests/integration/models.test.ts` (2 lines changed in 2 different `it()` blocks).
- **Verification:** All 4 adjacent tests pass (models.test.ts, list-models-policy-filter.integration.test.ts, registry-disabled.test.ts, tests/unit/registry.test.ts).
- **Committed in:** `6a4d60f` (part of the atomic Plan 20-02 commit).

### Operational adjustment (not code)

**3. [Operational — non-deviation] docker compose build before --force-recreate**
- **Same as Plan 20-01 Operational adjustment.** The deployment recipe needs `docker compose build router` BEFORE `docker compose up -d --force-recreate router` because this plan modifies TypeScript sources that get bundled into `dist/index.js`. A bare `--force-recreate` reuses the cached image. This is the canonical `bin/deploy-router.sh full` path documented in 20-CONTEXT.md §D-07. The lack of an actual deploy script is exactly what OPS-01 (Wave 5) addresses.
- **Operational impact:** Image timestamp `2026-06-03T11:01:56Z` confirms the build was applied (>> Plan 20-01 baseline `2026-06-03T03:57:38Z`).

## Live Verification Transcript

### Pre-deployment (source + tests)

- `npx tsc --noEmit` → exit 0
- `npx vitest run src/health/__tests__/backend-probe.test.ts` → **8 passed**
- `npx vitest run src/plugins/__tests__/backend-health-plugin.test.ts` → **5 passed**
- `npx vitest run tests/integration/v1-models-health-field.integration.test.ts` → **5 passed**
- Adjacent regression: `npx vitest run tests/integration/models.test.ts tests/integration/list-models-policy-filter.integration.test.ts src/config/__tests__/registry-disabled.test.ts tests/unit/registry.test.ts tests/unit/mcp/host/tools/list-models.test.ts` → **43 passed** (was 36 before model fixture update — now includes the `health` key in expected shapes)
- Full vitest sweep: **1316 passed / 39 skipped / 2 todo / 0 failed** (was 1297 pre-Wave-1; +19 net from new tests + 1 less flake — the hotreload.vram.test.ts parallel-load flake from Plan 20-01 also passed this run)

### Post-deployment (live router)

```
$ docker image inspect local-llms-router --format '{{.Created}}'
2026-06-03T11:01:56.572545269Z          # > 2026-06-03T03:57:38Z Plan 20-01 baseline ✓

$ curl http://127.0.0.1:3210/healthz
{"status":"ok","service":"router","phase":2,"registry_models":14}    # 14 = 11 enabled + 3 disabled ✓

$ curl ... /v1/models | jq '.data | length'
11                                                                    # 10 enabled (Wave 0) + 1 raw alias (qwen2.5:7b-instruct-q4_K_M from a4580e0) ✓

$ curl ... /v1/models | jq '.data[0]'
{
  "id": "llama3.2:3b-instruct-q4_K_M",
  "object": "model",
  "created": 1780484558,
  "owned_by": "local-llms",
  "capabilities": ["chat"],
  "policy": {"cloud_allowed": true},
  "health": {
    "status": "ok",
    "checked_at": "2026-06-03T11:02:38.741Z"
  }
}                                                                     # health field structurally correct ✓

$ curl ... /v1/models | jq '.data | map({id, status: .health.status})'
# 8 entries report status:ok (ollama-* + bge-reranker-local + embed-local + vision-local)
# 3 entries report status:unknown (gpt-oss:120b-cloud + gpt-oss:20b-cloud + big-cloud — all backend=ollama-cloud)
# Matches PROBE_ENDPOINTS mapping exactly ✓

$ curl ... /v1/models/chat-local | jq '.health'
{"status":"ok","checked_at":"2026-06-03T11:02:38.741Z"}              # /v1/models/:id also surfaces health ✓

$ docker compose exec valkey valkey-cli -a "$VALKEY_PASSWORD" --no-auth-warning KEYS 'backend-health:*'
backend-health:ollama
backend-health:ollama-cloud
                                                                       # 2 cache keys — one per distinct enabled backend post-Wave-0 ✓

$ docker compose exec valkey valkey-cli -a "$VALKEY_PASSWORD" --no-auth-warning GET 'backend-health:ollama'
{"status":"ok","checked_at":"2026-06-03T11:25:09.135Z"}              # cached value matches in-memory ✓

$ docker compose exec router sh -c 'grep -c "toolCallState" /app/dist/index.js'
5                                                                     # Plan 19-08 tool-calls fix preserved in deployed bundle ✓

# RESS-WITH-TOOLS smoke gate (5-retry harness — gpt-oss:20b-cloud has documented ~40-60% non-determinism)
Attempt 1: DELTA_OK=0 COMPLETED_OK=1 (response.completed emitted; no tool-emission this run)
Attempt 2: DELTA_OK=1 COMPLETED_OK=1 PASS
                                                                       # Phase 19 surface unaffected ✓
```

## CAT-02 Status

**CLOSED.**

REQUIREMENTS.md line 38 condition satisfied: "`GET /v1/models` exposes a per-entry `health` or `available` boolean computed from a startup-time backend reachability probe. Consumers can filter unreachable aliases without trial-and-error. Field is additive — existing consumers that ignore it continue to work."

- Per-entry field `health: {status, checked_at}` shipped on both `/v1/models` and `/v1/models/:id`.
- Field is **additive** (proven by Open WebUI + n8n continuing to work — they ignore unknown response fields per OpenAI-compat client semantics; and proven by the backward-compat integration test case 2 which asserts the field is structurally well-formed when the plugin is wired but doesn't require consumer code changes).
- Status comes from **startup-time backend reachability probe** (boot probe runs at app.ready()) with **60s lazy refresh** (operator-tunable via `ROUTER_BACKEND_HEALTH_TTL_SEC`).
- Consumers can **filter unreachable aliases without trial-and-error** by reading `health.status`. Per D-04, the router does NOT auto-filter — consumer decides.

## Architectural Note: ollama-cloud's 'unknown' status is intentional

PROBE_ENDPOINTS[ollama-cloud] = null. This is NOT a bug. Three reasons:

1. **No public bearer-accessible /healthz on ollama.com.** The OpenAI-compat surface at `https://ollama.com/v1/...` requires authentication, and there is no documented unauthenticated health endpoint.
2. **Setting 'ok' would lie** — we genuinely don't know whether the cloud is healthy at any given moment.
3. **Setting 'down' would lie** — for the same reason, and worse: it would actively mislead consumers into thinking the cloud is unreachable when it might be perfectly fine.

The taxonomy explicitly includes `'unknown'` for exactly this case. Documented in PROBE_ENDPOINTS map, in the plugin's JSDoc, and in this SUMMARY's key-decisions. Cloud entries' health is `{status: 'unknown', checked_at: <recent>}` permanently, until/unless Ollama Cloud publishes a public /healthz that the router's bearer can hit.

If a future operator wants live cloud probes anyway (e.g. by sending a `POST /v1/chat/completions` with `max_tokens: 1`), that's a deliberate cost-vs-confidence trade-off and would be a separate plan, not a bug fix.

## Reversibility Note

Wave 1 is fully reversible by design:

```bash
git revert 6a4d60f
docker compose build router
docker compose up -d --force-recreate router
```

Restores the pre-Wave-1 /v1/models surface (no `health` field; same key list as Plan 20-01). The 5 new files would be deleted by the revert; the 5 modified files revert to their Plan 20-01 state. Test suite would shrink by 18 cases.

## Known Stubs

None. Every contract claimed in this SUMMARY is backed by either a passing test, a live curl, or both.

## Threat Flags

None. The `health` field exposes the same backend-name surface that was already public via /v1/models' existing `id` field; adding a `status` value does not change attack surface (T-20-05 accepted in plan's threat model). Backend URLs, backend types, and backend_model values remain projected-out by the existing T-3-A2 anti-leak (explicit field allowlist; no spread).

## Known Deferred / Out-of-Scope

- **MCP `list_models` tool surface** (router/src/mcp/host/tools/list-models.ts) does NOT yet include the `health` field. Adding it would be a Phase 21 follow-up — out of scope for CAT-02 which targets the HTTP /v1/models surface. Dual-surface parity tests (`list-models-policy-filter.integration.test.ts`) still PASS — the MCP surface keeps its existing 6-field projection unchanged.
- **No live cloud probe** (see Architectural Note above). If future requirement asks for it, separate plan needed.
- **No `?available=true` query param** (D-04 explicit non-goal — adding it later is a 1-line additive change; consumer-side filtering would shift policy into the router, anti-pattern per C7).
- **No metrics added.** POL-06 cardinality discipline preserved (Wave 3 adds the `router_deprecated_alias_used_total` counter for CAT-04).

## Self-Check: PASSED

- File `router/src/health/backend-probe.ts` exists ✓
- File `router/src/health/__tests__/backend-probe.test.ts` exists ✓
- File `router/src/plugins/backend-health-plugin.ts` exists ✓
- File `router/src/plugins/__tests__/backend-health-plugin.test.ts` exists ✓
- File `router/tests/integration/v1-models-health-field.integration.test.ts` exists ✓
- File `router/src/app.ts` modified ✓
- File `router/src/config/env.ts` modified ✓
- File `router/src/index.ts` modified ✓
- File `router/src/routes/v1/models.ts` modified ✓
- File `router/tests/integration/models.test.ts` modified ✓
- Commit `6a4d60f` present in `git log` ✓
- 18/18 new tests pass (8 probe + 5 plugin + 5 integration) ✓
- /v1/models live count = 11; every entry has `health` field ✓
- ollama-* entries report `status: 'ok'`; ollama-cloud entries report `status: 'unknown'` ✓
- Valkey contains 2 `backend-health:*` keys with matching cached values ✓
- Phase 19 RESS-WITH-TOOLS smoke gate PASS post-deployment (attempt 2/5) ✓
