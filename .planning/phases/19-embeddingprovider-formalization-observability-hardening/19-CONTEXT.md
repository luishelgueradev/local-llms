# Phase 19: EmbeddingProvider Formalization + Observability Hardening - Context

**Gathered:** 2026-06-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 19 closes the v0.11.0 milestone by:

1. **Extracting** the existing `/v1/embeddings` capability into a named `EmbeddingProvider` interface exposed via `fastify.decorate('embeddingProvider', ...)` so future RetrieverProvider implementations can consume embeddings directly without round-tripping through HTTP — EMBP-01 + EMBP-02.
2. **Hardening observability** across the full v0.11.0 surface — extend the cardinality CI guard to parse live `/metrics` (OBSV-02), close the smoke-test-router.sh gaps for the new surfaces (OBSV-01), consolidate README/DEPLOY documentation (OBSV-03), and tombstone-verify the migration 0007 safety net (OBSV-04 — already shipped by Plan 18-02).

The strategic frame holds (carry-over from Phase 18, locked by Plan 18-08 SUMMARY): **the EmbeddingProvider follows Frame-01 — interface in `router/src/providers/embedding-provider.ts` with ZERO production implementation classes; the "default impl" is the composition root constructing a thin wrapper over the existing `BackendAdapter.embeddings` surface. A test-only fake lives in `tests/fakes.ts`. The router never instantiates a retriever — that strategic invariant from `project_retrieval_agnostic_principle.md` is the load-bearing constraint of this phase.**

Phase 19 is the final phase of v0.11.0 — after this lands, the milestone is COMPLETE and the router is "retrieval-ready infrastructure" with five provider interfaces (`SessionStore`, `ContextProvider`, `RetrieverProvider`, `EmbeddingProvider`, `SummaryProvider`), MCP host + client, streaming Responses API, and policy primitives — without the router assuming a single line of retrieval, memory, or business logic.

**Phase is NOT delivering:** changes to `/v1/embeddings` wire shape (P7-01 BLOCK locked in `tests/unit/grep-gates/embeddings-untouched.test.ts`), a default RetrieverProvider that calls the EmbeddingProvider (Frame-01 BLOCK — retrieval implementations are caller-supplied), MCP-native streaming (deferred to MCPS-FUT), the `LlmSummaryProvider` (SUMP-FUT-01), session GC cron (SESS-FUT-01), or any v0.12+ scaling work (pool/health-check/per-tenant MCP — MCPC-FUT-01/02).

</domain>

<decisions>
## Implementation Decisions

### EmbeddingProvider Interface Shape (EMBP-01)

- **D-01:** **`embed(input, opts) → { embeddings: number[][], model, usage }`** — normalized return shape per REQUIREMENTS.md verbatim. `embeddings` is always a flat `number[][]` (one vector per input). The `/v1/embeddings` route re-wraps as the OpenAI `data: [{ object: 'embedding', index, embedding }]` shape on the way out to preserve P7-01 BLOCK byte-identical wire shape. RetrieverProvider consumers get the clean shape: `const [vec] = await fastify.embeddingProvider.embed(query, { model: 'embed-local' })`. **NOT** the OpenAI-list shape, **NOT** a dual-field union.

- **D-02:** **Provider does NOT accept `encoding_format`** — always decodes base64 from upstream into `number[]` before returning. The `/v1/embeddings` route still accepts `encoding_format: 'base64'` from clients; when present, the route re-encodes the provider's `number[][]` to base64 at the wire boundary. Provider stays focused on "give me vectors"; encoding is a route-level concern. EMB-H04 fail-open semantics for base64 cache-skip move into the provider's cache path (still skip base64 inputs at provider level — but the upstream call always asks for `float` so base64 round-trip happens once at the wire).

- **D-03:** **Dims enforcement moves INTO the provider.** `EmbeddingProvider.embed()` throws `EmbeddingsDimsMismatchError` when an upstream vector mismatches the resolved `entry.dims`. The route's existing post-adapter dims check becomes either (a) removed (provider is canonical) or (b) reduced to a one-line `if (vec.length !== entry.dims) throw …` defense-in-depth assertion. Picked (a) — single source of truth. A direct provider call from a future RetrieverProvider can no longer poison a downstream vector store with wrong-dim vectors.

- **D-04:** **Call signature: `embed(input, opts: { model, dimensions?, user? })`** — caller passes the public model name; provider runs `registry.resolve(model)` + capability check (`embeddings` in `entry.capabilities`) + `makeAdapter(entry)` internally. The `/v1/embeddings` route still runs `applyPreflight(body.model, { registry, breaker })` UPSTREAM of the provider call so policy + breaker fire on every wire-shape request. Provider's internal resolve is the second cheap lookup (same registry snapshot, no extra Valkey/Postgres I/O). `dimensions` and `user` are forwarded to the underlying adapter; `encoding_format` is intentionally omitted (D-02).

- **D-05:** **Provider error vocabulary reuses existing types.** Throws: `RegistryUnknownModelError` (from registry.resolve), `CapabilityNotSupportedError(modelName, 'embeddings')` (capability gate), `EmbeddingsDimsMismatchError` (D-03), `BreakerOpenError` (if provider is called from a path that skipped applyPreflight — defense-in-depth), backend errors propagated unchanged. Route's centralized error handler maps each via `toOpenAIErrorEnvelope` — no new error types for Phase 19.

### Cache Placement (EMBP-02 carry-over from Phase 12)

- **D-06:** **The Valkey per-input cache moves INTO the provider.** `EmbeddingProvider` owns:
  - Per-item lookup keyed by `embeddingsCacheKey({ backend, backend_model, encoding_format, dimensions, input })` (existing function in `router/src/embeddings/cache.ts` — reused unchanged).
  - `router_embeddings_cache_total{result=hit|miss|bypass}` increment per item (same metric name, same labels — only ownership shifts).
  - Base64 bypass (still skip when client asked for base64, but encoding is handled at the route wire boundary — provider always works in `float`).
  - Fail-open on Valkey errors (warn log + fall through to upstream; no metric increment per EMB-H04 contract).
  - Reassembling cache hits + upstream miss results into the original input order.

  Any consumer of `fastify.embeddingProvider` — current `/v1/embeddings` route, future RetrieverProvider hooks, smoke scripts — gets cache hits for free. Route becomes a thin wrapper that just translates wire-shape ↔ provider-shape.

- **D-07:** **Route still owns `router_embeddings_batch_size` histogram (EMB-H03).** Wire-shape metric stays in the wire layer — observes inbound `body.input.length` BEFORE any cache work. Provider doesn't know what the route received vs what a retriever passed; keeping batch_size route-local preserves the "what did clients send me" semantic. Provider may internally observe a different histogram in v0.12+ if RetrieverProvider call shape diverges; deferred.

- **D-08:** **Route still owns cost (`X-Cost-Cents` header + `request_log.cost_cents`).** Provider returns `usage: { prompt_tokens, total_tokens }` reflecting **only the upstream-billed tokens** — cache hits contribute 0 prompt_tokens (same as today). Route runs `computeCostCents(usage, entry)` and stamps the header + buffered writer row. RetrieverProvider consumers calling the provider directly don't get a cost-cents response field (they're not a wire-billable surface); their cost still lands in `request_log.cost_cents` because the outer request's recordOutcome closes over the provider's accumulated usage. **Pending implementation note for planner:** the route needs to capture the provider's accumulated upstream `usage` (sum across the cache-miss sub-batch) and pass it to recordOutcome — currently the adapter return value carries usage; with the cache in the provider, the provider's return shape carries the aggregated `usage`.

### Provider Wire-Up (EMBP-01 success criterion 4)

- **D-09:** **Composition root constructs the provider.** `router/src/index.ts` builds `makeOpenAIEmbeddingProvider({ registry, makeAdapter: makeAdapterWithCloudKey, valkey: valkeyClient, env: opts.env, metrics: { embeddingsCacheTotal, embeddingsDimsTotal }, log })` and passes it via `buildApp({ ..., embeddingProvider })`. **Not** built inside buildApp; **not** built inside a plugin. Mirrors Phase 17 `SessionStore` + Phase 18 `preCompletionHooks` Map composition pattern (Frame-01).

- **D-10:** **`BuildAppOpts` gains a new field `embeddingProvider?: EmbeddingProvider`.** Optional for backward compatibility with tests that don't need embeddings. When present, `buildApp` calls `app.decorate('embeddingProvider', opts.embeddingProvider)`. When absent (test path), no decorator is registered; the `/v1/embeddings` route still works because the route also accepts `opts.embeddingProvider` directly (option-bag pattern — same as `opts.recordOutcome`, `opts.breaker`, etc.). Production composition always provides it.

- **D-11:** **Fastify type-augmentation file required.** New `router/src/types/fastify.d.ts` (or extend existing) adds:
  ```ts
  declare module 'fastify' {
    interface FastifyInstance {
      embeddingProvider: EmbeddingProvider;
    }
  }
  ```
  Otherwise `fastify.embeddingProvider` is `any` to consumers — destroys EMBP-01's "interface conformance" success criterion. Mirrors Phase 17's `req.sessionId` + Phase 18's `req.hookLog` typing pattern.

- **D-12:** **Tests inject a fake via `tests/fakes.ts`.** Add `makeFakeEmbeddingProvider({ dims = 1024 }): EmbeddingProvider` returning deterministic vectors (e.g., `Array(dims).fill(0.42)`). Same pattern as `makeFakeRetrieverProvider`, `makeFakeSessionStore`, etc. Tests that need real-shape responses but no upstream call use the fake; tests that exercise upstream behavior use the existing MSW fixtures.

### OBSV-02: Live Prometheus Cardinality Check

- **D-13:** **Extend the existing `router/scripts/check-prometheus-cardinality.ts` to dual-mode.** Same file, same `FORBIDDEN_LABEL_RE = /_id$/` regex, two operating modes:
  - `check-prometheus-cardinality --source <path>` (default — existing behavior, scans `src/metrics/registry.ts` text)
  - `check-prometheus-cardinality --live <url>` (NEW — fetches `<url>`, parses Prometheus exposition lines, asserts no label name ends in `_id` across every observed series)

  One script, two flags. CLI dispatches to either `checkCardinalitySource(text)` or `checkCardinalityLive(text)`; both return `CardinalityViolation[]`; CLI shape unchanged. Phase 14's BOM comment `'live-parse case is deferred to Phase 19'` becomes the design contract being honored.

- **D-14:** **Roll our own regex parser.** Prometheus exposition is simple line-based:
  ```
  metric_name{label1="value",label2="value2"} 42.0 [timestamp]
  ```
  ~30 lines of regex extracts label names per series (the values are irrelevant — only NAMES matter for cardinality). Skip `#` comment/HELP/TYPE lines. Zero new dependencies in `router/package.json`. Matches the static script's existing regex ethos.

- **D-15:** **Live check runs BOTH in CI (vitest in-band) AND in smoke-test-router.sh.**
  - **CI / vitest:** new `router/tests/integration/cardinality-live.integration.test.ts` calls `buildApp(...)` with a minimal fixture (registry, fakes), hits `/metrics` via `app.inject({ method: 'GET', url: '/metrics' })`, pipes the body through `checkCardinalityLive(text)`, asserts `violations.length === 0`. Runs every CI run — catches inline metric declarations at import time + runtime drift in the rendered exposition format (e.g., a label set that only appears once a histogram has been observed). Boots in <200 ms; no Docker dependency.
  - **Smoke:** `bin/smoke-test-router.sh` gains a new gate `OBSV-02-LIVE` that does `curl -sS "${ROUTER_URL}/metrics" | node router/scripts/check-prometheus-cardinality.ts --live -` (or `--live "${ROUTER_URL}/metrics"`) and PASSes when exit code is 0. Runs against the live tunnel post-deploy.

  Why both: vitest catches drift on every PR (cheap, no live router); smoke catches drift in the deployed image (the CI image may differ from the prod image if env-gated metrics light up only at runtime).

### OBSV-01: Smoke Coverage of New Surfaces

- **D-16:** **MCP host slice: marked DONE-by-prior-phase.** Phase 15 smoke section (lines 2059–2191 of `bin/smoke-test-router.sh`) already gates:
  - MCP-01 (initialize + Mcp-Session-Id) — covers OBSV-01's "MCP host /mcp initialize"
  - MCP-02 (401 bearer enforcement)
  - MCP-03 (tools/call list_models dual-shape) — covers OBSV-01's "tools/call for list_models"

  Phase 19 smoke section adds a one-line banner cite: `Phase 19 OBSV-01: MCP slice satisfied by Phase 15 MCP-01..03`. No new MCP gates.

- **D-17 [informational]:** **`tools/list` explicit gate: NOT added** — Phase 15 MCP-03 invokes `tools/call list_models` which exercises the same tools-routing path as `tools/list`. Adding a `tools/list` gate would be defensive duplication. Decision logged here so future audits don't flag it as a gap. (If a real consumer reports `tools/list` working but `tools/call` broken — which would be very unusual — we add the gate then.)

- **D-18:** **`/v1/responses` streaming WITH tools: NEW live smoke gate.** Phase 16 smoke covers stream-no-tools (lines 2194–2287). OBSV-01 literally says "with and without tools" — Phase 19 adds a new gate `RESS-WITH-TOOLS` to `bin/smoke-test-router.sh`:
  - POST to `/v1/responses` with `{ stream: true, model: '<cloud-function-calling-model>', input: '<deterministic-tool-trigger-prompt>', tools: [...] }`.
  - Asserts the SSE stream contains `response.function_call_arguments.delta` events.
  - Asserts the final event is `response.completed` with `status: 'incomplete'` + `incomplete_details: { reason: 'tool_calls' }` (Phase 16 SC-2 contract).
  - **Soft-skip when `OLLAMA_API_KEY` is absent OR no function-calling cloud model is declared in `models.yaml`** — same skip pattern used by Phase 8 cloud gates.

  **Planner: confirm which model to target during planning** — current `models.yaml` has `gpt-oss:120b-cloud` and `gpt-oss:20b-cloud`; one of them is the right pick if it emits Responses-API-compatible tool calls (verify against Phase 16 vitest tool tests). Cost is bounded: ~1 request × ~50 tokens × cloud rate = ~$0.001 per smoke run.

- **D-19:** **SessionStore round-trip: marked DONE-by-prior-phase.** Phase 17 SESSION section (lines 2290–2431 of `bin/smoke-test-router.sh`) gates SC-1..SC-4 + the `router_session_append_failed_total` Prometheus signal + POL-06 cardinality re-check. Phase 19 smoke cites: `OBSV-01 Session: satisfied by Phase 17 SESSION section`.

- **D-20:** **EmbeddingProvider conformance: VITEST-ONLY gate (EMBP-01 SC-4).** Per EMBP-01's literal text "verified by unit test asserting interface conformance" — new `router/tests/providers/embedding-provider.test.ts` does:
  - Builds the real `OpenAIEmbeddingProvider` with a fake adapter.
  - Asserts `expectTypeOf(provider).toMatchTypeOf<EmbeddingProvider>()`.
  - Calls `provider.embed(['hello'], { model: 'embed-local' })` and asserts shape `{ embeddings: number[][], model: string, usage: { prompt_tokens, total_tokens } }`.
  - Re-runs with `body.input` as a string vs array — both must work (matches existing wire schema).

  Smoke gets one regression line `EMBP-02: /v1/embeddings byte-identical (Phase 7 + Phase 12 gates re-asserted)` — the existing Phase 7 EMBED-01 + Phase 12 EMB-H01..06 smoke gates already exercise wire-shape regression; Phase 19 just confirms they still pass post-refactor.

### OBSV-03: README + DEPLOY Documentation Consolidation

- **D-21:** **OBSV-03 is mostly already done in prior phases — Phase 19 lands the consolidation pass + EmbeddingProvider section.** Coverage matrix:
  | OBSV-03 doc requirement | Where it lives today |
  |---|---|
  | MCP host endpoint + tools + auth | `DEPLOY.md` §"MCP Host (Phase 15 — v0.11.0)" (line 469) + `README.md` §"MCP host (Phase 15 — v0.11.0)" (intro bullets) — **DONE** Phase 15 |
  | `mcp_servers:` config schema | `DEPLOY.md` §"MCP Client + Pre-Completion Hooks (Phase 18 — v0.11.0)" — **DONE** Phase 18 |
  | `X-Session-ID` + `SESSION_TTL_DAYS` | `DEPLOY.md` §"Sessions + ContextProvider (Phase 17 — v0.11.0)" + `README.md` §"Sessions / X-Session-ID (v0.11.0)" — **DONE** Phase 17 |
  | Pre-completion hook registration + `on_timeout` | `DEPLOY.md` §"Hook registration extension point" — **DONE** Phase 18 |
  | `model_allowlist` + `cloud_allowed` policy | `DEPLOY.md` §"Policy primitives (Phase 14 — v0.11.0)" + `README.md` §"Policy & multi-tenant context (v0.11.0)" — **DONE** Phase 14 |
  | `X-Tenant-ID` / `X-Project-ID` headers | `DEPLOY.md` §"Scoped IDs (X-Tenant-ID / X-Project-ID / X-Agent-ID / X-Workload-Class)" — **DONE** Phase 14 |

  Phase 19 adds:
  - **New `DEPLOY.md` §"EmbeddingProvider (Phase 19 — v0.11.0)"** — operator-facing: how to use the `fastify.embeddingProvider` decorator from a hook; Frame-01 invariant (no router-shipped retriever); strategic-frame citation; verification matrix.
  - **New `README.md` §"EmbeddingProvider (v0.11.0)"** — consumer-facing: TS interface signature, code example, link to DEPLOY.md.
  - **Top-of-README "v0.11.0 SHIPPED" status banner** flipping the Estado del proyecto table row to ✅.

### OBSV-04: Migration 0007 hook_log JSONB — Already Shipped

- **D-22:** **OBSV-04 is a no-op — already shipped by Plan 18-02.** REQ text: "if not already added in Phase 18, migration 0007 adds it here as safety net". It WAS added in Phase 18 (`router/db/migrations/0007_request_log_hook_log.sql` + `_journal.json` idx=7 + Drizzle schema). Phase 19 closes OBSV-04 with:
  - A verification plan that asserts `request_log.hook_log` column EXISTS in the live Postgres + the column type is `jsonb` (one PG-gated vitest test re-asserting the Plan 18-02 migration).
  - REQUIREMENTS.md OBSV-04 status flips to `Complete (Phase 18 Plan 18-02 — re-verified Phase 19)`.
  - **No new migration in Phase 19.** Adding a no-op migration would burn an index and risk drift between dev and prod journals.

### Phase 19 Plan Structure (planner guidance)

- **D-23 [informational]:** **Expected plan count: 5–7 plans.** Tentative breakdown (planner refines):
  1. Wave 0 scaffold — test placeholders (provider unit test + cardinality-live integration test + smoke gate stubs)
  2. `EmbeddingProvider` interface + types/fastify.d.ts augmentation + `OpenAIEmbeddingProvider` impl (with cache moved in)
  3. `/v1/embeddings` route refactor — delegate to provider, preserve wire shape (P7-01 gate)
  4. `check-prometheus-cardinality.ts` dual-mode extension + new `checkCardinalityLive` parser + CI test
  5. Smoke section additions — `RESS-WITH-TOOLS` gate + `OBSV-02-LIVE` gate + EMBP-02 regression banner
  6. OBSV-03 docs (DEPLOY + README EmbeddingProvider sections + v0.11.0 SHIPPED banner)
  7. v0.11.0 milestone wrap-up — REQUIREMENTS.md status flips, ROADMAP Phase 19 row complete, STATE.md milestone SHIPPED metadata, milestone audit prep

- **D-24:** **P7-01 BLOCK enforcement.** Every PR in Phase 19 MUST keep `tests/unit/grep-gates/embeddings-untouched.test.ts` GREEN. The gate computes SHA-256 of `router/src/routes/v1/embeddings.ts` and compares against the Phase 12 baseline. If the refactor touches the route handler (it must, to delegate to the provider), the baseline gets a new SHA captured BEFORE the route changes, then re-asserted to that new SHA after. The substantive invariant — wire shape byte-identical to pre-Phase-19 — is verified by re-running the Phase 7 EMBED-01 + Phase 12 EMB-H01..06 smoke gates and the vitest regression suite (existing tests must pass unchanged).

### Claude's Discretion

- Exact file layout under `router/src/providers/embedding-provider.ts` — provider interface, error types, factory function `makeOpenAIEmbeddingProvider`, internal cache helper. Planner picks coarser/finer file split based on existing `providers/` layout.
- Whether the new `tests/fakes.ts` extension goes in `makeFakeEmbeddingProvider` directly or in a sibling `tests/fakes/embedding.ts` — match the existing pattern.
- Exact wording of the `RESS-WITH-TOOLS` smoke-skip message + the model name targeted (after planner verifies which cloud function-calling model in `models.yaml` consistently emits Responses-API tool calls).
- The exact CI workflow file path / step where `cardinality-live.integration.test.ts` is invoked (likely the existing vitest run picks it up automatically — no CI config change expected).
- Whether the OBSV-04 re-verification PG-gated test is a new file or an extension of an existing migrations test in `router/tests/integration/migrations/`.
- README v0.11.0 SHIPPED banner exact wording / badge style — mirror the existing v0.9.0 / v0.10.0 row format.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Roadmap + Requirements
- `.planning/ROADMAP.md` §"Phase 19: EmbeddingProvider Formalization + Observability Hardening" — goal, dependencies on Phase 18, design constraints (P7-01 BLOCK reaffirmed + OBSV-04 safety-net language), success criteria 1–5
- `.planning/REQUIREMENTS.md` EMBP-01, EMBP-02, OBSV-01, OBSV-02, OBSV-03, OBSV-04 — full requirement text and locked exclusions
- `.planning/REQUIREMENTS.md` §"Architectural-Frame Violation Trip-Wires" #1–#6 — invariants Phase 19 must not violate (esp. #1 "no default in-process retriever")
- `.planning/STATE.md` "Key Design Decisions (v0.11.0)" + "Active Decisions" rows — Phase 18 SHIPPED metadata + remaining-work delta (Phase 19 6 REQs)
- `.planning/PROJECT.md` — strategic frame: "Retrieval Interfaces, not Retrieval Logic" + single-host/single-user constraints

### Prior Phase Artifacts (Phase 19 builds on, never breaks)
- `.planning/phases/18-mcp-client-retrieverprovider-pre-completion-hook/18-08-SUMMARY.md` — explicit "Phase 19's EmbeddingProvider interface should follow Frame-01-style pattern" carry-forward statement
- `.planning/phases/18-mcp-client-retrieverprovider-pre-completion-hook/deferred-items.md` §"Known carry-overs (Phase 19+ scope)" — EMBP-01/02 + OBSV-01..04 deferral context; live-tunnel-rebuild operator action; Frame-01 BLOCK ongoing reminder
- `.planning/phases/15-mcp-host-router-as-mcp-server/15-CONTEXT.md` — Phase 15 D-07 (cardinality discipline) + D-09 (applyPreflight shared helper) carry-forward
- `.planning/phases/14-policy-primitives-tenant-project-id-foundation/14-CONTEXT.md` D-25..28 — Prometheus cardinality discipline that Phase 19 OBSV-02 extends to live `/metrics`
- `.planning/research/PITFALLS.md` §"Section 7: Embedding-Provider Pitfalls" P7-01 BLOCK — `/v1/embeddings` wire shape MUST NOT change; SHA-256 baseline gate
- `.planning/research/PITFALLS.md` §"Section 8: Observability Pitfalls" P8-03 BLOCK — no `_id` labels in Prometheus
- `.planning/research/PITFALLS.md` §"Section 9: Migration Pitfalls" P9-01 BLOCK — `_journal.json` read FIRST (relevant only IF Phase 19 needs a migration — D-22 says no)
- `.planning/research/PITFALLS.md` §"Section 9" P9-03 BLOCK — smoke test extension is not optional for new surfaces
- `.planning/research/SUMMARY.md` §"Phase 19" + adoption rationale for EmbeddingProvider extraction
- `.planning/research/ARCHITECTURE.md` §"EmbeddingProvider seam" — placement rationale, why route delegates rather than provider being a plugin
- `.planning/MILESTONES.md` — v0.10.0 archive (Phase 12 embeddings hardening — EMB-H01..06 baseline that Phase 19 must NOT regress)
- `.planning/milestones/v0.10.0-REQUIREMENTS.md` EMB-H01..06 — exact wire-shape contract the regression suite enforces

### Codebase — Files Phase 19 Touches Directly
- `router/src/providers/retriever-provider.ts` — model for the new `embedding-provider.ts` (interface-only, Frame-01 pattern, fake-in-tests/fakes.ts)
- `router/src/providers/session-store.ts` — second model (interface + error types collocated, factory pattern documented)
- `router/src/routes/v1/embeddings.ts` lines 148–552 — the route to refactor; preserve wire shape; delegate to `req.server.embeddingProvider` (or accept via opts)
- `router/src/backends/adapter.ts` lines 94–108 (`BackendAdapter.embeddings` method) — the underlying call the provider wraps
- `router/src/embeddings/cache.ts` — `embeddingsCacheKey()` + `CachedVector` + `EmbeddingsCache` interface (reused by provider; moved from route)
- `router/src/cost/computeCostCents.ts` — STAYS in route (D-08)
- `router/src/app.ts` lines 1030–1066 — registerEmbeddingsRoute call site; adapt opts (no provider injection here; pass via BuildAppOpts and route reads from server decorator)
- `router/src/app.ts` lines 268–305 + 392 — bearer/policy/breaker hook stack (untouched; provider lives in the dispatch path AFTER these)
- `router/src/index.ts` lines 89–376 — composition root; ADD `makeOpenAIEmbeddingProvider` construction + threading through `buildApp` opts
- `router/src/config/env.ts` — verify no new env vars (cache TTL already in `ROUTER_EMBED_CACHE_TTL_SEC`)
- `router/src/errors/envelope.ts` — `EmbeddingsDimsMismatchError`, `CapabilityNotSupportedError`, `RegistryUnknownModelError`, `BreakerOpenError` — reused unchanged
- `router/src/metrics/registry.ts` — `embeddingsCacheTotal`, `embeddingsBatchSize`, `embeddingsDimsTotal` declarations — name/labels stay; ownership shifts at runtime
- `router/scripts/check-prometheus-cardinality.ts` — extend to dual-mode (D-13); add `checkCardinalityLive(exposition: string): CardinalityViolation[]`
- `router/scripts/__tests__/check-prometheus-cardinality.test.ts` — existing static-mode tests stay; add live-mode test fixture
- `router/tests/integration/cardinality-live.integration.test.ts` — NEW (D-15 vitest in-band scrape)
- `router/tests/providers/embedding-provider.test.ts` — NEW (D-12 + D-20 unit conformance)
- `router/tests/fakes.ts` — extend with `makeFakeEmbeddingProvider(opts)` (D-12)
- `router/src/types/fastify.d.ts` (NEW or extend existing) — `interface FastifyInstance { embeddingProvider: EmbeddingProvider }` (D-11)
- `router/tests/unit/grep-gates/embeddings-untouched.test.ts` — update SHA-256 baseline BEFORE route refactor (D-24)
- `bin/smoke-test-router.sh` — new Phase 19 section between Phase 18 section and the final summary banner; cites D-16/D-19 prior-phase coverage; adds D-18 `RESS-WITH-TOOLS` gate + D-15 `OBSV-02-LIVE` gate + D-20 `EMBP-02` regression banner
- `DEPLOY.md` — new §"EmbeddingProvider (Phase 19 — v0.11.0)" between Phase 18 section and "Backups + retencion"
- `README.md` — new §"EmbeddingProvider (v0.11.0)" between "MCP Client + Hooks (v0.11.0)" and "Operacion"; flip Estado del proyecto v0.11.0 row to ✅

### Operational + External
- `router/models.yaml` — verify which cloud function-calling model is declared (D-18 RESS-WITH-TOOLS skip predicate)
- `router/.env.example` — no new vars expected
- `router/db/migrations/meta/_journal.json` — read FIRST if any migration is needed (D-22 says no — but verify)
- [OpenAI Embeddings API spec](https://platform.openai.com/docs/api-reference/embeddings) — wire shape contract Phase 19 cannot change
- [Prometheus text exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format) — parser reference for D-14
- [`@modelcontextprotocol/sdk` TypeScript types](https://github.com/modelcontextprotocol/typescript-sdk) — already in repo; no version bump expected

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`embeddingsCacheKey()` + `CachedVector` + `EmbeddingsCache` interface (`router/src/embeddings/cache.ts`)** — full Valkey cache plumbing from Phase 12. The provider re-uses these unchanged; the only delta is the call site (route → provider).
- **`BackendAdapter.embeddings(input, model, signal, opts?)` (`router/src/backends/adapter.ts:94–108`)** — the underlying upstream call. The provider's internal upstream path is exactly this method; provider adds resolve + cache + dims + base64-decode on top.
- **`applyPreflight(model, { registry, breaker })` (`router/src/dispatch/preflight.ts`)** — Phase 15 D-09 helper. Route still runs this UPSTREAM of the provider call; provider does NOT call it (would re-fire breaker + policy unnecessarily).
- **`registry.resolve(model)` + `entry.capabilities` (`router/src/config/registry.ts`)** — provider uses internally per D-04; same registry snapshot as the route (no re-snapshot).
- **`EmbeddingsDimsMismatchError`, `CapabilityNotSupportedError`, `RegistryUnknownModelError`, `BreakerOpenError` (`router/src/errors/envelope.ts`)** — all reused; provider throws them; route's centralized error handler maps them to OpenAI envelopes.
- **`computeCostCents(usage, entry)` (`router/src/cost/computeCostCents.ts`)** — STAYS in route. Provider returns `usage`; route computes cost.
- **`bufferedWriter.push(row)` (`router/src/db/bufferedWriter.ts`)** — STAYS in route. Cache hits + provider usage flow into the same row shape.
- **`recordOutcome(ctx)` (`router/src/metrics/recordOutcome.ts`)** — STAYS in route's outer finally. Provider doesn't touch metrics ownership at the per-request boundary; only the cache counter ownership shifts (provider increments `embeddingsCacheTotal`).
- **`checkCardinality(source: string)` (`router/scripts/check-prometheus-cardinality.ts:53`)** — static parser stays unchanged; new sibling function `checkCardinalityLive(exposition: string)` lives in the same file. Both return `CardinalityViolation[]`. CLI dispatches on `--source | --live` flag.
- **Phase 15 D-09 `applyPreflight` shared helper** — Phase 19 does not touch this. Provider is internal to dispatch, behind applyPreflight in the wire path.
- **Phase 17 SessionStore + Phase 18 RetrieverProvider patterns** — the "interface in `providers/`, fake in `tests/fakes.ts`, composition-root wires the default" pattern is exact. Mirror it.

### Established Patterns

- **Frame-01 (Phase 18, locked):** providers are interfaces with ZERO production implementation classes shipped in `router/src/`. The "default impl" is a thin wrapper constructed at the composition root. A grep gate (`grep -rE 'class \w+EmbeddingProvider' router/src/`) would protect this — planner adds it if a future review needs it. EmbeddingProvider is slightly different from RetrieverProvider in that there IS a production impl (because /v1/embeddings has to work) — the impl is the `makeOpenAIEmbeddingProvider` factory which returns an object literal, NOT a class. Frame-01 spirit preserved: the router doesn't carry retrieval-shaped logic; the embeddings-shaped logic is essential to /v1/embeddings.
- **P7-01 BLOCK (Phase 18, locked):** `tests/unit/grep-gates/embeddings-untouched.test.ts` SHA-256-locks `router/src/routes/v1/embeddings.ts`. Phase 19 MUST update the baseline atomically with the route refactor.
- **D-25/26/27/28 cardinality discipline (Phase 14, locked):** no `_id` labels in Prometheus. Phase 19 OBSV-02 closes the live-parse gap that Phase 14 deferred.
- **Composition root pattern:** Phase 17 SessionStore + Phase 18 preCompletionHooks Map literal — both constructed in `router/src/index.ts`, threaded through `buildApp` opts. EmbeddingProvider follows.
- **`app.decorate` typing:** Phase 17 augmented `req.sessionId`; Phase 18 augmented `req.hookLog`. Phase 19 augments `FastifyInstance.embeddingProvider` — same `declare module 'fastify'` pattern.
- **Smoke section structure:** every phase ends with a smoke section that asserts BLOCK invariants + cross-phase regression. Phase 19 section mirrors Phase 18 (header banner + N PASS gates + final cite line).
- **`makeFakeXProvider` fakes (Phase 17, 18):** test fakes are factory functions returning interface-conforming objects, NOT classes. EmbeddingProvider fake follows.

### Integration Points

- **`buildApp` opts.embeddingProvider field added:** `BuildAppOpts.embeddingProvider?: EmbeddingProvider`. When present, `app.decorate('embeddingProvider', opts.embeddingProvider)`. When absent (tests), no decorator; the route reads its provider from `opts` directly (route-level opts.embeddingProvider, same pattern as opts.recordOutcome).
- **Route delegates to provider:** lines 232–500 of `embeddings.ts` (the entire post-preflight body — cache + adapter + dims + post-batch metric) collapses to ~50 lines: capability gate → idempotency leader/follower → `await provider.embed(inputs, { model: body.model, dimensions, user })` → re-encode base64 if requested → wrap as OpenAI list → stamp cost → return.
- **Composition root `router/src/index.ts`:** new construction:
  ```ts
  const embeddingProvider = makeOpenAIEmbeddingProvider({
    registry: registryStore,
    makeAdapter: makeAdapterWithCloudKey,
    valkey: valkeyClient,
    env: env,
    metrics: { embeddingsCacheTotal, embeddingsDimsTotal },
    log: app.log,
  });
  ```
  Passed to `buildApp({ ..., embeddingProvider })`.
- **`check-prometheus-cardinality.ts` CLI:** existing `import.meta.url === \`file://${process.argv[1]}\`` block expands to parse `--source <path> | --live <url>`; reads stdin when `<url>` is `-`. CLI exit code 0 / 1 unchanged.
- **CI integration (vitest):** new `router/tests/integration/cardinality-live.integration.test.ts` runs in the existing vitest suite. No CI workflow YAML change expected — the existing `npm test` / `npm run test:integration` step picks it up.
- **Smoke test integration (`bin/smoke-test-router.sh`):** new Phase 19 section inserted between Phase 18 section (ends at line 2538) and the final summary banner (starts at line 2544). Two new gates (RESS-WITH-TOOLS, OBSV-02-LIVE) + four cite-only lines (D-16/D-19 prior-phase coverage + D-20 EMBP-02 regression cite).
- **Documentation:** DEPLOY.md inserts a new §"EmbeddingProvider (Phase 19 — v0.11.0)" between Phase 18 §667 and Backups §808. README.md inserts a new §"EmbeddingProvider (v0.11.0)" between MCP Client + Hooks §458 and Operacion §520.

</code_context>

<specifics>
## Specific Ideas

### `EmbeddingProvider` interface (locked from discussion)
```ts
// router/src/providers/embedding-provider.ts
export interface EmbeddingProvider {
  embed(
    input: string | string[],
    opts: {
      model: string;
      dimensions?: number;
      user?: string;
    },
  ): Promise<{
    embeddings: number[][];
    model: string;
    usage: { prompt_tokens: number; total_tokens: number };
  }>;
}
```

### `makeOpenAIEmbeddingProvider` factory sketch (planner refines exact internals)
```ts
// router/src/providers/embedding-provider.ts
export interface MakeOpenAIEmbeddingProviderOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  valkey?: Redis;
  env?: { ROUTER_EMBED_CACHE_TTL_SEC: number };
  metrics: {
    embeddingsCacheTotal: { inc(labels: { result: 'hit' | 'miss' | 'bypass' }): void };
    embeddingsDimsTotal: { inc(labels: { model: string; dims: string }, value?: number): void };
  };
  log: Logger;
}

export function makeOpenAIEmbeddingProvider(opts: MakeOpenAIEmbeddingProviderOpts): EmbeddingProvider {
  const cache = opts.valkey && opts.env
    ? makeEmbeddingsCache({ valkey: opts.valkey, ttlSec: opts.env.ROUTER_EMBED_CACHE_TTL_SEC, log: opts.log })
    : undefined;

  return {
    async embed(input, callOpts) {
      const snapshot = opts.registry.get();
      const entry = snapshot.resolve(callOpts.model);  // RegistryUnknownModelError
      if (!entry.capabilities.includes('embeddings')) {
        throw new CapabilityNotSupportedError(entry.name, 'embeddings');
      }
      const inputs = Array.isArray(input) ? input : [input];
      const adapter = opts.makeAdapter(entry);

      // Per-item cache lookup (D-06) — same logic moved from embeddings.ts:267–318
      const slots: Array<number[] | null> = new Array(inputs.length).fill(null);
      const missIndices: number[] = [];
      for (let i = 0; i < inputs.length; i++) {
        // ... existing cache lookup ...
      }

      // Upstream sub-batch for misses
      let usage = { prompt_tokens: 0, total_tokens: 0 };
      if (missIndices.length > 0) {
        const subBatch = missIndices.map(i => inputs[i] as string);
        const upstream = await adapter.embeddings(subBatch, entry.backend_model, /* signal */ ..., {
          encoding_format: 'float',  // D-02 — provider always asks float
          dimensions: callOpts.dimensions,
          user: callOpts.user,
        });
        usage = upstream.usage;
        // Dims gate (D-03): assert every vector matches entry.dims
        for (const item of upstream.data) {
          const vec = Array.isArray(item.embedding) ? item.embedding : decodeBase64(item.embedding);
          if (entry.dims && vec.length !== entry.dims) {
            throw new EmbeddingsDimsMismatchError(entry.name, entry.dims, vec.length);
          }
          slots[missIndices[item.index]!] = vec;
          opts.metrics.embeddingsDimsTotal.inc({ model: entry.name, dims: String(vec.length) });
          // populate cache
        }
      }

      const embeddings = slots.map(v => v ?? []);
      return { embeddings, model: entry.name, usage };
    },
  };
}
```

### Route refactor sketch (P7-01 wire shape preserved)
```ts
// router/src/routes/v1/embeddings.ts (post-Phase-19, sketch)
// ... applyPreflight, capability check, idempotency leader/follower ... (unchanged) ...
const inputs = Array.isArray(body.input) ? body.input : [body.input];
opts.metrics?.embeddingsBatchSize.observe(inputs.length);  // D-07: route still owns batch_size

const providerResult = await req.server.embeddingProvider.embed(inputs, {
  model: body.model,
  dimensions: body.dimensions,
  user: body.user,
});

// D-02: re-encode to base64 if client asked
const data = providerResult.embeddings.map((vec, i) => ({
  object: 'embedding' as const,
  index: i,
  embedding: body.encoding_format === 'base64' ? encodeBase64(vec) : vec,
}));

const responseBody = {
  object: 'list' as const,
  data,
  model: providerResult.model,
  usage: providerResult.usage,
};

// D-08: route still computes cost
const cents = computeCostCents(providerResult.usage, entry);
reply.header('X-Cost-Cents', String(cents));
// ... safeRecord, etc. ...
return responseBody;  // BYTE-IDENTICAL to pre-Phase-19 wire shape (P7-01)
```

### `check-prometheus-cardinality.ts` dual-mode CLI (locked from D-13)
```ts
// router/scripts/check-prometheus-cardinality.ts (post-Phase-19, sketch)
export function checkCardinalityLive(exposition: string): CardinalityViolation[] {
  const violations: CardinalityViolation[] = [];
  const lines = exposition.split('\n');
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    if (!line || line.startsWith('#')) continue;  // skip HELP/TYPE/comments
    const labelMatch = line.match(/^([a-z0-9_]+)\{([^}]*)\}/);
    if (!labelMatch) continue;  // unlabeled metric or malformed line
    const metricName = labelMatch[1]!;
    const labelText = labelMatch[2]!;
    for (const m of labelText.matchAll(/([a-z0-9_]+)\s*=\s*"/g)) {
      const labelName = m[1]!;
      if (FORBIDDEN_LABEL_RE.test(labelName)) {
        violations.push({
          location: `/metrics:${lineNo + 1}`,
          arrayText: `{${labelText}}`,
          forbiddenLabel: labelName,
          metricNameHint: metricName,
        });
      }
    }
  }
  return violations;
}

// CLI dispatch
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const mode = args[0] === '--live' ? 'live' : 'source';
  const target = args[1] ?? (mode === 'source' ? 'src/metrics/registry.ts' : null);
  // ... fetch or readFileSync; run appropriate check; print + exit ...
}
```

### Smoke section new gate sketches (locked from D-15, D-18, D-20)
```bash
# bin/smoke-test-router.sh — new Phase 19 section between Phase 18 (line 2538) and the summary banner (line 2544)
echo ""
echo "[smoke-test-router] === Phase 19 — EmbeddingProvider + Observability hardening (EMBP-01..02 + OBSV-01..04) ==="

# Cite-only banner — prior phases satisfy slices of OBSV-01
echo "[smoke-test-router] OBSV-01 MCP slice: satisfied by Phase 15 MCP-01..03 (cited)"
echo "[smoke-test-router] OBSV-01 Session slice: satisfied by Phase 17 SESSION SC-1..SC-4 (cited)"
echo "[smoke-test-router] EMBP-02 regression: Phase 7 EMBED-01 + Phase 12 EMB-H01..06 gates re-asserted (above)"

# OBSV-02-LIVE: live /metrics cardinality scrape
OBSV02_LIVE=$(curl -sS "${ROUTER_URL}/metrics" | node router/scripts/check-prometheus-cardinality.ts --live - 2>&1 && echo OK || echo FAIL)
if [[ "${OBSV02_LIVE}" == "OK" ]]; then
  pass "OBSV-02-LIVE: /metrics exposition has no /_id$/ labels (live parser)"
else
  fail "OBSV-02-LIVE: ${OBSV02_LIVE}"
fi

# RESS-WITH-TOOLS: streaming /v1/responses with a function-calling cloud model
# Skip if OLLAMA_API_KEY absent or no function-calling cloud model in models.yaml
if [[ -z "${OLLAMA_API_KEY:-}" ]]; then
  skip "RESS-WITH-TOOLS: OLLAMA_API_KEY absent — skipping cloud function-call smoke"
else
  # ... POST /v1/responses with tools, assert response.function_call_arguments.delta + incomplete tool_calls ...
fi

echo ""
echo "[smoke-test-router] === Phase 19 section complete ==="
```

### DEPLOY.md new section structure (locked from D-21)
- `## EmbeddingProvider (Phase 19 — v0.11.0)`
  - Strategic frame citation (binding): "Retrieval Interfaces, not Retrieval Logic" + Frame-01 invariant
  - Interface TypeScript signature
  - Code example: how a pre-completion hook calls `fastify.embeddingProvider.embed` from a custom retriever
  - Wire-shape regression invariant (P7-01): `/v1/embeddings` byte-identical
  - Observability surface table: `router_embeddings_cache_total{result}` + `router_embeddings_batch_size` + `router_embeddings_dims_total{model,dims}` (unchanged from Phase 12; ownership shift noted)
  - Verification matrix: EMBP-01 → conformance unit test; EMBP-02 → regression suite + smoke gates

### README.md new section + status banner (locked from D-21)
- `## EmbeddingProvider (v0.11.0)`
  - One-paragraph TS interface intro + code example
  - Link to `DEPLOY.md` operator section
- Estado del proyecto table row for v0.11.0: ` `✅ shipped 2026-06-0X | 48 reqs / 6 phases · …`

</specifics>

<deferred>
## Deferred Ideas

- **`EmbeddingProvider` per-tenant scoping** — a future RetrieverProvider that needs tenant-isolated embedding usage tracking. v0.11.0 ships a single global provider; per-tenant is a v0.12+ scale-out shape. Same logic as MCPC-FUT-02.
- **`EmbeddingProvider.batchEmbed(batches[])` multi-batch API** — for high-throughput vector-ingestion pipelines. Not needed for chat-shaped retrieval (one query per turn). Defer to a real consumer ask.
- **Provider returns `cost_cents` field** — Cleaner separation rejected in favor of D-08 (route owns cost). If a future RetrieverProvider consumer needs per-call cost without going through the wire, we add it then.
- **Provider-level `embeddingsBatchSize` histogram** — D-07 keeps batch_size route-only. If RetrieverProvider call shape diverges significantly (e.g., always batch-size=1 vs route's typical batch-size=N), we add a sibling `router_embeddings_provider_batch_size`. Defer.
- **`prom-client`-based parser for OBSV-02 live mode** — D-14 keeps regex. If we hit a malformed-exposition edge case, switch to prom-client's parser. Defer until a real failure mode surfaces.
- **`/v1/responses` stream-WITH-tools golden fixture replay smoke gate** — D-18 picks live cloud call. If cost or flakiness becomes an issue, fall back to fixture replay. Defer.
- **`tools/list` explicit smoke gate** — D-17 logged as not added. Revisit if a consumer reports list-vs-call divergence.
- **EmbeddingProvider `dimensions` reduction inside provider** — currently provider forwards `dimensions` to upstream; OpenAI v3+ supports server-side truncation. If a future caller wants client-side truncation (e.g., 1024 → 768 PCA), add it then.
- **`session_appended_total` Prometheus signal sibling for embeddings cache** — Phase 17 added `router_session_append_failed_total`; an analogous counter for embeddings cache writes that fail could improve operability. Not in OBSV-01 scope; defer.
- **Hot-reload of `embedded_provider` cache TTL** — currently provider reads TTL at construction time; hot-reload would require re-wiring through `watchRegistry.onSwap`. Not in scope; defer.
- **Plan-time migration script** — the OBSV-04 no-op migration was tempting but D-22 vetos it. Future: a "milestone-close" no-op migration that records milestone wrap-up metadata. Out of scope, listed for the v0.12+ playbook.

</deferred>

---

*Phase: 19-embeddingprovider-formalization-observability-hardening*
*Context gathered: 2026-06-01*
