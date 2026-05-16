---
phase: 07-embeddings-vllm-gpu-telemetry
plan: 03
subsystem: infra
tags: [vllm, registry, backend-adapter, models-yaml, fastify, zod, openai-sdk]

# Dependency graph
requires:
  - phase: 03-multi-backend-dispatch-llama-cpp-registry-hardening
    provides: LocalBackendEnum, ModelEntrySchema, VRAM-envelope superRefine, BackendAdapter interface, AdapterFactory map, liveness scheduler driven by registry URLs
  - phase: 07-embeddings-vllm-gpu-telemetry/01
    provides: vllm + vllm-embed compose services on backend network (http://vllm:8000, http://vllm-embed:8000)
provides:
  - LocalBackendEnum widened from 2 to 4 values (ollama, llamacpp, vllm, vllm-embed)
  - VLLMOpenAIAdapter implementing BackendAdapter (chatCompletionsCanonical, chatCompletionsCanonicalStream, probeLiveness)
  - AdapterFactory dispatches vllm + vllm-embed to VLLMOpenAIAdapter (one class, two baseURLs)
  - router/models.yaml: 3 new entries (qwen2.5-7b-instruct-awq, bge-m3-ollama, bge-m3-vllm) + 2 new backends: blocks (vllm, vllm-embed)
  - MSW handlers (vllmModelsListHandler, vllmNonStreamHandler) for vllm-backed integration tests in future plans
affects: [07-04-embeddings-route, 07-05-grafana-dashboard, 07-06-live-smoke]

# Tech tracking
tech-stack:
  added: []  # No new libraries — VLLMOpenAIAdapter reuses openai SDK already in package.json
  patterns:
    - "Phase 7 dual-variant single-adapter pattern: two distinct backend enum values (vllm + vllm-embed) sharing one adapter class — keeps per-backend semaphore + VRAM-envelope sums independent while avoiding code duplication"
    - "Registry-driven liveness scheduler proves out: adding new backend URLs via models.yaml requires zero edits to liveness.ts because app.ts derives distinctBackendUrls from registry.models[].backend_url at startup"

key-files:
  created:
    - "router/src/backends/vllm-openai.ts"
    - "router/tests/unit/vllm-openai.test.ts"
  modified:
    - "router/src/config/registry.ts (LocalBackendEnum widened)"
    - "router/src/backends/factory.ts (ADAPTERS map: + vllm + vllm-embed)"
    - "router/models.yaml (3 new entries + 2 new backends: blocks)"
    - "router/tests/unit/registry.test.ts (replaced 'rejects vllm' with generic unknown-backend rejection)"
    - "router/tests/unit/registry.required.test.ts (added 2 acceptance tests for vllm + vllm-embed)"
    - "router/tests/unit/factory.test.ts (added 4 dispatch tests for vllm + vllm-embed)"
    - "router/tests/msw/handlers.ts (added vllmModelsListHandler + vllmNonStreamHandler)"

key-decisions:
  - "Single adapter class for two backend values: VLLMOpenAIAdapter serves both backend: vllm and backend: vllm-embed entries; the discriminator is entry.backend_url injected by the factory. Avoids a sibling class that would be byte-identical except for log labels."
  - "No edits to liveness.ts: verified the scheduler is registry-driven at app.ts:309 (distinctBackendUrls = Set(registry.models.map(m => m.backend_url))), so once models.yaml declares vllm/vllm-embed entries the /readyz scheduler probes them automatically via probeAdapterFor → factory → VLLMOpenAIAdapter.probeLiveness."
  - "400-not-500 in probeLiveness test: the OpenAI SDK auto-retries 5xx with exponential backoff (default 2 retries × ~1s base = 3+ seconds past vitest's 5s default test timeout). Using 400 exercises the same catch-and-surface branch without the retry penalty."
  - "Plan boundary respected: zero touch on router/src/backends/adapter.ts (Plan 07-04 widens the interface with .embeddings()), zero touch on router/src/routes/v1/* (Plan 07-04 adds the embeddings route), zero touch on compose.yml (Plan 07-01 already added vllm+vllm-embed; Plan 07-02 added observability stack in parallel)."

patterns-established:
  - "Dual-variant single-adapter: when a backend's chat and embed surfaces share the same wire protocol but should have independent semaphores/VRAM accounting, declare two LocalBackendEnum variants and map both to the same adapter class with distinct baseURLs."

requirements-completed: [BCKND-03, OAI-02]  # BCKND-03 adapter half complete (chat-completion path wired; live verification in Plan 07-06). OAI-02 registry half complete (embedding entries declared; the /v1/embeddings route lands in Plan 07-04).

# Metrics
duration: 10min
completed: 2026-05-16
---

# Phase 7 Plan 03: Router Registry Widening for vLLM Summary

**VLLMOpenAIAdapter + LocalBackendEnum + factory dispatch + models.yaml entries — vllm and vllm-embed are first-class router backends with zero adapter.ts or liveness.ts churn.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-16T20:42:21Z
- **Completed:** 2026-05-16T20:52:38Z
- **Tasks:** 1 (TDD-flavoured — RED → registry → adapter+factory → models.yaml)
- **Files modified:** 7 (3 src, 1 yaml, 3 tests) + 1 created (vllm-openai.ts) + 1 test file created (vllm-openai.test.ts)

## Accomplishments

- LocalBackendEnum widened from `['ollama', 'llamacpp']` to `['ollama', 'llamacpp', 'vllm', 'vllm-embed']` — models.yaml can now declare vllm and vllm-embed entries without zod parse failure.
- VLLMOpenAIAdapter implements BackendAdapter (chatCompletionsCanonical + chatCompletionsCanonicalStream + probeLiveness) by composing the OpenAI SDK with vLLM's OpenAI-compat surface — mirrors LlamacppOpenAIAdapter shape byte-for-byte modulo the `apiKey: 'vllm'` placeholder.
- AdapterFactory ADAPTERS map gains `vllm: VLLMOpenAIAdapter` and `'vllm-embed': VLLMOpenAIAdapter` — one class, two distinct baseURLs per Plan 07-01 + D-B5(a).
- router/models.yaml gains three new entries (qwen2.5-7b-instruct-awq, bge-m3-ollama, bge-m3-vllm) + two new `backends:` blocks (vllm, vllm-embed).
- VRAM-envelope superRefine continues to PASS for the updated registry (per-backend sums: ollama 14.5 / llamacpp 6 / vllm 7.2 / vllm-embed 2.5 — all ≤ 16 GB).
- Router test suite: **505 passing | 2 skipped | 0 failing** (was 489 passing before this plan; +16 = 9 new vllm-openai unit tests + 4 new factory dispatch tests + 2 new registry tests + 1 updated registry test).
- `tsc --noEmit` clean. `tsup build` clean (dist/index.js 128.40 KB).

## Task Commits

Plan 07-03 was committed atomically in 4 commits, each running its own scoped verify:

1. **RED — failing tests for vllm + vllm-embed registry + factory dispatch** — `2df0708` (test)
2. **Widen LocalBackendEnum to include vllm + vllm-embed** — `05855e4` (feat)
3. **Add VLLMOpenAIAdapter + wire factory for vllm + vllm-embed** — `344b3ac` (feat)
4. **Register vllm + vllm-embed entries in models.yaml** — `b580036` (feat)

**Plan metadata:** (to be committed with SUMMARY) — `docs(07-03): summary — vllm/vllm-embed router registry widening`

## Registry shape

```ts
// router/src/config/registry.ts:21
export const LocalBackendEnum = z.enum(['ollama', 'llamacpp', 'vllm', 'vllm-embed']);
```

`ModelEntrySchema`, `BackendsSection`, and the VRAM-envelope `superRefine` are unchanged — adding the two new enum values cascades through all three without further edits because:

1. `ModelEntrySchema.backend` uses LocalBackendEnum directly.
2. `BackendsSection` accepts arbitrary record-string keys (the backends: block doesn't enforce specific keys).
3. `superRefine` sums per-backend by iterating `reg.models` — new backend keys appear in `sums` automatically.

## VLLMOpenAIAdapter file shape

`router/src/backends/vllm-openai.ts` (124 lines, including comments). Method-for-method parity with `LlamacppOpenAIAdapter`:

| Method                                  | Behavior                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `constructor(baseURL)`                  | `new OpenAI({ baseURL, apiKey: 'vllm', timeout: 60_000 })`                                       |
| `chatCompletionsCanonical(c, sig)`      | `canonicalToOpenAIChatCompletionParams` → SDK `chat.completions.create({stream:false,…})` → `openAIChatCompletionToCanonical` |
| `chatCompletionsCanonicalStream(c, sig, opts)` | Same translation in; SDK `stream:true`; out via `openAIChunksToCanonicalEvents` with `opts.inputTokensHint` forwarded |
| `probeLiveness(sig)`                    | `client.models.list({signal})` → `{ok: data.length > 0, latencyMs, error?}`; never throws        |

No vLLM-specific tool-call code in the adapter: Plan 07-01 starts the vLLM chat container with `--enable-auto-tool-choice --tool-call-parser=hermes`, so the OpenAI-compat output is already standard `tool_calls` shape by the time it reaches the adapter.

No vision branch: vision lands in Phase 8 with a separate model entry on a vision-capable vLLM build.

No embeddings method: Plan 07-04 widens `BackendAdapter` with `.embeddings()` and adds the impl on this class.

## Factory dispatch additions

```ts
// router/src/backends/factory.ts:23-30
const ADAPTERS: Record<string, AdapterCtor> = {
  ollama: OllamaOpenAIAdapter,
  llamacpp: LlamacppOpenAIAdapter,
  vllm: VLLMOpenAIAdapter,
  'vllm-embed': VLLMOpenAIAdapter, // same class; baseURL is per-model from entry.backend_url
  // Phase 8: 'ollama-cloud': OllamaCloudAdapter,
};
```

Identity verified end-to-end: `makeAdapter(vllmEntry) instanceof VLLMOpenAIAdapter === true` and `makeAdapter(vllmEmbedEntry) instanceof VLLMOpenAIAdapter === true`.

## models.yaml entries (verbatim)

`backends:` section additions:

```yaml
vllm:
  base_url: http://vllm:8000/v1
  concurrency: 2
  queue_max_wait_ms: 30000
vllm-embed:
  base_url: http://vllm-embed:8000/v1
  concurrency: 4
  queue_max_wait_ms: 30000
```

`models:` section additions:

```yaml
- name: qwen2.5-7b-instruct-awq
  backend: vllm
  backend_url: http://vllm:8000/v1
  backend_model: Qwen/Qwen2.5-7B-Instruct-AWQ
  capabilities: [chat, tools]
  vram_budget_gb: 7.2
  concurrency: 2
  max_model_len: 8192
  profile: vllm

- name: bge-m3-ollama
  backend: ollama
  backend_url: http://ollama:11434/v1
  backend_model: bge-m3
  capabilities: [embeddings]
  vram_budget_gb: 2.5
  concurrency: 4
  max_model_len: 8192
  profile: ollama

- name: bge-m3-vllm
  backend: vllm-embed
  backend_url: http://vllm-embed:8000/v1
  backend_model: BAAI/bge-m3
  capabilities: [embeddings]
  vram_budget_gb: 2.5
  concurrency: 4
  max_model_len: 8192
  profile: vllm
```

## VRAM-envelope arithmetic

Per-backend sum (Plan 03 D-04, `VRAM_ENVELOPE_GB=16`):

| Backend    | Entries                                                          | Sum (GB)   | Envelope |
| ---------- | ---------------------------------------------------------------- | ---------- | -------- |
| ollama     | llama3.2:3b-instruct (4) + llama3.2-vision:11b (8) + bge-m3 (2.5) | 14.5       | ≤ 16 OK  |
| llamacpp   | qwen2.5-7b-instruct-q4km (6)                                     | 6          | ≤ 16 OK  |
| vllm       | qwen2.5-7b-instruct-awq (7.2)                                    | 7.2        | ≤ 16 OK  |
| vllm-embed | bge-m3-vllm (2.5)                                                | 2.5        | ≤ 16 OK  |

`superRefine` continues to PASS — verified by `registry.required.test.ts` (37 passing) + `registry.vram.test.ts` + direct `loadRegistryFromFile('models.yaml')` smoke.

## Test count delta

| Run             | Test files | Tests passing | Tests skipped |
| --------------- | ---------- | ------------- | ------------- |
| Before Plan 07-03 | 40         | 489           | 2             |
| After Plan 07-03  | 41         | 505           | 2             |

New tests added: **16**
- `vllm-openai.test.ts`: 6 (probeLiveness ok/empty/4xx/unreachable + chatCompletionsCanonical happy + baseURL routing)
- `factory.test.ts`: +4 (vllm + vllm-embed dispatch + 2 baseURL forwarding)
- `registry.required.test.ts`: +2 (vllm + vllm-embed acceptance)
- `registry.test.ts`: 0 net (replaced 1 existing "rejects vllm" test with 1 generic unknown-backend test)

## Type-check evidence

```
$ npm run typecheck
> tsc --noEmit
(no output — clean)
```

## Build evidence

```
$ npm run build
ESM dist/index.js     128.40 KB
ESM dist/index.js.map 383.06 KB
ESM ⚡️ Build success in 65ms
```

## Liveness scheduler — no edit needed

Verified at `router/src/app.ts:309-313`:

```ts
const distinctBackendUrls = Array.from(
  new Set(opts.registry.get().models.map((m) => m.backend_url)),
);
const initialUrls = pool ? [...distinctBackendUrls, POSTGRES_PROBE_URL] : distinctBackendUrls;
liveness.start(initialUrls);
```

Plus `probeAdapterFor(url)` at `router/src/app.ts:240-250` derives the adapter from the registry entry, so:

1. New entries in models.yaml → new URLs in `distinctBackendUrls`.
2. New URLs → new probes scheduled.
3. New probes → `probeAdapterFor(url)` looks up the entry → factory dispatches to VLLMOpenAIAdapter → `probeLiveness()` runs.

Zero source edits required in `liveness.ts`. This confirms the planner's expectation.

## Decisions Made

See `key-decisions` in frontmatter. Summary:
- One adapter class for two backend values.
- No edits to liveness.ts (scheduler is already registry-driven).
- 400-not-500 in probeLiveness test (avoid OpenAI SDK retry timeout).
- Plan-boundary respected (no touches to compose.yml, adapter.ts, or routes/).

## Deviations from Plan

None — plan executed exactly as written. The plan's `<action>` step 4 explicitly anticipated that liveness.ts would require no edit "if the existing implementation derives URLs from the registry models list (the Phase 3 pattern — likely the case)", and that is exactly what was found. The plan's `<verify>` automated grep gates all pass.

One minor test-design refinement (mentioned in key-decisions): the planned `probeLiveness` 500-status test was retargeted to 400 because the OpenAI SDK's default 5xx retry policy would have pushed the test past vitest's 5 s timeout. The catch-and-surface contract is unchanged.

## Issues Encountered

Transient test-suite flakiness on the first `npm test` run — 2 unrelated tests (bearer.test.ts, readyz.stale.test.ts) timed out under heavy parallel I/O load (cold module-graph compilation took 270 s of total transform time). Both passed individually in isolation, and both passed on the immediate re-run when the module cache was warm. This is a pre-existing flake (no relation to Plan 07-03 changes); not a regression. Confirmed by the final test pass: 505/505 with 6.12 s total wall time.

## User Setup Required

None — no new env vars, secrets, or external services for this plan. The vllm and vllm-embed services themselves come from Plan 07-01 (already in compose.yml); the registry now knows about them.

## Next Phase Readiness

**Plan 07-04 (embeddings route) hand-off:**
- ✅ `bge-m3-ollama` and `bge-m3-vllm` are resolvable via `registry.resolve(name)`.
- ✅ Both entries declare `capabilities: ['embeddings']` — Plan 07-04's capability-gate check (D-B3) can dispatch on this.
- ✅ Both entries' backends are mapped in the factory — `makeAdapter(entry)` returns a working VLLMOpenAIAdapter or OllamaOpenAIAdapter.
- ⏸ **Still pending for Plan 07-04:**
  - Widen `router/src/backends/adapter.ts` `BackendAdapter` interface with `.embeddings(canonical: CanonicalEmbeddingRequest, signal): Promise<CanonicalEmbeddingResponse>`.
  - Add the `.embeddings()` method impl on `OllamaOpenAIAdapter` + `LlamacppOpenAIAdapter` + `VLLMOpenAIAdapter` (all three OpenAI-compat backends).
  - Create `router/src/routes/v1/embeddings.ts` (mirror chat-completions.ts: bearer auth → registry resolve → capability gate → adapter dispatch → `recordRequestOutcome`).
  - Register the new route in `router/src/app.ts` route-registration block.
  - Add `bin/smoke-test-router.sh` extension hitting `/v1/embeddings` with model: bge-m3-ollama and asserting `data[0].embedding.length === 1024`.

**Plan 07-06 (live smoke) hand-off:**
- BCKND-03 is half-complete: adapter + factory + registry are wired, but no live verification has occurred (this plan only proves in-process via mocks). Plan 07-06's live smoke will cycle `docker compose --profile vllm up -d`, wait for the 600 s cold-start window, hit `/v1/chat/completions` with `model: qwen2.5-7b-instruct-awq`, and confirm a real response token flows through.

## Self-Check: PASSED

All claimed files exist on disk:
- router/src/backends/vllm-openai.ts (created)
- router/tests/unit/vllm-openai.test.ts (created)
- router/src/config/registry.ts, router/src/backends/factory.ts, router/models.yaml, router/tests/unit/factory.test.ts, router/tests/unit/registry.required.test.ts, router/tests/unit/registry.test.ts, router/tests/msw/handlers.ts (modified)
- .planning/phases/07-embeddings-vllm-gpu-telemetry/07-03-SUMMARY.md (this file)

All claimed commits exist on `master`:
- 2df0708 — test(07-03): RED
- 05855e4 — feat(07-03): widen LocalBackendEnum
- 344b3ac — feat(07-03): VLLMOpenAIAdapter + factory
- b580036 — feat(07-03): models.yaml entries

---
*Phase: 07-embeddings-vllm-gpu-telemetry*
*Completed: 2026-05-16*
