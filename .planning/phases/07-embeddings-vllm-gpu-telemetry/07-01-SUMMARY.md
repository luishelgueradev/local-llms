---
phase: 7
plan: 01
subsystem: compose-vllm-services
tags: [vllm, vllm-embed, compose, bge-m3, qwen25, awq-marlin, bcknd-03, wave-0-locked]
dependency_graph:
  requires:
    - phase-01-d-02-host-data-root          # ${HOST_DATA_ROOT}/models-hf/ + gpu-init-libcuda.sh wrapper
    - phase-01-d-04-gpu-preflight           # depends_on: gpu-preflight condition
    - phase-01-d-13-networks                # backend + app already declared
    - phase-07-00-vllm-coldstart-locked     # Wave 0 OUTCOME: locked (07-00-SUMMARY.md)
  provides:
    - phase-07-vllm-compose-block           # vllm + vllm-embed service definitions
    - phase-07-vllm-compile-cache-mount     # /root/.cache/vllm bind-mount on host
    - phase-07-env-grafana-admin-password   # consumed by Plan 07-02
    - phase-07-env-huggingface-hub-token    # optional; consumed by both vllm services
  affects:
    - phase-07-plan-02-observability-stack  # Prometheus scrape config will target vllm:8000 + vllm-embed:8000
    - phase-07-plan-03-router-vllm-adapter  # router will dispatch to vllm/vllm-embed via these container names
    - phase-07-plan-06-live-boot-verify     # human-verify plan that actually runs `docker compose --profile vllm up`
tech-stack:
  added:
    - "vllm/vllm-openai:v0.21.0-cu129 (chat + embed; same image, different runner)"
    - "Qwen/Qwen2.5-7B-Instruct-AWQ (vLLM chat model — awq_marlin kernel)"
    - "BAAI/bge-m3 (vLLM embed model — pooling runner, BgeM3EmbeddingModel arch)"
  patterns:
    - "Two-service vLLM topology (chat process + embed process) — CLOSED R-1 dictates: vLLM cannot serve generation+pooling in one process"
    - "Wave 0 directive override of CONTEXT D-A4: start_period bumped from 600s → 1200s for vllm: per empirical cold-start floor on this host"
    - "Bind-mount of /root/.cache/vllm to host vllm-compile-cache dir — amortizes the 264s torch.compile cost across cold-starts"
    - "VLLM_FLASH_ATTN_VERSION=2 as defensive baseline (always set; vLLM auto-selected FA2 anyway per Wave 0 logs — kept for forward-compat)"
key-files:
  created: []
  modified:
    - compose.yml
    - bin/bootstrap-host.sh
    - .env.example
decisions:
  - "Wave 0 OUTCOME: locked applied verbatim — --quantization=awq_marlin (not awq), no VLLM_USE_TRITON_AWQ=1, FA2 set defensively."
  - "start_period: 1200s on vllm (Wave 0 override of D-A4 600s). start_period: 300s on vllm-embed (smaller model, fast cold-start)."
  - "Both services use entrypoint:[/usr/local/bin/gpu-init-libcuda.sh] + command:[python3, -m, vllm.entrypoints.openai.api_server, ...] so the WSL2 libcuda projection wrapper from Phase 1 runs before vLLM's Python entrypoint. Mirrors ollama + llamacpp services exactly."
  - "Added /srv/local-llms/vllm-compile-cache to bin/bootstrap-host.sh DIRS + chown loop (Rule 3 scope expansion per Wave 0 directive; Plan 07-01 was identified as the responsible owner)."
  - "Did NOT run `docker compose up`. Validation surface = `docker compose config -q` only. Live boot owned by Plan 07-06 (human-verify)."
metrics:
  duration_minutes: 15
  completed_date: "2026-05-16"
  commits: 2
outcome: locked
requirements-completed: [BCKND-03]
---

# Phase 7 Plan 01: vLLM + vllm-embed Compose Services Summary

Added two Compose services (`vllm`, `vllm-embed`) wired to the locked Wave 0 stack — `vllm/vllm-openai:v0.21.0-cu129` with `awq_marlin` quantization and FlashAttention v2. Plan 07-00 empirically resolved Pitfall V-1 (sm_120 Blackwell kernel compat) and provided two Wave 0 overrides: `start_period: 1200s` on the chat service (not the 600s in D-A4) and a bind-mounted `/root/.cache/vllm` torch.compile cache. Both directives are reflected in this plan's output. The default Compose profile still excludes both services (`profiles: [vllm]` — activate with `docker compose --profile vllm up -d`). No `docker compose up` was run here; the live boot is owned by Plan 07-06.

## Wave 0 outcome applied

**OUTCOME: locked** (verified via `grep -oE 'OUTCOME: (locked|fallback-env|fallback-quant)' 07-00-SUMMARY.md`).

| Knob | Value applied | Reason |
|---|---|---|
| `--quantization` (vllm) | `awq_marlin` | Wave 0 smoke confirmed Marlin kernel works on sm_120 — no quant fallback needed |
| `VLLM_USE_TRITON_AWQ` (vllm + vllm-embed) | **not set** | Marlin path works; no env fallback needed |
| `VLLM_FLASH_ATTN_VERSION` (both) | `=2` | Defensive baseline; vLLM auto-selected FA2 anyway per Wave 0 logs (07-00-SUMMARY.md proof-of-success block) |
| `vllm.healthcheck.start_period` | **`1200s`** (Wave 0 override of D-A4's 600s) | Empirical cold-start floor on this host is ~1000–1200s; 07-00-SUMMARY.md §"Implications for downstream plans" item 2 |
| `vllm-embed.healthcheck.start_period` | `300s` | bge-m3 is ~2GB; smaller model + no heavy torch.compile path; 5min suffices |
| `/root/.cache/vllm` bind-mount | host `${HOST_DATA_ROOT}/vllm-compile-cache` | Amortizes 264s torch.compile cost across cold-starts (Wave 0 directive item 3) |

## compose.yml diff shape

Two new top-level service blocks inserted between the existing `llamacpp:` block and the existing `router:` block. Plus one DIRS-array entry in bin/bootstrap-host.sh.

### `vllm:` block (chat) — key flags

```yaml
vllm:
  image: vllm/vllm-openai:v0.21.0-cu129
  profiles: [vllm]
  <<: *gpu
  ipc: host
  shm_size: 16gb
  entrypoint: ["/usr/local/bin/gpu-init-libcuda.sh"]
  command:
    - python3
    - -m
    - vllm.entrypoints.openai.api_server
    - --model=Qwen/Qwen2.5-7B-Instruct-AWQ
    - --quantization=awq_marlin              # Wave 0 OUTCOME: locked
    - --max-model-len=8192
    - --gpu-memory-utilization=0.45
    - --enable-auto-tool-choice
    - --tool-call-parser=hermes              # CLOSED R-2
    - --served-model-name=Qwen/Qwen2.5-7B-Instruct-AWQ
    - --host=0.0.0.0
    - --port=8000
  environment:
    - VLLM_FLASH_ATTN_VERSION=2
    - HF_HOME=/root/.cache/huggingface
    - HF_HUB_CACHE=/root/.cache/huggingface
    - HUGGINGFACE_HUB_TOKEN=${HUGGINGFACE_HUB_TOKEN:-}
  volumes:
    - ${HOST_DATA_ROOT:-/srv/local-llms}/models-hf:/root/.cache/huggingface
    - ${HOST_DATA_ROOT:-/srv/local-llms}/vllm-compile-cache:/root/.cache/vllm   # NEW — Wave 0 directive
    - ./bin/gpu-init-libcuda.sh:/usr/local/bin/gpu-init-libcuda.sh:ro
  networks: [backend, app]
  healthcheck:
    test: ["CMD-SHELL", "curl -fsS http://localhost:8000/health || exit 1"]
    interval: 30s
    timeout: 5s
    start_period: 1200s                       # Wave 0 override of D-A4 600s
    retries: 10
  depends_on:
    gpu-preflight:
      condition: service_completed_successfully
```

### `vllm-embed:` block (embed) — key flags

```yaml
vllm-embed:
  image: vllm/vllm-openai:v0.21.0-cu129       # same image as vllm:
  profiles: [vllm]
  <<: *gpu
  ipc: host
  shm_size: 8gb
  entrypoint: ["/usr/local/bin/gpu-init-libcuda.sh"]
  command:
    - python3
    - -m
    - vllm.entrypoints.openai.api_server
    - --model=BAAI/bge-m3
    - --runner=pooling                        # CLOSED R-1
    - '--hf-overrides={"architectures":["BgeM3EmbeddingModel"]}'
    - --gpu-memory-utilization=0.25
    - --max-model-len=8192
    - --served-model-name=BAAI/bge-m3
    - --host=0.0.0.0
    - --port=8000
  environment:
    - VLLM_FLASH_ATTN_VERSION=2
    - HF_HOME=/root/.cache/huggingface
    - HF_HUB_CACHE=/root/.cache/huggingface
    - HUGGINGFACE_HUB_TOKEN=${HUGGINGFACE_HUB_TOKEN:-}
  volumes:
    - ${HOST_DATA_ROOT:-/srv/local-llms}/models-hf:/root/.cache/huggingface
    - ${HOST_DATA_ROOT:-/srv/local-llms}/vllm-compile-cache:/root/.cache/vllm   # shared with vllm:
    - ./bin/gpu-init-libcuda.sh:/usr/local/bin/gpu-init-libcuda.sh:ro
  networks: [backend, app]
  healthcheck:
    test: ["CMD-SHELL", "curl -fsS http://localhost:8000/health || exit 1"]
    interval: 30s
    timeout: 5s
    start_period: 300s
    retries: 10
  depends_on:
    gpu-preflight:
      condition: service_completed_successfully
```

## .env.example diff shape

Appended after the existing Phase 6 `TRAEFIK_BASIC_AUTH_PASS_PLAIN=` line. Two new env vars under a `# ── Phase 7 — Embeddings + vLLM + GPU Telemetry ──` header:

| Var | Default | Generation recipe | Consumer |
|---|---|---|---|
| `GRAFANA_ADMIN_PASSWORD` | (no default) | `openssl rand -hex 24` | Plan 07-02's grafana service (GF_SECURITY_ADMIN_PASSWORD) |
| `HUGGINGFACE_HUB_TOKEN` | empty | https://huggingface.co/settings/tokens (READ scope) | vllm + vllm-embed (optional — Qwen2.5-7B-AWQ + bge-m3 are public) |

## Host directory pre-creation evidence

```
$ ls -la /srv/local-llms/vllm-compile-cache
total 8
drwxrwxr-x  2 luis luis 4096 May 16 20:34 .
drwxr-xr-x 11 luis luis 4096 May 16 20:34 ..
```

Empty directory, owned by the invoking user (matches Phase 1 bootstrap-host.sh chown loop for models-hf, valkey, traefik). `bin/bootstrap-host.sh` was extended to include this dir in both its DIRS array and its chown loop so re-runs are idempotent.

## `docker compose --profile vllm config` validation output

Verbatim acceptance check results:

```
=== docker compose config WARN count (expect 0) ===
0

=== Services under --profile vllm (expect vllm + vllm-embed listed) ===
['gpu-preflight', 'openwebui', 'pg-backup', 'postgres', 'router', 'traefik', 'vllm', 'vllm-embed']
vllm: True
vllm-embed: True

=== vllm.image (expect vllm/vllm-openai:v0.21.0-cu129) ===
vllm/vllm-openai:v0.21.0-cu129

=== vllm.healthcheck.start_period (expect 1200s / 20m0s) ===
20m0s

=== vllm-embed.command contains --runner=pooling AND --hf-overrides ===
--runner=pooling: True
--hf-overrides: True

=== default profile excludes vllm + vllm-embed (expect both False) ===
vllm in services: False
vllm-embed in services: False

=== host vllm-compile-cache dir (expect dir exists) ===
EXISTS

=== .env.example new vars present (expect each 1) ===
GRAFANA_ADMIN_PASSWORD: 1
HUGGINGFACE_HUB_TOKEN:  1
```

Every acceptance criterion the orchestrator listed passes.

## Plan-mandated automated verifier (PLAN.md task 1 `<verify><automated>`)

Note: the PLAN.md verifier line still asserts `start_period: 600s`. The Wave 0 directive (07-00-SUMMARY.md §"Implications for downstream plans" item 2) explicitly overrides D-A4 from 600s → 1200s. So the literal PLAN.md verifier would fail on the 600s grep — by design. The orchestrator's `<acceptance_after_completion>` block (which is what actually gates this plan) asserts `1200s` and passes.

Documented as a Rule 4-adjacent acknowledgment: **no architectural decision needed** — the override was already a closed decision recorded in 07-00-SUMMARY.md before this plan started.

| Original PLAN.md check | Wave 0-corrected expectation | Result |
|---|---|---|
| `start_period: 600s` present | `start_period: 1200s` present | PASS (1200s present) |
| Image v0.21.0-cu129 ≥ 2x | Same | PASS (2 occurrences) |
| `profiles: [vllm]` ≥ 2x | Same | PASS (2 occurrences) |
| `start_period: 300s` present | Same | PASS |
| `VLLM_FLASH_ATTN_VERSION=2` present | Same | PASS (on both services) |
| `--runner=pooling` present | Same | PASS |
| `BgeM3EmbeddingModel` present | Same | PASS |
| `--tool-call-parser=hermes` present | Same | PASS |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pre-created `/srv/local-llms/vllm-compile-cache` host dir AND extended bin/bootstrap-host.sh**
- **Found during:** Task 1 verification (the bind-mount path would not exist on a fresh host).
- **Issue:** The Wave 0 directive item 3 in 07-00-SUMMARY.md requires bind-mounting `${HOST_DATA_ROOT}/vllm-compile-cache:/root/.cache/vllm` on both vLLM services, but the directory does not exist on the host AND `bin/bootstrap-host.sh` (the canonical idempotent host-tree creator) did not list it. On first `docker compose --profile vllm up -d`, Compose's "create-missing-bind-source" behavior would create the dir as root (since dockerd runs as root) and the cache writes from inside the container would also be root-owned — fine for first boot, but inconsistent with the rest of `${HOST_DATA_ROOT}` (user-owned).
- **Fix:** (a) `mkdir -p /srv/local-llms/vllm-compile-cache` so the dir exists with the correct uid:gid right now; (b) added the path to `bin/bootstrap-host.sh`'s DIRS array AND the targeted chown loop (matching the pattern for models-hf / valkey / traefik) so future operators bootstrapping a fresh host get the same dir + ownership without manual intervention. The 07-00-SUMMARY.md item explicitly identified this as a Plan 07-01 responsibility ("Plan 07-01's responsibility or Phase 9's").
- **Files modified:** `bin/bootstrap-host.sh` (3 inserts: DIRS array + echo line + chown loop)
- **Commit:** `8674459` (folded into Task 1 commit since both edits are part of the "land the vllm-compile-cache bind-mount on a fresh host" semantic unit)
- **Rationale:** Rule 3 — without this fix, the operator running a Wave 0-mandated bind-mount on a fresh-host bootstrap would either get a runtime mkdir-as-root surprise or have to discover the missing dir empirically. Aligns with Phase 1 D-02's principle of "single source of truth for the v1 host directory list".

**2. [Rule 2 - Missing critical functionality] Added `entrypoint: ["/usr/local/bin/gpu-init-libcuda.sh"]` to both new vLLM services**
- **Found during:** Task 1 implementation review.
- **Issue:** The plan's `<action>` block called out mounting the gpu-init-libcuda.sh wrapper RO ("ALSO mount `./bin/gpu-init-libcuda.sh:/usr/local/bin/gpu-init-libcuda.sh:ro` (same WSL2/Docker Desktop libcuda pattern Ollama + llamacpp use)") but did NOT explicitly say to set the `entrypoint:` to it. Mounting the script without wiring it as the entrypoint would mean the WSL2 libcuda projection workaround does nothing — vLLM would dlopen `libcuda.so.1` directly and fail on Docker Desktop hosts (Phase 1's libcuda projection is the published mitigation for this exact failure mode; see bin/gpu-init-libcuda.sh lines 17–24).
- **Fix:** Added `entrypoint: ["/usr/local/bin/gpu-init-libcuda.sh"]` + `command: ["python3", "-m", "vllm.entrypoints.openai.api_server", ...]` on both services. The wrapper `exec "$@"`s through to the original Python entrypoint, so vLLM's behavior is unchanged on native Linux + NCT (the wrapper short-circuits at line 42-44 when libcuda is already discoverable).
- **Files modified:** `compose.yml` (vllm + vllm-embed service blocks)
- **Commit:** `8674459`
- **Rationale:** Rule 2 — correctness requirement for WSL2 / Docker Desktop portability. Matches the pattern Phase 1 D-04 established for ollama (compose.yml line 105) and Phase 3 D-A5 reused for llamacpp (compose.yml line 180). Without this, the vLLM services would technically be valid Compose but functionally broken on the Wave 0 host that just proved the kernel works.

### Did NOT deviate

- DID NOT touch ollama / llamacpp / postgres / pg-backup / router / openwebui / traefik / gpu-preflight (per critical_constraints).
- DID NOT run `docker compose up` (per critical_constraints — Plan 07-06 / human-verify owns the live boot).
- DID NOT add Pitfall V-1 fallback env vars (`VLLM_USE_TRITON_AWQ`) or fallback quant (`awq`) — Wave 0 OUTCOME: locked rules them out.
- DID NOT redefine the x-gpu anchor or networks declarations (per critical_constraints).
- DID NOT publish host ports on either service.

## Hand-off to Plan 07-02 (Observability stack)

- vLLM service blocks exist in compose.yml but the default profile does NOT bring them up. Prometheus scrape config (Plan 07-02 will write `prometheus/prometheus.yml`) targets `vllm:8000` and `vllm-embed:8000`. **Expected behavior:** when the vllm profile is down, Prometheus will mark those scrape targets as `down` (status `503` / `connection refused`). This is correct and intentional — Prometheus surfaces the inference layer's health regardless of profile state. The Grafana dashboard (Plan 07-02) will show vLLM panels as "no data" when `--profile vllm` is not active.
- `GRAFANA_ADMIN_PASSWORD` env var is now declared in `.env.example`; Plan 07-02 can wire it directly into the grafana service as `GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}` without further .env.example churn.
- The `${HOST_DATA_ROOT}/prometheus` and `${HOST_DATA_ROOT}/grafana` directories are still NOT pre-created (Plan 07-02's responsibility to extend `bin/bootstrap-host.sh` further, following the same idempotent-DIRS pattern this plan just used for vllm-compile-cache).
- No merge conflict surface on `compose.yml`: Plan 07-02 will append its prometheus / grafana / gpu-exporter blocks AFTER the `openwebui:` block (the bottom of services:) — disjoint from this plan's vllm/vllm-embed blocks (inserted between llamacpp: and router:).

## Hand-off to Plan 07-03 (Router vLLM adapter)

- `vllm` and `vllm-embed` are the container names the router's `VLLMOpenAIAdapter` will dial. Both join the `backend` network where the router lives → DNS resolves as `http://vllm:8000` and `http://vllm-embed:8000`.
- BCKND-03 is **partially** complete after this plan: the Compose surface exists; the runtime live verification (a successful `--profile vllm up -d vllm vllm-embed` that produces `200 OK` on `/health` for both) is owned by Plan 07-06 (human-verify). The PLAN.md frontmatter requirements field lists BCKND-03; this plan satisfies the compose-side portion.

## Known Stubs

None — both new service blocks are wired with all required flags, volumes, healthchecks, and dependencies. No placeholder env values; no "TODO" comments; no commented-out command flags.

## Threat Flags

None — no new external network surface. Both services join only the internal `backend` network + the `app` network (used for HF egress to huggingface.co, which is in scope for vLLM's documented model-pull behavior). No host ports published. No Traefik labels (vLLM is router-only, not edge-exposed). Schema changes: none. The `HUGGINGFACE_HUB_TOKEN` env var is the only new credential surface; it has an empty default, T-07-02 disposition `accept` per the plan's threat register, and never flows through the router process.

## Self-Check

- [x] `compose.yml` updated — `git log -1 --name-only` lists it in commit `8674459`.
- [x] `bin/bootstrap-host.sh` updated — same commit, includes vllm-compile-cache in DIRS + chown loop, parses cleanly under `bash -n`.
- [x] `.env.example` updated — `git log -1 --name-only` lists it in commit `7de1346`.
- [x] `/srv/local-llms/vllm-compile-cache` directory exists with correct ownership (`drwxrwxr-x luis luis`).
- [x] `docker compose --profile vllm config -q` exits 0 (no errors, no warnings).
- [x] `docker compose --profile vllm config` lists both `vllm` and `vllm-embed` under `services:`.
- [x] `docker compose config` (default profile) does NOT list `vllm` or `vllm-embed`.
- [x] Image pin `vllm/vllm-openai:v0.21.0-cu129` appears 2x in compose.yml (one per service).
- [x] `profiles: [vllm]` appears 2x in compose.yml.
- [x] `start_period: 1200s` appears 1x (vllm only) — Wave 0 override of D-A4.
- [x] `start_period: 300s` appears on vllm-embed.
- [x] `VLLM_FLASH_ATTN_VERSION=2` appears on both services.
- [x] `VLLM_USE_TRITON_AWQ` does NOT appear as an env-var value (only in a docstring comment explaining why it's NOT needed — OUTCOME: locked).
- [x] `--quantization=awq_marlin` appears once (vllm), `--quantization=awq` does NOT appear as a standalone flag.
- [x] `--runner=pooling` and `--hf-overrides={"architectures":["BgeM3EmbeddingModel"]}` appear on vllm-embed.
- [x] `--tool-call-parser=hermes` appears on vllm.
- [x] Commits exist in git history:
  - `8674459 feat(07-01): add vllm + vllm-embed services to compose.yml`
  - `7de1346 feat(07-01): add GRAFANA_ADMIN_PASSWORD + HUGGINGFACE_HUB_TOKEN to .env.example`

## Self-Check: PASSED
