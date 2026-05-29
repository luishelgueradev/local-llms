# Feature Research

**Domain:** Self-hosted unified LLM gateway / "personal AI gateway" (single-user, agents-first, GPU-bound)
**Researched:** 2026-05-09
**Confidence:** HIGH (verified against current docs of OpenAI, Anthropic, vLLM, Ollama, Open WebUI, LiteLLM, OpenRouter and primary literature on dual-protocol translation)

---

## Categorization Key

- **Table stakes** — agents (the primary client) WILL leak/break/produce broken streams without this. Non-negotiable for v1.
- **Differentiator** — provides real leverage for THIS specific user's workflow (single human + many agents on a GPU-bound box).
- **Anti-feature** — exists in mature competitors (LiteLLM, OpenRouter, Portkey, Bifrost) but should be deliberately NOT built — reason always given.
- **Deferred** — interesting, has a real use case, but not v1 scope. Add post-v1 once core stabilises.

Complexity: **S** (≤1 day), **M** (2-5 days), **L** (>1 week of focused work).

---

## 1. Router / Gateway Features (Fastify service)

### 1.1 OpenAI-compatible surface

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| R1 | `POST /v1/chat/completions` (non-stream + stream) | **Table stakes** | M | Every agent SDK on the planet expects this. The single most important endpoint. |
| R2 | `POST /v1/embeddings` | **Table stakes** | S | Required by RAG pipelines, indexing scripts, n8n nodes. Already in PROJECT.md `Active`. |
| R3 | `GET /v1/models` returning `{object:"list", data:[{id, object:"model", created, owned_by}]}` | **Table stakes** | S | Open WebUI auto-discovers models from this endpoint; many CLIs use it for tab completion. Very cheap to implement (just emit from declarative config). |
| R4 | `POST /v1/completions` (legacy text completion) | **Anti-feature** | — | OpenAI itself moved away from it; modern agents use chat completions. Implementing it forces awkward prompt-template inversion per backend. **Skip with a clean 410/404.** |
| R5 | `/v1/audio/*` (TTS, STT, transcription) | **Anti-feature** for v1 | — | None of the local backends in the stack (Ollama/llama.cpp/vLLM) ship audio models in this hardware envelope; you'd be a translation layer to nothing. Out of scope explicitly. |
| R6 | `/v1/images/*` (DALL·E-style generation) | **Anti-feature** for v1 | — | No image-gen backend planned (would require ComfyUI/SD-WebUI, separate VRAM budget). Out of scope. |
| R7 | `/v1/responses` (OpenAI's new "Responses API" that supersedes Chat Completions) | **Deferred** | M | Recommended by OpenAI for new projects but ecosystem (Anthropic SDK, agent frameworks, n8n) still mostly emits Chat Completions. Re-evaluate once 50%+ of his agents need it. |

### 1.2 Anthropic-compatible surface

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| R8 | `POST /v1/messages` (non-stream + stream) | **Table stakes** | M-L | Half the agent ecosystem (Claude Code, Anthropic SDK, many MCP tools) speaks Anthropic natively. Need real translation, not a stub. |
| R9 | `POST /v1/messages/count_tokens` | **Table stakes** | S | Anthropic SDK calls this before long requests for budget/UX. Returning a plausible estimate (tiktoken `cl100k_base` or backend-native) is enough — Anthropic itself documents the count is approximate. |
| R10 | Anthropic system prompt as separate `system` field (not first message) | **Table stakes** | S | Required by spec; common bug source — translators that flatten it into messages break role alternation rules. |
| R11 | Strict user/assistant role alternation enforcement | **Table stakes** | S | Anthropic 400s on consecutive same-role messages; OpenAI doesn't. Translator must coalesce. |

### 1.3 Streaming (SSE)

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| R12 | OpenAI streaming: `data: {chunk}\n\n` with `delta.content`, terminating `data: [DONE]` | **Table stakes** | M | Locked in PROJECT.md as obligatory. |
| R13 | Anthropic streaming with typed events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `ping` | **Table stakes** | L | The hardest part of the project. Anthropic's protocol is structurally richer than OpenAI's; you must reconstruct event sequences from a backend that only produces OpenAI-style chunks. |
| R14 | Usage tokens emitted at start (input) AND end (output) for Anthropic streams | **Table stakes** | M | Spec requires it; Anthropic SDKs read `message_start.message.usage.input_tokens` and patch it via `message_delta.usage.output_tokens`. OpenAI puts everything in the last chunk — translator must split. |
| R15 | SSE keep-alive (Anthropic `ping`, OpenAI silent comments) every ~15s during long prefill | **Table stakes** | S | Without this, Traefik / corporate proxies / agent HTTP clients time out mid-stream on a 70B model warming up. |
| R16 | Backpressure on slow clients (do not buffer entire response in memory) | **Table stakes** | M | A single agent reading slowly should not OOM the router. Fastify has reply.raw piping helpers. |

### 1.4 Tool / function calling translation

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| R17 | OpenAI tool schema: `{type:"function", function:{name, description, parameters}}` ⇄ Anthropic: `{name, description, input_schema}` | **Table stakes** | M | Trivial structural rename, but easy to get JSON-Schema dialect drift wrong (Anthropic is stricter on `additionalProperties`). |
| R18 | OpenAI `tool_calls` array on message ⇄ Anthropic `tool_use` content blocks | **Table stakes** | M | Different shapes: OpenAI puts a parallel array; Anthropic interleaves `tool_use` blocks inside `content`. Streaming variant is even more painful — Anthropic emits `content_block_start{type:"tool_use"}` then `input_json_delta` chunks. |
| R19 | Tool result reply: OpenAI `role:"tool"` with `tool_call_id` ⇄ Anthropic `user` message containing `tool_result` content block referencing `tool_use_id` | **Table stakes** | M | Round-trip must preserve IDs so multi-turn tool conversations work. |
| R20 | Parallel tool calls in single response | **Table stakes** | M | OpenAI emits multiple in one `tool_calls` array natively. Anthropic emits multiple `tool_use` blocks; some Claude versions are reluctant to do this. Just preserve whatever the backend emits — don't try to force parallelism. |
| R21 | `tool_choice: "auto" / "none" / {type:"function", function:{name}} ` mapping | **Table stakes** | S | Anthropic uses `tool_choice: {type:"auto"\|"any"\|"tool", name}`. Direct translation. |
| R22 | Strict-mode JSON Schema (`strict:true`, OpenAI structured outputs) | **Deferred** | M | Useful but backends differ wildly; vLLM has guided decoding flags, llama.cpp has grammar files. v1 can let the model do its best. |

### 1.5 Vision / multimodal input

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| R23 | OpenAI image input: `{type:"image_url", image_url:{url:"data:image/...;base64,..." or http(s)://...}}` | **Table stakes** | M | URL form must be downloaded server-side and converted before forwarding to local backend. |
| R24 | Anthropic image input: `{type:"image", source:{type:"base64", media_type, data}}` (base64 only — URL form was added in late 2025 but still less universal) | **Table stakes** | M | Translator must base64-encode when going OpenAI→Anthropic, decode+stream-fetch when going Anthropic→OpenAI. |
| R25 | Reject vision request if backend's model lacks vision capability (declarative config flag `capabilities: [vision]`) | **Table stakes** | S | Otherwise text-only Llama silently drops the image and gives gibberish — classic agent failure mode. |
| R26 | Image size/dimension limits + downscaling before forwarding | **Differentiator** | M | Local vision models OOM fast on 4K screenshots. Auto-downscale to ~1568px long edge (Anthropic's recommendation) saves the user from reproducing this every time. |
| R27 | PDF input (Anthropic `document` content blocks) | **Deferred** | M | Niche; users typically pre-extract. Add when actual demand surfaces. |
| R28 | Audio input blocks | **Anti-feature** v1 | — | No audio-capable backend in stack. |

### 1.6 Backend management

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| R29 | Declarative model→backend mapping (YAML/JSON config: model id, backend URL, capabilities, context window, optional alias) | **Table stakes** | S | Already in PROJECT.md. Single source of truth. |
| R30 | Backend liveness probe (TCP/HTTP `/health` or equivalent) on a schedule, with status cached | **Table stakes** | S | Without this, the first request after a backend crash returns a 502 to the agent, who retries, who gets another 502 — agent loops die ugly. |
| R31 | Backend readiness probe (model actually loaded, not just process up — Ollama `/api/show`, vLLM `/v1/models`, llama.cpp `/health`) | **Table stakes** | S | Different signal from liveness; lazy-load backends report "up" before model is in VRAM. |
| R32 | Per-model hot/cold awareness (track which model is currently loaded in each backend; warn or reject if cold-load would exceed VRAM) | **Differentiator** | M | The user's box has 16 GB VRAM. Loading two 13B models simultaneously OOMs. Router knowing which slot is in use prevents cascade failures that vLLM/Ollama alone don't coordinate on. |
| R33 | Per-backend concurrency cap (e.g. vLLM=8, llama.cpp=1, Ollama=4) — semaphore in router, queue overflow → 429 | **Table stakes** | M | Agents fan out aggressively; without a cap a single agent loop can monopolise the GPU. |
| R34 | Per-model rate limit (token bucket, e.g. requests/min) | **Deferred** | S | Single-user — not needed in v1. Reconsider if a runaway agent burns the box. |
| R35 | Ollama Cloud fallback when local model unavailable (cold + can't fit, or repeated failures) | **Differentiator** | M | Already a key requirement (PROJECT.md). The killer feature: agent asks for `gpt-oss:120b`, local can't fit it, router transparently proxies to Ollama Cloud and rewrites IDs. |
| R36 | Failover chain config: `model: foo, fallback: [foo-cloud, foo-quantized]` | **Differentiator** | M | OpenRouter-style. Useful when the user wants graceful degradation rather than a hard 503. Keep it declarative, not auto-magic (PROJECT.md already rejects content-based routing). |
| R37 | Circuit breaker per backend (after N failures in M seconds, mark down for cooldown) | **Differentiator** | S | Avoids flooding a stuck llama.cpp with 100 retries. Cheap once R30 exists. |

### 1.7 Auth / accounting

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| R38 | Bearer token auth (single token from `.env`, constant-time compare) | **Table stakes** | S | Already locked. |
| R39 | Optional second header for "agent identity" tag (e.g. `X-Agent-Name`) for logging | **Differentiator** | S | Single user, but many agents — knowing whether the runaway request was n8n or Claude Code is gold. |
| R40 | Multi API key with per-key permissions / spend caps | **Anti-feature** | — | **Why not**: PROJECT.md explicitly rules out multi-tenant. Single user → one bearer token. Adding key management means a DB-backed key table, rotation UI, etc. — pure overhead. |
| R41 | OAuth / OIDC | **Anti-feature** | — | Single user. Nope. |
| R42 | Token usage in response: OpenAI `usage:{prompt_tokens, completion_tokens, total_tokens}` and Anthropic `usage:{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` | **Table stakes** | S | Agents (especially Claude Code, OpenAI Agents SDK) read this to enforce their own budgets. Pass through whatever backend reports; estimate if backend doesn't supply it. |
| R43 | Cost estimation in response (USD-equivalent based on local-vs-cloud) | **Deferred** | S | Cute but not needed in v1; postgres logging makes after-the-fact analysis trivial. |
| R44 | Per-model spend caps with hard 429 | **Anti-feature** v1 | — | Single user controls their own spend; cloud fallback can be disabled per-model in config if cost is a worry. Implementing budget enforcement adds DB writes on every request. |

### 1.8 Logging & observability (router-level)

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| R45 | Structured request log to Postgres: timestamp, agent_id (R39), protocol, model, backend chosen, status, latency_ms, ttft_ms, prompt_tokens, completion_tokens, error (if any) | **Table stakes** | M | The whole point of having Postgres in the stack. Required to debug "which agent burned the GPU" questions. Buffer + batch-insert (every 1-2s or N rows) so logging never blocks the request path. |
| R46 | Optional full prompt/response body capture (gated by env flag, with rotation) | **Differentiator** | M | When debugging an agent, having the actual conversation is invaluable. Off by default — privacy + Postgres bloat. |
| R47 | Prometheus `/metrics` endpoint on router (request counts, latencies, in-flight, error codes by backend) | **Differentiator** | S | Trivial with `fastify-metrics` or `prom-client`; Grafana dashboard is then a 1-hour job. Strong leverage given agents are the primary load. |
| R48 | OpenTelemetry traces (OTLP exporter) | **Deferred** | M | Useful but heavyweight; Prometheus + structured logs cover 90% in single-host. Add only if traces become necessary. |
| R49 | Health endpoint `/healthz` (liveness) and `/readyz` (any-backend-ready) | **Table stakes** | S | Traefik / Docker uses these; agents may use them as preflight. |

### 1.9 Anthropic-specific niceties

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| R50 | `cache_control` block passthrough — when the request goes to a real Anthropic-backed model (Ollama Cloud or future direct Anthropic backend), forward unchanged | **Table stakes** if any Anthropic-backed model exists; **Deferred** otherwise | S | Cheap. If router ever proxies to Anthropic-API-compatible providers, dropping `cache_control` halves the user's actual cache hit rate. For purely-local Anthropic-shape responses, the directive is a no-op. |
| R51 | Auto-injection of `cache_control` at heuristic breakpoints (Autocache-style) | **Anti-feature** | — | Adds magic that's hard to debug. The user already controls his agents — let him add `cache_control` himself when he wants it. |
| R52 | `stop_sequences` array (Anthropic) ⇄ `stop` (string or array) (OpenAI) | **Table stakes** | S | Trivial mapping but easy to forget. |
| R53 | `thinking` / extended-thinking / reasoning-content blocks (Anthropic-style reasoning models) | **Deferred** | M | Backend support is uneven; the local stack rarely surfaces explicit chain-of-thought. Add when a reasoning model is added to the catalog. |
| R54 | Anthropic-compatible request signing / `anthropic-version` header echoing | **Table stakes** | S | Some clients refuse to talk to a server that doesn't echo a recognised `anthropic-version`. Pin to a current spec date and document. |

---

## 2. Open WebUI Features (the human-facing UI)

Open WebUI sits behind Traefik and consumes the router via OpenAI-compatible API (its native protocol). It's the "secondary" surface (research/manual experimentation per PROJECT.md).

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| W1 | Connect to single OpenAI-compatible URL (the Fastify router) with bearer token | **Table stakes** | S | `OPENAI_API_BASE_URL` + `OPENAI_API_KEY` env vars. Done. |
| W2 | Auto-discovery of model list from `/v1/models` | **Table stakes** | S | Native OWUI behavior — depends on R3 above. |
| W3 | Disable auth (`WEBUI_AUTH=False`) | **Table stakes** | S | Single user, behind Traefik+TLS+bearer-token, on a private network. The internal OWUI auth is ceremony. **But verify OWUI is not network-exposed without auth** — keep it on the private docker network only. |
| W4 | Multi-backend (configure several OpenAI-compatible URLs simultaneously) | **Anti-feature** | — | **Why not**: the whole point of the router is to be the single backend. Adding direct OWUI→Ollama bypass connections re-creates the very fragmentation the router fixes. Only the Fastify router URL should be configured. |
| W5 | Per-chat parameter overrides (temperature, top_p, max_tokens, system prompt) | **Table stakes** | S | Native OWUI; for "research" use case (model comparison) this is essential. |
| W6 | Side-by-side model comparison ("Models" / arena view) | **Differentiator** | S | Native OWUI feature; matches the secondary use case in PROJECT.md (research). |
| W7 | RAG / Knowledge / document upload | **Deferred** | M | Native OWUI, but: (a) it lives separately from any RAG the agents build via embeddings, and (b) it pulls compute the user wanted on agents. **Disable in v1**, document how to turn on later. |
| W8 | Web search inside chat (Agentic Search) | **Deferred** | S | Niche for research; not needed initially. |
| W9 | Code interpreter / sandbox | **Anti-feature** | — | **Why not**: another container, another VRAM-adjacent process; the user's agents (Claude Code, n8n) have their own sandboxes already. |
| W10 | User management / admin / RBAC / signups | **Anti-feature** | — | Single user. `WEBUI_AUTH=False` + `ENABLE_SIGNUP=False`. |
| W11 | MCP (Model Context Protocol) server connections from OWUI | **Differentiator** | S | OWUI 0.6+ supports it. Lets the user wire his existing MCP servers (filesystem, git, etc.) into ad-hoc chats. Light-touch, big leverage. |
| W12 | Chat history persistence (SQLite by default; can be Postgres) | **Table stakes** | S | Default works. Optionally point at the same Postgres instance for unified backup. |
| W13 | Image upload in chat (vision input) | **Table stakes** | S | Round-trips through router → vision-capable backend; depends on R23-R26. |
| W14 | TTS / voice input | **Anti-feature** v1 | — | No audio backends in stack (R5/R28 above). |

---

## 3. Operations / Platform Features

### 3.1 Storage / model management

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| O1 | Single named Docker volume `models/` mounted into Ollama, llama.cpp, vLLM | **Table stakes** | S | Already in PROJECT.md `Active`. |
| O2 | Subdirectory layout that respects each runtime's expectations: `models/ollama/` (Ollama-managed blobs), `models/gguf/` (raw GGUF for llama.cpp), `models/hf/` (HuggingFace snapshot for vLLM) | **Table stakes** | S | Reality: Ollama uses its own blob/manifest layout — you can't just point llama.cpp at it. vLLM wants HF format (config.json + tokenizer + safetensors); GGUF support in vLLM is "highly experimental and under-optimized" (vLLM docs). **Don't try to share a single directory across all three runtimes** — share the parent volume but give each runtime its native subtree. |
| O3 | Cross-runtime model deduplication via symlink for GGUF files (one file, both llama.cpp and Ollama via `Modelfile FROM /path/to.gguf`) | **Differentiator** | S | Saves tens of GB on disk for popular models. Only works for GGUF. |
| O4 | Model registry / catalog file (declarative listing of what's downloaded, what's pinned, what's cloud-only) | **Differentiator** | S | The router config (R29) is one half; an "available locally" registry is the operator's half. Kept simple — a YAML the user edits. |
| O5 | Auto-download missing models on startup | **Anti-feature** v1 | — | Surprise multi-GB downloads on boot is a foot-gun. Manual `ollama pull` / `huggingface-cli download` is a feature, not a bug. |
| O6 | Model garbage collection (delete unused) | **Deferred** | S | Disk fills slowly enough that a quarterly manual sweep is fine. |

### 3.2 Reverse proxy / TLS

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| O7 | Traefik routing via Docker labels per service | **Table stakes** | S | Already in PROJECT.md. |
| O8 | TLS termination at Traefik with certs that browsers (and Node `https.Agent`) trust on LAN | **Table stakes** | M | mkcert-generated CA + Traefik file provider is the canonical pattern. ACME/Let's Encrypt is overkill for a LAN box (and may not even resolve depending on DNS). |
| O9 | Local domain handling: pick `*.lan` or a `traefik.me`/`nip.io`-style scheme; document in README | **Table stakes** | S | nip.io (`router.127.0.0.1.nip.io`) avoids `/etc/hosts` editing entirely. Cheap operational win. |
| O10 | HTTP→HTTPS redirect | **Table stakes** | S | Standard Traefik middleware. |
| O11 | Service exposure rules: only **router** + **OpenWebUI** + **Traefik dashboard** are routed externally; backends (Ollama/vLLM/llama.cpp/Postgres/Redis) are internal-only | **Table stakes** | S | Already in PROJECT.md (`Networking interno`). Surface as Traefik labels — no `expose` on the backends. |
| O12 | Wildcard DNS / single-cert-many-services | **Differentiator** | S | One cert covering `*.local.dev` (or chosen scheme) → less ceremony. |
| O13 | Public exposure (port forward, Cloudflare Tunnel, Tailscale Funnel) | **Anti-feature** v1 | — | **Why not**: bearer-token-only single-user setup is fine on LAN but a tempting target on the public internet. If remote access is needed, recommend Tailscale (private overlay) rather than exposing the gateway. Document this as a guidance note. |

### 3.3 Observability (platform-level)

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| O14 | Scrape vLLM `/metrics` (Prometheus-native, on by default) | **Differentiator** | S | vLLM publishes `vllm:num_requests_running`, `vllm:gpu_cache_usage_perc`, `vllm:e2e_request_latency_seconds`, etc. Free observability, just point Prometheus at it. |
| O15 | Scrape llama.cpp-server metrics (`/metrics` Prometheus endpoint when launched with `--metrics`) | **Differentiator** | S | Same idea. |
| O16 | Ollama metrics — none native; surface via router-level metrics (R47) instead | **Note** | — | Ollama doesn't expose Prometheus. Don't try; rely on router-side latency/error metrics. |
| O17 | Prometheus + Grafana containers in stack | **Differentiator** | M | One Prom + one Grafana + one dashboard JSON. ~half day. The leverage on a GPU-bound box is huge — VRAM pressure becomes visible. |
| O18 | nvidia-smi exporter (DCGM exporter or `nvidia_gpu_exporter`) | **Differentiator** | S | Surfaces GPU temp, VRAM used, power draw — essential for spotting "model leak" between runtimes. |
| O19 | Centralised logs (Loki/Vector) | **Deferred** | M | Postgres structured log table (R45) is enough for v1. Add Loki only if log volume explodes. |
| O20 | Alerting (Alertmanager → email/ntfy/discord) | **Deferred** | S | Single user staring at dashboards is fine. Add alerts when something hurts often enough. |

### 3.4 Backups

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| O21 | Postgres `pg_dump` cron sidecar (e.g. `kartoza/docker-pg-backup` or a tiny custom container) writing dated dumps to a host volume | **Table stakes** | S | Without this, the request log + Open WebUI history are one `docker compose down -v` away from gone. Daily dumps + 7-day retention is the lazy-correct default. |
| O22 | Open WebUI state backup (its data volume containing chats, RAG indices, configs) | **Table stakes** | S | Either (a) point OWUI at the Postgres in O21 (then it's covered), or (b) tar its volume on a cron. (a) is cleaner. |
| O23 | Redis snapshot (RDB / AOF) backup | **Deferred** | S | Redis is cache/queue per PROJECT.md — by definition disposable. Persistence not worth backing up unless its role grows. |
| O24 | Models volume backup | **Anti-feature** | — | **Why not**: models are re-downloadable; backing up tens of GB of weights is wasteful. Document the model list (O4) instead — that's the "backup". |
| O25 | Restore drill / documented restore procedure | **Table stakes** | S | Backup that's never restored is folklore. README section: "to restore, run X". |
| O26 | Off-host backup destination (rsync to NAS / S3 / Backblaze) | **Differentiator** | S | One `restic` or `rclone` cron after O21 lands. Leverage is huge if the host disk fails. |

### 3.5 Deployment / lifecycle

| # | Feature | Category | Complexity | Why / Notes |
|---|--------|----------|------------|-------------|
| O27 | Single `docker compose up -d` brings the whole stack | **Table stakes** | S | Already implied. |
| O28 | `.env`-driven configuration (token, ports, model list path, OLLAMA_API_KEY for cloud) | **Table stakes** | S | Already implied. |
| O29 | Profile-based compose (e.g. `--profile vllm` to skip vLLM if you don't need it that day) | **Differentiator** | S | vLLM is heavy on startup VRAM. Letting the user toggle backends without editing files is convenient. |
| O30 | Healthcheck-aware service ordering (`depends_on: condition: service_healthy`) | **Table stakes** | S | Otherwise the router boots before backends and produces noise. |
| O31 | GPU device reservation per service (`deploy.resources.reservations.devices`) | **Table stakes** | S | NVIDIA Container Toolkit standard config. Already implied by PROJECT.md. |
| O32 | Auto-restart policy (`restart: unless-stopped`) on every long-running service | **Table stakes** | S | Single-host means the box's reboot is the recovery story; autorestart makes it work. |
| O33 | Build the router image locally vs pull pre-built | **Note** | S | Local Dockerfile build is fine; don't ship a registry until needed. |
| O34 | Service mesh / sidecars / Istio | **Anti-feature** | — | **Why not**: single host, single user, Docker Compose. k8s/mesh overhead would dwarf the workload. PROJECT.md already excludes orchestrators. |

---

## 4. Cross-cutting summary tables

### 4.1 Anti-feature roundup with rationale

| ID | Anti-feature | Reason it doesn't apply HERE |
|----|--------------|--------------------------------|
| R4 | Legacy `/v1/completions` | OpenAI itself deprecated; modern agents use chat. |
| R5/R6/R28/W14 | Audio + image-gen endpoints | No backend in stack; single GPU, 16 GB. |
| R40/R41/R44/W10 | Multi-key, OAuth, spend caps, RBAC, signups | Single user — explicit project constraint. |
| R51 | Auto cache_control injection | Magic; user controls his own agents. |
| W4 | OWUI talking directly to Ollama/vLLM | Defeats the point of the unified router. |
| W9 | Code interpreter inside OWUI | Agents have their own sandboxes; VRAM contention. |
| O5 | Auto-download missing models | Surprising multi-GB transfers on boot. |
| O13 | Public-internet exposure | Bearer-token-only is risky on the open internet; recommend Tailscale. |
| O24 | Models volume backup | Re-downloadable; waste of space. Backup the model list, not the bytes. |
| O34 | Service mesh / k8s | Over-engineering for single host. |

### 4.2 Differentiators (what makes THIS gateway worth building over LiteLLM)

| ID | Differentiator | Why it matters here |
|----|----------------|---------------------|
| R32 | Per-model VRAM/slot awareness | 16 GB box; preventing OOM cascades is a force multiplier. |
| R35 | Ollama Cloud transparent fallback | The killer feature: agents request any model, big ones spill to cloud. |
| R36 | Declarative failover chain | Predictable, debuggable graceful-degradation. |
| R37 | Per-backend circuit breaker | Stops a stuck backend from poisoning the agent loop. |
| R39 | Per-agent identity tag in logs | Knowing which of your N agents is the runaway. |
| R47 | Router Prometheus metrics | Free observability with negligible cost. |
| O14-O18 | vLLM / llama.cpp / GPU exporters | VRAM pressure visualisation on the constrained resource. |
| O3 | GGUF symlink dedup across Ollama + llama.cpp | Saves tens of GB. |
| O12 | Wildcard cert + nip.io | Operational ergonomics on a personal LAN. |
| W6 | OWUI side-by-side compare | Matches the "research" secondary use case. |
| W11 | OWUI MCP servers | Light wiring, big agent leverage. |
| O26 | Off-host backup destination | Disk-failure recovery. |

### 4.3 Table stakes — must-have for v1

Translation surface (R1, R2, R3, R8, R9, R10, R11), streaming (R12-R16), tool calling (R17-R21), vision (R23-R25), backends (R29-R31, R33), auth/usage (R38, R42), logging (R45, R49), Open WebUI (W1-W3, W5, W12, W13), platform (O1, O2, O7-O11, O21, O22, O25, O27-O32). Anthropic version echo (R54), stop_sequences (R52). Anthropic spec stop_sequences (R52).

---

## 5. Feature Dependencies

```
                                ┌─ R29 (model→backend config) ──────────────┐
                                │                                            │
                                ▼                                            ▼
R30/R31 (health probes) ───► R33 (concurrency caps) ───► R37 (circuit breaker)
                                │                                            │
                                ▼                                            ▼
                          R32 (slot awareness)                     R35 (Ollama Cloud fallback)
                                                                            │
                                                                            ▼
                                                                  R36 (failover chains)

R1 (chat) ──┬──► R12 (OAI stream) ──► R15 (keep-alive) ──► R16 (backpressure)
            │
            └──► R17 (tool schema) ──► R18 (tool_calls) ──► R19 (tool_result) ──► R20 (parallel)
                       ▲
R8 (messages) ─────────┤
            │
            └──► R13 (Anthropic stream) ──► R14 (split usage) ──► R15

R23/R24 (image input) ──► R25 (capability gating) ──► R26 (downscale)

R38 (bearer auth) ──► R39 (agent tag header) ──► R45 (structured log) ──► R46 (body capture)
                                                          │
                                                          └──► R47 (Prom metrics)

R3 (/v1/models) ──► W2 (OWUI auto-discovery)

W1 (OWUI single backend) ──► W3 (no auth) ──► [private network only]

O1 (volume) ──► O2 (per-runtime layout) ──► O3 (GGUF dedup symlinks)

O7 (Traefik labels) ──► O8 (TLS) ──► O9 (local domain) ──► O10 (HTTP→HTTPS)
                                                  │
                                                  └──► O11 (internal-only backends)

O14/O15/O18 (exporters) ──► O17 (Prom+Grafana) ──► R47 (router metrics integrate)

O21 (pg_dump) ──► O22 (OWUI state via Postgres) ──► O25 (restore drill) ──► O26 (off-host)
```

### Critical dependency notes

- **R13 (Anthropic streaming) is the single hardest item.** It depends on R8 + R12 + R14 because the translator must reconstruct typed events from OpenAI-shape chunks. Plan to do it after R12 is solid.
- **R17-R20 (tool calling translation) requires a stable schema-mapping layer** (a small set of pure functions: `oaiToolsToAnthropic`, `anthropicToolsToOai`, plus the streaming variant). Build the layer first, then wire it into both R1 and R8 paths so tool support is uniform.
- **R32 (slot awareness) requires R29 + R30 + R31** — you can't reason about VRAM pressure without knowing what's loaded where, which requires both static config and live probes.
- **R45 (logging) depends on Postgres being up before the router starts serving** — but writes must be non-blocking (buffered async). If Postgres is down, the router must keep serving and log to a fallback (stderr / local file ring buffer).
- **R35 (Ollama Cloud fallback) depends on R30 (health) + R36 (failover chain config) for predictability.** Don't make it implicit/automatic — make it a declared fallback in R29 config.
- **W2 (OWUI auto-discovery) depends on R3 (`/v1/models`).** If R3 is wrong/empty, OWUI shows nothing and the user thinks the stack is broken.
- **O22 (OWUI backup) is cleaner if you point OWUI at the Postgres in O21** rather than backing up two separate volumes.

### Conflict / mutual-exclusion notes

- **W4 (multi-backend OWUI) conflicts with the unified-router goal.** Pick one: route everything through the router (recommended), or accept fragmented logging.
- **R51 (auto-cache injection) conflicts with R50 (cache_control passthrough)** — pick passthrough; don't add a second decision-maker.
- **R34 (per-model rate limits) and R44 (spend caps) overlap with R33 (concurrency caps).** R33 alone is enough for a single-user box.

---

## MVP Definition

### v1 (launch)

The minimum to call the project "working" — agents can call any of the configured models from either protocol and get correct, observable, non-hanging answers.

- [ ] R1, R2, R3 (OpenAI surface)
- [ ] R8, R9, R10, R11, R54 (Anthropic surface basics + version echo)
- [ ] R12, R13, R14, R15, R16 (streaming both protocols)
- [ ] R17-R21 (tool calling end-to-end)
- [ ] R23-R26 (vision input)
- [ ] R29, R30, R31, R33 (declarative routing + health + concurrency cap)
- [ ] R35 (Ollama Cloud fallback) — the differentiator that justifies the project
- [ ] R38, R39, R42 (auth + per-agent tag + usage in response)
- [ ] R45, R47, R49 (Postgres log + Prometheus metrics + healthz)
- [ ] R52 (stop_sequences mapping)
- [ ] W1, W2, W3, W5, W12, W13 (OWUI usable + connected to router only)
- [ ] O1, O2, O3 (model storage layout + GGUF symlink dedup)
- [ ] O7-O12 (Traefik + TLS + local domain + internal-only backends)
- [ ] O14, O15, O17, O18 (Prometheus stack + GPU exporter)
- [ ] O21, O22, O25 (Postgres backup + OWUI state via Postgres + restore drill)
- [ ] O27-O32 (compose ergonomics)

### v1.x (after v1 stabilises)

Add when real friction shows up:

- [ ] R36 (declared failover chains beyond just cloud)
- [ ] R37 (circuit breaker per backend)
- [ ] R32 (per-model slot/VRAM awareness) — escalate when OOM happens twice
- [ ] R46 (full body capture, env-gated)
- [ ] R50 (cache_control passthrough) — when Anthropic-backed cloud models are used
- [ ] W6, W11 (OWUI compare + MCP)
- [ ] O26 (off-host backup destination)
- [ ] O29 (compose profiles for selective backends)

### v2+ (future consideration)

- [ ] R7 (`/v1/responses` API)
- [ ] R22 (strict structured outputs / guided decoding)
- [ ] R27 (PDF input blocks)
- [ ] R43 (USD cost estimation in response)
- [ ] R48 (OpenTelemetry traces)
- [ ] R53 (extended thinking blocks)
- [ ] O19, O20 (Loki + alerting)
- [ ] Fine-tuning milestone (already deferred per PROJECT.md)

---

## Feature Prioritization Matrix

| Feature | User value | Implementation cost | Priority |
|---------|------------|---------------------|----------|
| R1 chat completions | HIGH | M | P1 |
| R8 messages | HIGH | M | P1 |
| R13 Anthropic streaming | HIGH | L | P1 |
| R17-R21 tool calling | HIGH | M | P1 |
| R23-R26 vision | HIGH | M | P1 |
| R35 Ollama Cloud fallback | HIGH | M | P1 |
| R45 Postgres log | HIGH | M | P1 |
| O14-O18 metrics stack | MED | M | P1 |
| O21 backups | HIGH | S | P1 |
| O8 TLS | HIGH | M | P1 |
| R32 slot awareness | MED | M | P2 |
| R36 failover chains | MED | M | P2 |
| R37 circuit breaker | MED | S | P2 |
| W11 OWUI MCP | MED | S | P2 |
| O26 off-host backup | HIGH | S | P2 |
| R7 Responses API | LOW (today) | M | P3 |
| R22 strict outputs | MED | M | P3 |
| R48 OTel | LOW | M | P3 |

---

## Competitor feature analysis (informs what to copy vs skip)

| Feature | LiteLLM | OpenRouter | Bifrost | Our approach |
|---------|---------|------------|---------|--------------|
| OpenAI surface | Full | Full | Full | Subset (chat + embeddings + models). Skip legacy completions, audio, images. |
| Anthropic surface | Translation, no native /v1/messages serving | No native | Limited | **First-class native /v1/messages — translation in BOTH directions.** Differentiator. |
| Tool calling translation | Full | Pass-through to provider | Full | Full (table stakes). |
| Streaming | Buggy in mixed-protocol mode (cf. issue #26529) | Native | Native | Treat streaming as a top-tier requirement; budget time for end-to-end test. |
| Multi-key / spend caps | Yes | Yes | Yes | **Skip** — single user. |
| Prompt caching auto-inject | Optional (Autocache) | Passthrough | — | Passthrough only; no auto-inject. |
| Model registry config | YAML | UI + DB | YAML | YAML — declarative, fits Compose era. |
| Cloud fallback for big models | Generic provider chain | Native priority list | Generic | **Specialised: Ollama Cloud as first-class fallback** for VRAM-overflow models. |
| Self-hosted single-host install | Easy | N/A (SaaS) | Easy | Easy (compose up). |
| Postgres-backed structured logs | Yes | N/A | Optional | Yes — Postgres already in stack. |
| GPU/VRAM awareness | No | N/A | No | Yes (R32). Differentiator on a 16 GB box. |

---

## Sources

- LiteLLM: [BerriAI/litellm GitHub](https://github.com/BerriAI/litellm), [LiteLLM Anthropic provider](https://docs.litellm.ai/docs/providers/anthropic), [LiteLLM count_tokens](https://docs.litellm.ai/docs/anthropic_count_tokens), [LiteLLM logging](https://docs.litellm.ai/docs/proxy/logging), [LiteLLM streaming bug #26529](https://github.com/BerriAI/litellm/issues/26529)
- OpenRouter: [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection), [Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks), [Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- Anthropic specs: [Messages API](https://platform.claude.com/docs/en/build-with-claude/working-with-messages), [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Vision](https://platform.claude.com/docs/en/build-with-claude/vision), [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting), [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [count_tokens API ref](https://docs.anthropic.com/en/api/messages-count-tokens)
- OpenAI specs: [List models](https://platform.openai.com/docs/api-reference/models/list), [Streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses), [Images & vision](https://developers.openai.com/api/docs/guides/images-vision), [Deprecations](https://developers.openai.com/api/docs/deprecations), [Migrate to Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- Streaming format comparison: [Percolation Labs SSE comparison](https://medium.com/percolation-labs/comparing-the-streaming-response-structure-for-different-llm-apis-2b8645028b41), [Simon Willison on streaming](https://til.simonwillison.net/llms/streaming-llm-apis)
- Translation analysis: [Migrating OpenAI ↔ Anthropic](https://awesomeagents.ai/migrations/openai-to-anthropic-api/), [Anthropic /v1/messages parameters](https://scalablehuman.com/2025/09/03/anthropics-v1-messages-endpoint-parameters-openai-comparison-more/), [Portkey Responses vs Chat vs Messages](https://portkey.ai/blog/open-ai-responses-api-vs-chat-completions-vs-anthropic-anthropic-messages-api/)
- Open WebUI: [Features overview](https://docs.openwebui.com/features/), [OpenAI-compatible providers](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/), [RAG](https://docs.openwebui.com/features/chat-conversations/rag/), [Agentic Search](https://docs.openwebui.com/features/chat-conversations/web-search/agentic-search/), [Open WebUI 2026 setup guide](https://weavai.app/blog/en/2026/04/24/open-webui-2026-free-local-ai-interface-setup-guide/)
- vLLM observability: [vLLM Production Metrics](https://docs.vllm.ai/en/stable/usage/metrics/), [vLLM GGUF](https://docs.vllm.ai/en/latest/features/quantization/gguf/), [vLLM tuning](https://developers.redhat.com/articles/2026/03/03/practical-strategies-vllm-performance-tuning), [Monitor LLM Inference 2026](https://www.glukhov.org/observability/monitoring-llm-inference-prometheus-grafana/)
- Ollama: [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [Ollama Cloud authentication](https://docs.ollama.com/api/authentication), [Pi + Ollama Cloud blog](https://fabiorehm.com/blog/2026/04/12/pi-ollama-cloud-api/)
- Local runtimes comparison: [Ollama vs vLLM vs LM Studio 2026](https://www.glukhov.org/llm-hosting/comparisons/hosting-llms-ollama-localai-jan-lmstudio-vllm-comparison/), [Ollama vs llama.cpp vs vLLM 2026](https://www.aimadetools.com/blog/ollama-vs-llama-cpp-vs-vllm/), [Local AI stack guide](https://www.mindstudio.ai/blog/build-local-ai-stack-ollama-to-vllm-step-by-step)
- Gateway landscape: [Best OpenRouter alternatives 2026](https://www.edenai.co/post/best-alternatives-to-openrouter), [Best LLM Routers 2026 (Pinggy)](https://pinggy.io/blog/best_ai_llm_routers_openrouter_alternatives/), [Top 5 LLM Gateways](https://www.helicone.ai/blog/top-llm-gateways-comparison-2025), [LLM Gateway vs OpenRouter](https://llmgateway.io/blog/llm-gateway-vs-openrouter)
- Concurrency / VRAM: [Multi-model serving gateway pattern + VRAM](https://www.systemoverflow.com/learn/ml-model-serving/multi-model-serving/llm-multi-model-serving-gateway-pattern-and-vram-constraints), [LLM inference at scale](https://theneuralmaze.substack.com/p/a-practical-guide-to-llm-inference)
- Backups: [Automated PostgreSQL backups in Docker](https://serversinc.io/blog/automated-postgresql-backups-in-docker-complete-guide-with-pg-dump/), [kartoza/docker-pg-backup](https://github.com/kartoza/docker-pg-backup)
- Traefik: [compose-dev-tls (Bret Fisher)](https://github.com/BretFisher/compose-dev-tls), [Setting up Traefik 2 local SSL](https://kevinquillen.com/setting-traefik-2-local-ssl-certificate)
- Prompt cache passthrough: [Autocache proxy](https://github.com/montevive/autocache)
- Observability: [Portkey LLM observability guide](https://portkey.ai/blog/the-complete-guide-to-llm-observability/), [Braintrust gateway observability comparison](https://www.braintrust.dev/articles/best-llm-gateways-observability-2026)

---

*Feature research for: self-hosted unified LLM gateway (single user, agents-first, GPU-bound)*
*Researched: 2026-05-09*
