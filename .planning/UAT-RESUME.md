# UAT Resume Guide

**Paused:** 2026-05-17 — user shutting down host
**Last UAT session:** autonomous UAT pass against live stack started after milestone v0.9.0 audit
**Current branch:** master (post-Phase 9 commit `a58f574`)

---

## What's done ✅

| Step | Item | Result |
|------|------|--------|
| 1 | `.env` top-up — added `GRAFANA_ADMIN_PASSWORD`, `ROUTER_RATE_LIMIT_RPM=600`, `CIRCUIT_*`, `DISK_ALERT_THRESHOLD_PCT=80`, generated `VALKEY_PASSWORD` | ✓ |
| 2 | `docker compose up -d valkey prometheus grafana nvidia_gpu_exporter` | ✓ healthy |
| 3 | Router rebuild + restart with full env | ✓ healthy |
| 4 | `docker compose exec ollama ollama pull bge-m3` | ✓ |
| 5 | **`bash bin/smoke-test-cloud.sh`** | ✓ **PASS** (17/17 active, 2 SKIP-by-design) |
| 6 | **`bash bin/smoke-test-observability.sh`** | ✓ **PASS** (7/7 active, 2 SKIP profile-gated) |

---

## What's pending ⏸

| Step | Item | Status |
|------|------|--------|
| 7 | vLLM cold-start (`--profile vllm` up; max-model-len=4096) | mid-flight; was loading model when paused |
| 8a | Open WebUI page eyeball via playwright | OWUI was still doing app startup |
| 8b | Grafana dashboard eyeball via playwright | not started |
| 9 | Final report | not started |

---

## Uncommitted changes (load-bearing fixes — DO NOT discard)

```
M bin/smoke-test-cloud.sh                    # max_tokens 16 → 256 (reasoning model needs headroom)
M bin/smoke-test-observability.sh            # wget --user → URL-embedded auth (busybox compat)
M compose.yml                                # gpu_exporter: WSL2 NVIDIA runtime fix; healthcheck binary fix; router env (OLLAMA_API_KEY + CIRCUIT_* + RATE_LIMIT_RPM); vllm max-model-len 8192 → 4096
M router/src/resilience/idempotency.ts       # subscribeToChannel waits for 'ready' event before SUBSCRIBE (Phase 8 prod bug surfaced live)
?? docker-compose.uat.yml                    # UAT overlay: temp host ports for router :3000 / openwebui :8080 / grafana :3030
```

Tests post-idempotency fix: **692 passed / 7 skipped** (`cd router && npm test`).

---

## Bugs surfaced + fixed live

1. **Idempotency multiplexer — `subscribeToChannel` Stream-not-writeable race** (PROD bug). subscriberFactory returns a fresh ioredis client; SUBSCRIBE was called before TCP+AUTH handshake completed; with `enableOfflineQueue: false` the command rejected. Fix: wait for `'ready'` event (or already-ready status) with 2s timeout, then SUBSCRIBE. Patch in `router/src/resilience/idempotency.ts`. Covers what 08-REVIEW CR-04 fix missed (CR-04 only handled disconnect-on-throw; not the underlying timing).

2. **`nvidia_gpu_exporter` devices: + WSL2** (PROD bug). compose.yml hardcoded `/dev/nvidiactl` + `/dev/nvidia0` which don't exist in WSL2. Fix: use the `x-gpu` anchor (NVIDIA Container Runtime via `deploy.resources.reservations.devices`). Removed WSL2 `/usr/lib/wsl/lib` bind-mounts (runtime auto-projects).

3. **`nvidia_gpu_exporter` healthcheck** (latent bug). Image is FROM scratch — no `wget`. Fix: use `/usr/bin/nvidia_gpu_exporter --version` as liveness probe.

4. **`compose.yml router:` missing env passthrough** (PROD bug). Service block didn't pass `OLLAMA_API_KEY` (needed by Phase 8 boot validator) or `ROUTER_RATE_LIMIT_RPM` / `CIRCUIT_*` envs into the container.

5. **Grafana smoke `wget --user`** (smoke bug). Grafana container ships busybox wget which ignores `--user`. Fix: URL-embedded `http://admin:pw@localhost:3000/...`.

6. **`smoke-test-cloud.sh` max_tokens=16** (smoke bug). gpt-oss:20b is a reasoning model; 16 tokens get burned on internal thinking, output is empty + `finish_reason:length`. Fix: bump to 256.

7. **vLLM max-model-len=8192 + Ollama coexistence** (config tradeoff). Ollama holds ~5 GiB; vLLM's 0.45 utilization × 16 GiB = ~7.2 GiB, leaving 0.4 GiB for KV cache vs 0.44 GiB needed. Fix: dropped max-model-len to 4096. To restore 8192 later, stop Ollama before bringing up vLLM (one-backend-hot pattern from PROJECT.md).

---

## How to resume

Open a terminal, `cd /home/luis/proyectos/local-llms`, then:

```bash
# 0) Confirm where you left off
cat .planning/UAT-RESUME.md
docker compose ps --format '{{.Service}}\t{{.Status}}'

# 1) If stack was shut down, bring it back up (uses the UAT overlay so host ports work)
export PATH="$HOME/.local/bin:$PATH"   # jq installed here
docker compose -f compose.yml -f docker-compose.uat.yml up -d \
  valkey prometheus grafana nvidia_gpu_exporter router openwebui

# 2) Resume vLLM cold-start (max-model-len=4096 keeps it stable next to Ollama)
docker compose --profile vllm up -d vllm vllm-embed
# Watch progress (Ctrl-C when "Application startup complete" appears):
docker compose logs -f vllm | grep -E 'Capturing CUDA graphs|application startup complete|ERROR'

# 3) Re-run the two passing smokes to confirm nothing rotted overnight
bash bin/smoke-test-cloud.sh              # expected: PASS (17/17 active, 2 SKIP-by-design)
bash bin/smoke-test-observability.sh      # expected: PASS (7/7 always-on)
# Once vLLM is healthy:
docker compose --profile vllm up -d vllm  # ensure vllm running
bash bin/smoke-test-observability.sh      # this run should see up{job=vllm}=1 (Section 3 SKIPs become PASSes)

# 4) Phase 6 + Grafana eyeball via playwright (the part I didn't get to)
#    OWUI is at  http://127.0.0.1:8080/   (UAT overlay; bypasses Traefik)
#    Grafana is at http://127.0.0.1:3030/ (UAT overlay; bypasses Traefik)
playwright-cli open http://127.0.0.1:8080/
playwright-cli snapshot                    # check OWUI loads, models listed
playwright-cli screenshot --filename=/tmp/owui-uat.png
playwright-cli goto http://127.0.0.1:3030/d/local-llms/
# Login: admin / $(grep '^GRAFANA_ADMIN_PASSWORD=' .env | cut -d= -f2)
playwright-cli snapshot                    # confirm 6 panels render with live data
playwright-cli screenshot --filename=/tmp/grafana-uat.png
playwright-cli close

# 5) Commit the load-bearing fixes
git add bin/smoke-test-cloud.sh bin/smoke-test-observability.sh compose.yml \
        router/src/resilience/idempotency.ts
git commit -m "fix(uat): live-stack hotfixes from autonomous UAT pass

- router/src/resilience/idempotency.ts: wait for ioredis 'ready' event before
  SUBSCRIBE — 08-REVIEW CR-04 follow-up (Stream-not-writeable race surfaced
  in live concurrent-idempotency-key test; integration tests with ioredis-mock
  did not catch the TCP+AUTH timing).
- compose.yml: nvidia_gpu_exporter switched from /dev/nvidiactl + /dev/nvidia0
  devices: to the x-gpu anchor (WSL2 has neither — Pitfall G-3 manifested);
  healthcheck switched to /usr/bin/nvidia_gpu_exporter --version (image FROM
  scratch — no wget); router env block extended with OLLAMA_API_KEY,
  ROUTER_RATE_LIMIT_RPM, CIRCUIT_FAILURE_THRESHOLD/WINDOW_MS/COOLDOWN_MS;
  vllm max-model-len 8192 → 4096 (coexists with Ollama in 16 GiB).
- bin/smoke-test-cloud.sh: cloud chat max_tokens 16 → 256 (reasoning model
  burned all 16 tokens on internal thinking → empty content + finish=length).
- bin/smoke-test-observability.sh: wget --user not honored by busybox in
  grafana container → URL-embedded basic-auth.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

# Optionally also commit the UAT overlay as a documented helper:
git add docker-compose.uat.yml
git commit -m "chore: add docker-compose.uat.yml overlay (host ports for local UAT)"

# 6) Once eyeball is done, flip the deferred-by-design Phase 6/7/8 UATs:
#    - .planning/phases/06-*/06-VERIFICATION.md      status: passed (or note remaining gaps)
#    - .planning/phases/07-*/07-VERIFICATION.md      status: passed
#    - .planning/phases/08-*/08-VERIFICATION.md      status: passed
#    Then proceed to lifecycle:
/clear  # in Claude Code
# (then ask Claude:)
"corre /gsd-complete-milestone v0.9.0 y después /gsd-cleanup — todas las UATs pasaron"
```

---

## Open items to confirm during resume

- **Grafana dashboard eyeball**: confirm all 6 required panels (VRAM Utilization, Request Rate, TTFT p95, Request Duration p95, Error Rate, Backend Selection) actually render data. The smoke proved the dashboard JSON is loaded; eyeball confirms PromQL queries return data.
- **vLLM smoke step**: run `bash bin/smoke-test-router.sh` once vLLM is up — Phase 7 §section will exercise `up{job=vllm}=1` + Qwen2.5-7B-Instruct-AWQ chat completion.
- **Cloud-embed parity (EMBED-02)**: Section 3 of smoke-test-cloud.sh SKIPs because `models.yaml` has no `backend: ollama-cloud, capabilities: [embeddings]` entry. The code path is implemented (Plan 08-02 `OllamaCloudAdapter.embeddings()`) but no live invocation. If you want to exercise it, add an entry like:
  ```yaml
  - name: nomic-embed-text-cloud
    backend: ollama-cloud
    backend_url: https://ollama.com
    backend_model: nomic-embed-text
    capabilities: [embeddings]
    vram_budget_gb: 0
  ```
  (verify the cloud model name against `https://ollama.com/library`)

---

## Tear-down (if you want to revert to baseline)

```bash
# Restore .env from the timestamped backup (created at UAT start)
cp .env.bak.uat-1779058336 .env

# Remove UAT overlay
rm docker-compose.uat.yml

# Restart router without UAT overlay (no host port on :3000)
docker compose up -d --force-recreate router openwebui grafana
```

But the load-bearing fixes (idempotency timing, gpu_exporter, router env passthrough) should NOT be reverted — they're real bugs.

---

*Generated by autonomous UAT pause checkpoint. Next session: read this file first, then resume from step 2 above.*
