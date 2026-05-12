---
phase: 03-multi-backend-dispatch-llama-cpp-registry-hardening
plan: "01"
subsystem: router/backends + compose
tags:
  - multi-backend
  - llamacpp
  - compose-profiles
  - backend-adapter
  - factory
dependency_graph:
  requires:
    - "03-02: widened zod schema (LocalBackendEnum, capabilities required, vram_budget_gb required)"
    - "Phase 1: gpu-preflight service, x-gpu anchor, gpu-init-libcuda.sh"
    - "Phase 2: OllamaOpenAIAdapter, BackendAdapter interface, BuildApp pattern"
  provides:
    - "LlamacppOpenAIAdapter implementing BackendAdapter (BCKND-02)"
    - "AdapterFactory.makeAdapter(entry) dispatch by entry.backend (BCKND-05)"
    - "BackendAdapter.probeLiveness(signal) seam on both adapters"
    - "llamacpp Compose service with profiles: [llamacpp], no host port, pinned image"
    - "ollama Compose service gains profiles: [ollama]"
    - "router depends_on: required:false for both backends"
  affects:
    - "router/src/backends/adapter.ts — probeLiveness widening"
    - "router/src/backends/ollama-openai.ts — probeLiveness implementation"
    - "router/tests/msw/handlers.ts — llamacpp handler factories added"
    - "compose.yml — llamacpp service + profiles + required:false"
tech_stack:
  added: []
  patterns:
    - "Map-lookup AdapterFactory: ADAPTERS[entry.backend] => new Ctor(entry.backend_url)"
    - "probeLiveness: /v1/models probe, returns {ok, latencyMs, error?}, never throws"
    - "Compose profiles per backend service (ollama/llamacpp); router boots with either or neither"
key_files:
  created:
    - router/src/backends/llamacpp-openai.ts
    - router/src/backends/factory.ts
    - router/tests/unit/factory.test.ts
    - router/tests/integration/chat-completions.llamacpp.test.ts
  modified:
    - router/src/backends/adapter.ts
    - router/src/backends/ollama-openai.ts
    - router/tests/msw/handlers.ts
    - router/tests/integration/chat-completions.stream.test.ts
    - compose.yml
decisions:
  - "Image tag server-cuda-b9115 pinned (as specified in 03-PATTERNS.md — T-3-S1 mitigation)"
  - "makeLlamacppAdapterFromEntry helper exported from llamacpp-openai.ts (mirrors makeOllamaAdapterFromEntry)"
  - "Factory does NOT cache adapter instances (new per call — defer until benchmarks justify)"
  - "router/models.yaml NOT touched — owned by Plan 03-02 (Blocker 1 resolution, revision 1)"
  - "router-dev service also gets required:false on its depends_on for consistency"
  - "probeLiveness uses client.models.list() — calls /v1/models, checks data[].length > 0"
metrics:
  duration: "~5 minutes"
  completed: "2026-05-12"
  tasks: 2
  files_created: 4
  files_modified: 5
---

# Phase 3 Plan 01: llama.cpp Adapter + Compose Service + Factory Summary

**One-liner:** LlamacppOpenAIAdapter + Map-lookup factory dispatch by entry.backend, Compose llamacpp service pinned to server-cuda-b9115 with no host port, profiles:ollama/llamacpp, SC1 proved in-process.

## What Was Built

### Task 1: BackendAdapter widening + LlamacppOpenAIAdapter + factory.ts + msw extensions

**router/src/backends/adapter.ts** widened with `probeLiveness`:
- Added `probeLiveness(signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }>` to the interface
- Updated JSDoc to remove "Phase 3 adds LlamacppOpenAIAdapter" future-tense wording (it now exists)

**router/src/backends/ollama-openai.ts** gains `probeLiveness`:
- Calls `this.client.models.list({ signal })`, returns `{ ok: data.length > 0, latencyMs, error? }`
- Never throws — catch block returns `{ ok: false, latencyMs, error: err.message }`

**router/src/backends/llamacpp-openai.ts** (new):
- Mirrors `OllamaOpenAIAdapter` exactly; only `apiKey: 'llamacpp'` differs (SDK v6 requires non-empty)
- Same `stream_options: { include_usage: true }` on both stream and non-stream calls (D-B3 drift prevention)
- Exports `makeLlamacppAdapterFromEntry(entry)` convenience factory for tests that bypass the dispatch factory
- Same `probeLiveness` implementation as OllamaOpenAIAdapter

**router/src/backends/factory.ts** (new):
- `ADAPTERS: Record<string, AdapterCtor>` map with `ollama: OllamaOpenAIAdapter, llamacpp: LlamacppOpenAIAdapter`
- `makeAdapter(entry)` does `ADAPTERS[entry.backend]` — throws `Error('No adapter registered for backend "..."')` on unknown
- No memoization (creates new instance per call — per 03-PATTERNS.md line 168)
- Phase 8 comment placeholder: `// 'ollama-cloud': OllamaCloudAdapter,`

**router/tests/msw/handlers.ts** extended:
- `llamacppNonStreamHandler(opts)` — default URL `http://llamacpp:8080/v1/chat/completions`
- `llamacppStreamHandler(opts)` — same SSE shape as ollamaStreamHandler, model default `qwen2.5-7b-instruct-q4_K_M`
- `llamacppModelsListHandler(opts)` — supports `modelIds: []` for empty-data probe test case

### Task 2: Compose service + integration tests

**compose.yml** changes:
- `ollama` service: added `profiles: [ollama]` (D-A3)
- New `llamacpp` service:
  - Image: `ghcr.io/ggml-org/llama.cpp:server-cuda-b9115` (pinned — T-3-S1 mitigated)
  - `profiles: [llamacpp]`
  - `<<: *gpu` anchor (Phase 1 D-02 GPU reservation)
  - `entrypoint: ["/usr/local/bin/gpu-init-libcuda.sh"]` (Phase 1 libcuda wrapper)
  - `command`: `llama-server -m /models/Qwen2.5-7B-Instruct-Q4_K_M.gguf --n-gpu-layers 99 --ctx-size 16384 --parallel 2 --metrics`
  - `networks: [backend]` — NO host port (T-3-04 mitigated)
  - Volume: `${HOST_DATA_ROOT}/models-gguf/gguf:/models:ro` — read-only, separate from ollama store (T-3-S2 mitigated)
  - Volume: `./bin/gpu-init-libcuda.sh:/usr/local/bin/gpu-init-libcuda.sh:ro`
  - Healthcheck: `curl -fsS http://localhost:8080/health` (server-cuda image has curl)
  - `depends_on.gpu-preflight.condition: service_completed_successfully` (T-3-E1 mitigated)
- `router` service: `depends_on.ollama.required: false` + new `depends_on.llamacpp.required: false` (Pitfall 2)
- `router-dev` service: same `required: false` treatment for consistency

**router/tests/integration/chat-completions.llamacpp.test.ts** (new):
- 3 tests using `LlamacppOpenAIAdapter` directly (stream forwarding, [DONE] synthesis, usage chunk)
- 3 SC1 proof tests using `factory.makeAdapter`: ollama model -> ollama upstream, qwen model -> llamacpp upstream, sequential requests to both prove different adapters invoked
- Uses inline `loadRegistryFromString` YAML — does NOT read `router/models.yaml` from disk

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] MockAbortAdapter in chat-completions.stream.test.ts didn't implement probeLiveness**
- **Found during:** Task 1 GREEN phase — `npx tsc --noEmit` failed
- **Issue:** The existing integration test had a `MockAbortAdapter implements BackendAdapter` class that was missing `probeLiveness` after the interface was widened.
- **Fix:** Added `async probeLiveness(_signal) { return { ok: true, latencyMs: 0 }; }` to `MockAbortAdapter`.
- **Files modified:** `router/tests/integration/chat-completions.stream.test.ts`
- **Commit:** c3a419d

### Architecture Decisions

**app.ts factory wiring deferred to next wave:**
- Per Task 1 action note and 03-02 SUMMARY Option β: `app.ts` still uses `makeOllamaAdapterFromEntry` as the default for chat completions
- This plan creates `factory.ts` and wires it only in tests (via `makeAdapter` injection to `buildApp`)
- The full `app.ts` wiring (replacing `makeOllamaAdapterFromEntry` with `defaultMakeAdapter`) is for a subsequent plan

## TDD Gate Compliance

- Task 1 RED: `test(03-01): add failing factory unit tests (RED)` — commit a43ed31
- Task 1 GREEN: `feat(03-01): widen BackendAdapter + add LlamacppOpenAIAdapter + factory.ts + msw handlers (GREEN)` — commit c3a419d
- Task 2: Integration test written after Compose changes (tests passed immediately; implementation was already in place from Task 1)

## Output Requirements

- **Image tag used:** `ghcr.io/ggml-org/llama.cpp:server-cuda-b9115` (as specified in 03-PATTERNS.md §External Pins, verified 2026-05-12)
- **makeLlamacppAdapterFromEntry exported:** YES — exported from `router/src/backends/llamacpp-openai.ts`
- **Factory caches adapters:** NO — creates new instance per `makeAdapter(entry)` call (per 03-PATTERNS.md line 168; deferred until benchmarks)
- **Deviations from 03-PATTERNS.md verbatim sources:** One minor — probeLiveness uses `{ signal } as Parameters<...>[0]` type cast for SDK v6 compatibility (SDK types don't expose the signal option directly on models.list but it is supported at runtime)
- **router/models.yaml touched in this plan's commits:** NO — confirmed with `git diff a43ed31..HEAD -- router/models.yaml | wc -l` = 0
- **Compose version at execution time:** Docker Compose v5.1.3 (supports `required: false` — requirement was >= 2.20.2)

## Threat Model Mitigation Summary

| Threat ID | Status | Verification |
|-----------|--------|-------------|
| T-3-04 (llamacpp on host port) | MITIGATED | No `ports:` key in llamacpp service; `networks: [backend]` only |
| T-3-S1 (image tag drift) | MITIGATED | Pinned to `:server-cuda-b9115`; no `:latest` in compose.yml |
| T-3-S2 (shared model store) | MITIGATED | Mounts `models-gguf/gguf:/models:ro` only (not ollama's blob store) |
| T-3-E1 (GPU without preflight) | MITIGATED | `depends_on.gpu-preflight.condition: service_completed_successfully` |

## Self-Check: PASSED

| Item | Status |
|------|--------|
| router/src/backends/llamacpp-openai.ts | FOUND |
| router/src/backends/factory.ts | FOUND |
| router/src/backends/adapter.ts (probeLiveness) | FOUND |
| router/src/backends/ollama-openai.ts (probeLiveness) | FOUND |
| router/tests/msw/handlers.ts (3 llamacpp handlers) | FOUND |
| router/tests/unit/factory.test.ts | FOUND |
| router/tests/integration/chat-completions.llamacpp.test.ts | FOUND |
| compose.yml (llamacpp service + profiles) | FOUND |
| commit a43ed31 (RED) | FOUND |
| commit c3a419d (GREEN Task 1) | FOUND |
| commit 527fcbe (integration test) | FOUND |
| commit fce48a1 (compose changes) | FOUND |
| router/models.yaml NOT modified | CONFIRMED |
