# Phase 19: EmbeddingProvider Formalization + Observability Hardening — Research

**Researched:** 2026-06-01
**Domain:** Provider-interface formalization + observability tooling extension (infrastructure phase — zero AI/model integration)
**Confidence:** HIGH (all unknowns resolved from in-repo evidence; CONTEXT.md D-01..D-24 already lock the design)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01..D-05** — EmbeddingProvider interface shape: `embed(input, opts) → { embeddings: number[][], model, usage }`; provider does NOT accept `encoding_format` (always works in float, route handles base64 round-trip); dims enforcement moves INTO the provider (single source of truth — option (a)); `embed(input, { model, dimensions?, user? })`; reuses existing error types (`RegistryUnknownModelError`, `CapabilityNotSupportedError`, `EmbeddingsDimsMismatchError`, `BreakerOpenError`).
- **D-06..D-08** — Valkey cache moves INTO provider (owns hit/miss/bypass increments + fail-open); route still owns `router_embeddings_batch_size` (wire-shape metric); route still owns cost (`X-Cost-Cents` + `request_log.cost_cents`). Provider returns `usage`; route runs `computeCostCents(usage, entry)`.
- **D-09..D-12** — Composition root in `router/src/index.ts` constructs `makeOpenAIEmbeddingProvider({ registry, makeAdapter, valkey, env, metrics, log })`; threaded through `BuildAppOpts.embeddingProvider?: EmbeddingProvider`; `app.decorate('embeddingProvider', ...)` when present; new Fastify type-augmentation file required; test fake `makeFakeEmbeddingProvider({ dims })` in `tests/fakes.ts`.
- **D-13..D-15** — Extend `router/scripts/check-prometheus-cardinality.ts` to dual-mode (`--source <path>` | `--live <url>`); roll our own regex parser (no new deps); live check runs BOTH in CI (new `router/tests/integration/cardinality-live.integration.test.ts`) AND smoke (`OBSV-02-LIVE` gate).
- **D-16..D-20** — MCP slice (OBSV-01) marked DONE by Phase 15 MCP-01..03; `tools/list` explicit gate NOT added (duplication); `/v1/responses` streaming WITH tools = NEW `RESS-WITH-TOOLS` smoke gate (soft-skip on missing `OLLAMA_API_KEY` or function-calling cloud model); SessionStore round-trip DONE by Phase 17 SC-1..SC-4; EmbeddingProvider conformance is VITEST-ONLY in `router/tests/providers/embedding-provider.test.ts`.
- **D-21** — OBSV-03 doc consolidation: new DEPLOY.md §"EmbeddingProvider (Phase 19 — v0.11.0)", new README.md §"EmbeddingProvider (v0.11.0)", flip v0.11.0 SHIPPED banner row to ✅.
- **D-22** — OBSV-04 is a no-op (migration 0007 shipped by Plan 18-02); Phase 19 adds a PG-gated re-verification test only; NO new migration.
- **D-23** — Expected plan count: 5–7. Tentative 7-plan breakdown listed.
- **D-24** — P7-01 BLOCK: SHA-256 baseline in `tests/unit/grep-gates/embeddings-untouched.test.ts` must be updated atomically with the route refactor (route diff + baseline diff in the SAME commit).

### Claude's Discretion
- Exact file layout under `router/src/providers/embedding-provider.ts` (interface, error re-exports, factory function, internal cache helper). Planner picks coarser/finer split based on existing `providers/` layout.
- Whether `makeFakeEmbeddingProvider` lives in `tests/fakes.ts` directly or in a sibling file (match existing pattern — Phase 17 + Phase 18 fakes all live in `tests/fakes.ts`, no sibling files).
- Exact wording of `RESS-WITH-TOOLS` smoke-skip message + cloud model name targeted (this RESEARCH proposes `gpt-oss:20b-cloud` — cheaper than 120b — see §3).
- Exact CI workflow file path / step where `cardinality-live.integration.test.ts` is invoked (this RESEARCH confirms: zero config change needed — see §6).
- Whether OBSV-04 re-verification PG-gated test is a new file or an extension of `tests/integration/migrations/0007-hook-log.test.ts` (this RESEARCH recommends EXTEND existing — see §8).
- README v0.11.0 SHIPPED banner exact wording — mirror existing v0.9.0 / v0.10.0 row format.

### Deferred Ideas (OUT OF SCOPE)
- Per-tenant EmbeddingProvider scoping; `EmbeddingProvider.batchEmbed`; provider returns `cost_cents` field; provider-level batch-size histogram; `prom-client`-based parser (regex stays); RESS-WITH-TOOLS golden-fixture replay fallback; `tools/list` explicit smoke gate; provider-internal `dimensions` reduction; embeddings cache write-failure metric counter; hot-reload of cache TTL; plan-time milestone-close no-op migration.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **EMBP-01** | TypeScript interface `EmbeddingProvider` exported with `embed(input, opts) → { embeddings, model, usage }`; exposed via `fastify.decorate('embeddingProvider', ...)`. | §3 (conformance test pattern) + §7 (composition root threading) — mirror Phase 17 SessionStore + Phase 18 RetrieverProvider patterns. |
| **EMBP-02** | `/v1/embeddings` route delegates to `EmbeddingProvider`; wire shape, dims enforcement, Valkey cache, X-Cost-Cents unchanged (regression suite verifies). | §4 (defense-in-depth dims check is redundant — provider is canonical) + §5 (P7-01 SHA-256 baseline rotation procedure). |
| **OBSV-01** | `bin/smoke-test-router.sh` gains sections covering MCP host + `/v1/responses` stream with+without tools + SessionStore round-trip; live tunnel run prints PASS/FAIL summary. | §3 (RESS-WITH-TOOLS model selection) — MCP+Session slices already covered by Phase 15+17 sections (CONTEXT D-16/D-19). |
| **OBSV-02** | New CI check `check-prometheus-cardinality.ts` parses LIVE `/metrics` and FAILS on any `_id` label. | §2 (Prometheus exposition format invariants) + §6 (vitest config picks up new integration test). |
| **OBSV-03** | README + DEPLOY updated for MCP host/client + sessions + hooks + policy + scoped IDs. | Most content already shipped by Phase 14/15/17/18 docs; Phase 19 adds EmbeddingProvider section + flips v0.11.0 SHIPPED banner (CONTEXT D-21 coverage matrix). |
| **OBSV-04** | Drizzle migration 0007 adds `hook_log` JSONB IF not added in Phase 18 (safety net). | §8 (already shipped by Plan 18-02; verified live PG column — no new migration; re-verify in extended test). |
</phase_requirements>

## Executive Summary

- **Phase is infrastructure formalization, not new behavior.** CONTEXT.md locks every architectural decision (D-01..D-24). Research focused on the 8 executable unknowns the planner can't infer from CONTEXT alone — all resolved from in-repo evidence.
- **P7-01 SHA-256 baseline is currently `b53c6ba1298b8b78b65f75d951e778bd031994fdcd65d14e659f8f3dd666e970`** — verified via `shasum -a 256 router/src/routes/v1/embeddings.ts`. Phase 18 did not touch the file. Phase 19's route refactor MUST update the baseline in the SAME commit as the route diff (D-24 / `embeddings-untouched.test.ts:51` enforces).
- **`gpt-oss:20b-cloud` is the right model for the new `RESS-WITH-TOOLS` smoke gate** — it has `capabilities: [chat, tools, json_mode]` declared in `models.yaml:266`, lower per-token cost than the 120b sibling, and Phase 16 vitest tool tests verify the FSM-level invariants (the smoke gate adds the live-cloud round-trip Phase 16 deliberately couldn't cover).
- **`vitest.config.ts` already includes `tests/**/*.test.ts`** — the new `cardinality-live.integration.test.ts` is picked up with zero config change. No CI workflow YAML edit needed.
- **OBSV-04 is a verification-only requirement.** Migration 0007 already exists (`db/migrations/0007_request_log_hook_log.sql` + journal idx=7 + Drizzle schema). The PG-gated test `tests/integration/migrations/0007-hook-log.test.ts` already passes 7 cases. Phase 19 extends THIS file (don't create a new one) with a `'re-verified Phase 19'` describe block citing OBSV-04.

**Primary recommendation:** This is a high-confidence, low-novelty phase. Mirror Phase 17 (SessionStore) + Phase 18 (RetrieverProvider) patterns mechanically. The only NEW research deliverable is the Prometheus live-exposition regex (§2) — every other unknown is "look at how the prior phase did it."

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| EmbeddingProvider interface declaration | router/src/providers/ | — | Same tier as `session-store.ts` + `retriever-provider.ts`; Frame-01 keeps production impls out of `src/` (factory returns an object literal, never a class). |
| `makeOpenAIEmbeddingProvider` factory | router/src/providers/ | — | Co-located with the interface (same file pattern as `postgres-session-store.ts` sits next to `session-store.ts`). |
| Provider construction + wiring | router/src/index.ts | router/src/app.ts | Composition root (index.ts) constructs; app.ts widens `BuildAppOpts.embeddingProvider?` + `app.decorate(...)`. Mirrors Phase 17 SessionStore + Phase 18 MCPClientRegistry exactly. |
| Valkey cache lookup + populate | provider internals | — | D-06 moved cache from route to provider — single owner. |
| Dims enforcement | provider internals | — | D-03 picks option (a) — single source of truth. |
| Wire-shape `data: [{ object, index, embedding }]` envelope | `/v1/embeddings` route | — | D-08 + D-01: route translates provider's `number[][]` to OpenAI list shape on egress. |
| `X-Cost-Cents` header + `request_log.cost_cents` | `/v1/embeddings` route | — | D-08 keeps cost in the route (provider returns `usage` only). |
| `router_embeddings_batch_size` histogram | `/v1/embeddings` route | — | D-07: wire-shape metric stays in wire layer. |
| `router_embeddings_cache_total{result}` counter | provider internals | — | D-06: provider owns hit/miss/bypass increments. |
| `router_embeddings_dims_total{model,dims}` counter | provider internals | — | D-06: provider owns dims metric (next to dims-enforcement throw). |
| Live `/metrics` cardinality CI gate | `scripts/check-prometheus-cardinality.ts` (extended) | `router/tests/integration/` + `bin/smoke-test-router.sh` | D-13: same script, two flags (`--source` / `--live`); vitest in-band + smoke live-tunnel. |
| RESS-WITH-TOOLS smoke gate | `bin/smoke-test-router.sh` | `router/models.yaml` (model declaration) | D-18: live SSE round-trip with cloud function-calling model. |
| EmbeddingProvider docs | `DEPLOY.md` + `README.md` | — | D-21: operator-facing in DEPLOY, consumer-facing in README. |

## Standard Stack

### Core (already in repo — zero new dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Fastify | `^5.8.5` | `app.decorate('embeddingProvider', ...)` API | Already in repo; same `decorate` API used by Phase 17 `req.sessionId` + Phase 18 `req.hookLog`. `[CITED: router/package.json + existing app.ts]` |
| `fastify` type augmentation | (TS module-augmentation) | `declare module 'fastify' { interface FastifyInstance { embeddingProvider: EmbeddingProvider } }` | Pattern locked in CONTEXT D-11; mirrors Phase 17/18 augmentations. `[VERIFIED: read app.ts:80–305 + existing req-augmentation patterns in tests/]` |
| `ioredis` (Valkey client) | `^5.x` | Per-input cache lookup + populate | Already in repo; cache moves from route to provider unchanged (`embeddings/cache.ts` re-used). `[CITED: router/src/embeddings/cache.ts]` |
| `crypto` (Node built-in) | — | SHA-256 baseline computation for P7-01 gate | No new dep. `[VERIFIED: tests/unit/grep-gates/embeddings-untouched.test.ts:25]` |
| vitest | `^3.x` | Conformance test + integration test framework | Already in repo. `[CITED: router/vitest.config.ts]` |

**Installation:** **No new packages.** Phase 19 ships zero new npm dependencies. Confirmed by inspection of D-14 (regex parser, not `prom-client.Parser`) + D-09 (cache, registry, valkey all already in composition root).

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Regex Prometheus parser (D-14) | `prom-client`'s built-in parser | Adds nothing — `prom-client` exports metric collection, not exposition parsing. The only existing TS Prometheus parser is `parse-prometheus-text-format` (npm). CONTEXT.md picks regex explicitly; that's appropriate for the narrow "find label names ending in `_id`" job — full parser is overkill. |
| Conformance test via `expectTypeOf` (CONTEXT D-20) | Runtime structural assertion only | The existing Phase 17 SessionStore conformance test uses `expectTypeOf` for type-shape + runtime `expect()` for error-class wire behavior — Phase 19 must follow this exact pattern (see §3). |
| New OBSV-04 test file | Extending existing `0007-hook-log.test.ts` | Extending is correct — the migration is the same migration. Phase 17's pattern: `0006-sessions.test.ts` has one describe; we add a sibling describe block in `0007-hook-log.test.ts` for "Phase 19 re-verification." |

## Package Legitimacy Audit

> Phase 19 installs zero new npm packages. The Standard Stack table reuses only packages already declared in `router/package.json` and verified by the existing Phase 14/17/18 supply-chain audits.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| _none — zero new installs_ | — | — | — | — | — | — |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Answered Unknowns

### 1. D-18 RESS-WITH-TOOLS Model Selection

**Question:** Which cloud function-calling model declared in `router/models.yaml` consistently emits Responses-API-compatible `response.function_call_arguments.delta` events ending with `response.completed` + `status: 'incomplete'` + `incomplete_details: { reason: 'tool_calls' }`?

**Answer:** **`gpt-oss:20b-cloud`** `[VERIFIED: router/models.yaml:266–277]`

**Evidence in models.yaml (lines 266–277):**
```yaml
- name: gpt-oss:20b-cloud
  backend: ollama-cloud
  backend_url: https://ollama.com/v1
  backend_model: gpt-oss:20b-cloud
  capabilities: [chat, tools, json_mode]
  pricing:
    input_per_1m: 0.10
    output_per_1m: 0.30
  vram_budget_gb: 0
  concurrency: 4
  max_model_len: 32768
  profile: cloud
```

Both `gpt-oss:120b-cloud` and `gpt-oss:20b-cloud` declare `capabilities: [chat, tools, json_mode]`. The 20b variant is preferred because:
1. **5× cheaper input** (`$0.10/1M` vs `$0.50/1M`) — smoke runs frequently; cost matters
2. **5× cheaper output** (`$0.30/1M` vs `$1.50/1M`)
3. **Smaller context window (32768 vs 65536)** — neither matters for the trigger prompt
4. **Same capability declarations** — wire-level tool-call emission is identical

**Phase 16 vitest tool tests do NOT exercise real cloud models** — `router/tests/routes/responses-stream.test.ts:46–47` uses a FAKE adapter with `backend_model: qwen2.5:7b` and emits canonical events programmatically. The vitest tests verify the FSM-level invariants (the SSE event ordering, the `incomplete_details: { reason: 'tool_calls' }` invariant) `[VERIFIED: router/tests/routes/responses-stream.test.ts:361–402]`. The smoke gate adds what vitest cannot: a live cloud round-trip proving the FSM also handles real upstream tool-call deltas. This is the gap CONTEXT D-18 is explicitly closing.

**Minimal deterministic prompt + tool schema:**
```bash
curl -sS -N -X POST "${ROUTER_URL}/v1/responses" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "stream": true,
    "model": "gpt-oss:20b-cloud",
    "input": "Call get_time to fetch the current UTC time.",
    "tools": [{
      "type": "function",
      "name": "get_time",
      "description": "Get the current UTC time in ISO-8601 format.",
      "parameters": {
        "type": "object",
        "properties": {},
        "required": []
      }
    }]
  }'
```

**Soft-skip predicate** (mirrors Phase 8 §1568 pattern in `bin/smoke-test-router.sh`):
```bash
if [[ -z "${OLLAMA_API_KEY:-}" ]]; then
  skip "RESS-WITH-TOOLS: OLLAMA_API_KEY absent — skipping cloud function-call smoke"
elif ! grep -q "^[[:space:]]*-[[:space:]]*name:[[:space:]]*gpt-oss:20b-cloud" router/models.yaml; then
  skip "RESS-WITH-TOOLS: gpt-oss:20b-cloud not declared in models.yaml — skipping"
else
  # ... real curl + SSE parse + assert ...
fi
```

**Confidence:** HIGH — model declaration verified directly in `models.yaml`; Phase 16 FSM invariants verified in `router/tests/routes/responses-stream.test.ts:361–402`.

### 2. D-14 Prometheus Exposition Parser Edge Cases

**Question:** What minimal exposition-format invariants must the `checkCardinalityLive` regex parser handle?

**Authoritative spec:** [Prometheus text-based exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format) `[CITED]`

**Exposition lines the parser must handle (one series per line — strictly no continuations):**

| Line shape | Action | Example |
|------------|--------|---------|
| `# HELP <name> <text>` | **SKIP** — comment | `# HELP router_requests_total Total requests` |
| `# TYPE <name> <type>` | **SKIP** — comment | `# TYPE router_requests_total counter` |
| `# <anything>` | **SKIP** — any line starting with `#` | `# arbitrary operator comment` |
| Blank line | **SKIP** | (empty line between metric families) |
| `metric_name 42.0` | **SKIP** — unlabeled metric; no labels to check | `router_node_uptime_seconds 12345` |
| `metric_name{} 42.0` | **SKIP** — empty label set (defensive — valid but rare) | `router_xxx_total{} 0` |
| `metric_name{label1="v1",label2="v2"} 42.0` | **PARSE** — extract label NAMES, check `/_id$/` | `router_requests_total{method="GET",route="/api"} 1234` |
| `metric_name{label1="v1",label2="v2"} 42.0 1234567890` | **PARSE** — timestamp is appended; the parser ignores everything after `}` | (rarely emitted by prom-client; spec-allowed) |
| Histogram bucket: `metric_bucket{le="..."} 42.0` | **PARSE** — `le` is a reserved label, NOT user-defined; **still must pass the FORBIDDEN_LABEL_RE check** | `router_request_duration_ms_bucket{le="100",route="/api"} 42` |

**Escape rules inside label values** (spec §"Text-based format" — label values):
- Backslash-escaped: `\\` `\"` `\n`
- A label value can contain literal `\"` — the regex `([^}]*)` for the label set captures everything up to the FIRST `}`; values themselves may NOT contain `}` per the spec.

**Why the existing regex (CONTEXT D-14 sketch) is correct:**
```typescript
const labelMatch = line.match(/^([a-z0-9_]+)\{([^}]*)\}/);
// metricName = labelMatch[1]
// labelText  = labelMatch[2]
for (const m of labelText.matchAll(/([a-z0-9_]+)\s*=\s*"/g)) {
  const labelName = m[1]!;
  if (FORBIDDEN_LABEL_RE.test(labelName)) { /* violation */ }
}
```

- `^([a-z0-9_]+)\{` — metric name MUST be `[a-z0-9_]+` (Prometheus naming convention is enforced upstream by prom-client itself; the existing `LABEL_NAMES_RE` in `check-prometheus-cardinality.ts:34` already assumes this).
- `([^}]*)` — captures label text up to the first `}` (values cannot contain `}`).
- `([a-z0-9_]+)\s*=\s*"` — extracts label NAMES (the only thing we care about). Label NAMES are `[a-z_][a-z0-9_]*` per spec but the existing regex uses `[a-z0-9_]+` consistent with the static script — safe approximation (a name starting with a digit would be invalid Prometheus and rejected upstream).

**Edge cases the parser does NOT need to handle:**
- **Line continuations** — NOT part of Prometheus text format. One series per line. `[CITED: prometheus.io spec]`
- **Multi-line metric values** — Same. The value is the second whitespace-separated field.
- **Quoted label NAMES** — Names are unquoted in Prometheus exposition; only VALUES are quoted.
- **Unicode in label names** — Spec forbids; prom-client validates upstream.

**Histogram `_bucket{le="..."}` consideration:**
- `le` is a reserved label name. It does NOT end in `_id`. ✓
- Bucket lines look like `name_bucket{le="...",other_label="..."}` — the parser must NOT special-case bucket lines; the same `FORBIDDEN_LABEL_RE.test(labelName)` check applies to every label including `le`.
- Phase 18 added `router_hook_duration_ms` histogram with `[hook_name, status]` labels + implicit `le` — none ends in `_id`. ✓

**Confidence:** HIGH — spec is the authoritative source; existing static parser (`check-prometheus-cardinality.ts:53`) already handles the same general shape.

### 3. D-20 EmbeddingProvider Conformance Test — Mirror Pattern

**Question:** What's the exact assertion shape Phase 19's `router/tests/providers/embedding-provider.test.ts` must mirror?

**Authoritative reference:** `router/tests/providers/session-store.interface.test.ts` `[VERIFIED: read in full above]`

**Pattern to mirror (verbatim structure):**

```typescript
import { describe, expect, it, expectTypeOf } from 'vitest';
import type {
  EmbeddingProvider,
  // (any companion types: e.g., EmbeddingProviderResult, MakeOpenAIEmbeddingProviderOpts)
} from '../../src/providers/embedding-provider.js';
import { makeFakeEmbeddingProvider } from '../fakes.js';
// (existing) for the error-class wire tests, if any new ones land:
// import { EmbeddingsDimsMismatchError, ... } from '../../src/errors/envelope.js';

describe('EmbeddingProvider interface — EMBP-01', () => {
  it('EmbeddingProvider.embed signature', () => {
    expectTypeOf<EmbeddingProvider['embed']>().toEqualTypeOf<
      (
        input: string | string[],
        opts: { model: string; dimensions?: number; user?: string },
      ) => Promise<{
        embeddings: number[][];
        model: string;
        usage: { prompt_tokens: number; total_tokens: number };
      }>
    >();
  });

  it('returns { embeddings: number[][], model, usage } shape', async () => {
    const provider = makeFakeEmbeddingProvider({ dims: 1024 });
    const result = await provider.embed(['hello'], { model: 'embed-local' });
    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]).toHaveLength(1024);
    expect(result.embeddings[0]?.every((n) => typeof n === 'number')).toBe(true);
    expect(typeof result.model).toBe('string');
    expect(typeof result.usage.prompt_tokens).toBe('number');
    expect(typeof result.usage.total_tokens).toBe('number');
  });

  it('handles string input AND array input (matches wire schema union)', async () => {
    const provider = makeFakeEmbeddingProvider({ dims: 1024 });
    const stringResult = await provider.embed('hello', { model: 'embed-local' });
    const arrayResult = await provider.embed(['hello', 'world'], { model: 'embed-local' });
    expect(stringResult.embeddings).toHaveLength(1);
    expect(arrayResult.embeddings).toHaveLength(2);
  });

  // OPTIONAL: a "real factory with fake adapter" test if planner wants the
  // production factory exercised. The Phase 17 equivalent
  // (postgres-session-store.test.ts) does this for the Postgres impl.
});
```

**Key structural elements to mirror (from `session-store.interface.test.ts`):**
1. **One describe block per interface** — `'EmbeddingProvider interface — EMBP-01'` mirrors `'SessionStore interface — SESS-01'`.
2. **`expectTypeOf<T>().toEqualTypeOf<...>()`** for signature shape — Phase 17 used `Parameters<...>[1]` + `ReturnType<...>` for positional arg checks; Phase 19 can use a full-function `toEqualTypeOf` because the signature is small.
3. **Runtime `expect()` assertions** for the shape on a real fake — mirror `session-store.interface.test.ts:75–82` `Turn` shape assertions.
4. **Companion type imports next to the main type import** — single import block from `'../../src/providers/<X>.js'`.

**Where the `makeFakeEmbeddingProvider` fake lives:** `router/tests/fakes.ts` (CONTEXT D-12). The fake should mirror the Phase 17 `makeFakeSessionStore` builder shape (line 71 of `fakes.ts`):
```typescript
export interface FakeEmbeddingProviderOpts {
  dims?: number;             // default 1024 (matches bge-m3 / embed-local)
  shouldThrow?: boolean;     // optional — for error-path testing
}
export function makeFakeEmbeddingProvider(
  opts: FakeEmbeddingProviderOpts = {},
): EmbeddingProvider { /* returns deterministic Array(dims).fill(0.42) */ }
```

**Confidence:** HIGH — pattern verified against the actual existing file; mirror is mechanical.

### 4. D-03 Route Defense-in-Depth Dims Check Verification

**Question:** Is the route's post-adapter dims check (`router/src/routes/v1/embeddings.ts:406–429`) truly redundant once the provider owns dims enforcement?

**Answer:** **Yes — fully redundant under D-03 option (a).** `[VERIFIED: read embeddings.ts:406–429 in full above]`

**Evidence (route lines 406–429):**
```typescript
if (entry.dims !== undefined) {
  for (let i = 0; i < slots.length; i++) {
    const v = slots[i];
    if (Array.isArray(v) && v.length !== entry.dims) {
      // ... structured log ...
      throw new EmbeddingsDimsMismatchError(entry.name, entry.dims, v.length);
    }
  }
  opts.metrics?.embeddingsDimsTotal.inc(
    { model: entry.name, dims: String(entry.dims) },
    inputs.length,
  );
}
```

Under D-03, the provider's `embed()` performs **the same check inline as it places each upstream vector into the result array** (CONTEXT §"Specific Ideas" line 349-353). The provider throws `EmbeddingsDimsMismatchError` BEFORE the route ever sees the `slots[]`. Therefore:
- **The route's post-loop check is unreachable code** — a mismatched vector would have thrown inside `provider.embed(...)` before the route's `for (let i = 0; i < slots.length; i++)` runs.
- **The `embeddingsDimsTotal.inc(...)` increment must move into the provider** (D-06 already mandates this — the metric is owned by the provider after refactor).

**Existing wire-level test that must keep passing:** `router/tests/routes/embeddings.test.ts:691–740` ("rejects vector with wrong dims → 500 + structured envelope"). The test injects a bespoke adapter (`wrongDimAdapter`) returning `Array(768).fill(0.01)` for a model declared as `dims: 1024`, then asserts:
- `r.statusCode === 500`
- `pushed[0].status_class === 'server_error'`
- `pushed[0].error_message` contains "1024" + "768"

**Post-refactor invocation path** (the test must STILL pass with the route delegating to the provider):
1. Test injects `wrongDimAdapter` via `makeP12App({ adapter: wrongDimAdapter })`.
2. Route calls `req.server.embeddingProvider.embed(['hola'], { model: EMBED_MODEL })`.
3. Provider resolves entry, calls `adapter.embeddings(...)` → returns 768-dim vectors.
4. Provider's INTERNAL dims check throws `EmbeddingsDimsMismatchError(name, 1024, 768)`.
5. Throw bubbles to route's `catch (err)` block → caughtErr is set → mapToHttpStatus → 500.
6. recordOutcome stamps `error_message` with the throw's message containing both dims.

**Planner action:** Drop the route's post-loop dims block entirely (D-03 option (a)). The test at `embeddings.test.ts:691` continues to pass because the error still surfaces at the wire — just thrown one stack-frame deeper.

**Risk if missed:** Defense-in-depth check at the route level becomes dead code; not a correctness issue, but the planner should NOT leave both checks (D-03 explicitly picked option (a) over option (b)).

**Confidence:** HIGH — code paths read end-to-end; existing test verified.

### 5. D-24 SHA-256 Baseline Rotation Procedure

**Question:** Exact procedure for atomically updating the P7-01 SHA-256 baseline alongside the route refactor.

**Files involved:** `[VERIFIED: file existence + content checked]`
- **Baseline JSON:** `router/tests/unit/grep-gates/embeddings-untouched-baseline.json`
  - Current value: `"sha256": "b53c6ba1298b8b78b65f75d951e778bd031994fdcd65d14e659f8f3dd666e970"`
  - Other fields: `file`, `captured_at`, `phase`, `plan`, `rationale`
- **Gate test:** `router/tests/unit/grep-gates/embeddings-untouched.test.ts` (lines 47–65)
- **Subject file:** `router/src/routes/v1/embeddings.ts` (currently 552 lines, SHA-256 verified equal to baseline)

**SHA-256 computation command:**
```bash
shasum -a 256 router/src/routes/v1/embeddings.ts | awk '{print $1}'
```

**Atomic update procedure (planner MUST encode this in the route-refactor plan):**

1. **Apply the route refactor** (delete dims block, replace adapter call with `provider.embed(...)`, wrap return with OpenAI list shape, etc.).
2. **Compute new SHA:** `NEW_SHA=$(shasum -a 256 router/src/routes/v1/embeddings.ts | awk '{print $1}')`.
3. **Update baseline JSON** atomically:
   ```json
   {
     "file": "router/src/routes/v1/embeddings.ts",
     "sha256": "<NEW_SHA>",
     "captured_at": "2026-06-XX",
     "phase": "19",
     "plan": "19-XX",
     "rationale": "P7-01 BLOCK — baseline rotated as part of EMBP-02 route refactor (delegates to fastify.embeddingProvider per CONTEXT D-09). Wire shape verified byte-identical by full vitest regression on router/tests/routes/embeddings.test.ts + smoke Phase 7 EMBED-01 + Phase 12 EMB-H01..06 gates."
   }
   ```
4. **Commit BOTH files in ONE commit.** Plan SUMMARY.md must explicitly cite the deviation in the "Deviations" section as the test's error message (line 60–61) instructs.

**Ordering rule (D-24 + the test's own contract):** The route diff and the baseline diff MUST land in the SAME commit. Splitting them across commits would leave one commit RED (P7-01 violation) until the second commit lands — that's a broken bisect.

**Cross-phase references to the OLD baseline:** None. `grep -rn 'b53c6ba1298b8b78' /home/luis/proyectos/local-llms/` returns only the baseline JSON itself. No other test or doc hardcodes the SHA.

**Cross-phase tests that must still PASS after the refactor:**
- `router/tests/routes/embeddings.test.ts` — all 30+ existing cases (happy path, capability gate, input validation, schema passthrough, cache hit/miss, fail-open, dims enforcement, etc.) — these are the wire-shape regression net.
- `router/tests/embeddings/cache.test.ts` — the cache key + CachedVector shape (unchanged; cache module is re-used by the provider).
- Phase 7 EMBED-01 smoke gate (`bin/smoke-test-router.sh:1362`) — live `/v1/embeddings` curl returning 1024-dim vectors from `bge-m3-ollama`.
- Phase 12 EMB-H01..06 smoke gates (`bin/smoke-test-router.sh:1846`) — live cache + dims + metrics.
- P7-01 BLOCK test ITSELF — with the new baseline.

**Confidence:** HIGH — baseline file inspected; gate test inspected; no cross-references found.

### 6. D-15 CI Integration Verification

**Question:** Is the new `router/tests/integration/cardinality-live.integration.test.ts` picked up by the existing vitest config without any new glob/CI workflow edit?

**Answer:** **YES — zero config change needed.** `[VERIFIED: router/vitest.config.ts]`

**Evidence (`router/vitest.config.ts` full content):**
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.ts',                       // ← matches cardinality-live.integration.test.ts
      'src/**/__tests__/**/*.test.ts',
      'scripts/__tests__/**/*.test.ts',
    ],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 5_000,
    hookTimeout: 5_000,
  },
});
```

The glob `tests/**/*.test.ts` already matches `tests/integration/cardinality-live.integration.test.ts`. The naming convention (`.integration.test.ts` suffix) is purely documentary — it matches the same glob as any other `.test.ts`. Confirmed by inspection of existing files following the convention:
- `tests/integration/auth.test.ts`
- `tests/integration/mcp-host.integration.test.ts`
- `tests/integration/hook-position.integration.test.ts` (Phase 18 — same Phase pattern)
- `tests/integration/migrations/0006-sessions.test.ts` (Phase 17)

The 5000ms `testTimeout` is more than sufficient for an `app.inject({ method: 'GET', url: '/metrics' })` round-trip (typical < 50ms in-band).

**Recommended file naming convention for Phase 19:**
- `router/tests/integration/cardinality-live.integration.test.ts` — matches the Phase 18 `<feature>.integration.test.ts` pattern (e.g., `hook-metrics.integration.test.ts`).

**Confidence:** HIGH — config inspected; pattern observed across 30+ existing files.

### 7. D-09 Composition-Root Threading

**Question:** Exact insertion point in `router/src/index.ts` + `router/src/app.ts` for the new `embeddingProvider` wiring.

**Answer:** `[VERIFIED: read index.ts:1–451 + app.ts:1–305 in full above]`

**Insertion site in `router/src/index.ts`:**

The construction lives **between line 220 (Phase 18 `bootLog.info(...)`) and line 222 (`const app = await buildApp({`).** This is the same logical position the Phase 18 `mcpClientRegistry` + `preCompletionHooks` were inserted (lines 186–220) — directly above `buildApp(...)`.

Required prerequisites (all already present at the insertion point, no re-ordering needed):
- `registry` (line 159 — `makeRegistryStore(initialRegistry)`)
- `valkey` (line 82 — `makeValkeyClient(...)`)
- `metrics` (line 99 — `makeMetricsRegistry()`)
- `env` (line 56 — `loadEnv()`)
- `bootLog` (line 68 — `pino(loggerOpts)`)
- `makeAdapterWithCloudKey` — constructed inside `buildApp` per existing code (line 245 hint: `cloudApiKey: env.OLLAMA_API_KEY ?? ''`). This is the ONE wrinkle: the AdapterFactory is currently bound INSIDE `buildApp`. **Resolution:** either expose a helper that pre-binds `cloudApiKey` at the composition root, OR construct the embedding provider INSIDE `buildApp` similar to how `embeddingsCache` is constructed (app.ts:1031). CONTEXT D-09 says "Not built inside buildApp" — so the helper-expose route is the right one. Mirror Phase 18 Plan 18-07's `makeAdapterWithCloudKey` exposure (the registry already imports it for the `mcpClientRegistry` construction? — verify in plan).

  **Pragmatic recommendation:** Export a `makeAdapterFactory(cloudApiKey)` helper from `router/src/backends/factory.ts` so the composition root can pre-bind it. (Plan 08-02 / CLOUD-01 already factors `makeAdapterWithCloudKey` — confirm in the plan stage by reading `router/src/backends/factory.ts`.)

**Concrete construction (per CONTEXT §"Integration Points" lines 260–269):**
```typescript
// Phase 19 (v0.11.0 — EMBP-01): production-wired EmbeddingProvider.
const embeddingProvider = makeOpenAIEmbeddingProvider({
  registry,
  makeAdapter: makeAdapterWithCloudKey,  // see resolution note above
  valkey,
  env: { ROUTER_EMBED_CACHE_TTL_SEC: env.ROUTER_EMBED_CACHE_TTL_SEC },
  metrics: {
    embeddingsCacheTotal: metrics.embeddingsCacheTotal,
    embeddingsDimsTotal: metrics.embeddingsDimsTotal,
  },
  log: bootLog,
});

bootLog.info(
  { defaultModel: 'embed-local' },
  'Phase 19 EmbeddingProvider initialized',
);
```

**Insertion site in `router/src/app.ts`:**

1. **BuildAppOpts widening** — `app.ts:80` interface block. Add the field **AFTER `preCompletionHooks?`** (Phase 18's last addition):
   ```typescript
   /**
    * Phase 19 (v0.11.0 — EMBP-01): optional EmbeddingProvider. When provided,
    * buildApp calls app.decorate('embeddingProvider', opts.embeddingProvider) so
    * future RetrieverProvider implementations can read fastify.embeddingProvider
    * without HTTP round-tripping. When undefined (test fixtures), the
    * /v1/embeddings route falls back to opts.embeddingProvider injected
    * directly via RegisterEmbeddingsOpts. Production wiring (index.ts) always
    * passes a real provider.
    */
   embeddingProvider?: EmbeddingProvider;
   ```

2. **Decorator wiring** — inside `buildApp(...)`, immediately after the existing Phase 18 decorators block:
   ```typescript
   if (opts.embeddingProvider) {
     app.decorate('embeddingProvider', opts.embeddingProvider);
   }
   ```

3. **Route opts threading** — `app.ts:1048–1066` `registerEmbeddingsRoute(app, { ... })` call site. Add:
   ```typescript
   embeddingProvider: opts.embeddingProvider,  // when undefined, route falls back to its own
                                                // resolution path (preserves test fixtures)
   ```

   Note: The cache construction in `app.ts:1033–1040` (`makeEmbeddingsCache(...)`) **moves into the provider factory** — D-06 explicitly puts cache ownership in the provider. The `embeddingsCache` local variable disappears from `buildApp`. The `cache:` field in `RegisterEmbeddingsOpts` either drops, or remains as a test-only seam (planner picks based on test fixture usage; conservative: drop it because the provider now owns cache).

**Type augmentation file (D-11):** Create `router/src/types/fastify.d.ts`:
```typescript
import type { EmbeddingProvider } from '../providers/embedding-provider.js';

declare module 'fastify' {
  interface FastifyInstance {
    embeddingProvider: EmbeddingProvider;
  }
}
```

Confirmed: no `router/src/types/` directory exists today. Planner creates it. The file must be included in the tsconfig (verify in plan — `tsconfig.json` typically includes `src/**/*.d.ts` already; the Phase 17 `req.sessionId` augmentation went into a similar location).

**Confidence:** HIGH — read full index.ts, app.ts:1–305, app.ts:1020–1090.

### 8. D-22 OBSV-04 Re-verification Test Location

**Question:** Decide: new file vs extension of existing `router/tests/integration/migrations/0007-hook-log.test.ts`.

**Answer:** **EXTEND the existing file.** `[VERIFIED: read 0007-hook-log.test.ts in full above]`

**Evidence:** `tests/integration/migrations/0007-hook-log.test.ts` already exists (Phase 18 Plan 18-02 shipped it). It currently contains 7 PG-gated cases under a single describe block (`'Migration 0007: request_log.hook_log JSONB column'`). All 7 cases assert exactly the invariants CONTEXT D-22 requires: column exists, type is `jsonb`, nullable, COMMENT present, JSON round-trips, NULL round-trips, Drizzle schema declares it.

**Recommended pattern — sibling describe block in the same file:**
```typescript
// (existing describe at the top of the file — unchanged)
describeMaybe('Migration 0007: request_log.hook_log JSONB column', () => { /* 7 cases */ });

// NEW Phase 19 re-verification describe block — appended at the bottom
describeMaybe('Migration 0007: re-verified by Phase 19 (OBSV-04)', () => {
  let pool: Pool;
  beforeAll(async () => { pool = new Pool({ connectionString: PG_URL! }); });
  afterAll(async () => { await pool.end(); });

  it('Phase 19 OBSV-04: hook_log column still present + still JSONB + still nullable + COMMENT still cites RETR-04', async () => {
    // Same query as the Plan 18-02 case at line 46-55, but framed as an
    // OBSV-04 re-verification. One consolidated assertion is sufficient —
    // the Plan 18-02 cases above already prove granularity.
    const r = await pool.query(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'request_log'
          AND column_name = 'hook_log'`,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].data_type).toBe('jsonb');
    expect(r.rows[0].is_nullable).toBe('YES');
  });
});
```

**Why extend rather than create a new file:**
- Both files would target the same PG_TESTS=1 fixture + same pg.Pool — duplicated `beforeAll/afterAll` boilerplate.
- The migration is the SAME migration; splitting test ownership across files muddles which file owns the assertion of "is this column shape correct."
- The Phase 17 + Phase 18 convention is one test file per migration index (0006-sessions.test.ts, 0007-hook-log.test.ts) — sticking to that keeps the audit trail clean.

**REQUIREMENTS.md update (Plan to flip status):** Currently OBSV-04 = "Pending". After Phase 19 closes, line 228 of REQUIREMENTS.md flips to `Complete` per CONTEXT D-22 + the existing pattern at line 217 (`RETR-01 | Phase 18 | Complete`). The wording in CONTEXT D-22 ("status flips to `Complete (Phase 18 Plan 18-02 — re-verified Phase 19)`") implies the row should carry the dual-phase attribution — planner picks the exact text. Recommended: `OBSV-04 | Phase 19 | Complete (re-verifies Phase 18 Plan 18-02 migration 0007)`.

**Confidence:** HIGH — file exists, pattern observed, no ambiguity.

## Validation Architecture

> Per `nyquist_validation_enabled: true` — required.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest `^3.x` (already in repo; pinned by `router/package.json`) |
| Config file | `router/vitest.config.ts` |
| Quick run command | `cd router && npx vitest run --reporter=default tests/providers/embedding-provider.test.ts tests/integration/cardinality-live.integration.test.ts tests/unit/grep-gates/embeddings-untouched.test.ts` |
| Full suite command | `cd router && npm test` (runs vitest with the full glob) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| **EMBP-01** | Interface `EmbeddingProvider` exposed via `fastify.decorate('embeddingProvider', ...)` with the locked `embed(input, opts) → { embeddings, model, usage }` signature | vitest unit (`expectTypeOf` + runtime shape) | `npx vitest run tests/providers/embedding-provider.test.ts` | ❌ Wave 0 — new file `router/tests/providers/embedding-provider.test.ts` |
| **EMBP-02** | `/v1/embeddings` route delegates to provider; wire shape, dims enforcement, cache, X-Cost-Cents BYTE-IDENTICAL to Phase 12 baseline | (a) vitest regression: existing `embeddings.test.ts` 30+ cases still pass<br>(b) P7-01 SHA-256 gate with new baseline<br>(c) smoke: Phase 7 EMBED-01 (`bin/smoke-test-router.sh:1362`) + Phase 12 EMB-H01..06 (`:1846`) | `npx vitest run tests/routes/embeddings.test.ts tests/unit/grep-gates/embeddings-untouched.test.ts && bash bin/smoke-test-router.sh` | ✅ exists — both vitest files + smoke gates |
| **OBSV-01** | Smoke covers MCP host + `/v1/responses` stream WITH + WITHOUT tools + SessionStore round-trip | smoke gates: existing MCP-01..03 (Phase 15, lines 2059–2191) + existing SESSION SC-1..SC-4 (Phase 17, lines 2290–2431) + NEW RESS-WITH-TOOLS (Phase 19) | `bash bin/smoke-test-router.sh` (RESS-WITH-TOOLS soft-skips if `OLLAMA_API_KEY` absent) | ✅ MCP + Session gates exist; ❌ Wave 0 — RESS-WITH-TOOLS new gate |
| **OBSV-02** | Live `/metrics` cardinality CI gate; FAILS on any `_id` label | (a) vitest integration: new `cardinality-live.integration.test.ts` calls `buildApp(...).inject({GET,/metrics})` + `checkCardinalityLive(text)` + asserts `violations.length === 0`<br>(b) smoke: new `OBSV-02-LIVE` gate | `npx vitest run tests/integration/cardinality-live.integration.test.ts && curl -sS "${ROUTER_URL}/metrics" \| node router/scripts/check-prometheus-cardinality.ts --live -` | ❌ Wave 0 — new vitest file + new smoke gate |
| **OBSV-03** | README + DEPLOY document MCP host/client + sessions + hooks + policy + scoped IDs + EmbeddingProvider | manual review + grep gates for required headings; `bash -n bin/smoke-test-router.sh` keeps syntax-clean smoke; existing doc sections from Phase 14/15/17/18 already present | `grep -E '^## EmbeddingProvider' DEPLOY.md README.md && grep -E '## Estado.*v0\.11\.0.*✅' README.md` | ❌ Wave 0 — new doc sections + banner flip |
| **OBSV-04** | Migration 0007 `hook_log` JSONB column verified in live Postgres (re-verification of Plan 18-02 deliverable; NO new migration) | vitest PG-gated integration: NEW describe block in existing `0007-hook-log.test.ts` | `PG_TESTS=1 POSTGRES_URL=... npx vitest run tests/integration/migrations/0007-hook-log.test.ts` | ✅ file exists — extend with re-verify describe block |

### Sampling Rate
- **Per task commit:** `cd router && npx vitest run tests/providers/embedding-provider.test.ts tests/integration/cardinality-live.integration.test.ts tests/unit/grep-gates/embeddings-untouched.test.ts tests/routes/embeddings.test.ts` (sub-second turnaround for the 4 files)
- **Per wave merge:** `cd router && npm test` (full vitest sweep — expect ~1220+ passes including the Phase 19 additions)
- **Phase gate (before `/gsd:verify-work`):** `npm test` GREEN + `bash bin/smoke-test-router.sh` exit 0 (with `OLLAMA_API_KEY` set so RESS-WITH-TOOLS exercises the real cloud path)

### Cross-Phase Regression Dependencies (MUST still PASS after Phase 19)

| Prior-phase gate | What it verifies | Phase 19 risk |
|------------------|------------------|---------------|
| `tests/routes/embeddings.test.ts` (30+ cases — Phase 7 + Phase 12) | Wire shape + cache + dims + capability gate | Route refactor must preserve all wire-level behavior — provider is just a thinner layer. |
| `tests/unit/grep-gates/embeddings-untouched.test.ts` (P7-01) | SHA-256 of route file | MUST update baseline atomically with route diff (§5). |
| `bin/smoke-test-router.sh` Phase 7 EMBED-01 gate (line 1362) | Live 1024-dim vector return | Same wire shape — provider returns through route unchanged. |
| `bin/smoke-test-router.sh` Phase 12 EMB-H01..06 gates (lines 1846+) | Cache hit/miss/bypass + dims metric | Cache ownership moved to provider; metric names + label sets UNCHANGED. |
| `tests/db/migration-journal.test.ts` (P9-01 BLOCK) | Migration journal atomic-tuple | Phase 19 ships NO new migration (D-22). Gate is vacuously satisfied. |
| `tests/integration/migrations/0007-hook-log.test.ts` (existing 7 cases) | Plan 18-02 migration 0007 invariants | Phase 19 EXTENDS this file (§8). Existing cases stay green. |
| `tests/unit/grep-gates/no-default-retriever.test.ts` (Frame-01) | No `class \w+RetrieverProvider` in `router/src/` | EmbeddingProvider is NOT a RetrieverProvider — gate unaffected. |
| `scripts/__tests__/check-prometheus-cardinality.test.ts` (5 cases) | Static-source cardinality scan | Phase 19 ADDS a new `checkCardinalityLive` export — existing `checkCardinality` (static) stays exported unchanged. Existing tests stay green. |
| Phase 17 SESSION SC-1..SC-4 smoke gates | Session round-trip | Phase 19 does not touch session code. Vacuous. |
| Phase 18 P5-01..P5-05 + P2-01..P2-05 BLOCKs | Hook config + MCP client invariants | Phase 19 does not touch hook or MCP code. Vacuous. |

### Wave 0 Gaps

- [ ] `router/src/providers/embedding-provider.ts` — interface + factory (NEW source file, Wave 1 or 2)
- [ ] `router/src/types/fastify.d.ts` — FastifyInstance augmentation for `embeddingProvider` (NEW; create `router/src/types/` directory)
- [ ] `router/tests/providers/embedding-provider.test.ts` — conformance test (Wave 0 placeholder; Wave 1 flips to real)
- [ ] `router/tests/integration/cardinality-live.integration.test.ts` — live `/metrics` parse + assert (Wave 0 placeholder; Wave 1+)
- [ ] `router/tests/fakes.ts` — add `makeFakeEmbeddingProvider(opts)` builder (Wave 0; mirror Phase 17 patterns)
- [ ] Extension to `router/scripts/__tests__/check-prometheus-cardinality.test.ts` — new describe block for `checkCardinalityLive` with hand-rolled exposition fixtures (Wave 0 placeholder)
- [ ] Extension to `router/tests/integration/migrations/0007-hook-log.test.ts` — Phase 19 OBSV-04 re-verify describe block
- [ ] `bin/smoke-test-router.sh` — RESS-WITH-TOOLS gate + OBSV-02-LIVE gate + 4 cite lines between line 2538 (Phase 18 section end) and 2544 (summary banner)
- [ ] `DEPLOY.md` + `README.md` — EmbeddingProvider sections + v0.11.0 SHIPPED banner flip

*Framework install: none needed — vitest already in repo.*

## Security Domain

> `security_enforcement` default = enabled (no override found in `.planning/config.json`).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Phase 19 does not touch the bearer auth surface — provider sits INSIDE the `/v1/embeddings` handler which is already gated by `makeBearerHook` (`router/src/auth/bearer.ts`). |
| V3 Session Management | no | Phase 17 closed sessions; Phase 19 is orthogonal. |
| V4 Access Control | partial | `applyPreflight` (Phase 15) gates policy + breaker UPSTREAM of the provider call — provider is reachable only after policy passes. CONTEXT D-04 reaffirms route runs `applyPreflight` BEFORE `provider.embed(...)`. |
| V5 Input Validation | yes | `EmbeddingsRequestSchema` (zod, lines 85–95 of `embeddings.ts`) stays at the route boundary — provider gets validated inputs. |
| V6 Cryptography | no | No cryptographic primitives in scope (the SHA-256 in P7-01 baseline is integrity-checking, not security-cryptography). |
| V8 Data Protection | partial | `request_log.cost_cents` + `request_log.error_message` write paths unchanged — no new PII surfaces. |
| V9 Communication | no | No new outbound calls (cloud key already threaded by Phase 8). |
| V10 Malicious Code | no | Zero new npm packages — supply chain unchanged. |

### Known Threat Patterns for Phase 19's Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| **Wrong-dim vector poisoning** (provider returns vectors that don't match `entry.dims` — could corrupt a downstream vector store) | Tampering | D-03 puts `EmbeddingsDimsMismatchError` throw INSIDE the provider (single source of truth). Future RetrieverProvider consumers cannot bypass this check because they cannot reach the upstream adapter without going through `provider.embed(...)`. |
| **High-cardinality Prometheus labels** | Denial-of-Service via metric blowup | OBSV-02 live-parse gate (D-13/D-14/D-15) — the CI test scrapes `/metrics` from a real `buildApp(...)` and rejects any `_id` label. Mitigates labels that only light up at runtime (e.g., a histogram label only emitted after first observe). |
| **Wire-shape regression breaks n8n consumers** | Tampering / Availability | P7-01 BLOCK SHA-256 baseline gate + Phase 7 EMBED-01 smoke gate + Phase 12 EMB-H01..06 smoke gates + `tests/routes/embeddings.test.ts` regression suite. Four-layer defense. |
| **Cloud function-call cost runaway in smoke** | Denial-of-Wallet (operator's wallet) | RESS-WITH-TOOLS uses `gpt-oss:20b-cloud` (5× cheaper than 120b sibling). Trigger prompt is minimal (~50 tokens). Per-smoke-run cost bounded at ~$0.001. Skip predicate prevents accidental invocation when `OLLAMA_API_KEY` is empty. |

## Risks & Surprises

### Risk 1 — `makeAdapterWithCloudKey` is currently defined INSIDE `buildApp`, not at the composition root.

**What we found:** CONTEXT D-09 says construct the provider AT the composition root (`router/src/index.ts`), passing `makeAdapter: makeAdapterWithCloudKey` as an opt. But `makeAdapterWithCloudKey` is created inside `buildApp` (referenced in `app.ts:1049` — `opts.makeAdapter ?? makeAdapterWithCloudKey`).

**Resolution:** Plan-time read `router/src/backends/factory.ts` to confirm what's exported. If `makeAdapter(entry, cloudApiKey?)` is exported, the composition root can pre-bind via a thin closure: `const makeAdapterWithCloudKey = (entry) => makeAdapter(entry, env.OLLAMA_API_KEY ?? '')`. Then both index.ts (for the provider) and buildApp (for the route opts.makeAdapter fallback) consume the SAME closure shape.

**Severity:** LOW — mechanical refactor; doesn't change behavior. Planner just needs to thread it.

### Risk 2 — The provider's cache-skip rules differ subtly from the current route's.

**What we found:** Current route logic (`embeddings.ts:275`): `const cacheable = opts.cache !== undefined && body.encoding_format !== 'base64'`. CONTEXT D-06 says the provider always operates in `float` mode (D-02), so when the route's client asked for `base64`, the route encodes base64 ON EGRESS from the provider's `number[][]`. **This shifts the bypass increment semantics:** under the new flow, the provider never sees `encoding_format = 'base64'`, so the cache is always "cacheable" from the provider's perspective. But the metric expects a `bypass` increment when the client asked for base64.

**Resolution:** Decide who increments `embeddingsCacheTotal{result='bypass'}` for the base64-path case:
- **Option A (recommended):** Route still increments `bypass` for `body.encoding_format === 'base64'` BEFORE calling `provider.embed(...)`. Provider handles only hit/miss for the items it actually looks up. Preserves EMB-H03 metric semantics byte-identical.
- **Option B:** Provider takes a `skipCache?: boolean` opt and increments `bypass` itself. Adds opt-surface complexity.

**Severity:** MEDIUM — getting this wrong silently changes the cache_total metric label distribution. Plans must explicitly choose A or B and add a vitest assertion confirming the bypass count post-refactor matches pre-refactor for a base64 request.

### Risk 3 — The route currently has TWO places that throw `EmbeddingsDimsMismatchError`.

**What we found:** `embeddings.ts:420` is the explicit throw. The metric `embeddingsDimsTotal.inc(...)` at line 425 fires INLINE with that loop — moving both into the provider means the route's `inputs.length` post-loop counter increment must also move. (CONTEXT D-06 says provider owns this metric — confirmed.)

**Resolution:** Provider's `embed(...)` must increment `embeddingsDimsTotal` for EACH vector it serves (whether from cache hit OR upstream). Currently the metric increments by `inputs.length` once at the end — equivalent total, but the planner should preserve "one increment per served vector" not "one increment of N per request" for clarity.

**Severity:** LOW — metric value is the same either way (counter; integer increments compose).

### Risk 4 — `gpt-oss:20b-cloud` may not be installed in the operator's environment.

**What we found:** Cloud models are catalog entries on Ollama's side — they don't need a `docker pull`, but the operator's `OLLAMA_API_KEY` must be associated with an account that has access to `gpt-oss:20b-cloud`. If the model is not in the account's catalog, the smoke gate would fail with a 404-shaped error rather than soft-skip.

**Resolution:** The skip predicate must check BOTH `OLLAMA_API_KEY` presence AND the model declaration in `models.yaml`. If both pass but the upstream returns a non-tool-call response (e.g., generic error), the gate should `fail` (not `skip`) — that's a real environment misconfiguration the operator should fix.

**Severity:** LOW — `models.yaml` declares the model; if the operator's account doesn't have access, that's an operator-config issue surfaced as a smoke failure (not a Phase 19 design flaw).

### Risk 5 — The conformance test pattern uses `expectTypeOf` which requires correct tsconfig setup.

**What we found:** Phase 17 + Phase 18 already use `expectTypeOf` extensively (see `session-store.interface.test.ts:46-82`). The tsconfig is already configured. Confirmed by the existing tests passing.

**Severity:** NONE — no action needed, just noted to confirm.

## Planner Guidance

### Plan Ordering Recommendation

The 7-plan structure in CONTEXT D-23 is sound; concrete ordering for safety:

1. **Plan 19-01: Wave 0 scaffold** — Create placeholder test files (`tests/providers/embedding-provider.test.ts` with `it.todo`; `tests/integration/cardinality-live.integration.test.ts` with `it.todo`); add `makeFakeEmbeddingProvider` builder to `tests/fakes.ts` (with `await import('../src/providers/embedding-provider.js')` runtime sentinel so vitest surfaces the missing module as Wave-0 RED). NO production-code changes. Zero `it.skip` / `xit` — strict Wave-0 convention preserved.
2. **Plan 19-02: EmbeddingProvider interface + factory + type augmentation** — Create `router/src/providers/embedding-provider.ts` with the interface, `makeOpenAIEmbeddingProvider` factory (with cache moved IN), and `router/src/types/fastify.d.ts` augmentation. Flip `tests/providers/embedding-provider.test.ts` `it.todo` → `it()` with real `expectTypeOf` assertions + fake-provider shape checks. Verify P7-01 SHA-256 baseline still matches (route untouched yet).
3. **Plan 19-03: Route refactor + atomic baseline update** — Edit `router/src/routes/v1/embeddings.ts` to delegate to `req.server.embeddingProvider.embed(...)`; drop dims post-loop block (D-03 option (a)); preserve OpenAI list re-wrap on egress; preserve `embeddingsBatchSize` observation (D-07); preserve cost computation (D-08); **UPDATE `embeddings-untouched-baseline.json` SHA-256 IN THE SAME COMMIT** (§5 procedure). Verify ALL `tests/routes/embeddings.test.ts` cases still pass (30+); P7-01 baseline test passes with NEW SHA.
4. **Plan 19-04: `checkCardinalityLive` parser + extended unit tests + CI integration test** — Extend `router/scripts/check-prometheus-cardinality.ts` with `checkCardinalityLive(exposition: string) → CardinalityViolation[]` + CLI `--live` flag dispatch. Extend `scripts/__tests__/check-prometheus-cardinality.test.ts` with live-mode fixtures (the edge cases enumerated in §2). Flip `tests/integration/cardinality-live.integration.test.ts` `it.todo` → `it()` exercising real `buildApp(...).inject({GET,/metrics})`. Existing static-mode tests stay green.
5. **Plan 19-05: Smoke gate extensions** — Insert Phase 19 section in `bin/smoke-test-router.sh` between line 2538 (Phase 18 section end) and line 2544 (summary banner). Add: cite lines for OBSV-01 MCP slice + Session slice + EMBP-02 regression; `OBSV-02-LIVE` gate; `RESS-WITH-TOOLS` gate with soft-skip predicate (§1). Update summary banner: `Phase 2/3/4/5/7/8/12/13/15/16/17/18/19 router verification: COMPLETE.`. `bash -n bin/smoke-test-router.sh` must exit 0.
6. **Plan 19-06: OBSV-04 re-verification + docs** — Extend `tests/integration/migrations/0007-hook-log.test.ts` with the Phase 19 re-verify describe block (§8). Add `DEPLOY.md` §"EmbeddingProvider (Phase 19 — v0.11.0)" + `README.md` §"EmbeddingProvider (v0.11.0)" + flip Estado del proyecto v0.11.0 row to ✅ (D-21).
7. **Plan 19-07: v0.11.0 milestone wrap-up** — Flip REQUIREMENTS.md EMBP-01/02 + OBSV-01..04 to `Complete`; ROADMAP Phase 19 row → SHIPPED with completion date; STATE.md milestone metadata → `status: completed` + `completed_phases: 6` + `progress.percent: 100`; tag-or-attribute the v0.11.0 milestone closure; deferred-items.md or equivalent captured.

### Must-Haves (planner cannot skip these)

- **P7-01 atomic-commit rule** — Plan 19-03's route diff + baseline diff MUST land in ONE commit. Document explicitly in the plan's "Verification" section as a manual reviewer check.
- **EMB-H04 fail-open semantics preserved in provider** — cache read/write errors must warn-log + fall through without incrementing the cache_total counter. The metric semantic ("faithful representation of real cache outcomes") is invariant.
- **Base64 cache-bypass increment lives at the route** — Risk #2 resolution (Option A): preserve `embeddingsCacheTotal.inc({result:'bypass'})` for base64 requests at the route layer, BEFORE calling `provider.embed(...)`.
- **`embeddingsBatchSize` stays in route** (D-07) — observe `inputs.length` BEFORE handing to provider.
- **Cost stamping stays in route** (D-08) — `computeCostCents(usage, entry)` runs in route after provider returns; `req.computedCostCents` stamped before `reply.send` (Pitfall from `project_fastify_onsend_timing.md` user memory).
- **`makeFakeEmbeddingProvider` lives in `tests/fakes.ts`** (CONTEXT D-12) — not a sibling file. Phase 17 + Phase 18 all use this convention.
- **No new npm packages** — confirm via `git diff router/package.json router/package-lock.json` returning empty in every plan's verification step.

### Wave Assignment Recommendation

Based on the 7-plan structure:
- **Wave 0 (Plan 19-01)** — placeholder tests + fakes; no source code touched.
- **Wave 1 (Plans 19-02, 19-04)** — parallel: provider interface/factory AND cardinality-live parser. Both are additive to `router/src/`; no cross-dependency between them.
- **Wave 2 (Plan 19-03)** — route refactor (depends on Wave 1's provider being landed).
- **Wave 3 (Plans 19-05, 19-06)** — parallel: smoke gates AND docs+OBSV-04 re-verify.
- **Wave 4 (Plan 19-07)** — milestone close-out (depends on all prior waves).

### Soft-Validation Checks the Planner Should Add to Every Plan

- `git diff router/package.json` → empty
- `git diff router/package-lock.json` → empty
- `grep -rE 'class \w+EmbeddingProvider' router/src/` → empty (Frame-01 hygiene; the factory returns an object literal, not a class)
- `grep -rE 'class \w+RetrieverProvider' router/src/` → still empty (Phase 18 Frame-01 BLOCK persists)
- `shasum -a 256 router/src/routes/v1/embeddings.ts` → matches `embeddings-untouched-baseline.json` SHA value (post-Plan-19-03 with NEW SHA; before that, the existing SHA stays unchanged)
- `npx tsc --noEmit` exit 0 (router subtree)

## Open Questions

1. **`makeAdapterWithCloudKey` exposure at composition root** — Risk #1 above. Planner action: read `router/src/backends/factory.ts` during plan-time to determine the cleanest path (export a helper, or duplicate the small closure in index.ts). Both viable; not a blocking question.

2. **Should the Phase 19 conformance test exercise the real `makeOpenAIEmbeddingProvider` factory with a fake adapter, or just the fake provider?** CONTEXT D-20 says "Builds the real OpenAIEmbeddingProvider with a fake adapter." The Phase 17 equivalent (`postgres-session-store.test.ts`) exercises the real impl; mirror that. Planner verifies at plan-time.

3. **`prom-client` library version in repo** — should be 14+ for histogram label support; verify in plan-time `cat router/package.json`. This is informational — D-14 doesn't require any prom-client changes.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js 22 LTS | All TypeScript build + vitest run | ✓ (assumed; existing dev env) | 22.x | — |
| Docker + Compose | Live `/metrics` smoke gate | ✓ (existing project requirement) | — | — |
| Postgres (via Docker Compose) | OBSV-04 PG-gated test | ✓ (existing service) | 17 | tests soft-skip when PG_TESTS=1 absent |
| Valkey (via Docker Compose) | Cardinality live test app construction (`buildApp(opts.valkey)`) | ✓ (existing service) | 8 | tests can construct app without valkey (test fixture pattern already used in Phase 18) |
| `OLLAMA_API_KEY` env var | RESS-WITH-TOOLS smoke gate ONLY | varies | — | soft-skip per §1 |
| `gpt-oss:20b-cloud` model availability | RESS-WITH-TOOLS smoke gate ONLY | depends on operator's Ollama Cloud account | — | soft-skip via `models.yaml` grep predicate |

**Missing dependencies with no fallback:** none — every gate has either a fallback or a soft-skip path.

**Missing dependencies with fallback:** `OLLAMA_API_KEY` (skip), `gpt-oss:20b-cloud` (skip), `PG_TESTS=1` (skip).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `makeAdapter(entry, cloudApiKey?)` can be re-bound at the composition root via a thin closure | §7 + Risk #1 | Mechanical refactor; if `factory.ts` shape differs from expected, plan-time read reveals it. |
| A2 | `gpt-oss:20b-cloud` consistently emits Responses-API tool-call deltas when given a simple function tool | §1 | If the model emits text instead of a tool call for the trigger prompt, the smoke gate fails — operator sees a clear failure rather than silent skip. The Phase 16 FSM is already proven to handle tool-call deltas correctly; the only unknown is whether Ollama Cloud's `gpt-oss` emits them in the same shape as the canonical CompletionStream. Verified via Phase 16's `capabilities: [chat, tools, json_mode]` declaration and analogous behavior in `gpt-oss:120b-cloud`. |
| A3 | The OBSV-02 live `/metrics` scrape in vitest can use a minimal `buildApp(...)` fixture (no Valkey, no Postgres, just fakes) | §6 + Wave 0 Gaps | If `/metrics` only renders cardinality-risky labels when a real backend has been invoked (e.g., a histogram label that only appears post-first-observe), the test would miss them. **Mitigation:** the smoke gate also runs `OBSV-02-LIVE` against the LIVE tunnel post-deploy, which catches runtime-only labels (CONTEXT D-15 explicitly cites this two-layer defense). |
| A4 | The existing tsconfig already picks up `router/src/types/*.d.ts` augmentation files | §7 | If not, the planner adds `"include": ["src/**/*"]` is broad enough, but the planner verifies at Plan 19-02 by running `npx tsc --noEmit` after creating the augmentation file. |

If this table is mostly assumptions: all 4 are low-risk; the Phase 19 design has been so thoroughly locked by CONTEXT.md that virtually every claim is either VERIFIED from the codebase or one of these low-impact ASSUMED mechanical refactors.

## Sources

### Primary (HIGH confidence — read in full)
- `router/src/providers/retriever-provider.ts` — Frame-01 model file for the new interface
- `router/src/providers/session-store.ts` — Second Frame-01 model file
- `router/src/routes/v1/embeddings.ts` (552 lines) — Route being refactored
- `router/scripts/check-prometheus-cardinality.ts` — Existing static parser
- `router/scripts/__tests__/check-prometheus-cardinality.test.ts` — Existing test patterns
- `router/tests/unit/grep-gates/embeddings-untouched.test.ts` — P7-01 gate
- `router/tests/unit/grep-gates/embeddings-untouched-baseline.json` — Current SHA-256 baseline
- `router/tests/providers/session-store.interface.test.ts` — Conformance test mirror
- `router/tests/integration/migrations/0007-hook-log.test.ts` — OBSV-04 re-verify target
- `router/tests/routes/embeddings.test.ts:691–740` — Existing dims-mismatch test
- `router/tests/fakes.ts:1–80` — Fake builder pattern
- `router/models.yaml` (354 lines) — Model declarations
- `router/vitest.config.ts` — Test glob config
- `router/src/index.ts:1–451` — Composition root
- `router/src/app.ts:80–305 + 1020–1090` — BuildAppOpts + route call site
- `bin/smoke-test-router.sh` — Pass/fail/skip helpers + insertion sites
- `.planning/REQUIREMENTS.md` — EMBP/OBSV requirement text
- `.planning/STATE.md` — Phase 18 SHIPPED + Phase 19 unblocked
- `.planning/research/PITFALLS.md` — P7-01 / P8-03 / P9-01 / P9-03 BLOCK definitions

### Secondary (HIGH confidence — cited spec)
- [Prometheus text-based exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format) — D-14 parser invariants

### Tertiary
- (none — no LOW-confidence claims in this research)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new packages; every dependency already in repo and exercised in prior phases.
- Architecture: HIGH — CONTEXT.md D-01..D-24 lock every design decision; this research validates the integration points.
- Pitfalls: HIGH — P7-01 / P8-03 / P9-01 / P9-03 read in full; P7-01 baseline SHA verified by computation; no surprises.
- RESS-WITH-TOOLS model selection: HIGH — `models.yaml` inspected; capability declarations verified.
- Test patterns: HIGH — SessionStore conformance test read; 0007-hook-log test read; both mirror-ready.

**Research date:** 2026-06-01
**Valid until:** 2026-07-01 (30 days — Phase 19 is infrastructure formalization; design pressures are slow-moving)

## RESEARCH COMPLETE
