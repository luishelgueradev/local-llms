# Phase 19: EmbeddingProvider Formalization + Observability Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-01
**Phase:** 19-embeddingprovider-formalization-observability-hardening
**Areas discussed:** EmbeddingProvider shape, Cache placement after extraction, OBSV-02 live /metrics parse, OBSV-01 smoke gaps

---

## EmbeddingProvider shape

### Q1: Concrete shape of `embeddings`

| Option | Description | Selected |
|--------|-------------|----------|
| `number[][]` normalized | Provider returns flat number[][] (one vector per input, base64 always decoded). Route re-wraps as OpenAI data: [{ object, index, embedding }] to preserve P7-01 BLOCK byte-identical wire shape. Matches REQ language verbatim. | ✓ |
| OpenAI-list passthrough | Provider returns existing `{ object: 'list', data, model, usage }` verbatim. Route is a literal forwarder. Consumers must handle `data[].embedding: number[] \| string`. | |
| Both — `{ embeddings, openai }` | Provider returns BOTH the normalized embeddings and raw openai field. Heavier interface, zero consumer translation. | |

**User's choice:** `number[][]` normalized (Recommended).
**Notes:** Aligns with REQUIREMENTS.md literal text. RetrieverProvider consumers get a clean shape.

### Q2: `encoding_format` handling in the provider

| Option | Description | Selected |
|--------|-------------|----------|
| Provider ignores it — always `number[][]` | Provider opts omit `encoding_format`. Provider always decodes base64. Route still accepts client-side `encoding_format: 'base64'` and re-encodes at the wire boundary. | ✓ |
| Provider forwards it — returns `number[] \| string` | Provider opts include `encoding_format`. Consumers handle union. Closer to OpenAI semantics. | |
| You decide | Pick smallest diff once code is in front of you. | |

**User's choice:** Provider ignores it (Recommended).
**Notes:** Encoding is a wire-level concern, not a vector-shape concern.

### Q3: Dims enforcement location

| Option | Description | Selected |
|--------|-------------|----------|
| Move into the provider | Provider throws `EmbeddingsDimsMismatchError`. Direct provider calls (future retrievers) can't bypass dims protection. | ✓ |
| Keep dims gate in route | Provider returns raw vectors; route checks. Smaller provider surface but a future retriever can poison a vector store. | |
| Dual gate — provider checks then route re-checks | Defense-in-depth; more code, marginal benefit. | |

**User's choice:** Move into provider (Recommended).
**Notes:** Single source of truth; protects every consumer.

### Q4: `embed()` call signature

| Option | Description | Selected |
|--------|-------------|----------|
| `embed(input, opts: { model })` — provider resolves internally | Provider runs registry.resolve + capability check + adapter factory. Route still runs applyPreflight upstream (policy + breaker). | ✓ |
| `embed(input, opts: { entry })` — caller resolves | Caller passes ModelEntry. Retrievers need a separate `fastify.modelRegistry` decorator. More plumbing. | |
| Both — union typed | Provider accepts either. Maximally flexible, minor interface complexity. | |

**User's choice:** `embed(input, opts: { model })` (Recommended).
**Notes:** Clean separation; route's applyPreflight upstream guarantees policy + breaker still fire on the wire path.

---

## Cache placement after extraction

### Q1: Cache location

| Option | Description | Selected |
|--------|-------------|----------|
| Move cache into the provider | Provider owns Valkey hit/miss/bypass + base64-skip + fail-open. Any consumer gets cache for free. | ✓ |
| Keep cache in the route | Provider always calls upstream; retrievers pay full latency. Lowest regression risk on EMB-H01..04. | |
| Cache in route AND opt-in cache in provider | Most flexible; risk of two TTL-divergent cache instances. | |

**User's choice:** Move into the provider (Recommended).
**Notes:** Retriever consumers gain cache hits for free; metric name/labels unchanged (ownership shift only).

### Q2: `embeddingsBatchSize` histogram ownership (EMB-H03)

| Option | Description | Selected |
|--------|-------------|----------|
| Route still observes batch size | Wire-shape metric stays in wire layer. Clear separation: route observes inbound batch size; provider observes cache outcomes. | ✓ |
| Move batch histogram into provider | One observer; loses 'wire batch size' meaning if retrievers contribute. | |
| Both observe (split metrics) | Two histograms; clear separation; +cardinality cost (acceptable, no per-request labels). | |

**User's choice:** Route still observes (Recommended).
**Notes:** Wire metrics stay wire-local.

### Q3: Cost ownership

| Option | Description | Selected |
|--------|-------------|----------|
| Route still owns cost | Provider returns `usage` only (cache hits = 0 prompt_tokens). Route runs computeCostCents + stamps X-Cost-Cents. | ✓ |
| Provider returns `cost_cents` alongside usage | Provider runs computeCostCents itself. Retrievers see real cost numbers automatically. Couples pricing into provider. | |
| You decide | Smallest diff. | |

**User's choice:** Route still owns cost (Recommended).
**Notes:** Provider returns usage; route monetizes. Cleaner separation.

### Q4: Provider construction location

| Option | Description | Selected |
|--------|-------------|----------|
| Composition root + buildApp opts | router/src/index.ts constructs `makeOpenAIEmbeddingProvider({...})` and passes via buildApp opts. buildApp calls app.decorate. Mirrors Phase 17/18. | ✓ |
| buildApp constructs internally | Less surface; tests can't inject a fake without monkey-patching. | |
| Fastify plugin | More files; allows per-route scoping later. | |

**User's choice:** Composition root + buildApp opts (Recommended).
**Notes:** Frame-01 pattern preserved; tests inject fakes via tests/fakes.ts.

---

## OBSV-02 live /metrics parse

### Q1: Where does the live parser live?

| Option | Description | Selected |
|--------|-------------|----------|
| Extend existing script to dual-mode | `check-prometheus-cardinality.ts --source` (existing) + `--live <url>` (new). One script, two modes. | ✓ |
| Separate live-only script | New file, zero regression on static script. Two scripts, duplicated parsing. | |
| Embed in smoke-test-router.sh | bash-native grep gate. No new TS code. Smoke-only, no CI coverage. | |

**User's choice:** Extend existing script to dual-mode (Recommended).
**Notes:** Honors the Phase 14 BOM comment 'live-parse case is deferred to Phase 19' as a design contract.

### Q2: Parser choice

| Option | Description | Selected |
|--------|-------------|----------|
| Roll our own regex parser | ~30 lines, no new deps; FORBIDDEN_LABEL_RE = /_id$/ unchanged. Matches static script ethos. | ✓ |
| Add `prom-client` parsing helpers | Already in deps; risks pulling code that doesn't belong in a CI script. | |
| Zod schema parsing | Formal validation; marginal value for an _id$ substring search. | |

**User's choice:** Roll our own regex (Recommended).
**Notes:** Cheapest, lowest dependency footprint.

### Q3: When does the live check run?

| Option | Description | Selected |
|--------|-------------|----------|
| Smoke-test-router.sh only | Operator-driven; CI still runs static; matches CI vs smoke split. | |
| Both CI (in-band) and smoke | Catches drift in CI image vs prod image; +CI complexity. | ✓ |
| Pre-commit + smoke | Phase 14's CI gate already does static; pre-commit doesn't help. | |

**User's choice:** Both CI + smoke.
**Notes:** Stronger drift protection across build pipeline.

### Q4: How does CI get a live /metrics endpoint?

| Option | Description | Selected |
|--------|-------------|----------|
| Vitest in-band — buildApp + app.inject | Zero Docker, runs in existing vitest suite. Catches inline-declared metrics at import time + runtime drift. | ✓ |
| GitHub Actions service container | Docker dependency in CI; closer to prod traffic. Heavier. | |
| Single bootstrap script CI calls | Halfway between the two. | |

**User's choice:** Vitest in-band (Recommended).
**Notes:** No CI workflow YAML change expected; existing test runner picks it up.

---

## OBSV-01 smoke gaps

### Q1: `/v1/responses` streaming WITH tools — how to verify live?

| Option | Description | Selected |
|--------|-------------|----------|
| Cloud function-calling model live | New smoke gate against gpt-oss:120b-cloud (or whichever cloud model emits Responses-API tool calls). Soft-skip without OLLAMA_API_KEY. ~$0.001/run. | ✓ |
| Vitest covers it; smoke documents the split | Cheaper; reinterprets OBSV-01 literal 'with and without tools'. | |
| Golden fixture replay in smoke | Captures the with-tools sequence once; replays in smoke. No live call, no cost. | |

**User's choice:** Cloud function-calling model live (Recommended).
**Notes:** Honors OBSV-01 literal text; bounded cost.

### Q2: MCP slice — anything missing?

| Option | Description | Selected |
|--------|-------------|----------|
| Phase 15 smoke is sufficient — cite + done | MCP-01..03 already cover OBSV-01 MCP requirement. Phase 19 adds one-line banner cite. | ✓ |
| Add a `tools/list` explicit check | Phase 15 MCP-03 calls tools/call list_models but doesn't gate tools/list response shape. | |
| Re-run all Phase 15 MCP gates under OBSV-01 banner | Higher coverage signal; duplicates work. | |

**User's choice:** Phase 15 smoke is sufficient — cite + done (Recommended).
**Notes:** No new MCP gates in Phase 19 smoke.

### Q3: SessionStore round-trip — anything to extend?

| Option | Description | Selected |
|--------|-------------|----------|
| Phase 17 smoke is sufficient — cite + done | Phase 17 SC-1..SC-4 + Prometheus signal + POL-06 cite covers OBSV-01 session round-trip. | ✓ |
| Add a stream-mode session round-trip | Catches Phase 17 Q5 follower deferred case. | |
| Add EmbeddingProvider session-friendly gate | Tiny defensive check; near-zero failure-mode value. | |

**User's choice:** Phase 17 smoke is sufficient — cite + done (Recommended).
**Notes:** Reduces smoke surface; SessionStore semantics fully exercised by Phase 17 SESSION section.

### Q4: EmbeddingProvider conformance gate

| Option | Description | Selected |
|--------|-------------|----------|
| Vitest-only — unit test asserts conformance | EMBP-01 SC-4 literal: 'verified by unit test asserting interface conformance'. Smoke gets one regression cite line for EMBP-02. | ✓ |
| New smoke gate via /v1/embeddings | Reuses Phase 7 EMBED-01; just stronger byte-identical assertion. | |
| Smoke gate via debug `/__embedding_provider_self_test` route | Pollutes API surface; rejected pattern. | |

**User's choice:** Vitest-only (Recommended).
**Notes:** Honors EMBP-01 literal text; EMBP-02 covered by existing Phase 7 + Phase 12 smoke gates.

---

## Claude's Discretion

- Exact file layout under `router/src/providers/embedding-provider.ts` (interface, error types, factory function — coarser/finer split).
- Whether `makeFakeEmbeddingProvider` goes in `tests/fakes.ts` directly or in a sibling `tests/fakes/embedding.ts` — match existing pattern.
- Exact wording of the `RESS-WITH-TOOLS` smoke-skip message + which cloud model to target (planner verifies against Phase 16 vitest tool tests + current models.yaml).
- The exact CI workflow step where `cardinality-live.integration.test.ts` runs (likely auto-picked by existing vitest config).
- Whether the OBSV-04 re-verification PG-gated test is a new file or extends an existing migrations test.
- README v0.11.0 SHIPPED banner exact wording / badge style.

## Deferred Ideas

- EmbeddingProvider per-tenant scoping (v0.12+ scale-out shape).
- `EmbeddingProvider.batchEmbed(batches[])` multi-batch API.
- Provider returns `cost_cents` field (would require pricing config in provider).
- Provider-level `embeddingsBatchSize` histogram (currently route-only per D-07).
- `prom-client`-based parser for OBSV-02 live mode (regex covers; switch if exposition format edge case surfaces).
- Stream-WITH-tools golden fixture replay smoke gate (fallback if live cloud call gets too flaky/expensive).
- Explicit `tools/list` smoke gate (revisit if a consumer reports list-vs-call divergence).
- EmbeddingProvider `dimensions` reduction inside provider (currently forwarded to upstream).
- `router_embeddings_cache_failed_total` sibling Prometheus counter (analogous to Phase 17's session_append_failed_total).
- Hot-reload of embedded_provider cache TTL (currently construction-time only).
- Plan-time no-op milestone-close migration (out of scope; v0.12+ playbook idea).
