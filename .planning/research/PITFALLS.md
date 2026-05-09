# Pitfalls Research

**Domain:** Self-hosted Docker stack on NVIDIA GPU (WSL2 Linux) hosting Ollama + llama.cpp-server + vLLM behind a Fastify OpenAI/Anthropic-compatible router, plus Open WebUI / Redis / Postgres / Traefik. Single user, single host, agent-first.
**Researched:** 2026-05-09
**Confidence:** HIGH on Compose/Ollama/vLLM/SSE-through-Traefik (verified against official docs and 2026 issue trackers); MEDIUM on Anthropic↔OpenAI tool-call edge cases (multiple sources agree, but exact wire-format quirks shift release-to-release); MEDIUM on Ollama Cloud limits (docs intentionally vague on quotas).

---

## Critical Pitfalls

### Pitfall 1: NVIDIA driver / CUDA / Container Toolkit version drift on WSL2 — the silent CPU fallback

**What goes wrong:**
Containers "work" but inference is silently on CPU, or `nvidia-smi` works on the host but fails inside the container with `Failed to initialize NVML: GPU access blocked by the operating system` or `unknown runtime: nvidia`.

**Why it happens (WSL2-specific):**
- The Windows NVIDIA driver is the *only* driver that should be installed. Installing a Linux NVIDIA driver inside the WSL2 distro stubs over `libcuda.so` and breaks GPU passthrough. NVIDIA's CUDA-on-WSL guide is explicit: *do not install any NVIDIA GPU Linux driver within WSL 2*.
- `/dev/dxg` (the WSL2 GPU paravirtualization device) must be present; if it's missing, the kernel cannot reach the GPU regardless of toolkit config.
- The NVIDIA Container Toolkit runtime config is per-distro: `nvidia-ctk runtime configure --runtime=docker` must be run *inside the WSL2 distro* and Docker daemon restarted. Easy to skip when Docker Desktop is in play.
- Toolkit version must match the CUDA major version expected by the container. A container built for CUDA 12.4+ will silently fail on a host stack at 12.1.

**How to avoid (concrete):**
1. Phase 1 must include a `bin/preflight-gpu.sh` that asserts:
   - `ls -l /dev/dxg` returns a device.
   - `nvidia-smi` on host shows the GPU.
   - `docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi` shows the same GPU.
   - `nvidia-ctk --version` is present.
   - `/etc/docker/daemon.json` (inside WSL2) contains the `nvidia` runtime entry.
2. Pin the CUDA base image tag in every GPU-using service's Compose file and document the host driver minimum.
3. Refuse to start the stack if preflight fails — make it a Compose `depends_on` against a one-shot `gpu-preflight` service, not just a README note.

**Warning signs:**
- `tokens/sec` numbers that look 50–100x slower than expected.
- `nvidia-smi` inside container shows no processes when a model is loaded.
- Container logs include `CUDA error: no CUDA-capable device is detected` after an apparently successful start.

**Phase to address:** Phase 1 (Compose foundation) — preflight script and CUDA base image pinning.

---

### Pitfall 2: `runtime: nvidia` vs `deploy.resources.reservations.devices` schism

**What goes wrong:**
Copy-pasted Compose snippets from blog posts mix the two styles, services start without GPU access, or `docker compose up` errors with `unknown runtime` even though the toolkit is installed.

**Why it happens:**
Two valid Compose schemas exist:
- **Legacy (works in Compose v1 and v2 with `runtime: nvidia`):**
  ```yaml
  services:
    foo:
      runtime: nvidia
      environment:
        - NVIDIA_VISIBLE_DEVICES=all
  ```
  Requires `default-runtime: nvidia` *or* the runtime to be registered in `/etc/docker/daemon.json`.
- **Modern (Compose Deploy spec, Compose v2):**
  ```yaml
  services:
    foo:
      deploy:
        resources:
          reservations:
            devices:
              - driver: nvidia
                count: all   # or device_ids: ["0"]
                capabilities: [gpu]
      environment:
        - NVIDIA_VISIBLE_DEVICES=all
  ```
  Requires the NVIDIA Container Toolkit registered as a Docker runtime; does not require it to be the default.

Mixing the two (e.g. `runtime: nvidia` *and* `deploy.resources.reservations.devices`) leads to confusing "ignored field" warnings or silent fallback. `count` and `device_ids` cannot coexist — using both errors out.

**How to avoid (concrete):**
- Pick **the modern `deploy.resources.reservations.devices` form** for every GPU service. It's the documented direction for Compose v2 and avoids relying on `default-runtime`.
- Capabilities should be `[gpu, compute, utility]` — `utility` is what gives `nvidia-smi` *inside the container*; without it you can't introspect GPU state from inside a container even though the GPU works.
- Standardize a Compose YAML anchor (`x-gpu: &gpu`) so every backend service references the same block. Drift between services is a recurring cause of "works for Ollama, broken for vLLM" issues.

**Warning signs:**
- Compose warning: `the "runtime" field is deprecated`.
- One backend container has GPU access, another doesn't, with the same image base.
- `nvidia-smi` works inside one container but not another.

**Phase to address:** Phase 1 (Compose foundation) — define the `x-gpu` anchor once, reuse everywhere.

---

### Pitfall 3: Three GPU services racing for one 16 GB GPU — VRAM thrash

**What goes wrong:**
Ollama, llama.cpp-server, and vLLM all start simultaneously, each claims VRAM under defaults, two of them OOM, the third stays up but in a weird half-loaded state. Or worse: vLLM's `gpu_memory_utilization=0.9` (default) eats 14.4 GB before the other two even get to allocate.

**Why it happens:**
- vLLM **pre-allocates** `gpu_memory_utilization × total_VRAM` (default 0.9). On a 16 GB card that's 14.4 GB grabbed at startup, regardless of model size, because vLLM uses the headroom for KV cache.
- Ollama dynamically loads/unloads but `OLLAMA_MAX_LOADED_MODELS` (default 1) plus `OLLAMA_NUM_PARALLEL` (auto: 1 or 4) can balloon KV cache: required RAM scales as `OLLAMA_NUM_PARALLEL × OLLAMA_CONTEXT_LENGTH × per_token_KV`.
- llama.cpp-server with `--n-parallel 4` divides `--ctx-size` across slots. A request asking for the full context will fail because per-slot context is `total_ctx / n_parallel`.
- None of these tools cooperate. There is no shared scheduler. Whoever calls `cudaMalloc` first wins.

**How to avoid (concrete):**
1. **Static partitioning.** Decide up front (in `models.yaml` configuration):
   - vLLM: `--gpu-memory-utilization 0.45` (≈7.2 GB) when it's running.
   - llama.cpp-server: explicitly bound by GGUF + `--ctx-size` chosen for ~5 GB.
   - Ollama: cap with `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_NUM_PARALLEL=2`, leave it ~4 GB headroom.
2. **One backend hot at a time as the design default.** The router should know which backend is "primary" and stop/pause others. A Compose `profiles:` per backend, or `restart: "no"` plus a control script the router invokes, is simpler than coexistence.
3. **Always set `--max-model-len` on vLLM explicitly.** The default tries to use the model's full pretraining context (often 32k or 128k) and OOMs immediately on a 16 GB card. Start at `--max-model-len 8192` and grow.
4. **Refuse `gpu_memory_utilization > 0.5` when another GPU service is up.** Encode this as a router/health-check guard — not just docs.
5. Skip MIG and time-slicing. MIG is only available on data-center GPUs (A100/H100/etc.); it does not apply to RTX 4080/4060 Ti. Time-slicing via the toolkit exists but adds latency and offers no benefit for single-user serial workloads.

**Warning signs:**
- `nvidia-smi` shows ~14.4 GB used by `vllm` and 0 MB free even when no requests are in flight.
- Ollama logs `cudaMalloc failed: out of memory` or queues every request indefinitely.
- llama.cpp-server returns "context size exceeded" for prompts that are well under `--ctx-size`.

**Phase to address:** Phase 2 (backend bring-up) — VRAM partitioning policy and `models.yaml` budgets. Phase 3 (router) — backend lifecycle / "primary-only" enforcement.

---

### Pitfall 4: SSE through Traefik gets buffered — first byte arrives, then nothing

**What goes wrong:**
The agent receives the first chunk after a long delay (several seconds to "the entire response at once"), or worse, sees the connection idle out before any content arrives. Reproduces only when going through Traefik; works fine when hitting the router directly.

**Why it happens:**
Traefik's default behavior with HTTP/1.1 chunked responses can buffer. Reverse proxies tend to wait for a buffer threshold or `Content-Length` before forwarding bytes. Traefik also has `forwardingTimeouts` (`responseHeaderTimeout`, `idleConnTimeout`) that can guillotine long generations.

**How to avoid (concrete):**
1. **Router side (Fastify):**
   - Use `reply.raw.writeHead()` with explicit headers:
     ```ts
     reply.raw.writeHead(200, {
       'Content-Type': 'text/event-stream',
       'Cache-Control': 'no-cache, no-transform',
       'Connection': 'keep-alive',
       'X-Accel-Buffering': 'no'  // hints to nginx; harmless to Traefik
     });
     ```
   - Send a heartbeat comment (`: keep-alive\n\n`) every 15 s on idle streams.
   - Handle backpressure: check `reply.raw.write(chunk)` return value; on `false`, await `'drain'` before continuing. Without this, slow clients leak memory under the agent-retry-storm pattern (Pitfall 14).
   - Disable response compression on SSE routes — gzip middleware will buffer until flush boundaries.
   - Listen for `req.raw.on('close')` and abort the upstream backend stream. Without this, an agent that hangs up mid-generation leaves the GPU producing tokens nobody reads.
2. **Traefik side:**
   - Do **not** apply the `buffering` middleware to SSE routes. Traefik's `buffering` middleware is opt-in but blog templates often add it globally — verify it's absent.
   - Set per-router `forwardingTimeouts`:
     ```yaml
     # static config
     serversTransport:
       forwardingTimeouts:
         dialTimeout: 30s
         responseHeaderTimeout: 0s   # 0 = no timeout for header
         idleConnTimeout: 0s
     ```
   - For HTTP/2: Traefik streams HTTP/2 fine, but mixing HTTP/2 client → HTTP/1.1 backend can introduce buffering at the protocol bridge. Force backend to HTTP/1.1 only.

**Warning signs:**
- Test with `curl -N` directly to the router → tokens stream. Through Traefik → tokens batch.
- Browser DevTools Network panel shows the SSE request stuck on "Pending" with bytes appearing in lumps.
- Long generations fail with `502 Bad Gateway` after exactly 60 s or 90 s (Traefik default header timeout).

**Phase to address:** Phase 3 (router resilience) for Fastify side; Phase 1 or whichever phase introduces Traefik must include an SSE smoke test (`curl -N -H "Authorization: Bearer ..." …/v1/chat/completions` with `stream: true` and assert deltas arrive < 1 s apart).

---

### Pitfall 5: Anthropic ↔ OpenAI tool-calling translation — the silent corruption

**What goes wrong:**
Tool calls work for one direction, fail or produce malformed output for the other. Symptoms: agent gets `tool_calls: null` when the model definitely called a tool, or sees a `tool_use` block but never receives its `tool_result` echo, or the model loops forever calling the same tool.

**Why it happens (concrete differences):**
| Aspect | OpenAI | Anthropic |
|---|---|---|
| Schema field | `function.parameters` (JSON Schema) inside `tools[].function` | `tools[].input_schema` (JSON Schema), no `function` wrapper |
| System message | Item with `role: "system"` in `messages[]` | Top-level `system` parameter (string or array of content blocks); **not** in `messages[]` |
| Assistant tool call | `message.tool_calls[].id` + `function.name` + `function.arguments` (string-encoded JSON) | Content block `{type: "tool_use", id, name, input}` (input is structured JSON, not a string) |
| Tool result | `role: "tool", tool_call_id, content` | `role: "user"` message with content block `{type: "tool_result", tool_use_id, content}` |
| Multiple tools per turn | Native parallel via `tool_calls[]`; opt out with `parallel_tool_calls: false` | Multiple `tool_use` blocks in one assistant message; no equivalent off-switch — must instruct via `tool_choice: {type: "tool", name: "X"}` to force a single tool |
| Role alternation | Loose | Strict alternating `user`/`assistant`; cannot have `user` after `tool` without an intervening `assistant` |
| `tool_choice` shape | `"auto"`, `"none"`, `"required"`, or `{"type":"function","function":{"name":...}}` | `{"type":"auto"}`, `{"type":"any"}`, `{"type":"tool","name":"..."}` |

**How to avoid (concrete):**
1. **Normalize internally to one canonical shape** (recommend Anthropic-style content blocks — they're a strict superset, easier to round-trip). Translate inbound to canonical, dispatch to backend, translate outbound to whatever the client requested. Never translate directly OpenAI ↔ Anthropic in a single hop.
2. **JSON.stringify discipline:** OpenAI's `function.arguments` is a JSON-encoded string; Anthropic's `input` is parsed JSON. Forgetting this corrupts arguments containing quotes/newlines.
3. **Round-trip golden tests** in Phase 3:
   - For each protocol pair, fixture: prompt + tool defs + expected canonical message tree + expected wire-format output.
   - Test parallel tool calls explicitly (most translators get single-tool right and break on parallel).
   - Test the "tool returns an error" path — Anthropic uses `is_error: true` on the `tool_result` block; OpenAI just stuffs it in `content`.
4. **Validate role alternation** before sending to Anthropic. If the canonical history violates strict alternation, collapse adjacent same-role messages or insert a synthetic assistant ack.

**Warning signs:**
- Model "calls tool X" repeatedly even though the tool result is in the history → `tool_use_id` mismatch or `tool_result` placed in wrong role.
- Empty `arguments: ""` in OpenAI output → forgot to `JSON.stringify(input)` when translating from Anthropic canonical.
- Anthropic API returns `400 messages: roles must alternate` → translator passed through OpenAI-style consecutive `user` messages.

**Phase to address:** Phase 3 (router protocol surface). Allocate explicit time — this is the single largest source of routing bugs and the spec keeps evolving.

---

### Pitfall 6: vLLM `--max-model-len` default OOMs on first request

**What goes wrong:**
vLLM starts cleanly, model loads, first request returns immediately with `ValueError: The model's max seq len ... is larger than the maximum number of tokens that can be stored in KV cache` or simply OOMs.

**Why it happens:**
- vLLM by default reads `max_position_embeddings` from the model config — for many modern models that's 32k, 128k, or 1M tokens. KV cache memory needed to support that is computed at startup as `gpu_memory_utilization × VRAM` minus weights, and if the requested `max_model_len` exceeds what fits, vLLM either errors out or, worse, silently caps `max_num_seqs` to 1 and serializes everything.
- `gpu_memory_utilization` default 0.9 is too aggressive when other services share the GPU (see Pitfall 3).

**How to avoid (concrete):**
- Always set both `--max-model-len` and `--gpu-memory-utilization` explicitly. Starting points for 16 GB shared: `--max-model-len 8192 --gpu-memory-utilization 0.45` for a 7B model in fp16.
- Rough KV-cache budget: `2 × num_layers × hidden_size × max_model_len × max_num_seqs × dtype_bytes`. Budget *before* launching, not after the OOM.
- Pin a known-good config per model in `models.yaml`. Treat `max_model_len` as a model property, not a runtime knob.
- For models with very large native context (e.g. Qwen with rope_scaling), explicitly disable rope scaling unless the deployment needs long context — it changes accuracy.

**Warning signs:**
- vLLM logs `Maximum concurrency for X tokens per request: 1.00x` — means only one request at a time fits.
- Throughput collapses to ~1 req/s regardless of model size.

**Phase to address:** Phase 2 (vLLM bring-up) — `models.yaml` schema must require `max_model_len` and `gpu_memory_utilization`.

---

### Pitfall 7: vLLM container startup time / model download surprise

**What goes wrong:**
First `docker compose up vllm` takes 25+ minutes and looks hung. Or: container restarts in a loop because its healthcheck fires before the model is loaded. Or: re-downloads gigabytes on every `docker compose down && up` because the HuggingFace cache wasn't mounted.

**Why it happens:**
- `vllm/vllm-openai` downloads the model from HuggingFace on first launch into the container's ephemeral filesystem. Without a mounted cache volume, every `docker compose down` discards the download.
- vLLM's startup includes JIT compilation of CUDA graphs and torch.compile — even with cached weights, cold start can be 30–120 s for medium models.
- Compose healthchecks default `start_period: 0s`. The container goes "unhealthy" before it has a chance to boot; orchestration may restart it mid-load.

**How to avoid (concrete):**
1. Mount a single shared `/srv/models/hf-cache` volume into vLLM at `/root/.cache/huggingface` and set `HF_HUB_CACHE=/root/.cache/huggingface` (and `HF_HOME` to the same parent). Reuse this volume across vLLM and any HF-using sidecar. Do *not* mix this with Ollama's blob storage — they're different layouts.
2. **Pre-download in CI / a one-shot job** before bringing the service up:
   ```bash
   docker run --rm -v /srv/models/hf-cache:/cache \
     -e HF_HOME=/cache \
     ghcr.io/huggingface/huggingface_hub:latest \
     huggingface-cli download <repo> --local-dir-use-symlinks False
   ```
3. Healthcheck must use `start_period: 600s` (or longer for big models) and probe `GET /health` on the OpenAI server.
4. Set `restart: unless-stopped` not `restart: always` — `always` will fight a crash-looping container into oblivion; `unless-stopped` lets you `down` it cleanly.
5. For HF gated models (Llama, Gemma): pass `HF_TOKEN` via Docker secret, not env var. Env vars leak into `docker inspect`.

**Warning signs:**
- vLLM container CPU is pinned at 100% and disk IO is high for many minutes — it's downloading.
- `docker compose logs vllm` shows `Resolving config files from huggingface.co` repeatedly across restarts.

**Phase to address:** Phase 2 (vLLM bring-up) — pre-download workflow + healthcheck `start_period`.

---

### Pitfall 8: Ollama OpenAI-compat endpoint quirks (vision + role conventions + name resolution)

**What goes wrong:**
- The same prompt that works on `/api/chat` returns 400 or empty content on `/v1/chat/completions`.
- Vision requests succeed against native Ollama but fail through the OpenAI-compat layer.
- Model names in the router's config don't resolve because Ollama is picky about tags (`llama3.1` vs `llama3.1:latest` vs `llama3.1:8b-instruct-q4_K_M`).
- Ollama Cloud models referenced as `gpt-oss:120b-cloud` work locally but as `gpt-oss:120b` against `ollama.com` directly — different naming conventions for the same artifact.

**Why it happens:**
- Ollama's `/v1/chat/completions` is a thin compatibility shim. It re-translates OpenAI vision content arrays (`type: image_url` with data URLs) into the native `images: ["<base64>"]` array. It works for many models but has known issues with newer multimodal models — community reports of 500s on Ollama Cloud vision through `/v1/chat/completions`. Native `/api/chat` is more reliable.
- Tags are not aliases — `llama3.1` resolves to `llama3.1:latest` but `latest` may differ from what you pulled six months ago. Pinning a specific tag (`:8b-instruct-q4_K_M`) is the only reproducible reference.
- Ollama Cloud uses the same model name space but with `-cloud` suffix when referenced through a *local* Ollama as a cloud model, vs. without the suffix when calling the cloud API directly.

**How to avoid (concrete):**
- Router should call **native `/api/chat`** to Ollama for vision and tools, not the `/v1/chat/completions` shim. Translate from the canonical internal shape directly to native Ollama format. The OpenAI-compat layer is a backup, not the primary path.
- Always reference models with full tag (`model: "llama3.1:8b-instruct-q4_K_M"`) in `models.yaml`. Forbid `:latest`.
- For Ollama Cloud, treat it as a separate backend in `models.yaml` with its own base URL (`https://ollama.com`) and bearer token, even if the underlying client library can do it transparently. This makes routing decisions explicit and rate-limit handling local.
- When calling Ollama from another container in the Compose network, use the service DNS name (`http://ollama:11434`), not `localhost` or `host.docker.internal`. Bind Ollama with `OLLAMA_HOST=0.0.0.0:11434` in the container, which is the default in the official image but not always in custom Dockerfiles.

**Warning signs:**
- Vision calls return text that ignores the image (model "saw" an empty array).
- Intermittent 404 model-not-found because `latest` was repulled and the manifest changed.
- 401 Unauthorized to Ollama Cloud: the `Authorization: Bearer <ollama-api-key>` header is missing — the local Ollama relays it only for cloud-suffixed models.

**Phase to address:** Phase 2 (Ollama backend integration) and Phase 3 (router translation layer). Phase 4 (Ollama Cloud fallback) treats cloud as a distinct backend definition.

---

### Pitfall 9: Ollama Cloud quotas, rate limits, and cost surprises

**What goes wrong:**
Mid-day every request to a cloud model returns 429 with no warning. Or: an agent retry loop silently consumes the weekly quota in an hour. Or: an `agent-spawns-agents` workflow blows through concurrency limit and queues forever.

**Why it happens:**
- Ollama Cloud bills GPU-time, not tokens, and quotas reset on **5-hour session** and **7-day weekly** windows. Quotas are not exposed via the API — only the web dashboard shows remaining budget.
- Concurrency is plan-capped; over-cap requests are queued, not rejected, so a parallel agent fan-out looks slow rather than failing fast.
- Cloud models also have a hard `max_tokens` ceiling (reported at 16,384 in late 2025) regardless of the model's nominal context. Long-document workflows truncate silently.

**How to avoid (concrete):**
- Router must implement a **circuit breaker** per backend: after N 429s in M seconds, mark the backend as DOWN for a cooldown window and surface a clear error to the agent ("Ollama Cloud rate-limited, retry in Xs"). Do **not** retry blindly upstream — that's how budget burns happen.
- Track per-day cloud spend (proxy for GPU-time) in Postgres, alert at thresholds. The metric is `sum(generation_duration_ms)` scoped to cloud backends.
- Cap `max_tokens` in the router for cloud models at the documented ceiling. Reject requests exceeding it with a clear error; do not silently truncate.
- Configure Ollama Cloud as **fallback only**, not load-balanced primary. The router's routing logic should be `if model in local_backends → local; else → cloud`. No "if local is busy → cloud" — that path is what produces surprise bills.

**Warning signs:**
- Sudden burst of `error: rate_limit` in router logs.
- Agent latency P95 jumps to multiple seconds (queueing).
- Manual dashboard check shows weekly quota at 90% mid-week.

**Phase to address:** Phase 4 (Ollama Cloud fallback) — circuit breaker, spend tracking, max_tokens cap.

---

### Pitfall 10: Open WebUI first-boot creates an admin account silently

**What goes wrong:**
Open WebUI is brought up, the first person who hits the URL becomes admin permanently. In a "single user agent-first" stack, that "first person" might be a port-scanner or a colleague checking the URL.

**Why it happens:**
Open WebUI's first-account-becomes-admin behavior is hardcoded. Once an admin exists, you cannot retroactively flip to `WEBUI_AUTH=False` (unauth mode) — the docs are explicit: *if you want to disable WEBUI_AUTH, make sure your web interface doesn't have any existing users and is a fresh installation. You cannot switch between single-user mode and multi-account mode after this change.*

**How to avoid (concrete):**
1. For pure single-user agent-first deployment: set `WEBUI_AUTH=False` from the very first boot. Bring Open WebUI up with this env var in the initial Compose file, never with auth enabled "just for testing first."
2. Alternatively, set `WEBUI_ADMIN_EMAIL` and `WEBUI_ADMIN_PASSWORD` to seed the admin deterministically before exposing the port.
3. Open WebUI's data lives in `/app/backend/data` (sqlite + chats). Mount as a named volume from day one. If you ever need to "reset" to flip auth modes, this volume is what you delete.
4. Bind Open WebUI **only** to the internal Traefik network. Do not publish a host port. The Traefik router for it should be authenticated (basic auth middleware) even when `WEBUI_AUTH=False`, so the unauth UI is gated by the proxy.

**Warning signs:**
- Logs show a successful signup from an unfamiliar IP.
- "Disable login" doesn't take effect after editing env vars — you're already past the point of no return.

**Phase to address:** Phase 5 (platform services / Open WebUI bring-up) — must include the `WEBUI_AUTH` decision and Traefik auth middleware before the service is publicly addressable.

---

### Pitfall 11: Models volume balloons to 100+ GB unnoticed

**What goes wrong:**
After a few weeks of "let me try this 70B" experiments, `/var/lib/docker/volumes/local-llms_models` is 200 GB and the host disk is 95% full. Backups take hours, GPU service restarts fail because Docker can't allocate writable layer space.

**Why it happens:**
- Ollama keeps every pulled model forever. `ollama pull` doesn't garbage-collect older layer blobs that no manifest references.
- HuggingFace cache (vLLM) and llama.cpp GGUF cache are separate from Ollama's blob store — same model can exist three times.
- A 13B model in fp16 is ~26 GB; in Q8_0 ~14 GB; in Q4_K_M ~7.5 GB. Pulling "just to compare" is expensive.

**How to avoid (concrete):**
- Single shared volume layout, with backend-specific subdirs:
  ```
  /srv/models/
    ollama/        # OLLAMA_MODELS=/srv/models/ollama
    hf-cache/      # HF_HOME for vLLM
    gguf/          # llama.cpp -m points here
  ```
- Disk-usage check in nightly cron: alert when `/srv/models` exceeds threshold.
- `models.yaml` is the **source of truth**; a `bin/gc-models.sh` script removes any blob/repo not referenced by `models.yaml` after manual confirmation.
- Document Ollama-specific cleanup: `ollama rm <model>` to remove a model; `ollama list` to inventory. Note: `ollama rm` does not always reclaim shared blob layers immediately.
- Quota the `/srv/models` filesystem if possible (LVM thin volume or ZFS dataset with `quota=` set).

**Warning signs:**
- `docker system df` shows volume usage growing each week.
- `df -h /srv/models` < 20% free.
- Container starts fail with `no space left on device`.

**Phase to address:** Phase 1 (volume layout) — define the schema. Phase 6 or operations milestone — GC script + monitoring.

---

### Pitfall 12: Bearer token leaks into logs

**What goes wrong:**
The single bearer token (the auth for the entire stack) ends up in:
- Fastify access logs (`Authorization: Bearer eyJ...`)
- Traefik access logs
- Docker container stdout captured by the journald driver
- A panic stack trace that includes request headers
- Postgres `pg_stat_statements` if request bodies are mistakenly stored

Once it's in any log, rotation is the only fix.

**Why it happens:**
- Fastify's default `pino` logger doesn't redact unless you tell it to.
- Many SSE debug snippets log full request objects including headers.
- Error handlers that JSON.stringify the error including request context dump headers.

**How to avoid (concrete):**
1. Configure pino with `redact: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', '*.apiKey', '*.api_key']`. Apply at the root logger.
2. Traefik access log: `accesslog.fields.headers.defaultmode=drop` (Traefik logs no headers by default; verify nobody flipped this).
3. Token format: prefix-tagged (`local-llms_<random>`) so accidental leaks are searchable in Git history later.
4. Token comes from an env file (`.env` chmod 600, gitignored), never from a hardcoded fallback in source. Unit-test that the fallback is "fail closed" not "use 'changeme'".
5. Health endpoint (`/healthz`) must **not** require auth — an authenticated healthcheck risks the token going into a Compose healthcheck command, which `docker inspect` exposes.
6. Test for it: `docker compose logs | grep -i "bearer\|authorization"` should produce zero hits after a typical agent session.

**Warning signs:**
- `docker compose logs router | grep Bearer` returns matches.
- `journalctl -u docker | grep eyJ` returns matches.

**Phase to address:** Phase 3 (router) — pino redact config + health endpoint contract from day one.

---

### Pitfall 13: Long generations vs. cascading proxy timeouts

**What goes wrong:**
A reasoning-heavy model takes 90 s to finish a response. The agent client gets `502` or `499` after 60 s — Traefik or the router timed out the upstream connection before the backend finished. The backend then keeps generating tokens for nobody, holding a slot.

**Why it happens:**
Three timeout layers, each with different defaults:
- Backend → Router (Fastify): default request timeout in `node-fetch`/`undici` is none, but if you set one (commonly 30 s in libraries), it kills the stream.
- Router → Traefik: Traefik's `responseHeaderTimeout` defaults to 0 (no limit) but `idleConnTimeout` defaults to 90 s — kills idle SSE streams.
- Traefik → Client (browser/agent): browser default is no idle timeout for SSE; some agent SDKs set 60–120 s.

**How to avoid (concrete):**
- For each hop, set timeout to 0 (disabled) for `responseHeader` and use a heartbeat to keep the connection alive (see Pitfall 4). Idle timeouts must exceed heartbeat interval × 3.
- On the **router → backend** hop, use `undici`'s `bodyTimeout: 0, headersTimeout: 30_000`. Headers must arrive within 30 s (backend liveness); body can stream forever.
- On client disconnect (`req.raw.on('close')`), abort the upstream call. This is the single most-forgotten line; without it a hung client → router → backend chain holds GPU slots until backend finishes.
- End-to-end timeout test: a fixture prompt that takes ≥ 120 s on the slowest backend, executed through Traefik, must complete successfully.

**Warning signs:**
- `502 Bad Gateway` after consistent intervals (60s, 90s) on long generations.
- GPU stays at 100% utilization for tens of seconds after a client disconnect.

**Phase to address:** Phase 3 (router resilience) — abort propagation; Phase whichever covers Traefik — timeout audit.

---

### Pitfall 14: Agent retry storms DoS the local GPU

**What goes wrong:**
An agent SDK with default exponential backoff and `max_retries=8` hits a transient backend error. Eight retries in 60 s, each a full generation, each holding a GPU slot. Other agents queue. The system goes from "fine" to "completely jammed" in under a minute.

**Why it happens:**
- LLM client SDKs (OpenAI, Anthropic, langchain, ai-sdk) retry on 5xx and on read timeouts by default.
- Local backends emit transient errors during model load (Ollama swapping models in/out under VRAM pressure → 503; vLLM during warmup → connection refused).
- The retry is at the SDK level, but the cost is at the GPU level — every retry is a full inference run.

**How to avoid (concrete):**
1. **Server-side rate limiting** (Fastify `@fastify/rate-limit`): per-token, e.g. 60 req/min, 10 concurrent. Return `429 Retry-After: 30` so well-behaved SDKs back off.
2. **Idempotency keys**: accept `Idempotency-Key` header; if a retry comes in with the same key while the original is still streaming, attach to the existing stream rather than starting a new generation. This is the highest-impact change against retry storms but requires care with SSE.
3. **Circuit breaker per backend** (already in Pitfall 9): if a backend has failed > N times in M seconds, fail fast for the cooldown window. Don't queue.
4. **Distinct error codes**: 503 with `Retry-After` for "loading model, try again", 429 for "too many requests", 500 for "actual bug". SDKs treat 503/429 differently from 500; using the right code matters.
5. Document for human users: do not set `max_retries > 2` on the SDK side; let the router handle retries.

**Warning signs:**
- `nvidia-smi` shows 100% utilization sustained while only one logical request is "in flight" from the user's perspective.
- Router logs show duplicate request IDs in close succession.
- Postgres usage table shows N×expected token counts for a single agent session.

**Phase to address:** Phase 3 (router) — rate-limit and circuit breaker. Phase 7 (agent-first hardening / observability).

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|---|---|---|---|
| Run all backends in one container | Simpler Compose, one place to look | Restart blast radius (one OOM kills everything); inability to upgrade vLLM without taking Ollama down; logs interleaved | **Never** for this stack — separation is essentially free with Compose |
| `restart: always` instead of `unless-stopped` | "It comes back" | Crash loops fight your `down`; logs flood; resource churn | Only for stateless tools you genuinely never want to stop manually |
| Hardcode model list in router source | One less file | Every model change is a code change + redeploy; no runtime switching | MVP first 48h; replace with `models.yaml` before any real use |
| Skip Postgres in v1 ("we can add it later") | Less infra | Schema migration retrofitted onto live data; usage history starts at zero | If usage tracking explicitly deferred — but token-level audit trail will not be reconstructible |
| Use `:latest` Docker tags | Always "current" | Silent breaking changes; reproducibility gone | Never for inference runtimes (CUDA ABI breaks); acceptable for `redis:7` / `postgres:16` only with major-version pinning |
| Skip `models.yaml` schema validation | Less code | A typo brings down the whole router on reload | Never — validate with zod/typebox at config load |
| Single `docker compose up` for all services | One command | Pulling 30 GB at first run; no incremental bring-up | OK if combined with a `make` target that does the right ordering |
| Log full request body on error | Easy debug | Token + prompt + PII in logs forever | Only with redaction (Pitfall 12); prefer logging request ID + correlating to in-memory ring buffer |
| Skip a `gpu-preflight` service | Faster iteration | Mysterious CPU-fallback bugs months later | Only on a fresh, just-validated host; re-add for any new host |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|---|---|---|
| Ollama from another container | Calling `localhost:11434` | Use Compose service DNS: `http://ollama:11434`. Bind Ollama with `OLLAMA_HOST=0.0.0.0:11434`. |
| vLLM model loading | Letting it download at startup | Pre-download to mounted HF cache; pin model revision SHA, not just name |
| llama.cpp `--ctx-size` with `--n-parallel` | Setting `--ctx-size 8192 --n-parallel 4` and expecting 8k per request | Per-slot context = total / parallel. Use `--ctx-size 32768 --n-parallel 4` for 8k per slot. |
| Anthropic system message | Putting it in `messages[]` with `role: "system"` | Top-level `system` parameter only. Fail closed if a `system` role appears in messages — it's an OpenAI shape that wasn't translated. |
| Anthropic role alternation | Sending `[user, user, assistant]` after collapsing tool results | Validator that errors before send; collapse logic must respect strict alternation. |
| OpenAI tool arguments | Passing `arguments` as a parsed object | OpenAI requires `arguments` as a JSON-encoded string; `JSON.stringify` is mandatory. |
| Ollama Cloud auth | Reusing the local Ollama API key | Ollama Cloud uses a *separate* API key from the dashboard; set `OLLAMA_API_KEY` for Cloud, distinct from local. |
| Open WebUI ↔ Router | Adding the router URL with `/v1` suffix | Open WebUI's "OpenAI API" connector expects the base URL *without* `/v1`; it appends paths itself. Easy to double-prefix. |
| Traefik Docker provider | Forgetting `traefik.docker.network=local-llms_proxy` | Without the explicit network label, Traefik picks an IP from a network it can't route to. Symptom: `Bad Gateway` to a container that's clearly running. |
| Postgres in same Compose | Default Postgres image with no init script | Set `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB` from `.env`; mount init scripts to `/docker-entrypoint-initdb.d/` for schema bootstrap. |
| Redis | Using default `redis:7` with no `--maxmemory-policy` | Set `--maxmemory <budget> --maxmemory-policy allkeys-lru`; otherwise Redis grows until OOM-killed. |
| HuggingFace gated models | Putting `HF_TOKEN` in `.env` and committing | Use Docker `secrets:` (file-based) or pass via env from a non-committed `.env` listed in `.gitignore`; verify `git status` is clean post-add. |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|---|---|---|---|
| `OLLAMA_NUM_PARALLEL` left at default | Throughput collapses with two concurrent requests; KV cache eats VRAM unexpectedly | Set explicitly per-model in env; budget VRAM as `parallel × ctx × per_token_KV` | First time two agents hit the same Ollama model at once |
| vLLM `--max-num-seqs` too high | Per-request throughput drops as concurrency grows | Match `max-num-seqs` to expected steady-state concurrency; for single-user agent-first, 4–8 is plenty | When agent fan-out exceeds expected concurrency |
| llama.cpp `-ngl` too low | Layers run on CPU, throughput is 1/10th of GPU baseline | `-ngl 99` (or model layer count) for "all layers on GPU"; verify VRAM headroom first | On any model where layer count was guessed |
| SSE without backpressure | Memory growth on slow consumers; eventual OOM on the router process | `reply.raw.write()` return-value check + `'drain'` await | When clients are slow, agents stall, or networks are flaky |
| Logging full streamed responses | Disk fills; log shipper falls behind; tail latency spikes during flush | Log token counts and timing only; full bodies behind a `DEBUG_FULL_BODY` flag | Sustained agent traffic over hours |
| Agent retry storms | GPU pinned at 100% with low effective throughput; queue depth grows | Server-side rate limit + idempotency keys + circuit breakers | First production-like agent workflow with default SDK retry settings |
| Open WebUI model list cache stale | UI shows models that don't exist or hides ones that do | After backend changes, restart Open WebUI or call its `/api/models/refresh` endpoint | Whenever `models.yaml` changes |
| Postgres without `pg_stat_statements` planning | Mystery slow queries when usage table grows; query patterns invisible | Enable extension from day one; periodic vacuum on usage tables | Around 1M usage rows |
| Compose without resource limits on Redis/Postgres | A bug in usage logging fills Redis; everything degrades | Compose `mem_limit` / `--maxmemory` per service | Long-running deployment + a logging bug |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---|---|---|
| Bearer token in logs | Full stack auth compromise via log access | pino redact + Traefik header drop (Pitfall 12) |
| Healthcheck command embeds the token | `docker inspect` shows the token | Public unauthenticated `/healthz`; auth required only on inference endpoints |
| Backend services exposed on host ports | LAN access bypasses router auth | All backends bind only to internal Compose network; only Traefik (and optionally router) publishes ports |
| Open WebUI `WEBUI_AUTH=False` on public port | Anyone on LAN/internet drives your GPU and reads chat history | Always behind Traefik basic-auth or VPN; never publish Open WebUI port directly |
| `.env` committed to Git | Token + HF_TOKEN + Postgres password leaked | `.gitignore` `.env`, commit `.env.example`; pre-commit hook scanning for secrets (gitleaks/trufflehog) |
| HF_TOKEN as plain env var | Visible in `docker inspect` to anyone with Docker socket access | Use Docker secrets (`secrets:` Compose key) or read from mounted file |
| Single shared bearer for both human and agent traffic | Cannot revoke agent access without breaking your own UI | Even in single-user mode, two tokens (human/UI vs. agent) — both still in `.env`, but rotateable independently |
| CORS `*` on the router | Browser pages on any origin can call the API with the user's cookies | Lock CORS to known origins (Open WebUI, localhost dev); never `*` in production config |
| Postgres exposed to host port | Anyone on the box can connect with leaked password | Internal-only network; Postgres has no `ports:` published |
| Trusting model output in shell calls | A model that returns shell commands gets executed if a tool wraps `bash -c` | Tool implementations sandboxed; never `exec(model_output)` even from a "trusted" local model |

---

## UX Pitfalls (agent-first)

| Pitfall | User Impact | Better Approach |
|---|---|---|
| Routing decisions hidden from response | Agent can't tell if it got a local or cloud model | Include `X-Model-Backend: ollama|llama.cpp|vllm|ollama-cloud` response header on every response |
| `model: "gpt-4"` resolves to whatever | Agents using OpenAI SDK with default model name get "something" | Explicit allowlist; unknown model name → 400 with list of available |
| Streaming errors mid-stream are silent | Agent receives partial text, thinks it's complete | Final SSE event must be `event: done` with `finish_reason`; on error, send `event: error` with structured body before closing |
| Tool-call schemas drift between protocols | Agent expecting OpenAI shape gets Anthropic-shaped error | Translate errors on the way out, not just success cases (Pitfall 5) |
| Embeddings endpoint returns wrong dimensions | Agent's vector store rejects the insert | Include `dimensions` in `/v1/models` listing; refuse mismatch at insert time |

---

## "Looks Done But Isn't" Checklist

- [ ] **GPU passthrough:** preflight script asserts `/dev/dxg`, host `nvidia-smi`, and container `nvidia-smi` all work — not just "the model loaded" (silent CPU fallback is the default failure mode on WSL2).
- [ ] **SSE streaming:** verified end-to-end through Traefik with `curl -N`, with deltas arriving < 1 s apart on a slow generation. Direct-to-router success does not guarantee through-Traefik success.
- [ ] **Tool calling:** parallel tool calls round-trip in both protocols (most translators get single-tool right and break on parallel).
- [ ] **Vision:** image payloads round-trip in both protocols, both as URL and base64. Many implementations only test one path.
- [ ] **Long generations:** a 120 s+ generation through Traefik completes successfully without 502.
- [ ] **Client disconnect:** killing `curl` mid-stream verifies GPU returns to idle within ~1 s (abort propagation).
- [ ] **Token redaction:** `docker compose logs | grep -i "bearer\|authorization"` returns zero matches after a representative session.
- [ ] **Open WebUI auth posture:** explicit decision documented (`WEBUI_AUTH=False` + Traefik basic-auth, OR seeded admin) before first public boot.
- [ ] **Backups:** at least one Postgres `pg_dump` has been restored to a scratch instance and reads correctly. "We have backups" without a tested restore = no backups.
- [ ] **Models volume bound:** `docker volume inspect` shows the expected size; `df -h` on the host filesystem has > 30% free.
- [ ] **Restart policy:** every service has `restart: unless-stopped` (audit `docker compose config | grep -A1 restart`).
- [ ] **Health endpoints:** every backend and the router expose `/healthz` (or equivalent) returning quickly without auth, used by Compose healthchecks.
- [ ] **Resource limits:** Redis has `--maxmemory`, Postgres has `shared_buffers`/`effective_cache_size` tuned, no service is unbounded.
- [ ] **Idempotency:** retrying a request with the same `Idempotency-Key` does not double-charge the GPU.
- [ ] **Config schema:** `models.yaml` is validated at router startup; bad config produces a clear startup error, not a 500 on first request.

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---|---|---|
| GPU silent CPU fallback | LOW | Run preflight; reinstall toolkit inside WSL2; restart Docker daemon; `docker compose down && up` |
| vLLM OOM at startup | LOW | Lower `--max-model-len` and/or `--gpu-memory-utilization`; restart |
| VRAM thrash (3 backends fighting) | LOW | Set `profiles:` and bring up one backend; revisit `models.yaml` budgets |
| Tool-call corruption | MEDIUM | Add round-trip tests; refactor translation layer to canonical-shape; treat as a bug, not config |
| Token leaked to logs | HIGH | Rotate token (every client config update); audit log retention; purge journald/log volumes; **never** `git rebase` to "remove" — assume compromised |
| Open WebUI admin set wrong | MEDIUM | Stop Open WebUI; delete its data volume; restart with desired `WEBUI_AUTH` and `WEBUI_ADMIN_*` env vars from clean state |
| Models volume full | MEDIUM | `gc-models.sh` against `models.yaml`; `ollama rm` unused; vacuum Docker (`docker system prune --volumes` only after explicit backup) |
| Postgres data loss | HIGH | Restore from latest `pg_dump`; if no tested restore, accept loss of usage/history; the rest of the stack is stateless |
| Agent retry storm in progress | LOW | `docker compose restart router`; cooldown clears in-flight; address with rate-limit + circuit breaker |
| Cloud quota exhausted | LOW | Switch routing to local-only; wait for reset window |
| Cert renewal failure | MEDIUM | Fall back to self-signed for internal; debug ACME DNS challenge separately; do not let cert failure block inference |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---|---|---|
| 1. WSL2 driver/toolkit drift | Phase 1 (Compose foundation) | `bin/preflight-gpu.sh` exits 0; `docker run --gpus all` smoke test |
| 2. `runtime: nvidia` vs `deploy.resources` | Phase 1 | Compose lint pass; `x-gpu` anchor referenced by every GPU service |
| 3. Three backends thrashing 16 GB | Phase 2 (backends) + Phase 3 (router) | `models.yaml` enforces VRAM budget; integration test: load 3 models, assert no OOM |
| 4. SSE buffered through Traefik | Phase 1 (Traefik) + Phase 3 (router SSE) | `curl -N` test through Traefik shows deltas < 1 s apart |
| 5. Tool-call translation | Phase 3 (router) | Round-trip golden tests for OpenAI ↔ Anthropic ↔ canonical |
| 6. vLLM `max-model-len` OOM | Phase 2 (vLLM bring-up) | `models.yaml` requires `max_model_len` field; startup test on 16 GB ceiling |
| 7. vLLM startup / model download | Phase 2 (vLLM bring-up) | Pre-download workflow + `start_period: 600s`; cold-start test |
| 8. Ollama OpenAI-compat quirks + naming | Phase 2 (Ollama) + Phase 3 (router) | Native `/api/chat` path used for Ollama; `:latest` forbidden in `models.yaml` |
| 9. Ollama Cloud quotas / costs | Phase 4 (Cloud fallback) | Circuit breaker test; spend metric; `max_tokens` cap test |
| 10. Open WebUI admin first-boot | Phase 5 (platform / Open WebUI) | First boot in `WEBUI_AUTH=False` mode; behind Traefik basic-auth |
| 11. Models volume balloon | Phase 1 (volume layout) + Phase 6 (ops) | `gc-models.sh`; disk-usage alert |
| 12. Bearer token in logs | Phase 3 (router) | `pino redact` config; `grep` test in CI smoke run |
| 13. Long-generation timeouts | Phase 3 + Traefik phase | 120 s+ generation E2E test |
| 14. Agent retry storm | Phase 3 (router) + Phase 7 (agent-first hardening) | Rate-limit headers present; chaos test with `max_retries=8` and assert no GPU saturation |

---

## Sources

### NVIDIA / Docker / GPU on WSL2
- [CUDA on WSL User Guide — NVIDIA](https://docs.nvidia.com/cuda/wsl-user-guide/index.html)
- [Installing the NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
- [Docker Compose GPU support](https://docs.docker.com/compose/how-tos/gpu-support/)
- [Compose Deploy Specification — devices reservations](https://docs.docker.com/reference/compose-file/deploy/)
- [Markaicode — Docker GPU passthrough fails in WSL2 with Ollama (2026 fix guide)](https://markaicode.com/docker-gpu-passthrough-wsl2-ollama/)
- [microsoft/WSL #9962 — GPU access blocked by the operating system](https://github.com/microsoft/WSL/issues/9962)

### Ollama
- [Ollama FAQ (concurrency, OLLAMA_NUM_PARALLEL, OLLAMA_MAX_LOADED_MODELS)](https://docs.ollama.com/faq)
- [How Ollama Handles Parallel Requests — Rost Glukhov](https://www.glukhov.org/llm-performance/ollama/how-ollama-handles-parallel-requests/)
- [Ollama Cloud docs](https://docs.ollama.com/cloud)
- [ollama/ollama #15663 — expose account quota/usage details](https://github.com/ollama/ollama/issues/15663)
- [ollama/ollama #13089 — limiting max tokens on cloud models to 16,384](https://github.com/ollama/ollama/issues/13089)
- [Ollama Vision capability docs](https://docs.ollama.com/capabilities/vision)
- [Ollama OpenAI compatibility layer notes](https://ollama.readthedocs.io/en/openai/)
- [hermes-agent #14592 — Ollama Cloud vision returns 500 on /v1/chat/completions](https://github.com/NousResearch/hermes-agent/issues/14592)

### llama.cpp
- [llama.cpp server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [ggml-org/llama.cpp #11681 — `--ctx-size` is divided by `--parallel`](https://github.com/ggml-org/llama.cpp/issues/11681)
- [Parallelization / Batching Explanation (llama.cpp discussion #4130)](https://github.com/ggml-org/llama.cpp/discussions/4130)
- [llama.cpp VRAM Requirements 2026 guide](https://localllm.in/blog/llamacpp-vram-requirements-for-local-llms)
- [oobabooga — GGUF VRAM formula from layers and context](https://oobabooga.github.io/blog/posts/gguf-vram-formula/)

### vLLM
- [vLLM — Conserving Memory](https://docs.vllm.ai/en/latest/configuration/conserving_memory/)
- [vLLM — Optimization and Tuning](https://docs.vllm.ai/en/stable/configuration/optimization/)
- [vLLM — Using Docker](https://docs.vllm.ai/en/stable/deployment/docker/)
- [vLLM — Troubleshooting](https://docs.vllm.ai/en/latest/usage/troubleshooting/)
- [vllm-project/vllm #11049 — local storage path for downloaded models](https://github.com/vllm-project/vllm/issues/11049)

### Tool calling protocols
- [Function Calling & Tool Use Guide 2026 — OpenAI / Anthropic / Gemini compared](https://ofox.ai/blog/function-calling-tool-use-complete-guide-2026/)
- [TokenMix — Function Calling and Tool Use Guide 2026](https://tokenmix.ai/blog/function-calling-guide)
- [LiteLLM — Anthropic provider notes](https://docs.litellm.ai/docs/providers/anthropic)
- [LiteLLM — /v1/messages unified endpoint](https://docs.litellm.ai/docs/anthropic_unified)
- [BerriAI/litellm #15315 — Fix parallel tool calls in Anthropic passthrough adapter](https://github.com/BerriAI/litellm/pull/15315)
- [openai-agents-python #1797 — tool_result blocks before tool_use blocks](https://github.com/openai/openai-agents-python/issues/1797)
- [langchain #31657 — Anthropic errors with system messages in tool-calling flows](https://github.com/langchain-ai/langchain/issues/31657)

### Fastify / SSE / Traefik
- [@fastify/sse on npm](https://www.npmjs.com/package/@fastify/sse)
- [Liran Tal — Avoid Fastify's reply.raw and reply.hijack (or know what you're doing)](https://lirantal.com/blog/avoid-fastify-reply-raw-and-reply-hijack-despite-being-a-powerful-http-streams-tool)
- [Fastify Reply reference](https://fastify.dev/docs/latest/Reference/Reply/)
- [Traefik community — Problem with streaming SSE server behind traefik](https://community.traefik.io/t/problem-with-streaming-sse-server-behind-traefik/23007)
- [Traefik community — Disable response buffering](https://community.traefik.io/t/disable-response-buffering/25764)
- [Traefik dynamic configuration providers](https://doc.traefik.io/traefik/reference/routing-configuration/dynamic-configuration-methods/)
- [Traefik ACME certificates resolver](https://doc.traefik.io/traefik/https/acme/)

### Open WebUI
- [Open WebUI — Quick Start](https://docs.openwebui.com/getting-started/quick-start/)
- [open-webui #9973 — can't disable WEBUI_AUTH after users exist](https://github.com/open-webui/open-webui/discussions/9973)
- [open-webui #10982 — Deploying without mandatory login](https://github.com/open-webui/open-webui/discussions/10982)

### Operations / Postgres backups / agent failure modes
- [Automated PostgreSQL backups in Docker with pg_dump](https://serversinc.io/blog/automated-postgresql-backups-in-docker-complete-guide-with-pg-dump/)
- [kartoza/docker-pg-backup](https://github.com/kartoza/docker-pg-backup)
- [Will Velida — Preventing Cascading Failures in AI Agents](https://www.willvelida.com/posts/preventing-cascading-failures-ai-agents)
- [Why AI Agents Fail — failure modes that cost tokens and time](https://dev.to/aws/why-ai-agents-fail-3-failure-modes-that-cost-you-tokens-and-time-1flb)

---
*Pitfalls research for: self-hosted multi-runtime LLM gateway on NVIDIA GPU under WSL2*
*Researched: 2026-05-09*
