# Phase 7: Embeddings + vLLM + GPU Telemetry — Research

**Researched:** 2026-05-16
**Domain:** vLLM AWQ on RTX 5060 Ti (Blackwell sm_120) under WSL2, OpenAI `/v1/embeddings` surface, Prometheus + Grafana observability, GPU exporter
**Confidence:** HIGH on stack pins, tool-call parser, Prometheus/Grafana schemas, GPU exporter; **MEDIUM on the locked vLLM image tag** (sm_120 prebuilt-wheel risk — see Pitfall V-1 below)

---

## Summary

Phase 7 lands the embedding endpoint and vLLM AWQ backend on a 16 GB RTX 5060 Ti running through WSL2, with Prometheus + Grafana auto-provisioned for observability. Six of the seven open ⚠ research items close with verified 2026 answers; one — the vLLM Blackwell sm_120 prebuilt-image risk — has a binary outcome the operator must run a 5-minute smoke test to verify (and a documented escape route if the locked image fails).

**Primary recommendation:** Implement Phase 7 against the locked stack pins, but add a **Wave 0 smoke task** that brings up vLLM with the locked image and asserts `nvidia-smi` shows the vLLM process consuming VRAM (i.e., a real CUDA kernel ran). If the smoke task fails with "no kernel image is available", fall back to `vllm/vllm-openai:v0.21.0-cu129-ubuntu2404` (published 2026-05-15) which ships with the post-#35432 Blackwell fix per the v0.21.0 release notes' explicit Blackwell hardware section. Do not block the phase on a `:latest` or nightly build — pin one or the other deterministically before merging.

**Closed research items:**
1. D-B5 vLLM multi-model strategy → **(a) separate `vllm-embed` container** (verified vLLM cannot host generation + pooling in one process).
2. Tool-call parser → **`hermes`** (canonical for Qwen2.5 per vLLM official docs; `qwen2_5` does not exist).
3. AWQ Marlin on sm_120 → **works**, but requires verifying the image's PyTorch wheel includes sm_120; falls back to `--quantization awq` (non-Marlin Triton path) if Marlin fails.
4. Prometheus v3 scrape config → **schema unchanged from v2**; same `static_configs.targets` shape.
5. Grafana provisioning → **`apiVersion: 1`** for both datasources and dashboards (verified against 11.x + 13.x docs).
6. `nvidia_gpu_exporter` WSL2 → **works**, but requires explicit `libnvidia-ml.so` + `nvidia-smi` bind-mounts (the `x-gpu` anchor alone is insufficient — DCGM-style passthrough doesn't apply).
7. Qwen2.5-7B-Instruct-AWQ tool-call stability → **stable with `hermes` parser**; one known stream-mode quirk patched in v0.20.x.

---

## User Constraints (from CONTEXT.md)

### Locked Decisions

**vLLM backend (BCKND-03):**
- **D-A1:** vLLM image `vllm/vllm-openai:v0.20.2-cu129-ubuntu2404` (planner verifies sm_120 — see Pitfall V-1)
- **D-A2:** Model `Qwen/Qwen2.5-7B-Instruct-AWQ`
- **D-A3:** Flags `--model Qwen/Qwen2.5-7B-Instruct-AWQ --quantization awq_marlin --max-model-len 8192 --gpu-memory-utilization 0.45 --enable-auto-tool-choice --tool-call-parser hermes` (parser CLOSED below)
- **D-A4:** `ipc: host`, `shm_size: 16gb`, `x-gpu` anchor, healthcheck `start_period: 600s`
- **D-A5:** Compose `profiles: [vllm]` — default profile keeps Ollama hot
- **D-A6:** vLLM on `backend` + `app` (HF cache pulls); NOT `webui-app`
- **D-A7:** HF cache at `${HOST_DATA_ROOT}/models-hf/:/root/.cache/huggingface/`; HF_TOKEN optional
- **D-A8:** `LocalBackendEnum` widens to `ollama | llamacpp | vllm`; new schema fields `vllm_max_model_len`, `vllm_gpu_memory_utilization`

**Embeddings (OAI-02, EMBED-01):**
- **D-B1:** New route `POST /v1/embeddings` mirroring chat-completions.ts
- **D-B2:** `bge-m3-ollama` (Ollama) + `bge-m3-vllm` (vLLM `BAAI/bge-m3`)
- **D-B3:** Capability gating reuses `CapabilityNotSupportedError`
- **D-B4:** `GET /v1/models` reflects new entries
- **D-B5:** vLLM multi-model strategy — **CLOSED below: (a) separate `vllm-embed` container**

**GPU exporter (OBS-03):**
- **D-C1..D-C4:** `utkuozdemir/nvidia_gpu_exporter:1.3.0` on `backend` network; port 9835; needs `x-gpu` anchor

**Prometheus + Grafana (OBS-02, OBS-04):**
- **D-D1..D-D8:** Prometheus v3.x + Grafana 11.x; scrape router/vllm/llamacpp/gpu; declarative provisioning; Traefik basic-auth at edge; Grafana on `chat.<tailnet>.ts.net`-style Tailscale Serve hostname

**Single-backend-hot policy (BCKND-04):**
- **D-E1..D-E3:** VRAM envelope continues; vLLM under `profiles: [vllm]`

### Claude's Discretion
- Exact vLLM image patch within v0.20.2-cu129 (or v0.21.0 fallback per Pitfall V-1)
- Prometheus + Grafana minor pins at planning time (current pins below)
- vLLM embeddings architecture — CLOSED: separate `vllm-embed` container
- Tool-call parser — CLOSED: `hermes`
- Grafana dashboard JSON exact panel layout (5 panel types from SC4 are MUST)
- README Phase 7 section content + healthcheck retries/interval tuning

### Deferred Ideas (OUT OF SCOPE)
- EMBED-02 Ollama Cloud `/v1/embeddings` passthrough → Phase 8
- `X-Model-Backend` response header → Phase 8 (ROUTE-10)
- `Idempotency-Key` → Phase 8
- Valkey-backed embedding cache → Phase 8 (when Valkey lands)
- Grafana alerting rules → Phase 9 / v2 (ALERT-01)
- Loki / OTel traces → v2 (LOG-01, TRACE-01)
- HF_TOKEN for gated models (Qwen 7B AWQ is public) — declared empty in `.env`
- Multi-GPU / NVLink — single-GPU stack
- vLLM speculative decoding / LoRA — not v1
- `bin/gc-models.sh`, off-host backup, disk alert → Phase 9

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **BCKND-03** | vLLM serves at least one HF AWQ model with `--max-model-len` + `--gpu-memory-utilization 0.45` + `ipc: host` + `shm_size: 16gb` | Standard Stack §vLLM; D-A1..D-A8; Validated Code Snippets §vLLM Compose service |
| **OAI-02** | `/v1/embeddings` works against Ollama embed model AND vLLM embed model | Standard Stack §Embeddings; Validated Code Snippets §Router embeddings route; D-B1..D-B5 |
| **EMBED-01** | `/v1/embeddings` works against Ollama embedding models AND a vLLM-served embedding model | Same as OAI-02; verified BAAI/bge-m3 + vLLM serving path via `--runner pooling` |
| **OBS-02** | vLLM `/metrics` AND llama.cpp `/metrics` scraped by Prometheus | Standard Stack §Prometheus; vLLM exposes Prometheus format at `/metrics` natively; llama.cpp-server's `--metrics` flag already enabled in compose.yml line 195 |
| **OBS-03** | GPU exporter running and scraped | `utkuozdemir/nvidia_gpu_exporter` §Standard Stack; Validated Code Snippets §nvidia_gpu_exporter Compose service |
| **OBS-04** | Grafana dashboard shows VRAM, request rate, ttft, error rate, backend selection | Standard Stack §Grafana 11.x; Validated Code Snippets §Grafana provisioning files |
| **OBS-05** (partial, Phase 5 covered most) | vLLM healthcheck contributes | D-A4 healthcheck verified against vLLM `/health` endpoint behavior |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| AWQ chat inference (Qwen2.5-7B) | API / Backend (vLLM) | — | GPU-bound inference owned by the runtime tier |
| AWQ embedding inference (BAAI/bge-m3) | API / Backend (vllm-embed) | — | Same tier; separate process per CLOSED D-B5 |
| Embedding endpoint surface (`/v1/embeddings`) | API / Backend (router) | — | Router owns the protocol surface, dispatches by registry; existing Phase 2/3 pattern unchanged |
| OpenAI ↔ vLLM translation | API / Backend (router → VLLMOpenAIAdapter) | — | vLLM serves OpenAI-compatible `/v1/...`; thin adapter |
| Backend selection / VRAM gating | API / Backend (router registry) | — | models.yaml superRefine + capability gating; no client/edge involvement |
| Metrics scrape | Database / Storage (Prometheus) | API / Backend (router, vllm, llamacpp, gpu-exporter expose) | Pull-model; Prometheus owns the time-series persistence |
| Metrics visualization | Frontend Server (Grafana) | Database / Storage (Prometheus query backend) | Grafana renders + queries; Prometheus is the data source |
| Edge exposure of Grafana | CDN / Edge (Traefik) | Frontend Server (Grafana) | Traefik does TLS + basic-auth; Grafana behind it |

---

## Standard Stack

### Core
| Library / Image | Version | Purpose | Why Standard |
|-----------------|---------|---------|--------------|
| `vllm/vllm-openai` | **`v0.20.2-cu129-ubuntu2404`** (locked) — fallback `v0.21.0-cu129-ubuntu2404` if sm_120 fails (see Pitfall V-1) | AWQ-quantized chat backend on Blackwell | [VERIFIED: `gh api repos/vllm-project/vllm/releases`] v0.20.2 published **2026-05-10**; v0.21.0 published **2026-05-15** with explicit Blackwell §"NVIDIA Blackwell: TOKENSPEED_MLA backend …" feature list |
| `Qwen/Qwen2.5-7B-Instruct-AWQ` | (HF model ID; pull at runtime) | Tool-calling AWQ chat model, ~4.5 GB weights | [CITED: docs.vllm.ai/en/stable/features/tool_calling.html] — "Qwen2.5 models (`Qwen/Qwen2.5-*`) support tool calls using the `hermes` parser" |
| `BAAI/bge-m3` | (HF model ID; pull at runtime) | 1024-dim multilingual embedding model, dual-backend (Ollama + vLLM) | [CITED: huggingface.co/BAAI/bge-m3] + [VERIFIED via Context7 vllm pooling_models/specific_models.md] — requires `--hf-overrides '{"architectures": ["BgeM3EmbeddingModel"]}'` for sparse/colbert weight loading |
| Ollama `bge-m3` (server-side tag) | bge-m3 in Ollama library | 1024-dim embedding via Ollama's OpenAI-compat `/v1/embeddings` shim | [CITED: ollama.com/library/bge-m3] — pull via `docker compose exec ollama ollama pull bge-m3` |
| `prom/prometheus` | **`v3.10.0`** (latest stable as of 2026-05-16) — `v3.11.x` exists per Docker Hub but `v3.10.0` is the GA release confirmed at prometheus.io | Time-series metrics scrape + storage | [VERIFIED: github.com/prometheus/prometheus/releases/tag/v3.10.0] published 2026-02-24; Docker tag `prom/prometheus:v3.10.0` |
| `grafana/grafana-oss` | **CONTEXT.md says 11.x; CURRENT STABLE is 13.0.1** as of 2026-05-16 (see Pitfall G-1) — recommend planner pin **`grafana/grafana-oss:12.4.3`** (the most-recent 12.x stable; conservative one-major-back from 13) | Dashboard visualization | [VERIFIED: hub.docker.com/r/grafana/grafana-oss/tags] — 13.0.1 latest; 12.4.3 prior stable; 11.x line is ~14 months old |
| `utkuozdemir/nvidia_gpu_exporter` | **`1.4.1`** (latest stable) — CONTEXT.md says `1.3.0`; recommend pin update (see Pitfall G-2) | nvidia-smi → Prometheus format on port 9835 | [VERIFIED: github.com/utkuozdemir/nvidia_gpu_exporter/releases] v1.4.1 published 2025-10-06; v1.3.0 from 2025-01-11 (14 months stale) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Router files (existing) | — | Reuse from Phases 2–5 | `recordOutcome.ts` (Phase 5), `factory.ts`, `adapter.ts`, `ollama-openai.ts` (template for VLLMOpenAIAdapter), `chat-completions.ts` (template for embeddings.ts) |
| `openai` Node SDK | `^6.x` (already in router) | Outbound client for vLLM OpenAI-compatible `/v1/...` | vLLM's `/v1/embeddings` is OpenAI-shape; `client.embeddings.create({model, input})` works identically against vLLM, Ollama, llama.cpp |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `vllm/vllm-openai:v0.20.2-cu129` | `vllm/vllm-openai:v0.21.0-cu129` (1 day newer, broader Blackwell) | v0.21.0 has 367 commits since v0.20.x — more surface for regression. Use ONLY if v0.20.2 smoke-test fails on sm_120 |
| `awq_marlin` quant kernel | `awq` (Triton path, non-Marlin) | Marlin is 1.5–2× faster but requires sm_120 kernel support; non-Marlin AWQ works on every CUDA-capable GPU at lower throughput |
| Single vLLM container multi-model | Separate `vllm` + `vllm-embed` | [VERIFIED] vLLM cannot host generation + pooling tasks in one process — `--runner pooling` is mutually exclusive with default generation runner. Must be two containers. |
| `utkuozdemir/nvidia_gpu_exporter:1.4.1` | `nvidia/dcgm-exporter` | DCGM is "official" but pulls libdcgm runtime which has known WSL2 incompatibilities (libdcgm dlopen fails on host-projected driver) |
| `prom/prometheus:v3.10.0` | `prom/prometheus:v2.55.x` | v2 is in maintenance only as of 2025-Q4. New deployments should use v3. |
| Grafana OSS | Grafana Enterprise | Enterprise needs license; OSS covers every panel/datasource we need |

**Installation (pin verification commands the planner runs at plan time):**
```bash
# Verify vLLM image still exists and is pullable (DOES NOT pull — just metadata)
curl -fsS "https://hub.docker.com/v2/repositories/vllm/vllm-openai/tags/v0.20.2-cu129-ubuntu2404/" | jq '.last_updated, .full_size'

# Verify Prometheus + Grafana + GPU exporter
curl -fsS "https://hub.docker.com/v2/repositories/prom/prometheus/tags/v3.10.0/" | jq '.last_updated'
curl -fsS "https://hub.docker.com/v2/repositories/grafana/grafana-oss/tags/12.4.3/" | jq '.last_updated'
curl -fsS "https://hub.docker.com/v2/repositories/utkuozdemir/nvidia_gpu_exporter/tags/1.4.1/" | jq '.last_updated'

# Verify Qwen2.5-7B-Instruct-AWQ HF model exists (HEAD request — no download)
curl -fsSI "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-AWQ/resolve/main/config.json" | head -1
curl -fsSI "https://huggingface.co/BAAI/bge-m3/resolve/main/config.json" | head -1
```

---

## Closure of ⚠ Research Items

### ⚠ R-1: D-B5 vLLM multi-model strategy — **CLOSED: (a) separate `vllm-embed` container**

**Verdict:** **A single vLLM 0.20.x / 0.21.x process CANNOT serve a generation model and a pooling/embedding model simultaneously.** Confirmed from two sources:

- [CITED: docs.vllm.ai/en/latest/models/pooling_models/embed/] — "use `--runner pooling` to indicate this is an embedding model rather than a generation model. There is no `--task` flag. **These are mutually exclusive configurations at startup, not features that can coexist within one process.**"
- [VERIFIED via Context7 `/websites/vllm_ai_en` pooling_models/README] — pooling models use a different model runner architecture (`AllPool.forward`); generation models use the V1/V2 engine. The two runners are not composable.

Therefore D-B5 is closed as **option (a)**: a separate Compose service `vllm-embed` running `vllm serve BAAI/bge-m3 --runner pooling --hf-overrides '{"architectures": ["BgeM3EmbeddingModel"]}' --gpu-memory-utilization 0.25 --max-model-len 8192`.

VRAM accounting (16 GB envelope):
- vLLM chat: 0.45 × 16 = 7.2 GB
- vLLM embed: 0.25 × 16 = 4.0 GB
- Ollama (when hot): up to 7 GB depending on loaded model
- **Total worst case when ALL three hot:** 7.2 + 4.0 + 7.0 = 18.2 GB ❌ — exceeds envelope.

**Mitigation:** vLLM-embed sits under `profiles: [vllm]` alongside vLLM-chat. When `--profile vllm` is active, the operator's mental model is "vLLM mode" — Ollama may still be running (default profile starts it) but `models.yaml` declares `bge-m3-ollama` as the always-on Ollama embedding option. Phase 7 documents in README that running BOTH Ollama-hot AND vllm + vllm-embed concurrently is a 2-of-3 choice (operator picks two), enforced softly via VRAM envelope warning at registry load.

[ASSUMED] VRAM budget for `bge-m3-vllm` is ~2.5 GB based on the bge-m3 model card weights (~1 GB FP16 + KV cache for max-model-len 8192 × small batch); the actual share depends on `--gpu-memory-utilization` which we set to 0.25 (4 GB pre-allocation). This needs runtime verification via `nvidia-smi` after vllm-embed first boot. Flag for confirmation in Phase 7 verification.

### ⚠ R-2: Tool-call parser flag for Qwen2.5 in vLLM 0.20.x — **CLOSED: `hermes`**

**Verdict:** `--tool-call-parser hermes`. There is no `qwen2_5` parser in the current vLLM tool_calling registry.

- [CITED: docs.vllm.ai/en/stable/features/tool_calling.html] — "For Qwen2.5, the chat template in tokenizer_config.json has already included support for the Hermes-style tool use. Therefore, you can use the `hermes` parser to enable tool calls for Qwen models."
- [VERIFIED via Context7 vllm/docs/features/tool_calling.md] — "Qwen2.5 models (`Qwen/Qwen2.5-*`) and `Qwen/QwQ-32B` support tool calls using the `hermes` parser."

A separate `qwen3_coder` parser exists for the newer Qwen3.6-27B-Coder family (per v0.21.0 release notes), and a community plugin `qwen2_5_coder_tool_parser.py` exists for Qwen2.5-**Coder** specifically. Neither applies to `Qwen/Qwen2.5-7B-Instruct-AWQ` — the instruct (non-Coder) Qwen2.5 family uses **`hermes`**.

**One known quirk** [CITED: github.com/vllm-project/vllm/issues/31871]: "Streaming mode with --tool-call-parser hermes returns raw text instead of parsed tool_calls" — this was a bug in vLLM 0.16.x and is fixed by v0.20.0. The locked v0.20.2 image is past the fix.

### ⚠ R-3: AWQ Marlin kernel compat with RTX 5060 Ti (sm_120 Blackwell) — **CONDITIONALLY CLOSED**

**Verdict:** **awq_marlin runs on sm_120 IF the vLLM image's PyTorch wheels include sm_120 kernels.** The v0.20.2-cu129-ubuntu2404 image was built before the PyTorch stable channel landed sm_120 wheels (PyTorch issue #164342 is still open as of 2026-05-16); the cu129 vLLM Docker base may or may not include the sm_120 PR backport.

Evidence:
- [CITED: discuss.vllm.ai field report] — One operator reports awq_marlin + TRITON_ATTN working on RTX 5060 Ti / WSL2, but with **vLLM 0.17.2rc1.dev + PyTorch 2.10.0+cu130 nightly**, NOT a stable cu129 image.
- [CITED: github.com/vllm-project/vllm/issues/35432] — Issue is CLOSED but only one comment ("must use CUDA 13.x"). The closure was likely "fixed in main"; the v0.20.2 image release notes do NOT explicitly call out sm_120 wheel inclusion.
- [CITED: github.com/vllm-project/vllm/releases/tag/v0.21.0] — Published 2026-05-15 (one day before this research), explicitly lists "NVIDIA Blackwell: TOKENSPEED_MLA backend ... faster per-token FP8 group quant packed kernel ... FP8 on NVIDIA Thor/SM110 ... CUTLASS scaled mm for non-compatible sizes" — Blackwell support is explicitly in scope.

**Risk classification:** MEDIUM. The locked image MAY work; smoke test required.

**Mitigation strategy (planner MUST encode in Wave 0):**

1. **Smoke task:** After bringing up the vLLM service with the locked image, send one tiny chat request (`max_tokens: 4`) and verify (a) HTTP 200, (b) `nvidia-smi` shows the vLLM process consuming VRAM, (c) `docker compose logs vllm` contains no `CUDA error: no kernel image is available for execution on the device` line.

2. **Fallback path A — try newer image:** If smoke fails, swap to `vllm/vllm-openai:v0.21.0-cu129-ubuntu2404` (published 2026-05-15 with explicit Blackwell scope). Same all-other-flags.

3. **Fallback path B — drop Marlin:** If both images fail with awq_marlin kernel errors specifically (but other operations succeed), swap `--quantization awq_marlin` for `--quantization awq` (Triton-based path, slower but kernel-agnostic). Also set `VLLM_FLASH_ATTN_VERSION=2` env var per the consistent community recommendation for Blackwell.

4. **Environment variables for the Compose service (defensive):**
   ```yaml
   environment:
     - VLLM_FLASH_ATTN_VERSION=2          # FA3 doesn't support Blackwell as of v0.21.0
     - VLLM_USE_TRITON_AWQ=1              # Forces Triton AWQ path if Marlin fails (community-verified for sm_120)
     # - TORCH_CUDA_ARCH_LIST=12.0         # Only set if building from source; not for prebuilt image
   ```
   Set these now (defensive), revisit at smoke-test time.

### ⚠ R-4: Prometheus v3.x scrape config syntax — **CLOSED: schema unchanged from v2**

**Verdict:** [CITED: prometheus.io/docs/prometheus/latest/configuration/configuration/ via WebFetch] "**No field names have changed** from v2 to v3. The core configuration parameters remain identical: `scrape_interval`, `evaluation_interval`, `scrape_configs`, `static_configs`, `targets`."

The CONTEXT.md skeleton (lines 273–284) is canonical-correct for v3.10. No migration needed.

Behavior changes v2→v3 (relevant but not blocking):
- Native histograms enabled by default (no impact — our metrics are classic histograms from prom-client).
- Remote-write protocol bumped (no impact — we don't remote-write).
- Scrape protocol negotiation tightened (no impact — vLLM, llama.cpp, router, nvidia_gpu_exporter all serve `text/plain; version=0.0.4` Prometheus format).

### ⚠ R-5: Grafana 11.x provisioning YAML schema — **CLOSED: `apiVersion: 1`**

**Verdict:** [CITED: grafana.com/docs/grafana/latest/administration/provisioning/ via WebFetch] — Datasources and dashboards both use `apiVersion: 1`. The schema has been stable across 10.x → 11.x → 12.x → 13.x.

Schema confirmed (see Validated Code Snippets §Grafana files below).

**Pitfall G-1 alert:** Grafana 11.x is OLD (~14 months) as of 2026-05-16. Current stable is 13.0.1; the most-recent 12.x patch is 12.4.3. Recommend planner upgrade the locked decision from `grafana-oss:11.x` to `grafana-oss:12.4.3` — provisioning schema is identical, and 12.x has the better Prometheus 3.x datasource plugin.

### ⚠ R-6: `nvidia_gpu_exporter` WSL2 access — **CLOSED with caveat**

**Verdict:** **Works on WSL2**, but the `x-gpu` anchor alone is **NOT sufficient**. The exporter needs explicit bind-mounts of `nvidia-smi` and `libnvidia-ml.so{,.1}` from the host into the container.

Evidence:
- [CITED: github.com/utkuozdemir/nvidia_gpu_exporter/blob/master/INSTALL.md] — official docs require:
  ```yaml
  devices:
    - /dev/nvidiactl:/dev/nvidiactl
    - /dev/nvidia0:/dev/nvidia0
  volumes:
    - /usr/lib/x86_64-linux-gnu/libnvidia-ml.so:/usr/lib/x86_64-linux-gnu/libnvidia-ml.so
    - /usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1:/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1
    - /usr/bin/nvidia-smi:/usr/bin/nvidia-smi
  ```

- **WSL2-specific note:** On WSL2 with Docker Desktop's GPU paravirtualization (GPU-PV), `nvidia-smi` and `libnvidia-ml.so` are projected from Windows into `/usr/lib/wsl/lib/` (NOT `/usr/lib/x86_64-linux-gnu/`). The bin/gpu-init-libcuda.sh script in this repo (Phase 1) already handles the symlink dance for CUDA workloads, but **the gpu-exporter needs the symlinked libnvidia-ml.so available at a stable path INSIDE the container**.

- Two implementation options for the planner:
  - **Option A (simpler):** Use the `x-gpu` anchor + rely on the NVIDIA Container Toolkit to project `nvidia-smi` and `libnvidia-ml.so` into the container's standard paths. This is the documented NCT behavior when the container declares `capabilities: [gpu, utility]` (the existing anchor already does this). Smoke test required — if `nvidia-smi` is not found, fall back to B.
  - **Option B (explicit):** Add the three INSTALL.md bind-mounts to the gpu-exporter service. Most portable; documented to work everywhere.

  **Recommend B.** It is the documented canonical path and matches the explicit, declarative compose.yml style this project uses.

**Pitfall G-2:** CONTEXT.md pins `1.3.0` (January 2025). v1.4.1 (October 2025) is the current stable. Recommend planner update the pin — the 1.4.x line includes a SIGTERM-handling fix relevant to clean Compose shutdown.

### ⚠ R-7: Qwen2.5-7B-Instruct-AWQ tool-call stability — **CLOSED**

**Verdict:** Stable with `hermes` parser as of vLLM 0.20.x.

- [CITED: docs.vllm.ai tool_calling — official] No outstanding tool-call bugs listed for Qwen2.5-Instruct (non-Coder) with hermes parser.
- The streaming bug (#31871) referenced earlier affects only vLLM 0.16.x — the locked v0.20.2 is past the fix.
- Phase 4 already validated round-trip tool_use/tool_result against Ollama and llama.cpp; the same canonical translation (`canonicalToOpenAIChatCompletionParams`) flows through to vLLM's OpenAI-compat surface unchanged.

**One operational note:** The `enable-auto-tool-choice` flag is required (already in D-A3) to allow the model to decide when to invoke a tool. Without it, only explicit `tool_choice: {type: "function", function: {name: ...}}` requests will produce tool calls.

---

## Runtime State Inventory

This is not a rename/refactor phase — Phase 7 adds new services and a new endpoint. No prior runtime state needs renaming.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — Phase 7 introduces 0 new DB tables; reuses Phase 5 `request_log` for embedding requests | None |
| Live service config | None — all new services declarative in compose.yml + provisioning files | None |
| OS-registered state | None — no host-level cron, systemd, or scheduled tasks | None |
| Secrets/env vars | NEW: `GRAFANA_ADMIN_PASSWORD` (required, generate with `openssl rand -hex 24`); NEW (optional): `HUGGINGFACE_HUB_TOKEN` (empty default; required only if planner adds a gated HF model later) | Add to `.env.example` with generation recipe; planner-discretion whether to wire the optional token now |
| Build artifacts / installed packages | None — no new router-side build outputs; new directory tree `prometheus/`, `grafana/provisioning/` ships as plain files | None |

---

## Architecture Patterns

### System Architecture Diagram (Phase 7 surface additions in **bold**)

```
                            ┌──────────────────────────────┐
                            │  Tailscale Serve (operator)  │ ◄── chat.<tn>.ts.net
                            │  router.<tn>.ts.net          │     grafana.<tn>.ts.net (new)
                            └──────────┬───────────────────┘
                                       │ HTTPS terminated
                                       ▼
                   ┌─────────────────────────────────────────┐
                   │  Traefik v3.7  (edge)                   │
                   │  - basic-auth middleware                 │
                   │  - metrics-blackhole @ /metrics          │
                   └────┬──────────┬─────────────────────────┘
                        │          │                       │
                   app  │          │ webui-app             │ app (new label)
                        ▼          ▼                       ▼
                ┌────────────┐ ┌──────────┐         ┌─────────────┐
                │  router    │ │ openwebui│         │  GRAFANA    │ (NEW)
                │  (Fastify) │ └──────────┘         │  (12.4.3)   │
                │            │                       └──────┬──────┘
                │ +/v1/embed │                              │ queries
                │   (NEW)    │                              ▼ (backend)
                └─────┬──────┘                       ┌────────────────┐
            backend  │                               │  PROMETHEUS    │ (NEW)
                     │                               │  v3.10.0       │
              ┌──────┴──────┬───────────┬────────┐   └──┬─┬─┬─┬───────┘
              ▼             ▼           ▼        ▼      │ │ │ │
        ┌──────────┐  ┌──────────┐ ┌────────┐ ┌───────┐ │ │ │ │
        │  ollama  │  │ llamacpp │ │  VLLM  │ │ VLLM- │ │ │ │ │
        │  (chat + │  │  (chat,  │ │  CHAT  │ │ EMBED │ │ │ │ │
        │   embed) │  │   tools) │ │  (NEW) │ │ (NEW) │ │ │ │ │
        │ bge-m3   │  │ Qwen2.5- │ │ Qwen2.5│ │ BAAI/ │ │ │ │ │
        │ +llama3+ │  │   GGUF   │ │ -7B-   │ │ bge-m3│ │ │ │ │
        │  vision  │  │          │ │  AWQ   │ │       │ │ │ │ │
        └────┬─────┘  └────┬─────┘ └───┬────┘ └───┬───┘ │ │ │ │
             │ /metrics    │ /metrics  │ /metrics │     │ │ │ │
             │             │           │ /metrics      │ │ │ │
             └─────────────┴───────────┴──────────────-┘ │ │ │
                                  data                   │ │ │
                                  ▲                      │ │ │
                                  │ scrape router:3000   │ │ │
                                  │ scrape llamacpp:8080 ┘ │ │
                                  │ scrape vllm:8000       │ │
                                  │ scrape vllm-embed:8000-┘ │
                                  │ scrape gpu_exporter:9835-┘
                                  │
                          ┌───────┴───────┐
                          │  NVIDIA_GPU_  │ (NEW)
                          │  EXPORTER     │
                          │  v1.4.1       │
                          │  (port 9835)  │
                          └───────┬───────┘
                                  │ /dev/nvidia* + nvidia-smi + libnvidia-ml.so
                                  ▼
                          ┌───────────────┐
                          │  HOST GPU     │
                          │  RTX 5060 Ti  │
                          │  (sm_120)     │
                          └───────────────┘
```

### Pattern: vLLM Adapter — mirror LlamacppOpenAIAdapter

**What:** New `VLLMOpenAIAdapter` class at `router/src/backends/vllm-openai.ts`, identical shape to `LlamacppOpenAIAdapter` (`router/src/backends/llamacpp-openai.ts`).

**When to use:** All vLLM-backed models in `models.yaml` route through this adapter via the `factory.ts` map.

**Example (template — planner fleshes out):**
```typescript
// router/src/backends/vllm-openai.ts
import OpenAI from 'openai';
import type { BackendAdapter } from './adapter.js';
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../translation/canonical.js';
import { canonicalToOpenAIChatCompletionParams } from '../translation/openai-in.js';
import { openAIChatCompletionToCanonical, openAIChunksToCanonicalEvents } from '../translation/openai-out.js';

export class VLLMOpenAIAdapter implements BackendAdapter {
  private readonly client: OpenAI;
  constructor(baseURL: string) {
    // baseURL example: 'http://vllm:8000/v1' or 'http://vllm-embed:8000/v1'
    this.client = new OpenAI({ baseURL, apiKey: 'vllm', timeout: 60_000 });
  }

  async chatCompletionsCanonical(canonical: CanonicalRequest, signal: AbortSignal): Promise<CanonicalResponse> {
    const openaiReq = canonicalToOpenAIChatCompletionParams(canonical);
    const result = await this.client.chat.completions.create(
      { ...openaiReq, stream: false, stream_options: { include_usage: true } },
      { signal },
    );
    return openAIChatCompletionToCanonical(result);
  }

  async chatCompletionsCanonicalStream(canonical: CanonicalRequest, signal: AbortSignal, opts?: { inputTokensHint?: number }): Promise<AsyncIterable<CanonicalStreamEvent>> {
    const openaiReq = canonicalToOpenAIChatCompletionParams(canonical);
    const upstream = await this.client.chat.completions.create(
      { ...openaiReq, stream: true, stream_options: { include_usage: true } },
      { signal },
    );
    return openAIChunksToCanonicalEvents(upstream, { model: canonical.model, inputTokensHint: opts?.inputTokensHint });
  }

  // NEW for Phase 7 — embeddings entry point. Mirrors chat-completions but non-streaming.
  // Used by router/src/routes/v1/embeddings.ts. NOT part of BackendAdapter base interface
  // unless the planner widens it; can also be a static helper called from the route.
  async embeddings(input: string | string[], model: string, signal: AbortSignal) {
    return this.client.embeddings.create({ model, input }, { signal });
  }

  async probeLiveness(signal: AbortSignal) {
    const t0 = Date.now();
    try {
      const res = await this.client.models.list({ signal } as Parameters<typeof this.client.models.list>[0]);
      const ok = Array.isArray(res.data) && res.data.length > 0;
      return { ok, latencyMs: Date.now() - t0, error: ok ? undefined : 'empty data array' };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
```

**Planner choice:** Whether to widen `BackendAdapter` with `.embeddings()` or keep it as a per-adapter static. Recommend **widen** — keeps the factory pattern uniform and makes Ollama's `/v1/embeddings` shim discoverable. The chat-completions surface is canonical-typed because of multi-protocol fan-out; embeddings is single-protocol so a thin `.embeddings()` returning the OpenAI SDK type is acceptable.

### Pattern: Per-backend Compose `profiles` — already established (Phase 3 D-04)

vLLM + vllm-embed both join `profiles: [vllm]`. Default `docker compose up -d` does NOT start them. Operator opts in with `--profile vllm`.

This matches the BCKND-04 + PROJECT.md "one backend hot at a time" policy. The Prometheus + Grafana services have NO profile — they're always-on (the dashboard is empty but Prometheus still scrapes router metrics, which is OBS-01 satisfaction continuing from Phase 5).

### Anti-Patterns to Avoid

- **Single vLLM container for chat + embed:** [CITED] vLLM cannot serve both task types in one process. Don't try; D-B5 (b) is unviable.
- **`--gpus all` flag on the GPU exporter:** the `--gpus all` Compose shorthand has been on the rejection list since Phase 1 (CLAUDE.md "What NOT to Use"). Use the `x-gpu` anchor + the three INSTALL.md bind-mounts.
- **Putting Prometheus on the `edge` network:** Prometheus is data-plane only — `backend` network. Grafana queries Prometheus via Docker DNS on `backend`. Edge exposure goes through Traefik to Grafana, never to Prometheus.
- **`compress` middleware on Grafana:** Grafana streams responses for live panels; a compress middleware buffers them and breaks live updates. Match Phase 6's discipline on `/v1/chat/completions` and apply it to Grafana too.
- **Bind-mounting `dashboards/` writable:** Grafana persists dashboard edits in the SQLite/Postgres backend. If the dashboards bind-mount is RW, Grafana periodically rewrites the JSON files in place and re-loads them. Mount the dashboards directory **read-only** so the JSON-in-git is the source of truth.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Embedding endpoint | Custom embedding logic in router | vLLM `/v1/embeddings` (OpenAI-compat) + OpenAI SDK `client.embeddings.create()` | vLLM's pooling runner handles batching, padding, model-specific pooling strategy; reinventing this for bge-m3's sparse/colbert weights is weeks of work |
| GPU metrics scraping | Custom `nvidia-smi` polling in router | `utkuozdemir/nvidia_gpu_exporter:1.4.1` | Stable Prometheus-format output, handles all the nvidia-smi quirks (multi-GPU, sm_120 driver projection on WSL2, processes-using-VRAM enumeration). Don't reinvent. |
| Dashboard rendering | Custom HTML/SVG metric pages | Grafana 12.4.3 | Provisioned dashboards reset on container restart, query Prometheus via PromQL, support every panel type SC4 demands. Building this is a phase of its own. |
| Prometheus scrape orchestration | Custom prom-client `/metrics` aggregator | Prometheus v3.10.0 with `scrape_configs` | The Prometheus scrape protocol is more than "GET /metrics" — it handles retries, target discovery, label re-writing, scrape duration histograms. Don't replicate. |
| Grafana auth | Custom JWT layer in front of Grafana | Traefik basic-auth middleware (`webui-basic-auth@docker`, same credential as Phase 6 OWUI) | The credential already exists in `.env` (`TRAEFIK_BASIC_AUTH`). Grafana also has its own admin user (`GRAFANA_ADMIN_PASSWORD`) for internal management — two layers is fine. |

**Key insight:** Every component Phase 7 introduces is shrink-wrapped Docker images with declarative config. There is zero hand-rolling. The router work is two files (`embeddings.ts`, `vllm-openai.ts`) and one models.yaml widening — no algorithmic new logic.

---

## Common Pitfalls

### Pitfall V-1: vLLM v0.20.2-cu129 may fail on RTX 5060 Ti sm_120 with "no kernel image is available"

**What goes wrong:** vLLM container starts, model loads, first request returns `RuntimeError: CUDA error: no kernel image is available for execution on the device` or vLLM exits with `NVIDIA GeForce RTX 5060 Ti with CUDA capability sm_120 is not compatible with the current PyTorch installation`.

**Why it happens:** The official `vllm/vllm-openai:v0.20.2-cu129-ubuntu2404` image bundles a specific PyTorch wheel. PyTorch stable cu129 wheels did not include sm_120 kernels until recently (issue pytorch/pytorch#164342 is still **OPEN** as of 2026-05-16). v0.20.2 was published 2026-05-10 — its base may have picked up the sm_120 fix or may not have.

**How to avoid (concrete):**
1. **Wave 0 smoke test** — bring up the vLLM service with the locked image; send one `max_tokens: 4` chat request; verify `nvidia-smi` shows the vLLM process; check `docker compose logs vllm` for any CUDA error string.
2. **Fallback A:** swap to `vllm/vllm-openai:v0.21.0-cu129-ubuntu2404` (published 2026-05-15, explicit Blackwell scope in release notes).
3. **Fallback B:** add env vars `VLLM_FLASH_ATTN_VERSION=2` and `VLLM_USE_TRITON_AWQ=1` to force the non-Marlin Triton path which the community has verified works on sm_120 (per discuss.vllm.ai field report on RTX 5060 Ti).
4. **Last resort:** swap `--quantization awq_marlin` → `--quantization awq` (slower but kernel-agnostic).

**Warning signs:**
- vLLM container restart-loops with `start_period: 600s` despite a valid model + HF cache.
- `nvidia-smi` inside the vLLM container shows the GPU but no vllm process consuming VRAM after a request.

**Phase to address:** Phase 7 (this phase) — Wave 0 smoke task is mandatory.

### Pitfall V-2: vLLM JIT compile makes first cold-start 5–15 minutes

**What goes wrong:** `docker compose --profile vllm up -d vllm` takes 10+ minutes to become healthy. Operator assumes deadlock and `docker compose down`. State is lost.

**Why it happens:** vLLM does torch.compile + CUDA graph capture on first model load. Even with a populated HF cache (D-A7 bind-mount pre-exists), the JIT step adds 3–10 minutes for a 7B AWQ model. The healthcheck `start_period: 600s` (D-A4) is correct — the operator just needs to be told.

**How to avoid:**
- Document in README Phase 7 section: "vLLM cold-start can take up to 10 minutes on first boot. Watch `docker compose logs -f vllm`; you'll see `Capturing CUDA graphs` progress."
- The healthcheck's 600s grace period is non-negotiable.

**Warning signs:** Container is "starting" in `docker ps` for many minutes. `docker compose logs vllm | grep -i "capturing CUDA"` shows progress.

### Pitfall V-3: vLLM-embed VRAM contention with vLLM-chat

**What goes wrong:** vLLM-chat is hot at 7.2 GB, operator brings up vllm-embed which pre-allocates 4 GB, then Ollama tries to load a 7 GB model — third container OOMs at model load.

**Why it happens:** Both vLLM containers pre-allocate VRAM at startup via `--gpu-memory-utilization`. The VRAM envelope (16 GB) is exceeded when all three runtimes are hot.

**How to avoid:**
- VRAM envelope superRefine on `models.yaml` extends to vLLM entries (D-E1). Sum per-backend, sum across backends-hot — registry should warn (not fail) at load time when sum > 16.
- README documents the 2-of-3 rule: `--profile vllm` + Ollama means embeddings via vLLM displaces some Ollama chat capacity. Switching to vLLM-only requires `docker compose stop ollama`.

### Pitfall G-1: Grafana 11.x is stale; use 12.4.3 or 13.0.1

**What goes wrong:** Operator installs Grafana 11.x as CONTEXT.md specifies; Prometheus 3.x datasource plugin in 11.x has known PromQL compat warnings for native histograms.

**How to avoid:** Pin `grafana/grafana-oss:12.4.3` (conservative one-major-back from current 13.0.1). Provisioning schema is identical across 11.x → 12.x → 13.x; no migration work.

### Pitfall G-2: nvidia_gpu_exporter 1.3.0 has unclean SIGTERM handling

**What goes wrong:** `docker compose down` takes 30s on the gpu-exporter container while Compose waits for graceful shutdown.

**How to avoid:** Pin `utkuozdemir/nvidia_gpu_exporter:1.4.1` (2025-10-06) — includes SIGTERM handler fix.

### Pitfall G-3: WSL2 nvidia-smi path mismatch

**What goes wrong:** GPU exporter container starts but `/metrics` returns no GPU rows; logs show `nvidia-smi: command not found` or `libnvidia-ml.so: cannot open shared object file`.

**Why it happens:** On WSL2 + Docker Desktop GPU-PV, the host's `nvidia-smi` is at `/usr/bin/nvidia-smi` (projected from Windows). On native Linux it's at the same path. But the libnvidia-ml.so location varies: `/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1` on native Ubuntu; `/usr/lib/wsl/lib/libnvidia-ml.so.1` on WSL2.

**How to avoid:** Use the explicit bind-mounts per INSTALL.md AND add a defensive fallback for the WSL2 path:
```yaml
volumes:
  - /usr/bin/nvidia-smi:/usr/bin/nvidia-smi:ro
  - /usr/lib/x86_64-linux-gnu/libnvidia-ml.so:/usr/lib/x86_64-linux-gnu/libnvidia-ml.so:ro  # may not exist on WSL2
  - /usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1:/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1:ro
```
On WSL2 with Docker Desktop, the NCT runtime already projects the WSL paths into the container's standard `/usr/lib/x86_64-linux-gnu/` so the standard mount works. If smoke fails, planner adds an explicit `/usr/lib/wsl/lib` bind-mount as a fallback.

### Pitfall P-1: Prometheus targets up but Grafana shows "no data"

**What goes wrong:** Prometheus `/targets` page shows all UP; Grafana panel queries `vllm_request_count_total` and shows "No data".

**Why it happens:** The Grafana datasource URL is `http://prometheus:9090` (Docker DNS on `backend`). If Grafana joined only the `app` network, this DNS resolution fails. Or: the dashboard JSON references a datasource by UID that doesn't match the provisioned datasource's UID.

**How to avoid:**
- Grafana joins **both `app` (Traefik edge discovery) and `backend` (talks to Prometheus)** per D-D6.
- Pin the datasource UID in `datasource.yml` (`uid: prometheus-default`) and reference that UID in the dashboard JSON.

### Pitfall P-2: Prometheus persistent volume permissions on first up

**What goes wrong:** Prometheus container exits immediately: `opening storage failed: permission denied`.

**Why it happens:** The `prom/prometheus` image runs as UID 65534 (nobody). The host bind-mount directory is owned by 0:0 (root).

**How to avoid:** README documents `sudo chown -R 65534:65534 ${HOST_DATA_ROOT}/prometheus`. Same pattern as Phase 5's pg-backup UID 70 chown documented in compose.yml. The bootstrap-host.sh script can be extended to create the directory with the right ownership.

### Pitfall E-1: Embeddings empty input

**What goes wrong:** Client posts `{"model": "bge-m3-ollama", "input": ""}`; Ollama returns 200 with embedding all zeros, OpenAI clients break parsing.

**Why it happens:** OpenAI spec requires `input` to be non-empty (string or non-empty array). Backends handle this inconsistently.

**How to avoid:** Zod schema on `embeddings.ts` rejects empty string + empty array at the route boundary, returns 400 with the standard `invalid_request_error` envelope. Pattern mirrors chat-completions's `messages: z.array(...).min(1)`.

### Pitfall E-2: Dimension drift between Ollama bge-m3 and vLLM bge-m3

**What goes wrong:** Client embeds the same string against both `bge-m3-ollama` and `bge-m3-vllm`; vectors have different dimensions (1024 vs 1536) or different cosine similarity to a known reference.

**Why it happens:** Ollama's bge-m3 pull is the **dense** path only (1024-dim). vLLM with `--hf-overrides '{"architectures": ["BgeM3EmbeddingModel"]}'` loads sparse + dense + colbert weights; the default `/v1/embeddings` returns dense only too (1024-dim), but the model object is larger.

**How to avoid:** Smoke test asserts BOTH backends return 1024-dim vectors for the same input. README documents which embedding head each backend exposes. Cross-validation in `bin/smoke-test-router.sh` (extend existing) checks `.data[0].embedding | length == 1024` against both models.

---

## Validation Architecture

> Per `.planning/config.json` workflow.nyquist_validation (absent = enabled).

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `vitest@^2.x` (already in `router/package.json`) |
| Config file | `router/vitest.config.ts` (existing) |
| Quick run command | `cd router && npm test` |
| Full suite command | `cd router && npm run test:run` |

For Compose-level smoke (out-of-band of router unit tests):
| Property | Value |
|----------|-------|
| Framework | bash scripts under `bin/` (existing Phase 2..6 pattern) |
| Quick smoke | `bin/smoke-test-router.sh` (extend with embeddings) |
| New smoke | `bin/smoke-test-observability.sh` (new — Prometheus targets + Grafana datasource health) |
| vLLM cold-start smoke | `bin/smoke-test-vllm.sh` (new — Pitfall V-1 verification) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| BCKND-03 | vLLM serves Qwen2.5-7B-AWQ with locked flags; cold-start under 600s; nvidia-smi shows process consuming VRAM | smoke (Compose) | `bin/smoke-test-vllm.sh` | ❌ Wave 0 |
| OAI-02 | `/v1/embeddings` returns 1024-dim vector for bge-m3-ollama | integration | `bin/smoke-test-router.sh` (extend with `/v1/embeddings` curl + `.data[0].embedding | length == 1024` jq assertion) | ✏️ extend existing |
| OAI-02 | `/v1/embeddings` returns 1024-dim vector for bge-m3-vllm | integration | same script, different model arg | ✏️ extend existing |
| OAI-02 (capability) | `/v1/embeddings` against a chat-only model returns 400 `model_capability_mismatch` | unit | `tests/routes/embeddings.test.ts` | ❌ Wave 0 |
| EMBED-01 | Both Ollama AND vLLM embedding models work in the same test run | integration | same script, both models | ✏️ extend existing |
| OBS-02 | Prometheus `up{job="vllm"} == 1` AND `up{job="llamacpp"} == 1` | smoke | `bin/smoke-test-observability.sh` (PromQL query via curl) | ❌ Wave 0 |
| OBS-03 | `up{job="gpu"} == 1` AND `DCGM_FI_DEV_FB_USED` (or `nvidia_smi_memory_used`) returns a numeric value | smoke | `bin/smoke-test-observability.sh` | ❌ Wave 0 |
| OBS-04 | Grafana `/api/datasources/proxy/uid/prometheus-default/api/v1/query?query=up` returns 200 | smoke (HTTP) | `bin/smoke-test-observability.sh` (curl through Traefik basic-auth) | ❌ Wave 0 |
| OBS-04 | Provisioned dashboard exists at `/api/dashboards/uid/local-llms` | smoke (HTTP) | same script | ❌ Wave 0 |
| BCKND-03 SC2 | `nvidia-smi` shows realistic VRAM usage (e.g. 7+ GB) when vLLM is hot | smoke | `bin/smoke-test-vllm.sh` (exec nvidia-smi in any GPU container) | ❌ Wave 0 |
| Phase SC5 | `request_log` contains rows where backend = 'ollama' and route = '/v1/embeddings', AND rows where backend = 'vllm' and route = '/v1/embeddings' | smoke (SQL) | `bin/smoke-test-router.sh` (extend with psql query) | ✏️ extend existing |

### Sampling Rate
- **Per task commit:** `cd router && npm test` (unit + integration, no Compose) — < 30 seconds.
- **Per wave merge:** `cd router && npm run test:run` + `bin/smoke-test-router.sh` (router-only flow) — < 2 minutes assuming vLLM already warm.
- **Phase gate:** Full vLLM cold-boot smoke (`bin/smoke-test-vllm.sh`) + observability smoke (`bin/smoke-test-observability.sh`) + extend `bin/smoke-test-router.sh` runs green. Allow up to 15 minutes for vLLM cold-start the very first time.

### Wave 0 Gaps
- [ ] `router/tests/routes/embeddings.test.ts` — covers OAI-02 capability gating + zod validation
- [ ] `router/src/routes/v1/embeddings.ts` — the actual route handler
- [ ] `router/src/backends/vllm-openai.ts` — the VLLMOpenAIAdapter
- [ ] `router/tests/backends/vllm-openai.test.ts` — adapter unit tests (mocked OpenAI client; mirror llamacpp-openai.test.ts)
- [ ] `bin/smoke-test-vllm.sh` — Pitfall V-1 verification: cold-start, chat smoke, nvidia-smi shows vllm process
- [ ] `bin/smoke-test-observability.sh` — Prometheus targets up + Grafana dashboard provisioned
- [ ] `prometheus/prometheus.yml` — scrape config
- [ ] `grafana/provisioning/datasources/datasource.yml`
- [ ] `grafana/provisioning/dashboards/local-llms.yml`
- [ ] `grafana/provisioning/dashboards/local-llms.json` — must contain 5 panels per SC4

---

## Validated Code Snippets

### vLLM (chat) Compose service block

```yaml
  # ── vLLM (chat, Phase 7 — BCKND-03, D-A1..D-A8) ──────────────────────────
  # Pinned to v0.20.2-cu129-ubuntu2404 per CONTEXT.md D-A1. Driver 595.97 ≥ 555.x for cu129.
  # If sm_120 prebuilt-wheel issue surfaces at smoke (Pitfall V-1), swap to v0.21.0-cu129-ubuntu2404.
  # `start_period: 600s` is non-negotiable — JIT compile + CUDA graph capture can be 10 min on first boot.
  vllm:
    image: vllm/vllm-openai:v0.20.2-cu129-ubuntu2404  # [VERIFIED 2026-05-16 — Pitfall V-1 fallback: v0.21.0-cu129-ubuntu2404]
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-vllm
    profiles: [vllm]
    <<: *gpu
    restart: unless-stopped
    ipc: host           # D-A4 — required for vLLM's NCCL + shared memory between worker procs
    shm_size: 16gb      # D-A4 — same rationale
    command:
      - --model=Qwen/Qwen2.5-7B-Instruct-AWQ
      - --quantization=awq_marlin            # [VERIFIED 2026-05-16 — Pitfall V-1 fallback: --quantization=awq]
      - --max-model-len=8192
      - --gpu-memory-utilization=0.45
      - --enable-auto-tool-choice
      - --tool-call-parser=hermes            # [CLOSED R-2: hermes is canonical for Qwen2.5-Instruct per docs.vllm.ai]
      - --served-model-name=Qwen/Qwen2.5-7B-Instruct-AWQ
    environment:
      # Defensive — see Pitfall V-1 fallback strategy
      - VLLM_FLASH_ATTN_VERSION=2
      # Optional, set only if smoke fails with Marlin kernel error:
      # - VLLM_USE_TRITON_AWQ=1
      # HF cache pinning
      - HF_HOME=/root/.cache/huggingface
      - HF_HUB_CACHE=/root/.cache/huggingface
    volumes:
      - ${HOST_DATA_ROOT:-/srv/local-llms}/models-hf:/root/.cache/huggingface
      - ./bin/gpu-init-libcuda.sh:/usr/local/bin/gpu-init-libcuda.sh:ro
    networks:
      - backend       # data plane to router (internal:true blocks egress; HF pull goes via `app`)
      - app           # HF cache pulls from huggingface.co (egress)
    healthcheck:
      # [VERIFIED] vLLM exposes /health returning 200 when model loaded & ready
      test: ["CMD-SHELL", "curl -fsS http://localhost:8000/health || exit 1"]
      interval: 30s
      timeout: 5s
      start_period: 600s   # D-A4 — JIT compile + CUDA graphs; do NOT reduce
      retries: 10
    depends_on:
      gpu-preflight:
        condition: service_completed_successfully
```

### vllm-embed Compose service block (CLOSED D-B5 option (a))

```yaml
  # ── vLLM (embed, Phase 7 — D-B2, D-B5(a)) ────────────────────────────────
  # Separate vLLM process serving ONLY BAAI/bge-m3. vLLM cannot serve generation + pooling
  # in one process (CLOSED R-1). Same image; --runner pooling + --hf-overrides.
  # Lower --gpu-memory-utilization (0.25) keeps embed share at ~4 GB so both vLLM containers
  # + Ollama can transiently coexist in VRAM during model swap windows.
  vllm-embed:
    image: vllm/vllm-openai:v0.20.2-cu129-ubuntu2404
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-vllm-embed
    profiles: [vllm]                     # [TRADE-OFF] vllm-embed joins the vllm profile so they brought up as a pair; planner may split if needed
    <<: *gpu
    restart: unless-stopped
    ipc: host
    shm_size: 8gb                         # smaller than chat — embed has no KV cache
    command:
      - --model=BAAI/bge-m3
      - --runner=pooling                  # [CLOSED R-1: --runner pooling, NOT --task]
      - --hf-overrides={"architectures":["BgeM3EmbeddingModel"]}   # required for sparse/colbert weight loading
      - --gpu-memory-utilization=0.25
      - --max-model-len=8192
      - --served-model-name=BAAI/bge-m3
      - --port=8000
    environment:
      - VLLM_FLASH_ATTN_VERSION=2
      - HF_HOME=/root/.cache/huggingface
      - HF_HUB_CACHE=/root/.cache/huggingface
    volumes:
      - ${HOST_DATA_ROOT:-/srv/local-llms}/models-hf:/root/.cache/huggingface
      - ./bin/gpu-init-libcuda.sh:/usr/local/bin/gpu-init-libcuda.sh:ro
    networks:
      - backend
      - app
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:8000/health || exit 1"]
      interval: 30s
      timeout: 5s
      start_period: 300s    # embed model is smaller; 5min start_period sufficient
      retries: 10
    depends_on:
      gpu-preflight:
        condition: service_completed_successfully
```

### nvidia_gpu_exporter Compose service block

```yaml
  # ── nvidia_gpu_exporter (Phase 7 — OBS-03, D-C1..D-C4) ───────────────────
  # Pin updated from CONTEXT.md 1.3.0 to 1.4.1 (Pitfall G-2 — SIGTERM fix).
  # Bind-mounts per INSTALL.md (Pitfall G-3 — WSL2 nvidia-smi path).
  # NOT using x-gpu anchor alone — explicit binds are the documented canonical path.
  nvidia_gpu_exporter:
    image: utkuozdemir/nvidia_gpu_exporter:1.4.1   # [VERIFIED 2026-05-16 — latest stable]
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-gpu-exporter
    restart: unless-stopped
    devices:
      - /dev/nvidiactl:/dev/nvidiactl
      - /dev/nvidia0:/dev/nvidia0
    volumes:
      - /usr/bin/nvidia-smi:/usr/bin/nvidia-smi:ro
      - /usr/lib/x86_64-linux-gnu/libnvidia-ml.so:/usr/lib/x86_64-linux-gnu/libnvidia-ml.so:ro
      - /usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1:/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1:ro
      # WSL2 fallback paths (uncomment only if smoke fails) — Pitfall G-3:
      # - /usr/lib/wsl/lib/libnvidia-ml.so.1:/usr/lib/wsl/lib/libnvidia-ml.so.1:ro
    networks:
      - backend       # Prometheus scrapes from `backend`
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:9835/metrics >/dev/null 2>&1 || exit 1"]
      interval: 30s
      timeout: 5s
      start_period: 30s
      retries: 5
```

### Prometheus Compose service block + scrape config

```yaml
  # ── Prometheus (Phase 7 — OBS-02, D-D1..D-D2) ─────────────────────────────
  prometheus:
    image: prom/prometheus:v3.10.0     # [VERIFIED 2026-05-16 — current stable v3 GA]
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-prometheus
    restart: unless-stopped
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--storage.tsdb.path=/prometheus"
      - "--storage.tsdb.retention.time=15d"
      - "--web.listen-address=:9090"
      - "--web.enable-lifecycle"
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ${HOST_DATA_ROOT:-/srv/local-llms}/prometheus:/prometheus
    networks:
      - backend       # scrapes router/vllm/llamacpp/gpu-exporter here
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:9090/-/ready >/dev/null 2>&1 || exit 1"]
      interval: 15s
      timeout: 3s
      start_period: 30s
      retries: 5
    # Pitfall P-2 — prom runs as UID 65534. README documents:
    # sudo chown -R 65534:65534 ${HOST_DATA_ROOT}/prometheus
```

```yaml
# prometheus/prometheus.yml — [CLOSED R-4: v3 schema unchanged from v2]
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: router
    metrics_path: /metrics
    static_configs:
      - targets: ['router:3000']
        labels: {service: 'router', component: 'edge-router'}

  - job_name: vllm
    metrics_path: /metrics
    static_configs:
      - targets: ['vllm:8000', 'vllm-embed:8000']
        labels: {service: 'vllm', component: 'inference'}

  - job_name: llamacpp
    metrics_path: /metrics
    static_configs:
      - targets: ['llamacpp:8080']
        labels: {service: 'llamacpp', component: 'inference'}

  - job_name: gpu
    metrics_path: /metrics
    static_configs:
      - targets: ['nvidia_gpu_exporter:9835']
        labels: {service: 'nvidia_gpu_exporter', component: 'gpu'}

  # Self-scrape for Prometheus's own internal metrics
  - job_name: prometheus
    static_configs:
      - targets: ['localhost:9090']
        labels: {service: 'prometheus', component: 'observability'}
```

### Grafana Compose service block + provisioning files

```yaml
  # ── Grafana (Phase 7 — OBS-04, D-D3..D-D8) ───────────────────────────────
  grafana:
    image: grafana/grafana-oss:12.4.3    # [Pitfall G-1: CONTEXT.md 11.x is stale; 12.4.3 is current 12-stable; 13.0.1 also available]
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-grafana
    restart: unless-stopped
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
      - GF_AUTH_ANONYMOUS_ENABLED=false
      - GF_AUTH_BASIC_ENABLED=true
      - GF_USERS_ALLOW_SIGN_UP=false
      - GF_INSTALL_PLUGINS=                # explicitly empty — no plugins needed
      - GF_PATHS_PROVISIONING=/etc/grafana/provisioning
    volumes:
      - ${HOST_DATA_ROOT:-/srv/local-llms}/grafana:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning:ro
      # Pitfall: dashboards JSON file is mounted READ-ONLY so Grafana cannot overwrite
      # the source-of-truth in git. Grafana clones provisioned dashboards as editable
      # in its internal DB; resetting them is `docker compose down -v && up -d`.
      - ./grafana/provisioning/dashboards/local-llms.json:/etc/grafana/dashboards/local-llms.json:ro
    networks:
      - app          # Traefik discovery — Pitfall 12 disambiguation via label
      - backend      # talks to prometheus
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/api/health >/dev/null 2>&1 || exit 1"]
      interval: 15s
      timeout: 3s
      start_period: 30s
      retries: 5
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=${COMPOSE_PROJECT_NAME:-local-llms}_app"
      - "traefik.http.routers.grafana-edge.rule=Host(`grafana.${TAILNET_HOSTNAME}.ts.net`)"
      - "traefik.http.routers.grafana-edge.entrypoints=web"
      - "traefik.http.routers.grafana-edge.middlewares=webui-basic-auth@docker"   # D-D8 — reuse same credential as OWUI
      - "traefik.http.services.grafana-edge.loadbalancer.server.port=3000"
    depends_on:
      prometheus:
        condition: service_healthy
        required: false
```

```yaml
# grafana/provisioning/datasources/datasource.yml — [CLOSED R-5: apiVersion 1]
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    uid: prometheus-default        # pin UID — dashboard JSON references this UID (Pitfall P-1)
    editable: false                # provisioned datasources should be read-only in UI
    jsonData:
      timeInterval: 15s            # matches Prometheus global scrape_interval
      httpMethod: POST
```

```yaml
# grafana/provisioning/dashboards/local-llms.yml — [CLOSED R-5: apiVersion 1]
apiVersion: 1

providers:
  - name: 'local-llms'
    orgId: 1
    folder: ''                     # root folder
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30      # re-reads the JSON files this often
    allowUiUpdates: true           # operator can tweak dashboards in UI (clones to DB; reset via `down -v`)
    options:
      path: /etc/grafana/dashboards
      foldersFromFilesStructure: false
```

The dashboard JSON itself (`grafana/provisioning/dashboards/local-llms.json`) is too large to include verbatim. Planner builds it. **MUST** contain panels for:

| Panel | PromQL Query (template) | Source |
|-------|--------------------------|--------|
| VRAM utilization (per-GPU) | `nvidia_smi_memory_used_bytes / nvidia_smi_memory_total_bytes` | nvidia_gpu_exporter |
| Request rate (per protocol, per backend) | `sum(rate(router_requests_total{}[5m])) by (protocol, backend)` | Phase 5 router metrics |
| TTFT histogram | `histogram_quantile(0.95, sum(rate(router_ttft_ms_bucket[5m])) by (le))` | Phase 5 router metrics |
| Latency histogram | `histogram_quantile(0.95, sum(rate(router_request_duration_ms_bucket[5m])) by (le))` | Phase 5 router metrics |
| Error rate (status_class breakdown) | `sum(rate(router_requests_total{status_class!="success"}[5m])) by (status_class)` | Phase 5 router metrics |
| Backend selection (per-model request rate) | `sum(rate(router_requests_total[5m])) by (model, backend)` | Phase 5 router metrics |
| vLLM throughput (tokens/sec) | `rate(vllm:generation_tokens_total[5m])` | vLLM native metrics |

### Router embeddings route (template — planner fleshes out)

```typescript
// router/src/routes/v1/embeddings.ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory } from '../../backends/adapter.js';
import type { BackendSemaphore } from '../../concurrency/semaphore.js';
import { CapabilityNotSupportedError } from '../../errors/envelope.js';
import { performance } from 'node:perf_hooks';
import type { RecordRequestOutcome } from '../../metrics/recordOutcome.js';
import { deriveStatusClass, mapErrorToCode } from '../../metrics/recordOutcome.js';

export const EmbeddingsRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),     // Pitfall E-1 gate
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().optional(),
  user: z.string().optional(),
}).passthrough();

export interface RegisterEmbeddingsOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  semaphores: { get(backend: string): BackendSemaphore };
  recordOutcome: RecordRequestOutcome;
}

export function registerEmbeddingsRoute(app: FastifyInstance, opts: RegisterEmbeddingsOpts): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/v1/embeddings',
    { schema: { body: EmbeddingsRequestSchema } },
    async (req, reply) => {
      const body = req.body;
      const t0 = performance.now();

      const entry = opts.registry.resolve(body.model);

      // Capability gate (D-B3) — fire before semaphore acquire
      if (!entry.capabilities.includes('embeddings')) {
        throw new CapabilityNotSupportedError(entry.name, 'embeddings');
      }

      // (Planner: decide whether to widen BackendAdapter with .embeddings() or
      // duck-type on the adapter instance. Recommend widen — see Pattern §VLLMOpenAIAdapter.)
      const adapter = opts.makeAdapter(entry) as { embeddings: (input: string | string[], model: string, signal: AbortSignal) => Promise<{data: Array<{embedding: number[] | string}>, usage: {prompt_tokens: number, total_tokens: number}}>};

      // Semaphore + AbortController + outcome recording follow chat-completions.ts patterns.
      // Embeddings is non-streaming so the cleanup is simpler (no SSE heartbeat).

      const sem = opts.semaphores.get(entry.backend);
      const release = await sem.acquire();
      const ac = new AbortController();
      req.raw.on('close', () => { if (!reply.sent) ac.abort(); });

      try {
        const result = await adapter.embeddings(body.input, entry.backend_model, ac.signal);

        // Record outcome with the same pattern as chat-completions
        const durationMs = performance.now() - t0;
        opts.recordOutcome({
          protocol: 'openai',
          route: '/v1/embeddings',
          backend: entry.backend,
          model: entry.name,
          statusClass: 'success',
          httpStatus: 200,
          durationMs,
          tokensIn: result.usage?.prompt_tokens,
          tokensOut: 0,                       // embeddings have no output tokens
          requestId: req.id,
          timestamp: new Date(),
          agentId: (req as { agentId?: string }).agentId,
        });

        return result;
      } catch (err) {
        // Centralized error handler at app level maps capability/registry errors to envelopes.
        // Record the outcome via recordOutcome from the centralized handler too.
        throw err;
      } finally {
        release();
      }
    }
  );
}
```

### `models.yaml` extensions

```yaml
# router/models.yaml additions (planner refines)

backends:
  ollama:
    base_url: http://ollama:11434/v1
    concurrency: 2
    queue_max_wait_ms: 30000
  llamacpp:
    base_url: http://llamacpp:8080/v1
    concurrency: 2
    queue_max_wait_ms: 30000
  vllm:                                # NEW (D-A8)
    base_url: http://vllm:8000/v1
    concurrency: 2
    queue_max_wait_ms: 30000
  vllm-embed:                          # NEW (D-B5(a))
    base_url: http://vllm-embed:8000/v1
    concurrency: 4
    queue_max_wait_ms: 30000

models:
  # ... existing entries unchanged ...

  # NEW Phase 7 entries
  - name: qwen2.5-7b-instruct-awq
    backend: vllm
    backend_url: http://vllm:8000/v1
    backend_model: Qwen/Qwen2.5-7B-Instruct-AWQ
    capabilities: [chat, tools]
    vram_budget_gb: 7.2                # 0.45 × 16 GB envelope (matches --gpu-memory-utilization)
    concurrency: 2
    max_model_len: 8192
    vllm_max_model_len: 8192           # D-A8 — explicit per-model
    vllm_gpu_memory_utilization: 0.45  # D-A8
    profile: vllm

  - name: bge-m3-ollama
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: bge-m3
    capabilities: [embeddings]
    vram_budget_gb: 2.5
    concurrency: 4                     # embeddings are cheaper than chat
    max_model_len: 8192
    profile: ollama

  - name: bge-m3-vllm
    backend: vllm-embed                # NOTE: separate backend per D-B5(a)
    backend_url: http://vllm-embed:8000/v1
    backend_model: BAAI/bge-m3
    capabilities: [embeddings]
    vram_budget_gb: 2.5
    concurrency: 4
    max_model_len: 8192
    vllm_max_model_len: 8192
    vllm_gpu_memory_utilization: 0.25
    profile: vllm
```

### Smoke commands

```bash
# bin/smoke-test-vllm.sh — Pitfall V-1 verification
#!/usr/bin/env bash
set -euo pipefail
COMPOSE="docker compose"
TOKEN="${ROUTER_BEARER_TOKEN:?missing}"

# 1) Cold start
$COMPOSE --profile vllm up -d vllm
$COMPOSE wait vllm --timeout 900    # 15 min budget for JIT compile + CUDA graphs

# 2) Direct vLLM smoke (bypass router — exercise the kernel)
$COMPOSE exec -T vllm curl -fsS -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-7B-Instruct-AWQ","messages":[{"role":"user","content":"hi"}],"max_tokens":4}' \
  | jq -e '.choices[0].message.content | length > 0' >/dev/null
echo "✓ vLLM chat smoke OK"

# 3) nvidia-smi must show a vllm process (NOT a CPU fallback)
$COMPOSE exec -T vllm nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader \
  | grep -E "(vllm|python)" >/dev/null
echo "✓ vLLM is consuming GPU memory"

# 4) Router-mediated chat against the same model
curl -fsS -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5-7b-instruct-awq","messages":[{"role":"user","content":"ping"}],"max_tokens":4}' \
  | jq -e '.choices[0].message.content | length > 0' >/dev/null
echo "✓ Router → vLLM chat OK"
```

```bash
# bin/smoke-test-router.sh — APPEND these embeddings checks to existing file
echo "=== /v1/embeddings smoke ==="

# Ollama bge-m3
DIM=$(curl -fsS -X POST http://localhost:3000/v1/embeddings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"bge-m3-ollama","input":"Hola mundo desde local-llms"}' \
  | jq '.data[0].embedding | length')
[[ "$DIM" == "1024" ]] || { echo "FAIL: bge-m3-ollama dimensions=$DIM (expected 1024)"; exit 1; }
echo "✓ bge-m3-ollama → 1024-dim"

# vLLM BAAI/bge-m3 (requires --profile vllm)
DIM=$(curl -fsS -X POST http://localhost:3000/v1/embeddings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"bge-m3-vllm","input":"Hola mundo desde local-llms"}' \
  | jq '.data[0].embedding | length')
[[ "$DIM" == "1024" ]] || { echo "FAIL: bge-m3-vllm dimensions=$DIM (expected 1024)"; exit 1; }
echo "✓ bge-m3-vllm → 1024-dim"

# Phase SC5 — request_log rows distinct
docker compose exec -T postgres psql -U app -d router -c \
  "SELECT backend, COUNT(*) FROM request_log WHERE route='/v1/embeddings' GROUP BY backend;" \
  | grep -E "^\s*(ollama|vllm-embed)\s" >/dev/null
echo "✓ request_log distinct rows for embedding dispatch"
```

```bash
# bin/smoke-test-observability.sh — OBS-02..04
#!/usr/bin/env bash
set -euo pipefail
COMPOSE="docker compose"

# OBS-02 + OBS-03: Prometheus targets up
$COMPOSE exec -T prometheus wget -qO- http://localhost:9090/api/v1/targets \
  | jq -e '.data.activeTargets | map(select(.health == "up")) | length >= 4' >/dev/null
echo "✓ Prometheus has ≥4 healthy scrape targets"

for JOB in router vllm llamacpp gpu; do
  RESULT=$($COMPOSE exec -T prometheus wget -qO- "http://localhost:9090/api/v1/query?query=up{job=\"$JOB\"}" | jq -r '.data.result[0].value[1] // "0"')
  [[ "$RESULT" == "1" ]] || { echo "FAIL: up{job=\"$JOB\"} != 1"; exit 1; }
  echo "✓ up{job=\"$JOB\"} = 1"
done

# OBS-04: Grafana datasource healthy
$COMPOSE exec -T grafana wget -qO- --user "admin:$GRAFANA_ADMIN_PASSWORD" \
  http://localhost:3000/api/datasources/uid/prometheus-default \
  | jq -e '.name == "Prometheus"' >/dev/null
echo "✓ Grafana datasource provisioned"

# OBS-04: Provisioned dashboard exists
$COMPOSE exec -T grafana wget -qO- --user "admin:$GRAFANA_ADMIN_PASSWORD" \
  http://localhost:3000/api/dashboards/uid/local-llms \
  | jq -e '.dashboard.title | length > 0' >/dev/null
echo "✓ Grafana dashboard provisioned"
```

### `.env.example` additions

```bash
# ── Phase 7 — Grafana admin password ────────────────────────────────────────
# Grafana's internal admin user password (separate from Traefik edge basic-auth).
# Phase 6 Traefik basic-auth (TRAEFIK_BASIC_AUTH) is the EDGE gate — Grafana's
# admin password is the FALLBACK gate if someone reaches Grafana via the LAN
# bypass (127.0.0.1:80 with Host header). Generate with: openssl rand -hex 24
GRAFANA_ADMIN_PASSWORD=

# ── Phase 7 — HuggingFace Hub token (optional) ──────────────────────────────
# Empty by default. Set ONLY if pinning a gated HF model (Qwen2.5-7B-Instruct-AWQ
# is PUBLIC, BAAI/bge-m3 is PUBLIC). Get from https://huggingface.co/settings/tokens.
HUGGINGFACE_HUB_TOKEN=
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `--task embed` (vLLM 0.10.x and earlier) | **`--runner pooling`** | vLLM 0.15+ (deprecation), removed in 0.18+ | Phase 7 must use `--runner pooling` per CLOSED R-1 |
| BGE-M3 in vLLM via XLMRobertaForSequenceClassification auto-detection | **`--hf-overrides '{"architectures":["BgeM3EmbeddingModel"]}'`** | When vLLM added dedicated BgeM3EmbeddingModel class (v0.16+) | Required for sparse/colbert weight loading; otherwise dense-only |
| `--quantization awq` (Triton path) | **`--quantization awq_marlin`** for sm_80+ | vLLM 0.7+ default; Marlin kernel is 1.5–2× faster | Phase 7 locked decision; falls back to non-Marlin if sm_120 wheel issue (Pitfall V-1) |
| Grafana 11.x | **12.4.3 or 13.0.1** as of 2026-05-16 | Continuous; 11.x line is from early 2025 | Provisioning schema unchanged; pin newer for security/perf |
| nvidia_gpu_exporter 1.3.x | **1.4.1** (2025-10-06) | v1.4 series brought SIGTERM fixes | Cleaner Compose shutdown |
| Prometheus v2.x | **v3.10.0** (2026-02-24) | v3 is GA; v2 in maintenance | Phase 7 uses v3; schema backward-compatible |

**Deprecated/outdated:**
- vLLM `--quantization bitsandbytes` on Blackwell — bitsandbytes kernels are NOT compatible with sm_120. Don't use; AWQ is the right path here.
- DCGM-exporter on WSL2 — known libdcgm dlopen issues. nvidia_gpu_exporter is the right pick (per CONTEXT.md C-1, confirmed).
- `vllm/vllm-openai:latest` tag — never. Always pin a version-stamped tag.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | vLLM-embed VRAM share at `--gpu-memory-utilization 0.25` is approximately 4 GB on a 16 GB card | CLOSED R-1 mitigation + vllm-embed Compose | If actual share differs significantly, the VRAM envelope warning in models.yaml is wrong. Verify with `nvidia-smi` after vllm-embed first boot; adjust `vram_budget_gb` in models.yaml. |
| A2 | The v0.20.2-cu129 PyTorch wheel includes sm_120 kernels (closed via smoke test rather than verified via docs) | Pitfall V-1 | Smoke test catches this. Falls back to v0.21.0 or non-Marlin path. |
| A3 | BAAI/bge-m3 served via vLLM `/v1/embeddings` returns 1024-dim dense embeddings (matches Ollama bge-m3 default output) | Pitfall E-2 + smoke test | If actual dims differ, agents that expect cross-backend interchangeability break. Smoke test asserts 1024 on both backends. |
| A4 | Grafana basic-auth via Traefik (`webui-basic-auth@docker`) is sufficient edge auth; Grafana's own admin user is the fallback for LAN bypass | D-D8 + Grafana service block | If Grafana's UI requires its own login regardless of Traefik basic-auth, the operator sees two prompts. Acceptable. |
| A5 | The `models.yaml` `backend: vllm-embed` is a valid new LocalBackendEnum variant (separate from `vllm`) | CLOSED R-1 + models.yaml | Planner may decide to keep a single `vllm` backend value with the URL distinguishing chat vs embed instances. Either works; the separation makes the registry's per-backend semaphore counts cleaner. |
| A6 | The `nvidia_gpu_exporter` `/metrics` output uses metric names starting with `nvidia_smi_` (e.g., `nvidia_smi_memory_used_bytes`) — used in the Grafana dashboard PromQL | Validated Code Snippets §Dashboard panels | If exporter v1.4.1 uses different metric names than v1.3.0, the dashboard JSON references break. Smoke test catches this; planner verifies exact metric names by querying `/metrics` once the service is up. |

**Mitigation:** Each ASSUMED claim is paired with a smoke-test gate. Planner ensures Wave 0 includes the assertions that turn assumptions into verifications.

---

## Open Questions

1. **Does the operator want to keep vLLM hot AND Ollama hot simultaneously, or is the documented profile dance acceptable?**
   - What we know: VRAM envelope makes "all three hot" infeasible. Phase 3 already established the per-profile pattern.
   - What's unclear: Whether Phase 7 should add UX (e.g., a `bin/switch-backend.sh` script that does the stop/start dance).
   - Recommendation: README documentation only; no script in Phase 7. Phase 9 (operations hardening) is the right place if needed.

2. **Should `bge-m3-vllm` be a separate vLLM service or share the chat vLLM container?**
   - CLOSED: separate container (CLOSED R-1). No ambiguity remaining.

3. **Should the embeddings route emit a `request_log` row with `tokens_out=0` or `tokens_out=NULL`?**
   - What we know: embeddings have no output tokens. Phase 5 schema has `tokens_out INTEGER` with NULL allowed.
   - Recommendation: emit `0`, not NULL — embedding requests DID complete; NULL is reserved for "we couldn't measure". The `prompt_tokens` from the SDK response populates `tokens_in`.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker Compose | All Phase 7 services | ✓ | — | — |
| NVIDIA Container Toolkit (host) | All GPU services | ✓ (preflight gate) | — | Phase 1 `gpu-preflight` blocks otherwise |
| Host NVIDIA driver | All GPU services | ✓ | **595.97** ≥ 555.x ✓ | — |
| `nvidia-smi` binary | GPU exporter | ✓ (WSL2-projected from Windows) | — | If missing inside container, mount from `/usr/lib/wsl/lib/nvidia-smi` (Pitfall G-3) |
| `libnvidia-ml.so` | GPU exporter | ✓ | — | Same Pitfall G-3 fallback |
| Internet access for HF pulls | vllm + vllm-embed first boot | ✓ via `app` network | — | Pre-populate `${HOST_DATA_ROOT}/models-hf/` cache via host-side `huggingface-cli download` (Phase-1 D-02 layout already provides the path) |
| Tailscale Serve hostname for `grafana.<tn>.ts.net` | Edge access to Grafana | ⚠ Operator step deferred | — | Until then, reach Grafana via 127.0.0.1:80 + `Host: grafana.<tn>.ts.net` header (matches Phase 6 LAN bypass pattern) |
| HuggingFace Hub token | NONE (Qwen2.5-7B-AWQ + bge-m3 are public) | N/A | — | Declare env var empty; set only if planner adds gated model later |

**Missing dependencies with no fallback:** None. The host environment is fully provisioned for Phase 7.

**Missing dependencies with fallback:** Tailscale Serve `svc:grafana` registration (operator step, deferred — Grafana reachable via LAN bypass until configured).

---

## Project Constraints (from CLAUDE.md)

| Directive | Phase 7 Compliance |
|-----------|---------------------|
| **VRAM tope 16 GB** | `--gpu-memory-utilization 0.45` (chat) + 0.25 (embed) keeps vLLM share at 11.2 GB; Ollama and vLLM mutually exclusive via profiles |
| **NVIDIA Container Toolkit + driver propietario** | vLLM via `x-gpu` anchor; gpu-exporter via explicit binds + `x-gpu` (Pitfall G-3) |
| **Compose v2** | All Phase 7 services use the modern `deploy.resources.reservations.devices` form via the `x-gpu` anchor (Phase 1 D-13). No `runtime: nvidia`, no `--gpus all`. |
| **API contract: OpenAI + Anthropic compat** | Embeddings is OpenAI-only (Anthropic doesn't have a standard embeddings surface). EMBED-01 / OAI-02 are explicitly the OpenAI surface; documenting "no /v1/messages embedding equivalent" in README. |
| **Auth: bearer token único en `.env`** | Embeddings route uses the same Phase 2 bearer auth pre-handler. Grafana edge is Traefik basic-auth (separate credential); the bearer is unchanged. |
| **Streaming: SSE obligatorio** | Embeddings is non-streaming (synchronous request). Does not violate the SSE constraint — chat is still SSE. |
| **Single host, single user** | Single Grafana admin user; single bearer; per-token rate limit not needed in Phase 7 (lands in Phase 8). |
| **Pin images, never `:latest`** | Every new image is pinned: vLLM v0.20.2-cu129-ubuntu2404, Prometheus v3.10.0, Grafana 12.4.3, nvidia_gpu_exporter 1.4.1 |
| **Don't disable Grafana compression on streaming routes** | Not applicable — Grafana streams via WebSocket internally, not via Fastify SSE; Traefik compress middleware is disabled globally per Phase 6 |
| **No `bcrypt`/native deps on alpine** | Router is Debian bookworm-slim (Phase 2); no Phase 7 router changes affect base image |

---

## Sources

### Primary (HIGH confidence)
- Context7 `/websites/vllm_ai_en` — pooling models, tool calling, embeddings, OpenAI compat — **HIGH**
- Context7 `/vllm-project/vllm` — `docs/features/tool_calling.md`, `docs/models/pooling_models/specific_models.md`, `docs/models/pooling_models/embed.md` — **HIGH**
- [docs.vllm.ai/en/stable/features/tool_calling.html](https://docs.vllm.ai/en/stable/features/tool_calling.html) — Qwen2.5 uses `hermes` parser — **HIGH**
- [docs.vllm.ai/en/latest/models/pooling_models/embed/](https://docs.vllm.ai/en/latest/models/pooling_models/embed/) — `--runner pooling`, single-process limitation — **HIGH**
- [github.com/vllm-project/vllm/releases/tag/v0.20.2](https://github.com/vllm-project/vllm/releases/tag/v0.20.2) — released 2026-05-10 — **HIGH**
- [github.com/vllm-project/vllm/releases/tag/v0.21.0](https://github.com/vllm-project/vllm/releases/tag/v0.21.0) — released 2026-05-15 with explicit Blackwell scope — **HIGH**
- [github.com/utkuozdemir/nvidia_gpu_exporter/blob/master/INSTALL.md](https://github.com/utkuozdemir/nvidia_gpu_exporter/blob/master/INSTALL.md) — Docker bind-mount canonical config — **HIGH**
- [github.com/utkuozdemir/nvidia_gpu_exporter/releases](https://github.com/utkuozdemir/nvidia_gpu_exporter/releases) — v1.4.1 as 2025-10-06 latest — **HIGH**
- [prometheus.io/docs/prometheus/latest/configuration/configuration/](https://prometheus.io/docs/prometheus/latest/configuration/configuration/) — v3 schema unchanged from v2 — **HIGH**
- [grafana.com/docs/grafana/latest/administration/provisioning/](https://grafana.com/docs/grafana/latest/administration/provisioning/) — `apiVersion: 1` for datasources + dashboards — **HIGH**
- [huggingface.co/Qwen/Qwen2.5-7B-Instruct-AWQ](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-AWQ) — model card — **HIGH**
- [huggingface.co/BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) — model card — **HIGH**
- `.preflight-state.json` — host driver 595.97 ≥ 555.x for cu129 — **HIGH** (project artifact)
- `.planning/research/PITFALLS.md` Pitfalls 6 + 7 — vLLM tuning + cold-start — **HIGH** (project research)

### Secondary (MEDIUM confidence)
- [github.com/vllm-project/vllm/issues/35432](https://github.com/vllm-project/vllm/issues/35432) — Blackwell prebuilt issue (closed) — **MEDIUM** (closure context thin)
- [github.com/pytorch/pytorch/issues/164342](https://github.com/pytorch/pytorch/issues/164342) — PyTorch stable sm_120 still open as of 2026-05 — **MEDIUM** (open issue; status will shift)
- [discuss.vllm.ai field report on RTX 5060 Ti](https://discuss.vllm.ai/t/field-report-awq-on-rtx-5060-ti-sm-120-blackwell-awq-marlin-triton-attn-working/2463) — one operator's working config — **MEDIUM** (single source, but exact hardware match)
- [hub.docker.com/r/vllm/vllm-openai/tags](https://hub.docker.com/r/vllm/vllm-openai/tags) — v0.21.0 latest published 2026-05-15 — **MEDIUM-HIGH**
- [hub.docker.com/r/prom/prometheus/tags](https://hub.docker.com/r/prom/prometheus/tags) — v3.10.0 / v3.11.x — **MEDIUM-HIGH**
- [hub.docker.com/r/grafana/grafana-oss/tags](https://hub.docker.com/r/grafana/grafana-oss/tags) — 13.0.1 latest / 12.4.3 stable — **MEDIUM-HIGH**
- [docs.vllm.ai/en/stable/getting_started/installation/gpu/](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/) — Blackwell minimum CUDA 12.8 — **HIGH** (but doesn't enumerate consumer cards)

### Tertiary (LOW confidence)
- [ligma.blog post on vLLM Debian 12 + RTX 5070 Ti](https://ligma.blog/post1/) — RTX 5070 Ti specific working config — **LOW** (single blog post; hardware similar but not identical to 5060 Ti)
- [github.com/vllm-project/vllm/issues/14452](https://github.com/vllm-project/vllm/issues/14452) — RTX 5080/5090 setup tips — **LOW** (community thread; older context)
- [discuss.vllm.ai on RTX 5090 + torch 2.9.0 cu128](https://discuss.vllm.ai/t/vllm-on-rtx5090-working-gpu-setup-with-torch-2-9-0-cu128/1492) — sm_120 + nightly build success — **LOW** (sm_120 confirmed but with a non-stable build)

### External docs to verify still current at planning time
- vLLM Docker docs — `https://docs.vllm.ai/en/stable/deployment/docker/`
- vLLM Tool Calling — `https://docs.vllm.ai/en/stable/features/tool_calling/`
- vLLM Pooling Models — `https://docs.vllm.ai/en/latest/models/pooling_models/embed/`
- Prometheus v3 config — `https://prometheus.io/docs/prometheus/latest/configuration/configuration/`
- Grafana provisioning — `https://grafana.com/docs/grafana/latest/administration/provisioning/`
- nvidia_gpu_exporter README — `https://github.com/utkuozdemir/nvidia_gpu_exporter`

---

## Metadata

**Confidence breakdown:**
- Tool-call parser (`hermes`): **HIGH** — verified directly in official vLLM docs + Context7
- D-B5 separate container: **HIGH** — verified directly in pooling docs ("mutually exclusive at startup")
- Prometheus v3 schema: **HIGH** — verified at prometheus.io
- Grafana provisioning `apiVersion: 1`: **HIGH** — verified at grafana.com
- nvidia_gpu_exporter WSL2 binds: **HIGH** — INSTALL.md is unambiguous
- BGE-M3 `--hf-overrides`: **HIGH** — Context7 vllm specific_models.md
- vLLM v0.20.2 sm_120 prebuilt wheel inclusion: **MEDIUM** — release notes silent; resolution path documented via Wave 0 smoke
- Qwen2.5-AWQ tool-call stability: **MEDIUM-HIGH** — official docs say works; one historical bug fixed pre-v0.20.0

**Research date:** 2026-05-16
**Valid until:** 2026-06-15 (30 days; standard for stable stack). vLLM v0.21.0 was released 1 day before this research — re-check the sm_120 prebuilt-wheel status if Phase 7 planning slips past 2026-06-01, as a v0.21.1 patch may either confirm or break the cu129 Blackwell wheel.

---

*Phase 7 — Embeddings + vLLM + GPU Telemetry — Research*
*Researched: 2026-05-16*
