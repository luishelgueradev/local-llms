---
phase: 07-embeddings-vllm-gpu-telemetry
verified: 2026-05-17T04:34:18Z
status: human_needed
score: 4/5 must-haves verified (1 routed to human-verify)
overrides_applied: 0
methodology_note: |
  Phase mode is `mvp` but the ROADMAP.md goal is not in canonical User Story form
  ("As a..., I want to..., so that..."). gsd-sdk user-story.validate returned false.
  Standard goal-backward methodology was applied against the 5 explicit
  success_criteria + 7 requirement IDs declared in the roadmap (not refused). The
  operator may want to convert the goal to a User Story for future phases — but
  the success criteria are concrete and verifiable as-is, so verification proceeded.
deferred:
  - truth: "Ollama Cloud `/v1/embeddings` passthrough (EMBED-02 in ROADMAP requirements list)"
    addressed_in: "Phase 8 — Ollama Cloud Fallback + Resilience Hardening"
    evidence: |
      ROADMAP Phase 7 footnote explicitly says: "EMBED-02 (Ollama Cloud passthrough) deferred to
      Phase 8 per CONTEXT — the ROADMAP requirement line above includes EMBED-02 but Phase 7
      plans cover only six requirements; EMBED-02 lands in Phase 8." REQUIREMENTS.md confirms
      EMBED-02 status is Pending and routes through Phase 8's CLOUD-01..05 work. No Phase 7
      plan declared EMBED-02 in its frontmatter.
human_verification:
  - test: "Bring up the stack with the vLLM profile and observe cold-start"
    expected: |
      `docker compose --profile vllm up -d` succeeds.
      `docker compose ps vllm` reports `healthy` within 5–15 min (start_period: 1200s
      for cold first boot per Wave 0 OUTCOME).
      `docker compose ps vllm-embed` reports `healthy` within ~3–5 min.
      Cold-start log shows `capturing CUDA graphs` (visible with
      `docker compose logs -f vllm | grep -i 'capturing CUDA graphs'`).
    why_human: |
      Requires NVIDIA GPU access (RTX 5060 Ti on operator host), is destructive of
      VRAM state, and takes 5–20 min — out of scope for a sandboxed verifier worktree.
  - test: "First-time host fixes (only if surfaced)"
    expected: |
      If Prometheus fails: `sudo chown -R 65534:65534 ${HOST_DATA_ROOT:-/srv/local-llms}/prometheus`
      (Pitfall P-2) — bootstrap-host.sh now does this, so should not be needed.
      If `docker compose logs nvidia_gpu_exporter` shows `libnvidia-ml.so: cannot open
      shared object file`: uncomment the WSL2 `/usr/lib/wsl/lib` bind-mount in
      compose.yml (Pitfall G-3), then `docker compose up -d nvidia_gpu_exporter`.
    why_human: |
      Conditional remediation depending on host state; requires sudo and live logs.
  - test: "Pull bge-m3 into Ollama (one-time)"
    expected: |
      `docker compose exec ollama ollama pull bge-m3` completes; subsequent
      `ollama list` shows bge-m3.
    why_human: |
      Network operation against Ollama registry; ~2.3 GB download against operator
      bandwidth.
  - test: "Run bin/smoke-test-observability.sh"
    expected: |
      Every section prints `PASS:`; final line `Phase 7 observability smoke PASS`;
      exit code 0. Section breakdown:
        1. Prometheus /api/v1/targets returns ≥3 healthy active targets
        2. up{job=router|gpu|prometheus}==1 (always)
        3. up{job=vllm}==1 + up{job=vllm-embed}==1 (auto-detected via docker compose ps)
        4. nvidia_smi_memory_used_bytes returns a numeric sample
        5. Grafana datasource `prometheus-default` provisioned and named "Prometheus"
        6. Grafana dashboard `local-llms` provisioned with title set + panels >= 6
    why_human: |
      Requires live Prometheus + Grafana + GPU exporter containers running on the
      operator host. The script is profile-aware (skips vllm assertions when the
      profile is not active) — operator must run with `--profile vllm` to exercise SC2/SC3.
  - test: "Run bin/smoke-test-router.sh (covers Phase 2-6 + new Phase 7 section)"
    expected: |
      Every Phase 2-6 section passes (unchanged); Phase 7 section prints six PASS
      markers (or five PASS + one SKIP if vllm-embed not exercised); exit 0.
      Phase 7 sub-checks:
        1. bge-m3 present in Ollama (idempotent)
        2. bge-m3-ollama → 1024-dim (OAI-02 + EMBED-01 happy path)
        3. capability gate — qwen2.5-7b-instruct-awq on /v1/embeddings → 400
        4. zod gate — empty input → 400 (Pitfall E-1)
        5. bge-m3-vllm → 1024-dim (BCKND-03; gated on docker compose ps vllm-embed)
        6. request_log distinct rows: backend='ollama' AND backend='vllm-embed' present
           when both were exercised
    why_human: |
      Same as above — requires live router + live Ollama + live vLLM + live Postgres,
      and the bearer token from .env. The Phase 7 section is the canonical proof of
      SC1 and SC5.
  - test: "Visual Grafana dashboard check"
    expected: |
      Visit http://127.0.0.1/d/local-llms/ with the LAN bypass `Host:
      grafana.<TAILNET_HOSTNAME>.ts.net` header (or via the Tailscale URL on the
      operator's tailnet). Dashboard renders with live data on all six required
      panels (VRAM Utilization, Request Rate, TTFT p95, Request Duration p95, Error
      Rate, Backend Selection) plus the seventh "vLLM Generation Throughput".
      VRAM panel shows non-zero usage; Backend Selection shows both `ollama` and
      `vllm-embed` rows AFTER the smoke runs.
    why_human: |
      Visual confirmation of a browser-rendered dashboard cannot be automated from a
      sandboxed verifier; the worktree has no DOM rendering or screenshot harness for
      the Grafana UI bound to the operator's tailnet. SC4 explicitly requires "shows"
      panels — operator-eyeball verification is the canonical proof.
  - test: "Manual request_log distinct-row SQL"
    expected: |
      `docker compose exec postgres psql -U app -d router -c "SELECT backend, route,
      COUNT(*) FROM request_log WHERE route='/v1/embeddings' GROUP BY backend, route;"`
      returns ≥ 2 rows — one for `backend='ollama'`, one for `backend='vllm-embed'`.
    why_human: |
      Operator-side DB inspection after both smoke scripts have exercised both
      backends. Proves SC5 empirically.
  - test: "VRAM realism check with nvidia-smi"
    expected: |
      `docker compose exec vllm nvidia-smi` shows the vllm process using ~7-8 GB
      VRAM (matches D-E1 static budget); vllm-embed using ~3-4 GB; no silent CPU
      fallback. Both processes present when both backends are hot.
    why_human: |
      Requires GPU access and exec into a running vllm container.
---

# Phase 7: Embeddings + vLLM + GPU Telemetry — Verification Report

**Phase Goal:** Add the embedding endpoint and vLLM (heavy backend with VRAM pre-allocation and JIT compile) to an already-observable stack so vLLM's wins are measurable and the embedding surface lands with full telemetry.

**Verified:** 2026-05-17T04:34:18Z
**Status:** `human_needed`
**Re-verification:** No — initial verification

## Methodology Caveat

Phase 7 declares `mode: mvp` in the roadmap, but the goal is not in canonical User Story form (`As a..., I want to..., so that...`). `gsd-sdk query user-story.validate` returned `false`. Per the verifier's MVP-mode guard, this would normally trigger a refusal — however the orchestrator's instructions for this run explicitly direct goal-backward verification against the 5 success criteria + 7 requirement IDs, which are concrete and testable. I proceeded with standard goal-backward methodology rather than refusing. Recommend converting the goal to User Story form (`/gsd mvp-phase 7`) for future re-verification runs.

## Goal Achievement

### Observable Truths (from ROADMAP Success Criteria)

| # | Truth (Success Criterion) | Status | Evidence |
|---|----|----|----|
| SC1 | `POST /v1/embeddings` returns OpenAI-shape embedding vectors for at least one Ollama embedding model AND one vLLM-served embedding model | VERIFIED (code) + needs_human (live) | Code: `router/src/routes/v1/embeddings.ts:85-215` registers POST `/v1/embeddings` with zod-validated body, capability gate, semaphore, recordOutcome; `router/src/backends/{ollama,vllm}-openai.ts` both implement `.embeddings()` returning the OpenAI SDK `CreateEmbeddingResponse` shape; `models.yaml` declares `bge-m3-ollama` (backend=ollama, caps=[embeddings]) AND `bge-m3-vllm` (backend=vllm-embed, caps=[embeddings]). Smoke script `bin/smoke-test-router.sh:1311-1389` asserts 1024-dim for both. Live execution against the running stack is in the human-verify list. SC1 also mentions Ollama Cloud passthrough (EMBED-02) — that is explicitly DEFERRED to Phase 8 per ROADMAP footnote. |
| SC2 | vLLM runs Qwen/Qwen2.5-7B-Instruct-AWQ with `--max-model-len 8192` + `--gpu-memory-utilization 0.45` + `ipc:host` + `shm_size:16gb`; first cold-start succeeds without restart-loop | VERIFIED (code) + needs_human (live) | `compose.yml:232-289`: image `vllm/vllm-openai:v0.21.0-cu129`, `--quantization=awq_marlin`, `--max-model-len=8192`, `--gpu-memory-utilization=0.45`, `--enable-auto-tool-choice`, `--tool-call-parser=hermes`, `VLLM_FLASH_ATTN_VERSION=2`, `ipc: host`, `shm_size: 16gb`, `start_period: 1200s` (Wave 0 empirical floor), `depends_on: gpu-preflight`. Wave 0 (Plan 07-00) empirically proved the locked image runs the awq_marlin Marlin kernel on RTX 5060 Ti sm_120 — `OUTCOME: locked` recorded in 07-00-SUMMARY.md with 5.29 GiB GPU allocation evidence. Cold-start floor is ~17 min on this host — operator UAT must confirm this still holds. |
| SC3 | vLLM `/metrics` + llama.cpp `/metrics` scraped by Prometheus; GPU exporter running + scraped; nvidia-smi shows realistic concurrent VRAM | VERIFIED (code) + needs_human (live) | `prometheus/prometheus.yml`: 5 scrape jobs (router, vllm [vllm:8000 + vllm-embed:8000], llamacpp, gpu [nvidia_gpu_exporter:9835], prometheus). `compose.yml:374-423` declares `nvidia_gpu_exporter` (v1.4.1) with explicit nvidia-smi + libnvidia-ml.so bind-mounts (Pitfall G-3 mitigation). `bin/smoke-test-observability.sh` asserts up{job=router|gpu|prometheus}==1 always, up{job=vllm}==1 when active. Live VRAM verification (operator runs `docker compose exec vllm nvidia-smi`) is in the human-verify list. |
| SC4 | Grafana dashboard exists showing VRAM, request rate, TTFT, error rate, backend selection (fed by Phase 5 router metrics + new exporters) | VERIFIED (code) + needs_human (visual) | `grafana/provisioning/dashboards/local-llms.json` has `uid: local-llms`, 7 panels (5 required + 1 latency + 1 vLLM throughput), all referencing `ds_uid: prometheus-default`: (0) VRAM Utilization per-GPU [WR-01 fix applied — `on(gpu) group_left` join], (1) Request Rate by protocol+backend, (2) TTFT p95, (3) Request Duration p95, (4) Error Rate by status_class, (5) Backend Selection by model+backend, (6) vLLM Generation Throughput. `grafana/provisioning/dashboards/local-llms.yml` provider config + `grafana/provisioning/datasources/datasource.yml` with pinned `uid: prometheus-default` (Pitfall P-1 mitigation). Visual confirmation that the dashboard renders live data is in the human-verify list. |
| SC5 | Router's request_log shows distinct rows for embedding requests routed to Ollama and vLLM (proves dispatch handles non-chat protocol) | VERIFIED (code) + needs_human (live) | `embeddings.ts:182-211` outer finally block calls `safeRecord(...)` on both success and error paths — records `{ protocol: 'openai', route: '/v1/embeddings', backend: entry.backend, model: entry.name, ... }` via the same `recordRequestOutcome` helper used by chat-completions + messages. `app.ts:197-201` widens `isRecordedRoute` allowlist to include `/v1/embeddings` so pre-resolve errors still produce rows. `bin/smoke-test-router.sh:1390-1425` runs the canonical SQL `SELECT backend, COUNT(*) FROM request_log WHERE route='/v1/embeddings' GROUP BY backend ORDER BY backend` and asserts `>= 1` row for `backend='ollama'` (and for `backend='vllm-embed'` when exercised — gated on docker compose ps). The 3s sleep before psql matches Plan 07-04's D-B4 buffered-writer flush interval. |

**Score:** 4/5 SCs have full code-side verification; SC4 (Grafana dashboard rendering) is by-design only verifiable via operator browser inspection. All 5 SCs are routed to operator UAT for live execution (Plan 07-06 Task 3 — explicitly `autonomous: false`).

### Required Artifacts (per PLAN frontmatters)

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `bin/smoke-test-vllm-coldstart.sh` | Wave 0 sm_120 gate smoke; OUTCOME labels (locked/fallback-env/fallback-quant) | VERIFIED | Executable, 15342 bytes, bash -n clean. All three OUTCOME labels present. 07-00-SUMMARY.md records `OUTCOME: locked` with empirical proof of awq_marlin Marlin kernel + 5.29 GiB GPU allocation. Commits: c9a119e, eb1c9a6. |
| `compose.yml` (vllm + vllm-embed services) | Locked image v0.21.0-cu129; D-A3 flags; ipc:host; shm_size:16gb; healthcheck start_period:1200s/300s; gpu-preflight depends_on | VERIFIED | Both services declared at lines 232 + 306. Image pin verbatim. `--quantization=awq_marlin`, `--max-model-len=8192`, `--gpu-memory-utilization=0.45/0.25`, `--enable-auto-tool-choice`, `--tool-call-parser=hermes`. ipc:host + shm_size 16gb/8gb. start_period:1200s (chat — Wave 0 override of the 600s in CONTEXT) + 300s (embed). vllm-embed has `--runner=pooling` + `--hf-overrides {"architectures":["BgeM3EmbeddingModel"]}` per CLOSED R-1. |
| `compose.yml` (nvidia_gpu_exporter + prometheus + grafana) | OBS-02 + OBS-03 services on backend network | VERIFIED | Lines 374, 425, 484. nvidia_gpu_exporter has explicit nvidia-smi + libnvidia-ml.so bind-mounts (R-6 / Pitfall G-3). Grafana has GF_SECURITY_ADMIN_PASSWORD from .env. Traefik labels present for grafana.<tailnet>.ts.net via webui-basic-auth@docker. |
| `.env.example` | GRAFANA_ADMIN_PASSWORD + HUGGINGFACE_HUB_TOKEN | VERIFIED | Both vars present; openssl rand -hex 24 recipe documented; HF token optional with empty default. |
| `prometheus/prometheus.yml` | 5 scrape jobs | VERIFIED | router:3000, vllm/vllm-embed:8000, llamacpp:8080, nvidia_gpu_exporter:9835, prometheus localhost:9090. |
| `grafana/provisioning/datasources/datasource.yml` | uid:prometheus-default | VERIFIED | apiVersion:1, uid:prometheus-default, isDefault:true, editable:false, timeInterval:15s. |
| `grafana/provisioning/dashboards/local-llms.yml` | Dashboard provider config | VERIFIED | apiVersion:1, provider name `local-llms`, options.path `/etc/grafana/dashboards`. |
| `grafana/provisioning/dashboards/local-llms.json` | uid:local-llms with 6+ panels | VERIFIED | uid:`local-llms`, 7 panels, all reference `prometheus-default`. WR-01 fix applied to per-GPU VRAM math. |
| `router/src/config/registry.ts` | LocalBackendEnum widened to include vllm + vllm-embed | VERIFIED | `z.enum(['ollama', 'llamacpp', 'vllm', 'vllm-embed'])` at line 17. |
| `router/src/backends/vllm-openai.ts` | VLLMOpenAIAdapter implements BackendAdapter | VERIFIED | 172 lines. `implements BackendAdapter` at line 44. Implements chatCompletionsCanonical + chatCompletionsCanonicalStream + probeLiveness + embeddings. Single class serves both vllm + vllm-embed via baseURL injection. |
| `router/src/backends/factory.ts` | ADAPTERS map includes vllm + vllm-embed | VERIFIED | `'vllm': VLLMOpenAIAdapter` + `'vllm-embed': VLLMOpenAIAdapter` (same class, different baseURL per entry.backend_url). |
| `router/src/backends/liveness.ts` | Scheduler treats vllm + vllm-embed as scrapeable URLs | VERIFIED (by design) | Scheduler is URL-driven (no hardcoded backend list). app.ts:314 derives `distinctBackendUrls` from `registry.get().models.map(m => m.backend_url)` so the two new entries are probed automatically. |
| `router/models.yaml` | qwen2.5-7b-instruct-awq + bge-m3-ollama + bge-m3-vllm entries | VERIFIED | All three entries present with correct capabilities, vram_budget_gb, backend_url, profile. backends section adds `vllm` and `vllm-embed` keys with base_url + concurrency. |
| `router/src/backends/adapter.ts` | BackendAdapter interface gains `.embeddings()` method | VERIFIED | Lines 94-108 declare the new method. JSDoc at lines 66-93 documents CR-01 fix (encoding_format / dimensions / user opts). |
| `router/src/backends/ollama-openai.ts` | `.embeddings()` impl forwarding to Ollama /v1/embeddings | VERIFIED | Lines 217-243 implement with conditional spread for opts. |
| `router/src/backends/llamacpp-openai.ts` | `.embeddings()` throws CapabilityNotSupportedError | VERIFIED | Lines 118-132 throw `CapabilityNotSupportedError('llamacpp', 'embeddings')`. |
| `router/src/routes/v1/embeddings.ts` | POST /v1/embeddings with zod + capability gate + recordRequestOutcome | VERIFIED | 215 lines. EmbeddingsRequestSchema enforces Pitfall E-1 (non-empty string OR non-empty array of non-empty strings). Capability gate at line 154 fires BEFORE semaphore acquire. Outer finally records outcome on both success + error paths via safeRecord idempotency pattern. Forwards encoding_format / dimensions / user per CR-01. |
| `router/src/app.ts` | registerEmbeddingsRoute invocation + isRecordedRoute widened | VERIFIED | Line 19 imports; line 430 registers; lines 197-201 widen isRecordedRoute allowlist; line 200 includes `/v1/embeddings`. |
| `bin/smoke-test-observability.sh` | 6 sections per Plan 07-06 contract | VERIFIED | 232 lines (executable, bash -n clean). Sections: Prometheus targets, up{} always-on, up{} profile-aware, nvidia_smi sample, Grafana datasource, Grafana dashboard. WR-02 fix: pre-flight wget check inside containers. WR-07 fix: literal single-quoted error message (no backtick command substitution). |
| `bin/smoke-test-router.sh` (extended) | Phase 7 section with embeddings + request_log assertions | VERIFIED | Phase 7 section at lines 1296-1428 (~133 lines). 6 sub-checks: bge-m3 present in Ollama, bge-m3-ollama→1024, capability gate, zod gate, bge-m3-vllm→1024, request_log distinct rows. WR-06 fix: awk-based count parser replaces fragile regex. |
| `README.md` | §Phase 7 with profile commands + embeddings curls + Grafana access + env var generation + Pitfall mentions | VERIFIED | §"Phase 7 — Embeddings + vLLM + GPU Telemetry" at line 828+; covers --profile vllm pattern, bge-m3 curls for both backends, GRAFANA_ADMIN_PASSWORD generation, Pitfall P-2 + G-3 + V-2 operator steps. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `compose.yml services.vllm` | `${HOST_DATA_ROOT}/models-hf/` | HF cache bind-mount at `/root/.cache/huggingface` | WIRED | Volume mount present. |
| `compose.yml services.vllm-embed` | BAAI/bge-m3 with `--runner=pooling` + `--hf-overrides` | vLLM pooling runner per CLOSED R-1 | WIRED | `BgeM3EmbeddingModel` literal present at line 321. |
| `compose.yml services.{vllm,vllm-embed}` | `gpu-preflight` one-shot | `depends_on: condition: service_completed_successfully` | WIRED | Both services have gpu-preflight depends_on entries. |
| `compose.yml services.prometheus` | `prometheus/prometheus.yml` | bind-mount `:ro` | WIRED | Verified. |
| `compose.yml services.grafana` | `grafana/provisioning/datasources/datasource.yml` + `local-llms.yml` + `local-llms.json` | bind-mount `:ro` | WIRED | All three provisioning files bind-mounted. |
| `compose.yml services.nvidia_gpu_exporter` | host `/usr/bin/nvidia-smi` + `libnvidia-ml.so` | Explicit volume bind-mounts | WIRED | Per Pitfall G-3 / R-6. |
| `router/src/backends/vllm-openai.ts` | `BackendAdapter` interface | `implements BackendAdapter` | WIRED | Line 44. |
| `router/src/backends/factory.ts ADAPTERS` | `VLLMOpenAIAdapter` constructor | Map entries for both `vllm` and `vllm-embed` | WIRED | Verified — both map to same class with per-entry baseURL injection. |
| `router/models.yaml` | `compose.yml vllm + vllm-embed services` | backend_url points at Docker DNS | WIRED | `http://vllm:8000/v1` and `http://vllm-embed:8000/v1`. |
| `router/src/routes/v1/embeddings.ts` | `adapter.embeddings(input, backend_model, signal, {opts})` | calls adapter.embeddings | WIRED | Line 166-170. Forwards opts (CR-01 fix). |
| `router/src/routes/v1/embeddings.ts` | `recordRequestOutcome` | calls `opts.recordOutcome({protocol, route, ...})` in finally | WIRED | Lines 190-211 via `safeRecord` idempotency closure. |
| `router/src/routes/v1/embeddings.ts` | `CapabilityNotSupportedError` | throws when `entry.capabilities` does not include `'embeddings'` | WIRED | Line 154-156. |
| `grafana/.../local-llms.yml` | `/etc/grafana/dashboards/local-llms.json` | bind-mount + options.path | WIRED | Verified. |
| `grafana/.../local-llms.json panel targets` | `grafana/.../datasource.yml` | `datasource.uid: prometheus-default` | WIRED | All 7 panels reference uid `prometheus-default`. |
| `bin/smoke-test-observability.sh` | Prometheus `/api/v1/targets` + `/api/v1/query?query=up` | `docker compose exec -T prometheus wget` | WIRED | Verified. |
| `bin/smoke-test-observability.sh` | Grafana `/api/datasources/uid/prometheus-default` + `/api/dashboards/uid/local-llms` | `docker compose exec -T grafana wget --user admin:$GRAFANA_ADMIN_PASSWORD` | WIRED | Verified. |
| `bin/smoke-test-router.sh` | POST `/v1/embeddings` via router edge | `curl -fsS -H Authorization: Bearer ...` | WIRED | Lines 1325-1389 for both backends. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `routes/v1/embeddings.ts` (route handler) | `result` (embedding vector) | `adapter.embeddings()` → SDK → upstream Ollama/vLLM | YES (live SDK call, no static return; verified by smoke checking dim==1024) | FLOWING |
| `vllm-openai.ts.embeddings()` | upstream response | `this.client.embeddings.create({...})` via OpenAI SDK against `http://vllm-embed:8000/v1` | YES (SDK passthrough, no fallback) | FLOWING |
| `ollama-openai.ts.embeddings()` | upstream response | `this.client.embeddings.create({...})` via OpenAI SDK against `http://ollama:11434/v1` | YES | FLOWING |
| `local-llms.json` Grafana panels (×7) | Prometheus query result | PromQL against `prometheus-default` datasource → scrapes from router/vllm/llamacpp/gpu/prometheus | YES (live PromQL; not hardcoded data); operator UAT confirms VRAM panel shows non-zero | needs_human (visual) |
| `request_log` row insertion | `recordRequestOutcome({backend: entry.backend, ...})` | route's outer finally → bufferedWriter → Postgres | YES (resolved entry.backend, not 'unknown'; safeRecord idempotency suppresses double-fire from error handler) | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| All 3 smoke scripts parse cleanly | `bash -n bin/smoke-test-{vllm-coldstart,observability,router}.sh` | All exit 0 | PASS |
| Compose validates with --profile vllm | `docker compose --profile vllm config --quiet` | Exit 0 (with non-blocking warning that GRAFANA_ADMIN_PASSWORD is blank — expected since .env on verifier host is .env.bak'd) | PASS |
| Router test suite passes | `cd router && npm test` | **524 passed, 2 skipped** across 43 files in 5.92s | PASS |
| Models.yaml has both bge-m3 embedding entries | yaml.safe_load + filter capabilities=='embeddings' | `['bge-m3-ollama', 'bge-m3-vllm']` | PASS |
| Grafana dashboard JSON valid + panel count >= 6 | `python3 json.load` | uid='local-llms', 7 panels, all use ds_uid='prometheus-default' | PASS |
| Live vLLM /v1/embeddings happy-path returns 1024-dim | curl -X POST .../v1/embeddings -d '{"model":"bge-m3-{ollama,vllm}",...}' | Not run from verifier (no GPU access) | SKIP — routed to human-verify |
| live observability smoke | bash bin/smoke-test-observability.sh | Not run from verifier (no Prometheus + Grafana running) | SKIP — routed to human-verify |

### Probe Execution

Phase 7 has three probe-style scripts. The Wave 0 cold-start probe was executed by the operator during Plan 07-00 (`OUTCOME: locked` recorded). The two Wave 4 smoke scripts are by-design human-verify (Plan 07-06 is `autonomous: false`).

| Probe | Command | Result | Status |
|---|---|---|---|
| `bin/smoke-test-vllm-coldstart.sh` | `bash bin/smoke-test-vllm-coldstart.sh` (operator-run, Wave 0) | OUTCOME: locked — awq_marlin Marlin kernel proven on sm_120; 5.29 GiB GPU allocation; FlashAttention 2 selected; torch.compile cache produced. Timeout at 900s fired AFTER kernel proof — empirical cold-start floor ~1000–1200s drove start_period:1200s in compose.yml. | PASS (operator) |
| `bin/smoke-test-observability.sh` | `bash bin/smoke-test-observability.sh` (requires live stack) | Not run from verifier | needs_human |
| `bin/smoke-test-router.sh` (Phase 7 section) | `bash bin/smoke-test-router.sh` (requires live stack + bearer token + Postgres + bge-m3 pulled into Ollama) | Not run from verifier | needs_human |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| BCKND-03 | 07-00, 07-01, 07-03, 07-06 | vLLM serves AWQ model with `--max-model-len` + `--gpu-memory-utilization 0.45` + `ipc:host` + `shm_size:16gb` | SATISFIED (code) | compose.yml:232-289 (vllm) + 306-348 (vllm-embed); registry.ts widens enum; factory.ts dispatches; models.yaml declares qwen2.5-7b-instruct-awq with vram_budget_gb 7.2; Wave 0 OUTCOME locked. |
| OAI-02 | 07-03, 07-04, 07-06 | `POST /v1/embeddings` works against Ollama embedding model AND vLLM embedding model | SATISFIED (code) + needs_human (live) | routes/v1/embeddings.ts (215 lines); adapter.ts widened; ollama-openai.ts + vllm-openai.ts both implement; smoke asserts dim==1024 for both backends. |
| EMBED-01 | 07-04, 07-06 | `/v1/embeddings` against Ollama + vLLM embedding models | SATISFIED (code) + needs_human (live) | Same as OAI-02; capability gate enforced server-side via entry.capabilities. |
| EMBED-02 | (none — explicitly deferred) | `/v1/embeddings` passthrough against Ollama Cloud compat endpoint | DEFERRED | ROADMAP Phase 7 footnote: "EMBED-02 (Ollama Cloud passthrough) deferred to Phase 8 per CONTEXT — the ROADMAP requirement line above includes EMBED-02 but Phase 7 plans cover only six requirements; EMBED-02 lands in Phase 8." No Phase 7 plan declared EMBED-02 in its frontmatter. REQUIREMENTS.md confirms Pending. |
| OBS-02 | 07-02, 07-06 | vLLM `/metrics` + llama.cpp `/metrics` scraped by Prometheus | SATISFIED (code) + needs_human (live up{}) | prometheus.yml has vllm + llamacpp jobs; smoke asserts up{}==1. |
| OBS-03 | 07-02, 07-06 | GPU exporter running + scraped | SATISFIED (code) + needs_human (live nvidia-smi sample) | nvidia_gpu_exporter v1.4.1 declared in compose.yml with explicit bind-mounts (Pitfall G-3); gpu job in prometheus.yml; smoke asserts nvidia_smi_memory_used_bytes returns numeric sample. |
| OBS-04 | 07-05, 07-06 | Grafana dashboard shows VRAM, request rate, TTFT, error rate, backend selection | SATISFIED (code) + needs_human (visual render) | local-llms.json (7 panels), datasource.yml + dashboards.yml provisioning, README §Phase 7. |

**EMBED-02 is the only requirement on Phase 7's roadmap line that does not appear in any plan frontmatter — by design, deferred to Phase 8.** All other six requirements are explicitly claimed by at least one Phase 7 plan and code-side satisfied.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| (none) | — | — | — | Modified files scanned for TBD/FIXME/XXX/placeholder/"not yet implemented"; the only matches in {vllm,ollama,llamacpp}-openai.ts are JSDoc comments describing the SDK's required non-empty `apiKey: 'placeholder'` argument (the OpenAI SDK throws on empty apiKey — this is the documented backend-pattern, not a debt marker). No actual TBD/FIXME/XXX present. |

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|---|----------|
| 1 | EMBED-02 — Ollama Cloud `/v1/embeddings` passthrough | Phase 8 — Ollama Cloud Fallback + Resilience Hardening | ROADMAP Phase 7 footnote explicitly defers EMBED-02 to Phase 8; Phase 8 carries CLOUD-01..05 + ROUTE-10..12 which include the ollama-cloud adapter that EMBED-02 depends on. |
| 2 | CR-02 — `probeAdapterFor()` URL→backend lookup ambiguity under multi-backend-same-URL | Phase 8 (OllamaCloudAdapter introduction) | 07-REVIEW-FIX.md documents this as a Phase 8 blocker — current 4 backends do not share URLs so the fragility is latent; Phase 8 must add a registry validator + change the cache key shape before OllamaCloudAdapter ships. |
| 3 | WR-04 — extract `safeRecord` / `safeRelease` helper across three routes | Phase 8+ standalone refactor | 07-REVIEW-FIX.md flagged as refactor-scope; no current bug — REVIEW.md explicitly concluded "the recording-and-release flow is correct". |
| 4 | `hotreload.vram.test.ts` flaky test | Standalone `/gsd-quick` task | Pre-existing timing sensitivity unrelated to Phase 7. Tracked in `deferred-items.md`. |

### Human Verification Required

Plan 07-06 Task 3 is by-design `autonomous: false` — the operator must bring up the live stack with `--profile vllm`, run both smoke scripts end-to-end, watch the Grafana dashboard render real metrics, and approve the phase. The 8 items in the `human_verification:` frontmatter block above mirror the exact operator checklist from 07-06-SUMMARY.md §"User Setup Required". The verifier's worktree has no NVIDIA GPU access, no permission to bring up the live stack, and no way to render a browser dashboard.

**Approve criteria (all four — operator must confirm):**
- Both smoke scripts exit 0
- Grafana dashboard renders with live data on all six required panels
- request_log has distinct rows for `backend IN ('ollama','vllm-embed')`
- nvidia-smi shows realistic VRAM (no silent CPU fallback)

### Gaps Summary

**No code-side gaps were found in this verification pass.** Every artifact declared in Phase 7's seven plan frontmatters exists with substantive content, is wired into its consumers, and (for artifacts that render dynamic data) the data flow is live (real SDK calls, real Prometheus queries, real Postgres inserts) rather than static.

The 4/5 score reflects the operational reality of Phase 7: 4 success criteria are fully provable from code + 1 (SC4, Grafana dashboard rendering with live data) is fundamentally an operator-eyeball check. All 5 SCs additionally require operator UAT to confirm the live stack behaviour matches the code-side claims — that's the canonical purpose of Plan 07-06 Task 3.

Phase 7 cannot close until the operator runs the 8-item checklist on the RTX 5060 Ti host with `--profile vllm` active and replies `approved`.

---

_Verified: 2026-05-17T04:34:18Z_
_Verifier: Claude (gsd-verifier)_
