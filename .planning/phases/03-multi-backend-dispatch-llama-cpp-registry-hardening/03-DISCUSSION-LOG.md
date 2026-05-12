# Phase 3: Multi-Backend Dispatch — llama.cpp + Registry Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-12
**Phase:** 3-multi-backend-dispatch-llama-cpp-registry-hardening
**Areas discussed:** llama.cpp deployment shape, Concurrency cap behavior, `/v1/models` response shape, `/readyz` aggregation + liveness probes

---

## Area selection

| Option | Description | Selected |
|--------|-------------|----------|
| llama.cpp deployment shape | One Compose service per GGUF vs llama-swap proxy vs single instance — decides compose.yml shape and models.yaml addressing scheme | ✓ |
| Concurrency cap behavior | Queue-with-timeout vs immediate 429; cap per-backend vs per-model; slot pool semantics | ✓ |
| /v1/models response shape | Strict OpenAI fields only vs OpenAI + capabilities extension; filter rule for which models to list | ✓ |
| /readyz aggregation + liveness probes | Probe method per backend, schedule, cache TTL, aggregation rule across active vs all backends | ✓ |

**User's choice:** All four.
**Notes:** No areas deferred to Claude's discretion at the selection step. The fifth would-have-been area (VRAM budget enforcement scope) was implicitly resolved by Roadmap SC4 ("rejected at startup") and was not surfaced as a separate question.

---

## llama.cpp deployment shape

### Q1: How should llama.cpp-server be deployed in Phase 3?

| Option | Description | Selected |
|--------|-------------|----------|
| One service, one GGUF (recommended) | Single llamacpp Compose service; one GGUF; Compose profiles handle 'one backend hot at a time' | ✓ |
| Multiple llama.cpp services, profile-gated | Each GGUF gets its own Compose service entry; profiles make them mutually exclusive | |
| llama-swap proxy (mostlygeek/llama-swap) | Introduce llama-swap NOW; router talks to one proxy URL that auto-loads/unloads N llama.cpp instances | |

**User's choice:** One service, one GGUF.
**Notes:** SC1 only needs one llamacpp model to prove the registry seam. Multi-GGUF llama.cpp deferred (captured in `<deferred>` for revisit if/when ≥2 GGUFs concurrent/swappable is wanted).

### Q2: Which GGUF should Phase 3 ship and how do we get it onto disk?

| Option | Description | Selected |
|--------|-------------|----------|
| Qwen2.5-7B-Instruct Q4_K_M, manual download (recommended) | bartowski/Qwen2.5-7B-Instruct-GGUF Q4_K_M; user downloads once into ${HOST_DATA_ROOT}/models-gguf/gguf/; documented in README; matches PROJECT.md "no auto-download" policy | ✓ |
| Qwen2.5-7B-Instruct Q4_K_M, bin/pull-gguf.sh script | Same model; ship a bash helper that downloads + checksums | |
| Different model — specify in notes | Mistral, Llama 3.1 8B, smaller 1.5B for fast smoke tests, etc. | |

**User's choice:** Qwen2.5-7B-Instruct Q4_K_M, manual download.
**Notes:** Matches Phase 1's explicit-pull policy. Strong 7B/Qwen contrast against the 3B/Llama Phase 1 already runs makes the SC1 backend-switch obvious in the smoke test.

---

## Concurrency cap behavior

### Q1: When the cap is hit on a backend, what should the (N+1)th request see?

| Option | Description | Selected |
|--------|-------------|----------|
| Bounded queue with timeout → 429 (recommended) | FIFO queue with per-backend `queue_max_wait_ms`; dequeue on slot release; 429 Retry-After on timeout | ✓ |
| Immediate 429, no queue | Cap full → instant 429; agents own retry/backoff; closer to OpenAI/Anthropic rate-limit semantics | |
| Bounded queue, no timeout (just hard cap) | FIFO queue with `queue_max_depth`; past depth → 429; no per-request timeout; runs eventually | |

**User's choice:** Bounded queue with timeout → 429.
**Notes:** Picked for smoother behavior under bursty agent traffic; 30s default `queue_max_wait_ms`. `queue_max_depth` not enforced separately in Phase 3 — the timeout bounds memory implicitly.

### Q2: At what granularity should the cap and queue live?

| Option | Description | Selected |
|--------|-------------|----------|
| Per backend (recommended) | One semaphore + queue per backend instance; all models share the slot pool; matches OLLAMA_NUM_PARALLEL and llama.cpp --parallel | ✓ |
| Per model in models.yaml | Each model gets its own slot pool; flexible but creates router-vs-backend cap mismatch hazard | |
| Per model, sum-capped per backend | Both per-model AND per-backend sum cap; more state, more tests | |

**User's choice:** Per backend.
**Notes:** Defaults `concurrency: 2` for both ollama and llamacpp (matches the backends' own internal caps). Per-model `concurrency` field stays in `models.yaml` as accepted-but-ignored (forward-compat for Phase 7 vLLM serving embeddings + chat with very different costs).

---

## `/v1/models` response shape

### Q1: What shape should GET /v1/models return?

| Option | Description | Selected |
|--------|-------------|----------|
| OpenAI strict + capabilities extension (recommended) | Canonical { object, data: [{ id, object, created, owned_by }] } + extra `capabilities` field on each entry | ✓ |
| Strict OpenAI shape only; capabilities at separate endpoint | /v1/models strict; capabilities at /v1/models/{id} or /v1/models/capabilities | |
| Extended shape with full registry metadata | id, owned_by, capabilities, backend, vram_budget_gb, concurrency, max_model_len — leaks backend impl | |

**User's choice:** OpenAI strict + capabilities extension.
**Notes:** OpenAI SDK ignores unknown fields → backwards-compatible with canonical clients while exposing capability info to user's agents. `owned_by` stays as the literal `"local-llms"` to avoid leaking the backend name.

### Q2: Which models should /v1/models list?

| Option | Description | Selected |
|--------|-------------|----------|
| All registered, regardless of liveness (recommended) | Lists every model in models.yaml; liveness lives on /readyz; matches OpenAI semantics | ✓ |
| Only models whose backend is currently alive | Filter by cached liveness probe; stale-view risk for clients that cache | |
| Only models in the active Compose profile | Filter by `profile` field matching ACTIVE_PROFILE env var; adds operational coupling | |

**User's choice:** All registered, regardless of liveness.
**Notes:** Decouples /v1/models from the probe scheduler. Unreachable-backend call returns 502/503 at request time per the existing error envelope.

---

## `/readyz` aggregation + liveness probes

### Q1: How should per-backend liveness probes be scheduled and cached?

| Option | Description | Selected |
|--------|-------------|----------|
| Scheduled background probe, /readyz reads cache (recommended) | setInterval per backend (10s default); cache result + timestamp; /readyz reads cache instantly | ✓ |
| On-demand probe on every /readyz call, short TTL cache | First call probes; subsequent calls within cache_ttl_ms reuse; cache-miss callers pay probe cost | |
| Both — background + on-demand re-probe button | Background default + ?fresh=1 query param to force re-probe | |

**User's choice:** Scheduled background probe.
**Notes:** Zero upstream calls on the /readyz hot path. Stale-probe detection (`now - last_probe_at > 2× probe_interval`) treats it as down. Probe timers cleared on app shutdown.

### Q2: What's the aggregation rule for /readyz, and which backends does it consider?

| Option | Description | Selected |
|--------|-------------|----------|
| All distinct backends used by models.yaml; 200 only if ALL alive (recommended) | Probe every backend referenced in models.yaml; 200 iff every one alive; body always lists per-backend; strict K8s-style readiness | ✓ |
| Profile-aware — only probe backends in the active profile | Router reads ACTIVE_PROFILE; filters by `profile` field; avoids 503 under one-profile-at-a-time | |
| All distinct backends; 200 if ANY alive (lenient) | At least one alive → 200; doesn't match strict readiness semantics | |

**User's choice:** All distinct backends; 200 only if ALL alive.
**Notes:** Operational implication: under one-profile-at-a-time Compose deployments, `/readyz` will be 503 because the inactive backend's models.yaml entry exists and probes red. This is by design — `/readyz` is the canary. The router's Docker healthcheck uses `/healthz` (unconditional liveness). Phase 6 Traefik may pick `/readyz` or `/healthz` per its own use case.

---

## Claude's Discretion

Captured in CONTEXT.md `<decisions>` → "Claude's Discretion" subsection. Notable items:
- Exact llama.cpp build tag (pinned at planning time).
- Exact filename + sha for the Qwen2.5-7B-Instruct GGUF (verified at planning time from bartowski's HF repo).
- Whether to introduce a new `backends:` top-level section in `models.yaml` or derive per-backend config from per-model fields.
- In-process semaphore impl: hand-rolled vs `p-limit` vs `async-sema`.
- Internal class name `LlamacppOpenAIAdapter`.
- Whether `AdapterFactory` becomes a `Map` lookup or a `switch`.
- Probe timeout (2s suggested) and probe-failure log throttling.
- Exact `/readyz` JSON field names (recommended names in CONTEXT.md).
- Optional `ACTIVE_PROFILE` env var for diagnostic logging.
- README updates documenting the manual GGUF download, `--profile` flow, `/readyz` semantics under profiles.
- pino log shapes for probe lifecycle, queue wait, queue-drop events.
- Integration test additions (`models.endpoint.test.ts`, `readyz.test.ts`, `concurrency.test.ts`).

## Deferred Ideas

Captured in CONTEXT.md `<deferred>`. Highlights:
- Multi-GGUF llama.cpp / llama-swap proxy.
- Per-model concurrency cap activation (forward-compat for Phase 7).
- Runtime / live VRAM measurement + eviction (VRAM-01, v2).
- Profile-aware `/readyz` filtering (rejected here; revisit if operational friction).
- `X-Model-Backend` header (Phase 8).
- `Idempotency-Key` header (Phase 8).
- Anthropic surface (Phase 4).
- Prometheus `/metrics` on router (Phase 5).
- vLLM AWQ backend (Phase 7).
- Per-backend circuit breaker (Phase 8).
- Open WebUI integration via `/v1/models` (Phase 6).
- `bin/pull-gguf.sh` helper (deferred; user picked manual).
- Probe-driven availability flag in `/v1/models` (revisit if needed).
