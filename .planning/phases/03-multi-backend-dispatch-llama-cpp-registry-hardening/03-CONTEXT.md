# Phase 3: Multi-Backend Dispatch — llama.cpp + Registry Hardening - Context

**Gathered:** 2026-05-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Prove the router's registry-driven backend selection is the actual abstraction — not just a placeholder — by slotting **llama.cpp-server** in as the second backend via a `models.yaml` entry, *with no router code change between the two backends* (SC1). Then harden the seams every later backend (vLLM in Phase 7, Ollama Cloud in Phase 8) will rely on:

- **`GET /v1/models`** with capability flags (OAI-03).
- **`GET /readyz`** with per-backend liveness probes, scheduled + cached (ROUTE-06).
- **Per-backend concurrency caps** with queue-then-429 overflow behavior (ROUTE-07).
- **`models.yaml` VRAM budget** validated at router startup (BCKND-04).
- **Compose `profiles:`** so exactly one GPU backend is hot at a time on the 16 GB envelope (BCKND-05).
- **llama.cpp-server** deployed correctly: `--n-gpu-layers 99`, `--ctx-size` sized per `--parallel`, no host port (BCKND-02).

**Scope:** exactly one new backend (llama.cpp-server) serving one GGUF; the four router-side hardening surfaces above; the Compose profile gating across the now-two-backend stack; the smoke test that proves SC1 by switching the `model` field in a `POST /v1/chat/completions` body and observing two different backends serve.

**Phase 3 cleanup of Phase 2 walking-skeleton state:**
- Ollama gains a `profiles: [ollama]` key (Phase 1 D-11 deferred the per-backend profile here).
- `models.yaml` zod schema **tightens validation**: the optional fields (`capabilities`, `vram_budget_gb`, `concurrency`, `max_model_len`, `profile`) that Phase 2 accepted-but-ignored now get **read** by the runtime; the schema starts treating `vram_budget_gb` and `concurrency` as effectively-required for any entry that points at a local backend (cloud entries in Phase 8 are exempt).
- The `backend` zod enum widens from `['ollama']` to `['ollama', 'llamacpp']`.

**Explicitly out of Phase 3** (each lives in its own phase per ROADMAP.md):
- `/v1/messages` (Anthropic surface) + tool calling translation + vision → Phase 4.
- `/v1/embeddings` → Phase 7.
- vLLM backend → Phase 7.
- Ollama Cloud backend → Phase 8.
- Postgres `request_log` + `/metrics` → Phase 5.
- Traefik / TLS / `/readyz` exposed via Traefik / four-network *enforcement* (Phase 1 declared the networks; Phase 6 enforces edge isolation) → Phase 6.
- Open WebUI → Phase 6.
- Rate limit (Valkey-backed), circuit breaker, `Idempotency-Key`, `X-Model-Backend` header → Phase 8.
- Multi-GGUF llama.cpp / llama-swap proxy → deferred (revisit when the user actually wants ≥2 GGUFs hot or rapidly-swappable).
- Runtime VRAM enforcement / live VRAM measurement / eviction → deferred; Phase 3 validates the *declared* budget at startup only (see VRAM-01 in v2 backlog).

</domain>

<decisions>
## Implementation Decisions

### llama.cpp deployment shape
- **D-A1:** **One llama.cpp Compose service serving exactly one GGUF in Phase 3.** Phase 3 SC1 needs only *one* `backend: llamacpp` model to prove the registry seam works for a new backend. The "multiple GGUFs hot at once" question (and the `mostlygeek/llama-swap` proxy that solves it) is deferred — re-evaluate when the user actually wants ≥2 GGUFs concurrent or rapidly-swappable. Until then, Compose `profiles:` provide "exactly one backend hot at a time" (BCKND-05, SC5), which is sufficient.
- **D-A2:** **Phase 3 GGUF is `bartowski/Qwen2.5-7B-Instruct-GGUF` :: `Q4_K_M`** (~4.4 GB on disk). Downloaded **manually** via `huggingface-cli download` / `wget` into the canonical host path `${HOST_DATA_ROOT}/models-gguf/gguf/`. **No auto-pull init service** — that contradicts PROJECT.md's anti-feature *"No auto-download of missing models — explicit `huggingface-cli download` is a feature"*. The README documents the one-time download step alongside Phase 1's `ollama pull`. The 7B/Qwen vs 3B/Llama-from-Phase-1 contrast makes the SC1 backend-switch obvious (different size, different vendor, different responses).
- **D-A3:** **Compose `profiles:` are symmetric across all three backends.** Phase 3 introduces `profiles: [ollama]` on the existing Ollama service and `profiles: [llamacpp]` on the new llama.cpp service. Phase 7 will add `profiles: [vllm]`. `gpu-preflight` and `router` stay profile-less (always-on). The router's `depends_on` for the backend is **soft** at the Compose level — the router boots without any backend running and uses `/readyz` to report not-ready; this is required because the router does not have a per-profile copy. Documented operational pattern: `docker compose --profile ollama up` brings up gpu-preflight + ollama + router; substituting `--profile llamacpp` swaps the backend.
- **D-A4:** **llama.cpp image pin: `ghcr.io/ggml-org/llama.cpp:server-cuda` pinned to a specific build tag** (e.g., `server-cuda-bXXXX` per the latest stable build at planning time). NO `:latest`. CUDA 12 variant matches NVIDIA Container Toolkit defaults in this stack. Planner picks the exact build number at planning time — but record it; future GGUFs and vLLM image choices may depend on the CUDA major.
- **D-A5:** **llama.cpp runtime flags (BCKND-02):**
  - `--n-gpu-layers 99` — push every transformer layer to GPU (the magic number "99" is documented idiom meaning "all").
  - `--ctx-size` sized so that **per-slot context = `--ctx-size / --parallel`** is at least the request's `max_tokens + reasonable input`. Default: `--ctx-size 16384 --parallel 2` (per-slot 8K). Documented in the service comment block.
  - `--host 0.0.0.0 --port 8080` (internal-network only — see D-A6).
  - `--metrics` enabled so Phase 7 can scrape `/metrics` without re-deploying.
- **D-A6:** **llama.cpp host port is NEVER published.** Joins the `backend` network only (internal-true per D-13). The router is the only externally-reachable surface (D-A4 of Phase 2). To exec against llama.cpp from the host, use `docker compose exec llamacpp curl http://localhost:8080/...` — same pattern as Ollama in Phase 2.
- **D-A7:** **GPU + preflight wiring matches Phase 1 D-04:** `depends_on: { gpu-preflight: { condition: service_completed_successfully } }`. References the `x-gpu` YAML anchor (D-02 of Phase 1) for GPU reservation. Uses the same `gpu-init-libcuda.sh` entrypoint wrapper (Phase 1 ships it; Ollama uses it; llama.cpp inherits — verified compatible because the wrapper just sets up `libcuda.so.1` and execs the original entrypoint).
- **D-A8:** **GGUF volume layout** (Phase 1 D-02): llama.cpp mounts `${HOST_DATA_ROOT}/models-gguf/gguf` as read-only at `/models`. The GGUF file path passed via `-m /models/<filename>.gguf`. **Never** mount `models-gguf/ollama/` into llama.cpp — that's Ollama's blob store, the file layout is incompatible.

### Concurrency cap behavior (ROUTE-07)
- **D-B1:** **Cap granularity = per backend** (not per model in Phase 3). One in-process semaphore + queue per `BackendAdapter` instance. All models served by the same backend share the slot pool. Matches Ollama's `OLLAMA_NUM_PARALLEL=2` semantics already in `compose.yml` and llama.cpp's `--parallel N` flag. The router cap exists to stop *upstream 5xx from oversubscription*, not to override the backend's own cap — keep them aligned.
- **D-B2:** **Overflow behavior = bounded FIFO queue with per-request timeout, then 429.** Excess requests `await` a slot up to `queue_max_wait_ms`. On slot release: dequeue and serve. On timeout: respond `429 Too Many Requests` with `Retry-After: <queue_max_wait_seconds>` and the OpenAI error envelope (`type: "rate_limit_error"`, `code: "backend_saturated"`).
- **D-B3:** **Default values for Phase 3:**
  - `concurrency` per backend: `ollama: 2` (matches `OLLAMA_NUM_PARALLEL=2`), `llamacpp: 2` (matches `--parallel 2`).
  - `queue_max_wait_ms`: `30_000` (30s default). Configurable per backend in `models.yaml` via a new field — see D-D2.
  - `queue_max_depth`: not enforced as a separate hard cap in Phase 3; the timeout bounds wait, which bounds memory pressure implicitly under any realistic agent load. Revisit if real load shows runaway queues.
- **D-B4:** **A streaming request holds its slot from the moment it acquires through the final byte / [DONE].** No "hand-off" mid-stream. This is the simple, correct interpretation; the slot pool reflects in-flight upstream socket consumption.
- **D-B5:** **Cap is enforced in the router**, not by passing through to the backend's own cap. The router's semaphore acquires *before* the `BackendAdapter` call; queue-wait time is included in the router's request-duration metric (planner picks the histogram bucket).
- **D-B6:** **Per-model `concurrency` field in `models.yaml` is accepted-but-ignored in Phase 3** (forward-compat for Phase 7 when one vLLM serves embeddings + chat with very different per-model costs). The **backend-level** cap is the new authoritative field; planner picks the exact YAML shape (suggest top-level `backends:` section keyed by backend name, OR derive from `max(concurrency)` across models pointing at the same backend — planner's call, document the choice).

### `GET /v1/models` response shape (OAI-03)
- **D-C1:** **OpenAI canonical shape + `capabilities` extension.** Response body:
  ```json
  {
    "object": "list",
    "data": [
      {
        "id": "llama3.2:3b-instruct-q4_K_M",
        "object": "model",
        "created": 1715517600,
        "owned_by": "local-llms",
        "capabilities": ["chat"]
      },
      {
        "id": "qwen2.5-7b-instruct-q4km",
        "object": "model",
        "created": 1715517600,
        "owned_by": "local-llms",
        "capabilities": ["chat", "tools"]
      }
    ]
  }
  ```
  OpenAI SDK consumers ignore unknown fields → backwards-compatible with canonical clients while exposing capability info to the user's own agents.
- **D-C2:** **`owned_by` = the literal string `"local-llms"`** for every locally-served model. Phase 8 may use `"ollama-cloud"` for cloud-routed entries — planner of Phase 8 to confirm. `owned_by` does **not** leak the backend name (`ollama`, `llamacpp`) — that's an implementation detail; agents should not branch on it.
- **D-C3:** **`created` = registry-load Unix timestamp.** Stable across the lifetime of a registry snapshot; refreshes on hot-reload. Not "model file mtime" (too coupled to filesystem), not "Unix epoch 0" (looks like a bug in client tooling). Planner picks whether per-model or shared-across-list.
- **D-C4:** **Listing rule: all models in the active `models.yaml` snapshot, regardless of liveness.** Liveness lives on `/readyz`. /v1/models is "models you can in principle call". A request to an unreachable backend returns 502/503 at call time (D-C3 row of Phase 2). This is the OpenAI semantic, matches what agents expect, and decouples the model-listing endpoint from the probe scheduler.
- **D-C5:** **Auth: `/v1/models` requires bearer.** Same auth gate as `/v1/chat/completions`. Public-without-auth surface is `/healthz` only (extended in this phase: `/readyz` is *also* public-without-auth — see D-D1).
- **D-C6:** **Capability values are the closed set: `chat`, `embeddings`, `vision`, `tools`.** Already declared in the zod enum in `router/src/config/registry.ts`. Phase 3 starts emitting these on `/v1/models`. Phase 4 (vision, tools), Phase 7 (embeddings) populate them in real models.yaml entries. Phase 3's two models declare:
  - `llama3.2:3b-instruct-q4_K_M`: `[chat]`.
  - `qwen2.5-7b-instruct-q4km`: `[chat, tools]` (Qwen2.5 has native tool-calling — declaring it forward-compat for Phase 4; Phase 3 doesn't exercise it).

### `/readyz` aggregation + per-backend liveness probes (ROUTE-06)
- **D-D1:** **`/readyz` is public-without-auth** (same skip-list as `/healthz`). Operational + Docker healthcheck convention. The endpoint exposes no secrets — just backend names and up/down status.
- **D-D2:** **Probe schedule: scheduled background + cached.** Each distinct backend URL in `models.yaml` gets a `setInterval` probing every **10 s** (default; configurable). Result + ISO timestamp stored in an in-memory map. `/readyz` reads the cache **synchronously** — zero upstream calls on the hot path. Probes registered on router boot and after every successful `models.yaml` hot-reload (de-dup so the same URL doesn't get N timers).
- **D-D3:** **Probe contract per backend:**
  - **Ollama**: `GET ${backend_url}/models` (the OpenAI-compat endpoint) with a 2s timeout. Success = HTTP 200 + non-empty `data` array. Falling back to `/api/tags` (Ollama-native) is **not** done in Phase 3 — both backends in Phase 3 expose the OpenAI-compat surface, and using a uniform probe path simplifies the adapter contract.
  - **llama.cpp-server**: `GET ${backend_url}/models` (OpenAI-compat). Same contract.
  - The probe method is encoded on the `BackendAdapter` interface as a new `probeLiveness(signal): Promise<void>` method (throws on failure). `OllamaOpenAIAdapter` and `LlamacppOpenAIAdapter` each implement it.
- **D-D4:** **Aggregation rule: 200 iff EVERY distinct backend referenced by `models.yaml` is alive.** Else 503. Response body **always** includes a per-backend status array, regardless of HTTP code:
  ```json
  {
    "status": "ready" | "not_ready",
    "checked_at": "2026-05-12T...Z",
    "backends": [
      { "url": "http://ollama:11434/v1", "status": "alive",  "last_probe_at": "...", "latency_ms": 8 },
      { "url": "http://llamacpp:8080/v1", "status": "down", "last_probe_at": "...", "error": "ECONNREFUSED" }
    ]
  }
  ```
  Strict Kubernetes-style readiness semantics.
- **D-D5:** **Operational consequence (documented in README):** With Compose profiles bringing up exactly one GPU backend at a time, **`/readyz` will return 503** as long as `models.yaml` declares models for the inactive backend. This is by design — `/readyz` is the canary that tells you which backends are reachable. **The router's Docker healthcheck uses `/healthz` (unconditional liveness), not `/readyz`.** External callers (and Phase 6's Traefik readiness probe) may use `/readyz` if they want strict semantics, or `/healthz` if they just want "router process up".
- **D-D6:** **Stale-probe handling:** if `now - last_probe_at > 2 × probe_interval_ms` for any backend, the response marks that backend as `status: "stale"` (counts as down for aggregation). This catches "the background timer crashed" scenarios.
- **D-D7:** **Probe cleanup on shutdown:** every `setInterval` is tracked; the app exposes a `stop()` method that clears all timers. Used by integration tests and graceful shutdown.

### Registry hardening (BCKND-04, models.yaml widening)
- **D-E1:** **`models.yaml` zod schema tightens in Phase 3:**
  - `backend` enum widens: `['ollama', 'llamacpp']`. Phase 8 will add `'ollama-cloud'`.
  - `capabilities`: now **required** (was optional). Min length 1. Reason: `/v1/models` is responsible for emitting it; making it required surfaces drift at config-load.
  - `vram_budget_gb`: **required** for local backends; planner introduces a discriminated union or refinement so cloud entries (Phase 8) can opt out. For Phase 3, both entries are local → both must declare it.
  - `concurrency`, `max_model_len`: kept optional with documented defaults (concurrency: 2; max_model_len: backend-dependent).
  - `profile`: optional; documents which Compose profile must be active for the model to be reachable. **Informational in Phase 3** — not read by the runtime, but emitted on `/v1/models` as a debug aid would be too implementation-leaky, so it stays internal. Planner keeps the field in the schema for forward-compat.
- **D-E2:** **VRAM budget enforcement scope: startup-time only.** SC4 says "rejected at startup with a clear error rather than crashing on first request". Algorithm:
  1. Group `models.yaml` entries by `backend` (string field).
  2. For each backend, `sum(vram_budget_gb)` across its entries.
  3. With Compose profiles enforcing "one backend hot at a time", validate **per-backend** (not summed across all backends): `sum_per_backend <= 16` for every backend. If any backend over-subscribes, reject startup with `ConfigError: backend "<name>" exceeds 16 GB VRAM envelope (sum=18.5 GB)`.
  4. Hot-reload (D-B4 / Phase 2 D-C3 row): same validation; on failure → **keep previous registry**, log at `error`, do **not** swap.
  5. **No live VRAM measurement in Phase 3.** Phase 3 trusts the declared `vram_budget_gb`. Live measurement / eviction is `VRAM-01` (v2 backlog).
- **D-E3:** **The VRAM envelope is hardcoded at `16` (GB) in Phase 3.** Configurable via an env var (`VRAM_ENVELOPE_GB`, default 16) so future-different-hardware setups don't require a code change. Documented but not exercised in Phase 3 smoke tests.

### Smoke test for SC1
- **D-F1:** **`bin/smoke-test-router.sh` extended in Phase 3** (the script already exists from Phase 2):
  - New section: "Phase 3 — multi-backend dispatch":
    - Bring up `--profile ollama`; `curl POST /v1/chat/completions` with `model: "llama3.2:3b-instruct-q4_K_M"`; assert 200 + non-empty content.
    - Tear down; bring up `--profile llamacpp`; same `curl` with `model: "qwen2.5-7b-instruct-q4km"`; assert 200 + non-empty content.
    - Assert `/v1/models` lists exactly the active-backend model in each profile (operational truth: models.yaml has both; only the one whose backend is alive serves; readyz says 503 for the inactive one).
    - Assert `/readyz` returns 503 in each profile (because the *other* backend's URL doesn't resolve), with the per-backend status body showing exactly one alive and one down.
  - This is the **SC1 verification artifact** — proves the same endpoint serves two different backends with zero router code change.

### Claude's Discretion
- Exact llama.cpp build tag (e.g., `:server-cuda-b4321`) — planner picks the latest stable at planning time and pins it. Document the choice and rationale (CUDA 12 compat).
- Exact filename for the Qwen2.5 GGUF (varies by quantization variant in bartowski's repo) and the recommended `huggingface-cli download` invocation — planner researches at planning time; pick one variant of `Q4_K_M`.
- Whether to introduce a new `backends:` top-level section in `models.yaml` for per-backend config (concurrency, queue_max_wait_ms) or to derive from per-model fields. Suggest: a new `backends:` map keyed by backend name (`ollama`, `llamacpp`) holding `{concurrency, queue_max_wait_ms, base_url?}`. Per-model `concurrency` remains accepted-but-ignored (forward-compat).
- Exact in-process semaphore implementation: hand-rolled mutex+queue vs `p-limit` vs `async-sema` — pick whatever has the cleanest TS types and zero CommonJS interop. Document the choice.
- Internal name for `LlamacppOpenAIAdapter` — keep parallel to `OllamaOpenAIAdapter`. Both implement `BackendAdapter` + the new `probeLiveness` method.
- Whether `AdapterFactory` becomes a `Map<backend_name, AdapterClass>` lookup or a `switch (entry.backend)` — pick one and apply consistently. The factory MUST live in one place so Phase 7/8 add backends in one edit.
- Probe timeout value (2s suggested), probe-failure log throttling (don't spam at error level every 10s when a backend is down — log on transitions: down→up, up→down). Planner picks the exact log shape and level.
- `/readyz` JSON schema exact field names — names above are recommended, planner can refine. Document and stick to it.
- Whether to expose `ACTIVE_PROFILE` as an env var the router reads for diagnostic purposes (logs include "current profile = llamacpp"). Useful but not required for any SC. Planner picks.
- README updates: document (a) the manual GGUF download step, (b) the `docker compose --profile <name> up` flow, (c) that `/readyz` will be 503 unless `models.yaml` matches the active profile, (d) how to verify SC1 via the extended smoke test.
- pino log additions for Phase 3: probe lifecycle transitions, queue-wait time, queue-drop (429-on-timeout) events. Planner picks levels.
- Integration tests: extend the vitest suite with `models.yaml` validation tests (capabilities required, vram budget enforced), `/v1/models` shape tests, `/readyz` aggregation tests (using a fake adapter that toggles liveness). The actual `llamacpp` adapter gets msw-style stubbed upstreams parallel to the existing Ollama tests.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase context (this directory)
- `.planning/phases/03-multi-backend-dispatch-llama-cpp-registry-hardening/03-CONTEXT.md` — this file (locked decisions D-A1..D-F1)
- `.planning/phases/03-multi-backend-dispatch-llama-cpp-registry-hardening/03-DISCUSSION-LOG.md` — full discussion audit trail (humans only; not consumed by agents)
- `.planning/phases/02-mvp-vertical-slice-router-ollama-sse/02-CONTEXT.md` — Phase 2 locked decisions: `BackendAdapter` seam (D-B2), `openai` SDK upstream pattern (D-B1), forward-compat `models.yaml` schema (D-B4), error envelope (D-C1..C4), router host port + Ollama port removal (D-A4)
- `.planning/phases/01-gpu-compose-foundation/01-CONTEXT.md` — Phase 1 locked decisions: `/srv/local-llms/` host root (D-01), volume layout (D-02), `gpu-preflight` + `depends_on` (D-04..D-06), `x-gpu` anchor (referenced in compose.yml), four networks (D-13), `.env` contract (D-14), single `compose.yml` (D-12), backend-profile deferral (D-11)

### Project-level
- `.planning/PROJECT.md` — Core Value, Constraints (16 GB VRAM cap), Key Decisions, Out-of-Scope (especially "No auto-download of missing models" — informs D-A2)
- `.planning/REQUIREMENTS.md` — v1 requirement IDs (this phase covers **BCKND-02, BCKND-04, BCKND-05, ROUTE-06, ROUTE-07, OAI-03**)
- `.planning/ROADMAP.md` §"Phase 3: Multi-Backend Dispatch — llama.cpp + Registry Hardening" — Goal + 5 Success Criteria (the verification anchor)
- `.planning/STATE.md` — accumulated context, standing anti-patterns to reject (especially: no `:latest`, no `node:22-alpine`, no compress middleware on SSE routes, no public-internet exposure, never shared `/models` tree across runtimes)
- `CLAUDE.md` — full stack spec including:
  - §"Core Technologies — Inference Layer" — llama.cpp image (`ghcr.io/ggml-org/llama.cpp:server-cuda` pinned)
  - §"Model formats per runtime" — GGUF flag set (`--n-gpu-layers 99`, `--ctx-size` / `--parallel` relationship), Q4_K_M / Q5_K_M sizing for 16 GB
  - §"Compose snippet — full stack skeleton" — reference compose layout
  - §"Stack Patterns by Variant" — explicit mention of `mostlygeek/llama-swap` as the multi-GGUF solution (currently deferred per D-A1)
  - §"What NOT to Use" — `:latest` tags, `--gpus all`, shared `/models` volume, multiple vLLM instances on one GPU

### Research (READ BEFORE PLANNING)
- `.planning/research/SUMMARY.md` §"Phase 3" (the multi-backend-dispatch / registry-hardening section if present) — phase rationale + MVP definition
- `.planning/research/STACK.md` §"Core Technologies — Inference Layer" — image pins, GGUF flags, VRAM tuning advice
- `.planning/research/STACK.md` §"Model formats per runtime — what to actually download" §llama.cpp-server — recommended quants for 16 GB, the "one server = one model" rule informing D-A1
- `.planning/research/STACK.md` §"Streaming gotchas — Fastify + SSE" — abort/heartbeat patterns Phase 2 already implements; Phase 3's new code (probes, queue) MUST NOT regress them
- `.planning/research/PITFALLS.md` Pitfall 2 — `:latest` tag drift (enforces D-A4 build-tag pinning)
- `.planning/research/PITFALLS.md` Pitfall 3 — VRAM thrashing / OLLAMA_NUM_PARALLEL (informs D-B3 default of 2)
- `.planning/research/PITFALLS.md` Pitfall 11 — models-volume layout (informs D-A8 — never share `/models` across runtimes)
- `.planning/research/ARCHITECTURE.md` §"four networks (not one)" — llama.cpp joins `backend` only

### Existing router code (read before editing)
- `router/src/backends/adapter.ts` — `BackendAdapter` interface + `AdapterFactory` (Phase 3 adds `probeLiveness` to the interface)
- `router/src/backends/ollama-openai.ts` — reference impl; `LlamacppOpenAIAdapter` parallels this exactly with a different `baseURL`
- `router/src/config/registry.ts` — zod schema + `RegistryStore` + `watchRegistry` hot-reload (Phase 3 widens enum, tightens validation, adds VRAM-envelope refinement)
- `router/src/routes/healthz.ts` — pattern for unauthenticated routes; Phase 3 adds `/readyz` and `/v1/models` next to it (`/readyz` joins the public skip-list; `/v1/models` does NOT)
- `router/src/auth/bearer.ts` — public-path skip-list (Phase 3 extends to include `/readyz`)
- `router/src/routes/v1/chat-completions.ts` — Phase 3's concurrency cap acquires before adapter call; reuses the existing error envelope + abort wiring untouched
- `router/src/errors/envelope.ts` — Phase 3 adds a `BackendSaturatedError` (or similar) that maps to HTTP 429 + `Retry-After`
- `router/models.yaml` — Phase 3 adds the second model entry (qwen2.5-7b-instruct-q4km) + populates `capabilities`, `vram_budget_gb`, `concurrency`, `profile` for both entries
- `compose.yml` — Phase 3 adds `llamacpp` service, gives existing `ollama` service `profiles: [ollama]`, leaves router/preflight profile-less
- `bin/smoke-test-router.sh` — Phase 3 extends with the SC1 multi-backend dispatch section
- `README.md` — Phase 3 adds the manual GGUF download step + `--profile` operational notes

### External docs (verify still current at planning time)
- llama.cpp server docs — `https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md` (`/v1/models`, `/v1/chat/completions`, `/metrics`, runtime flags)
- llama.cpp Docker images on GHCR — `https://github.com/ggml-org/llama.cpp/pkgs/container/llama.cpp` (current `server-cuda-bXXXX` tags)
- bartowski Qwen2.5-7B-Instruct GGUF repo — `https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF` (Q4_K_M variant; verify filename + checksum at planning time)
- huggingface-cli download docs — `https://huggingface.co/docs/huggingface_hub/en/guides/download` (the `huggingface-cli download <repo> <filename> --local-dir ... --local-dir-use-symlinks False` pattern)
- Docker Compose profiles docs — `https://docs.docker.com/compose/profiles/` (semantics for opt-in services; `--profile` flag behavior)
- OpenAI `/v1/models` reference — `https://platform.openai.com/docs/api-reference/models/list` (canonical shape that D-C1 extends)
- Fastify v5 hooks + reply lifecycle — `https://fastify.dev/docs/v5/Reference/Hooks/` (for the per-request semaphore-acquire pattern)
- Kubernetes Pod-Readiness conventions — `https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/` (the strict-all aggregation in D-D4 mirrors `readinessProbe` semantics)

### Image / package pins relevant to this phase
- `ghcr.io/ggml-org/llama.cpp:server-cuda-bXXXX` — pin to a specific build at planning time. NEVER `:latest`. CUDA 12 variant.
- `ollama/ollama:0.5.7` — UNCHANGED from Phase 1; Phase 3 only adds a `profiles: [ollama]` key on the Compose service
- `nvidia/cuda:12.6.0-base-ubuntu24.04` — UNCHANGED preflight image
- `node:22-bookworm-slim` — UNCHANGED router runtime image
- Router npm deps: NO new top-level deps required for Phase 3 (everything is in-process logic on top of existing `openai`, `zod`, `fastify`, `pino`). If the planner picks `p-limit` for the semaphore: pin `^6.x` (ESM-native, types built-in).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`router/src/backends/adapter.ts`** — `BackendAdapter` interface + `AdapterFactory` already exist (Phase 2 D-B2). Phase 3 widens the interface with `probeLiveness(signal): Promise<void>` and adds `LlamacppOpenAIAdapter` alongside `OllamaOpenAIAdapter`. The route handler in `chat-completions.ts` types its `BackendAdapter` arg generically — zero changes needed there for SC1.
- **`router/src/backends/ollama-openai.ts`** — exact template for `LlamacppOpenAIAdapter`. Same `openai` SDK pattern, same `stream_options.include_usage: true`, same abort signal wiring; only `baseURL` differs.
- **`router/src/config/registry.ts`** — `models.yaml` schema already declares the forward-compat fields (`capabilities`, `vram_budget_gb`, `concurrency`, `max_model_len`, `profile`) per D-B4 of Phase 2; Phase 3 tightens them (D-E1) without breaking the schema. `watchRegistry` hot-reload already exists with the "keep previous on error" semantic D-E2 step 4 leans on.
- **`router/src/auth/bearer.ts`** — public-path skip-list pattern already established (Phase 2: `/healthz`). Phase 3 adds `/readyz` to the list.
- **`router/src/sse/heartbeat.ts` + `sse/stream.ts`** — streaming infra unchanged; the new semaphore wraps OUTSIDE the SSE plumbing (acquire before adapter call, release on stream end / abort / error).
- **`bin/smoke-test-router.sh`** — Phase 2 script with section pattern; Phase 3 adds a "Multi-backend dispatch" section.
- **`bin/smoke-test-gpu.sh`** — Phase 1 script; reusable pattern for the `docker compose exec llamacpp` + nvidia-smi assertion if Phase 3 wants to verify GPU-resident inference on llama.cpp (recommended).
- **`bin/preflight-gpu.sh`** — Phase 1 script; UNCHANGED. llama.cpp depends on `gpu-preflight` via Compose, same as Ollama.
- **`bin/gpu-init-libcuda.sh`** — Phase 1 wrapper that handles the WSL2 libcuda projection. Reusable as-is for llama.cpp's entrypoint (it just sets up the symlink then execs the original entrypoint — backend-agnostic).
- **`compose.yml`** — single-file policy from D-12 of Phase 1; Phase 3 appends `llamacpp` service, adds `profiles:` to `ollama`, leaves everything else. No `compose.dev.yml` / `compose.gpu.yml` split.
- **`.env.example`** — no new top-level vars required for Phase 3 (the GGUF path is derived from `HOST_DATA_ROOT`). Planner may optionally add `VRAM_ENVELOPE_GB=16` per D-E3.

### Established Patterns
- **Pinned image tags everywhere** — `:server-cuda-bXXXX` for llama.cpp; never `:latest` (standing anti-pattern; STATE.md).
- **`bin/*.sh` as canonical entrypoints** — Phase 3 reuses for smoke-tests; never invents new entrypoint conventions.
- **`/srv/local-llms/` as canonical data root** — Phase 3's GGUF lives under `models-gguf/gguf/` (D-A8); Ollama blobs stay isolated in `models-gguf/ollama/`.
- **`depends_on: gpu-preflight: condition: service_completed_successfully`** for every GPU service — llama.cpp inherits.
- **`x-gpu` YAML anchor** — referenced via `<<: *gpu` on the new `llamacpp:` service.
- **Public-without-auth = small explicit skip-list** — `/healthz`, `/readyz` (new in Phase 3). Everything else requires bearer.
- **OpenAI-shape error envelope on OpenAI routes** (D-C1 of Phase 2) — extended in Phase 3 with `type: "rate_limit_error", code: "backend_saturated"` for the queue-timeout 429 case.
- **Fastify v5 conventions** — pass logger OPTIONS (not instance); zod type provider via `@bram-dc/fastify-type-provider-zod`; routes are pure functions registered against the typed instance.
- **vitest + msw integration tests** — Phase 3 extends with multi-backend stubs (one msw server per backend baseURL).

### Integration Points
- **`compose.yml`** — append `llamacpp` service:
  - `image: ghcr.io/ggml-org/llama.cpp:server-cuda-bXXXX` (pinned at planning time)
  - `profiles: [llamacpp]`
  - `<<: *gpu` + `depends_on: { gpu-preflight: { condition: service_completed_successfully } }`
  - `entrypoint: ["/usr/local/bin/gpu-init-libcuda.sh"]` + `command: ["--server", "-m", "/models/<file>.gguf", "--host", "0.0.0.0", "--port", "8080", "--n-gpu-layers", "99", "--ctx-size", "16384", "--parallel", "2", "--metrics"]` (exact command-line per llama.cpp docs at planning time)
  - `networks: [backend]` (NO host port — D-A6)
  - `volumes: ["${HOST_DATA_ROOT}/models-gguf/gguf:/models:ro", "./bin/gpu-init-libcuda.sh:/usr/local/bin/gpu-init-libcuda.sh:ro"]`
  - `healthcheck: curl http://localhost:8080/health` (llama.cpp-server ships curl in its base image — verify at planning time; if not, use the same `node -e fetch` pattern as the router OR a llama-cpp-cli probe)
- **`compose.yml`** — modify existing `ollama` service: add `profiles: [ollama]`. Nothing else changes.
- **`router/src/backends/llamacpp-openai.ts`** (new) — parallels `ollama-openai.ts`. Exports `LlamacppOpenAIAdapter` + `makeLlamacppAdapterFromEntry`.
- **`router/src/backends/adapter.ts`** — extend `BackendAdapter` with `probeLiveness(signal): Promise<void>`. Update both `OllamaOpenAIAdapter` and `LlamacppOpenAIAdapter` (and the planned Phase 8 `OllamaCloudAdapter`).
- **`router/src/backends/factory.ts`** (new) — `makeAdapter(entry: ModelEntry): BackendAdapter` lookup by `entry.backend`. The route handler imports this instead of importing `makeOllamaAdapterFromEntry` directly. `app.ts` plumbs it as the default `makeAdapter` factory.
- **`router/src/config/registry.ts`** — widen `backend` enum, tighten `capabilities`/`vram_budget_gb` to required, add the VRAM-envelope refinement (sum per backend ≤ `VRAM_ENVELOPE_GB`).
- **`router/src/routes/v1/models.ts`** (new) — `GET /v1/models`, gated by bearer auth, returns the D-C1 shape.
- **`router/src/routes/readyz.ts`** (new) — `GET /readyz`, public, reads probe cache, aggregates per D-D4/D-D5.
- **`router/src/backends/liveness.ts`** (new) — the probe scheduler: registers `setInterval` per distinct backend URL on registry load + on hot-reload, exposes the cache to `/readyz`, exposes a `stop()` for shutdown.
- **`router/src/concurrency/semaphore.ts`** (new) — per-backend semaphore + bounded-wait queue. Used by the route handler to wrap the adapter call.
- **`router/src/routes/v1/chat-completions.ts`** — small surgical change: `await semaphore.acquire(backend, queueTimeout)` before `adapter.chatCompletions(...)`; release in finally. Queue-timeout error maps to 429 via the existing error envelope (with the new `BackendSaturatedError`).
- **`router/src/auth/bearer.ts`** — add `/readyz` to public-path skip-list (it already exempts `/healthz`).
- **`router/src/app.ts`** — register the new routes; pass the new factory; wire the liveness scheduler with `app.addHook('onClose', () => liveness.stop())`.
- **`router/models.yaml`** — add second model entry (`qwen2.5-7b-instruct-q4km` :: `llamacpp`). Populate `capabilities` and `vram_budget_gb` on both. Optional new top-level `backends:` section with `concurrency` + `queue_max_wait_ms` per backend (planner's call).
- **`router/tests/integration/`** — add `models.endpoint.test.ts`, `readyz.test.ts`, `concurrency.test.ts`. Extend `chat-completions.*.test.ts` with the llama.cpp factory path.
- **`bin/smoke-test-router.sh`** — extend with the multi-backend dispatch section (D-F1).
- **`README.md`** — append "Phase 3: multi-backend dispatch" section with the manual GGUF download step + `--profile` operational notes + `/readyz` semantic explanation.

</code_context>

<specifics>
## Specific Ideas

- **Exact filename for the Qwen2.5 GGUF:** the recommended file from bartowski's repo at planning time is the Q4_K_M variant (the file naming convention is `Qwen2.5-7B-Instruct-Q4_K_M.gguf`). Planner verifies at `https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/tree/main`. Document the exact filename + SHA in the README so future deploys are reproducible.
- **`models.yaml` second entry shape** (planner refines):
  ```yaml
  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5-7b-instruct-q4_K_M    # whatever llama.cpp-server reports on /v1/models for this GGUF; verify empirically
    capabilities: [chat, tools]
    vram_budget_gb: 6                            # 4.4 GB model weights + KV cache headroom
    concurrency: 2
    max_model_len: 8192                          # per-slot context = --ctx-size / --parallel = 16384/2 = 8192
    profile: llamacpp
  ```
- **The Phase 2 first entry** (`llama3.2:3b-instruct-q4_K_M`) gets its forward-compat fields filled in: `capabilities: [chat]`, `vram_budget_gb: 4`, `concurrency: 2`, `profile: ollama`.
- **Optional new `backends:` section** in `models.yaml` (planner picks shape):
  ```yaml
  backends:
    ollama:
      base_url: http://ollama:11434/v1
      concurrency: 2
      queue_max_wait_ms: 30000
    llamacpp:
      base_url: http://llamacpp:8080/v1
      concurrency: 2
      queue_max_wait_ms: 30000
  ```
  This lets per-backend tuning live in one place independent of per-model entries. Per-model `backend_url` can become optional (fall back to `backends[name].base_url`). Planner picks whether to introduce this now or defer.
- **`/readyz` HTTP semantics:** 200 = ready (Content-Type: application/json, body per D-D4); 503 = not-ready (same Content-Type, same body shape). NEVER 204 (a body is the point).
- **Probe transition log shape:** `{ event: 'backend_liveness', backend: 'ollama', previous: 'down', current: 'alive', latency_ms: 8 }` at info; sustained-down stays at debug (don't spam). Specifics for the planner.
- **Smoke-test profile-swap pattern:**
  ```bash
  docker compose --profile ollama up -d
  # ... assertions ...
  docker compose --profile ollama down
  docker compose --profile llamacpp up -d
  # ... assertions ...
  ```
  Make sure `docker compose down` includes the right `--profile` (or `--remove-orphans`) so the previous profile's containers are actually torn down.
- **VRAM-envelope error message shape:** `Config error: backend "llamacpp" declared models sum to 18.5 GB, exceeds VRAM_ENVELOPE_GB=16. Reduce vram_budget_gb on one or more entries.` Specific enough that the user knows what to fix.

</specifics>

<deferred>
## Deferred Ideas

- **Multi-GGUF llama.cpp / llama-swap proxy** — defer until the user actually wants ≥2 GGUFs hot or rapidly-swappable. Phase 3 SC1 only needs ONE llamacpp model. When the time comes: introduce `mostlygeek/llama-swap` as a Compose service that fronts N llama.cpp instances; `models.yaml` entries point at the proxy URL; the registry seam absorbs the change with zero router-code edits.
- **Per-model concurrency cap** (D-B6 accepts-but-ignores the field) — Phase 7 will turn this on when one vLLM serves embeddings + chat with very different per-request costs. Until then, per-backend is sufficient.
- **Runtime / live VRAM measurement + eviction** — `VRAM-01` in v2 backlog. Phase 3 trusts declared `vram_budget_gb`. Re-evaluate when the user hits real "I tried to load too much and Ollama OOM'd" moments.
- **Profile-aware `/readyz` filtering** — the user rejected this in favor of strict "all declared backends must be alive". If operational friction with `/readyz: 503` under one-profile-at-a-time becomes painful, revisit: add `ACTIVE_PROFILE` env var; filter probe set; document the coupling.
- **`X-Model-Backend` response header** — ROUTE-10; Phase 8. Once it lands, agents can confirm which backend served without parsing `/v1/models`.
- **`Idempotency-Key` request header** — ROUTE-12; Phase 8.
- **Anthropic surface** — `/v1/messages` + tool calling translation + vision — Phase 4. Phase 3's `BackendAdapter` widening (with `probeLiveness`) is forward-compat for Phase 4's adapter additions; nothing prevents Phase 4 from extending the adapter again.
- **Prometheus `/metrics` on the router** — OBS-01; Phase 5. Phase 3's concurrency / queue / probe events will be natural metrics; track them now via pino logs, expose via Prometheus later.
- **vLLM AWQ backend** — BCKND-03; Phase 7. The `--gpu-memory-utilization` static-partition strategy (vs Phase 3's "one backend hot at a time") means vLLM will require a different operational story or, more likely, a per-deploy profile selector.
- **Per-backend circuit breaker** (CLOUD-03; Phase 8) — Phase 3 has the per-backend probe seam; a circuit breaker is a small layer on top (failure count, cooldown timer). Phase 8 lands it.
- **Open WebUI** — Phase 6. Open WebUI will hit `/v1/models` to populate its model picker — the Phase 3 shape (D-C1) is forward-compat with Open WebUI's expectation.
- **`huggingface-cli` baked into a bin script** (e.g., `bin/pull-gguf.sh`) — user picked the manual / one-off route. If GGUF management becomes routine, lift it into a bash helper later.
- **Probe-driven per-model availability flagging in `/v1/models`** — currently strict OpenAI-shape (D-C4 lists all registered). If the user's agents start frequently calling models whose backend is down, consider adding an opt-in `?filter=alive` query param. Defer.

</deferred>

---

*Phase: 3-Multi-Backend Dispatch — llama.cpp + Registry Hardening*
*Context gathered: 2026-05-12*
