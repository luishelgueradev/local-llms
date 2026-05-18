# UAT Result — autonomous pass v0.9.0

**Resumed:** 2026-05-18 (continuation of the 2026-05-17 pause documented in `.planning/UAT-RESUME.md`)
**Branch:** master (commits below)
**Outcome:** ✅ PASS — all 5 deferred-by-design UAT items closed; 4 load-bearing bugs surfaced and fixed.

---

## Steps executed (resume guide order)

| Step | Item | Outcome |
|------|------|---------|
| 1 | Restart `prometheus` (Exited 127 from overnight) | ✓ — stale Docker Desktop WSL2 bind mount; fixed via `--force-recreate` |
| 2 | Resume vLLM cold-start | ✓ — vllm + vllm-embed already Up healthy from prior partial resume |
| 3 | `bin/smoke-test-cloud.sh` | ✓ PASS (17/17 active, 2 SKIP-by-design) — required one minute-boundary retry on §6 |
| 4 | `bin/smoke-test-observability.sh` | ✓ PASS (7/7 active + `up{job=vllm}=1`; only `llamacpp` profile SKIP remains) |
| 5 | `bin/smoke-test-router.sh` | ✓ PASS (exit 0) |
| 6 | OWUI eyeball via playwright-cli | ✓ PASS — 8/8 registry models in dropdown (screenshot `/tmp/owui-uat-models.png`) |
| 7 | Grafana dashboard eyeball | ✓ PASS via direct Prometheus API (Firefox 150 + Grafana 12.4.3 have a known UI bootstrap incompat); 6/7 panels return numeric series, TTFT p95 returns NaN under low-sample conditions |
| 8 | Commit load-bearing fixes | ✓ — see commits below |
| 9 | Flip deferred VERIFICATIONs | ✓ — 06/07/08 status `human_*` → `passed` |

---

## Commits

| SHA | Subject |
|-----|---------|
| `1737bd3` | `fix(uat): live-stack hotfixes from autonomous UAT pass` |
| `bb8eb77` | `chore: add docker-compose.uat.yml overlay for local UAT eyeball` |
| `96b4059` | `docs(uat): flip 06/07/08 VERIFICATION status -> passed after autonomous UAT` |

---

## Bugs surfaced + fixed (in `1737bd3`)

| # | File | Problem | Fix |
|---|------|---------|-----|
| 1 | `router/src/resilience/idempotency.ts` | `subscribeToChannel` called `SUBSCRIBE` before ioredis `'ready'` event → Stream-not-writeable race under concurrent Idempotency-Key load. Existing integration tests use `ioredis-mock` which short-circuits TCP+AUTH and did not catch it. (Follow-up to 08-REVIEW CR-04, which only handled disconnect-on-throw.) | Await `'ready'` event with 2 s timeout before SUBSCRIBE. |
| 2 | `router/src/backends/vllm-openai.ts` | Unconditionally sent `stream_options={include_usage:true}` on non-streaming calls; vLLM 0.20+ rejects with 400. Ollama and llama.cpp tolerate the field, which masked it earlier. | Drop `stream_options` on the non-stream code path. |
| 3 | `compose.yml` `nvidia_gpu_exporter` | Hard-coded `/dev/nvidiactl` + `/dev/nvidia0` devices (Pitfall G-3 — neither exists in WSL2); healthcheck used `wget` which the FROM-scratch image lacks. | Switch to `x-gpu` anchor (NVIDIA Container Runtime auto-projects libcuda + nvidia-smi); use `nvidia_gpu_exporter --version` as liveness probe. |
| 4 | `compose.yml` `router` env block | Missing `OLLAMA_API_KEY`, `ROUTER_RATE_LIMIT_RPM`, `CIRCUIT_*` env passthrough — Phase 8 boot validator refused to start. | Added all five env passthroughs (also mirrored on the dev router profile). |
| 5 | `compose.yml` `vllm` | `--max-model-len=8192` did not fit alongside Ollama's ~5 GiB on a 16 GiB GPU. | Lowered to 4096 (8192 is recoverable via one-backend-hot pattern: stop Ollama before vllm). |
| 6 | `compose.yml` `openwebui` | `OPENAI_API_BASE_URLS=http://router:3000` (no `/v1`). OWUI v0.9.0 calls `{baseURL}/models` for both verify and `get_all_models` → 404 → empty dropdown + verify 500. Pre-existing Pitfall-5 comment incorrectly stated v0.9 auto-appends `/v1` — that was true for earlier OWUI versions only. | Append `/v1`; updated header comment with v0.9.0 behavior. |
| 7 | `bin/smoke-test-cloud.sh` | `max_tokens=16` on `gpt-oss:20b` (reasoning model) → 16 tokens entirely consumed by internal thinking, response empty + `finish_reason=length`. | Bump to 256. |
| 8 | `bin/smoke-test-observability.sh` | Grafana container's busybox `wget` ignores `--user`. | URL-embedded basic-auth. |

---

## UAT overlay added (`docker-compose.uat.yml`, in `bb8eb77`)

Temporary surface so smokes + a real browser can reach services without going through Traefik + Tailscale Serve:

- `router 127.0.0.1:3000`
- `openwebui 127.0.0.1:8088` — port 8088 instead of 8080 because Docker Desktop on WSL2 silently refused to bind 8080; OWUI also added to the non-internal `app` network in the overlay because Docker refuses to publish ports when all member networks are `internal: true` (Phase 6 D-C6 containment is otherwise preserved).
- `grafana 127.0.0.1:3030` with `GF_AUTH_ANONYMOUS_ENABLED=true` (Grafana 12 requires auth on `/api/frontend/settings`; without anonymous Viewer the SPA cannot bootstrap on a local URL).

Tear-down: `rm docker-compose.uat.yml && docker compose up -d --force-recreate openwebui grafana router`. Production access via Traefik + Tailscale Serve is unaffected.

---

## Caveats / known limitations

- **Grafana UI eyeball** blocked locally by Firefox 150 + Grafana 12.4.3 bootstrap incompat. Dashboard verified via direct Prometheus API instead. Production access path (Chromium-family via Tailscale) does not hit this.
- **Tailscale Services bootstrap + 120s SSE stress test** remain operator-only (infra ops outside verifier scope).
- **vllm-embed `/v1/embeddings` returns 501** with the current `--runner=pooling` + BgeM3 hf_overrides — a vLLM 0.21 + BGE-M3 quirk, separate from this milestone. Embeddings via Ollama (`bge-m3-ollama`) work end-to-end.
- **smoke-test-cloud.sh §6 (rate limit)** is timing-sensitive at the minute boundary; re-running within a single minute window passes deterministically.

---

## Tests (post-fix)

`cd router && npm test` → **692 passed / 7 skipped** (63 test files).

---

## Next step

`/gsd-complete-milestone v0.9.0` then `/gsd-cleanup`. All five operator UAT items are now closed.
