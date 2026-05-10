<!-- GSD:project-start source:PROJECT.md -->
## Project

**local-llms**

Stack autohospedado en Docker que sirve LLMs locales sobre GPU NVIDIA y los unifica, junto con modelos remotos de Ollama Cloud, detrás de un único endpoint HTTP compatible con OpenAI y Anthropic. Pensado para alimentar agentes y automatizaciones (clientes API) del propio usuario y, secundariamente, para experimentación/research con modelos. Single host, single user.

**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

### Constraints

- **Hardware**: VRAM tope 16 GB — cualquier modelo que no quepa cuantizado va por Ollama Cloud
- **Tech stack — runtime de inferencia**: NVIDIA Container Toolkit obligatorio; driver NVIDIA propietario en host; Compose v2
- **Tech stack — router**: Node + Fastify + TypeScript (decisión cerrada)
- **API contract**: compatibilidad simultánea con OpenAI y Anthropic (no es opcional)
- **Auth**: bearer token único en `.env`; rotación manual aceptable
- **Streaming**: SSE obligatorio desde v1 — agentes lo necesitan
- **Despliegue**: un único host con Docker Compose; sin orquestadores externos (k8s, Nomad)
- **Operacional**: usuario único; mantenimiento manual aceptable
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core Technologies — Inference Layer
| Technology | Version / Image | Purpose | Why Recommended |
|------------|-----------------|---------|-----------------|
| Ollama | `ollama/ollama:0.5.7` (or pin newer; avoid `:latest` in prod) | Primary catalog runtime — easy model pulls, auto KV-cache mgmt, OpenAI-compatible API at `/v1/...` and native `/api/...` | Lowest friction backend. Has built-in OpenAI compat (`/v1/chat/completions`, `/v1/embeddings`, `/v1/models`). Single binary, single mount. **HIGH confidence.** |
| llama.cpp server | `ghcr.io/ggml-org/llama.cpp:server-cuda` (CUDA 12 build) — pin to a build tag like `server-cuda-bXXXX` | Fine-grained GGUF inference with full control over `--n-gpu-layers`, `--ctx-size`, batch params | The official `ggml-org/llama.cpp` server image. CUDA 12 variant matches NVIDIA Container Toolkit defaults. Use when you need quant variants Ollama doesn't expose or precise VRAM control. **HIGH confidence** (verified on ggml-org GHCR). Note: GPU images are built but not CI-tested by the project itself. |
| vLLM | `vllm/vllm-openai:v0.20.2-cu129-ubuntu2404` (pinned; `latest` defaults to CUDA 13 from v0.20.0+) | Throughput-oriented HF-model serving with PagedAttention, continuous batching, AWQ/GPTQ kernels | Best per-token throughput on a single GPU when model fits. Native OpenAI-compatible server. CUDA 12.9 image is the right pick for stable NVIDIA Container Toolkit installs in 2026. **HIGH confidence** (Docker Hub verified 2026-05). |
### Core Technologies — Router (Node + Fastify + TypeScript)
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | `node:22-bookworm-slim` (LTS through April 2027) | Runtime for the router | Node 22 is current Active LTS; `bookworm-slim` is small enough and has glibc compat the SDKs assume. Avoid `node:22-alpine` for SDKs that pull native deps. **HIGH confidence.** |
| Fastify | `fastify@^5.8.5` | HTTP server framework | Fastify v5 is the current major (5.8.5 published 2026-04-14). 5x faster than Express for streaming, schema-based validation built in, first-class async support. Dual-API surface (OpenAI + Anthropic) maps cleanly to per-route schemas. **HIGH confidence.** |
| TypeScript | `typescript@^5.6` | Type safety | Required by `@anthropic-ai/sdk` (TS ≥ 4.9) and `openai` (≥ 5.x). v5.6 has `verbatimModuleSyntax` and `--noUncheckedSideEffectImports` which catch the common SDK-import footguns. **HIGH confidence.** |
| pino | `pino@^9.x` (built into Fastify) | Structured JSON logging | Default Fastify logger; ~5–8× faster than Winston. Fastify v5 uses pino 9 transport-style. Don't pass a custom logger instance — pass options (`logger: { level: 'info' }`) per the v5 type changes. **HIGH confidence.** |
| OpenAI Node SDK | `openai@^6.30.0` | Outbound client when proxying to OpenAI-compatible backends (Ollama, vLLM, llama.cpp-server) | v6 is the current major (released 2026-03-16). Set `baseURL` per-backend. Use `client.chat.completions.create({ stream: true })` and re-emit as SSE. **HIGH confidence.** |
| Anthropic SDK | `@anthropic-ai/sdk@^0.95.1` | Type definitions for the Anthropic Messages API surface (Anthropic-style requests in, Anthropic-style responses out) | v0.95.1 published 2026-05-07. Used here mainly for **types and stream-event shapes** so the router can produce wire-correct `/v1/messages` SSE — you are *not* calling Anthropic remotely; you translate to/from the local backends. **HIGH confidence.** |
| zod | `zod@^4.x` | Request validation, model registry parsing | v4 supports the `from 'zod/v4'` import path used by current Fastify type providers. **HIGH confidence.** |
### Supporting Libraries — Router
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `fastify-sse-v2` | `^4.2.1` | SSE plugin with `reply.sse(asyncIterable)` | **Primary choice** for streaming `chat.completions` and `messages`. The async-iterable API is exactly what you want when re-emitting upstream SDK streams. 16× more weekly downloads than `@fastify/sse` and battle-tested. |
| `@fastify/sse` | `^0.4.0` | Official Fastify SSE plugin | Alternative if you prefer first-party. Less mature (4 dependents vs 16 for v2 plugin). Skip unless you hit a v2-plugin bug. |
| `fastify-type-provider-zod` (or `@bram-dc/fastify-type-provider-zod` for Fastify 5) | `@bram-dc/fastify-type-provider-zod@^7.0.1` | Wires Zod schemas into Fastify validation + serialization | Use the `@bram-dc/...` fork — it is the actively-maintained Fastify-5 build. The original `turkerdev/fastify-type-provider-zod` targets Fastify 4. |
| `@fastify/cors` | `^11.2.0` | CORS for Open WebUI / browser clients | Only needed if a browser hits the router directly. Open WebUI is server-to-server, so CORS may be skippable. |
| `@fastify/helmet` | `^13.x` | Security headers | Behind Traefik you can omit most; keep `noSniff` and `frameguard`. |
| `@fastify/rate-limit` | `^10.x` | Token-bucket per-IP rate limiting (Redis-backed) | Single-user, but agents can hammer concurrently. Backstops misbehaving loops. |
| `@fastify/sensible` | `^6.x` | HTTP error helpers | Cheap quality-of-life. |
| `ioredis` | `^5.x` | Redis client (Valkey-compatible) | Streams, pipelines, cluster-ready. Pairs with `@fastify/rate-limit`. |
| `pg` + `drizzle-orm` | `pg@^8.13`, `drizzle-orm@^0.36` | Postgres access (usage logs, request audit) | Drizzle's TS-first schema declaration is a clean fit; lighter than Prisma for a service-layer use case; no codegen step. |
| `js-yaml` | `^4.1` | Parse `models.yaml` (declarative model→backend registry) | The router's source of truth for "which model is served by which backend at which URL". |
| `undici` (peer dep, often pinned) | `^7.x` | HTTP/1.1+2 client used by Fastify and the SDKs | Mostly transitive — only pin directly if you need keep-alive tuning for upstream backends. |
### Core Technologies — Platform Services
| Technology | Image / Version | Purpose | Why Recommended |
|------------|-----------------|---------|-----------------|
| Open WebUI | `ghcr.io/open-webui/open-webui:v0.9.0` (pin) — variants: `:cuda`, `:ollama`, `:main`, `:dev` | Human chat UI, model comparison, conversation history | Industry-standard Ollama UI, supports **multiple OpenAI-compatible connections simultaneously** with per-connection toggle and prefix to disambiguate same-named models. Wire it to the **router**, not directly to backends, so you exercise the OpenAI surface end-to-end. **HIGH confidence.** Avoid `:main` in prod (rolling). |
| Redis / Valkey | `valkey/valkey:8-alpine` (recommended) **or** `redis:7-alpine` | Rate-limit counters, response cache (optional), idempotency keys | **Valkey is the default in 2026** — BSD-licensed Redis fork, AWS/GCP migrated to it, drop-in compatible with Redis 7 protocol. Pick Valkey unless you need Redis 8's bundled JSON/Vector modules (you don't here). **MEDIUM-HIGH confidence.** |
| PostgreSQL | `postgres:17-alpine` (avoid jumping to 18 yet) | Open WebUI state (users, chats, prompts, files, RAG vectors via pgvector if used) + router usage logs (request_id, model, backend, tokens_in/out, latency, status) | Postgres 17 is the well-trodden current LTS-ish; 18 is shipping but extension ecosystem (pgvector, etc.) is more reliable on 17. Open WebUI uses Postgres natively when `DATABASE_URL` is set. **HIGH confidence.** |
| pgvector (extension) | `pgvector/pgvector:pg17` if Open WebUI RAG is enabled | Vector search for Open WebUI knowledge / docs | Use the `pgvector/pgvector:pg17` image instead of plain `postgres:17` if RAG is on. Otherwise skip. |
| Traefik | `traefik:v3.7` (latest stable, published 2026-05-05; tags: `v3.7`, `v3`, `latest`) | Reverse proxy, TLS termination, Docker service discovery via labels | v3 is the current major; v2 is EOL territory. Native Docker provider (no `nginx-proxy`/companion sidecar dance), Let's Encrypt built in, dynamic config from container labels — perfect for a Compose-only single host. **HIGH confidence.** |
| NVIDIA Container Toolkit | `nvidia-container-toolkit` (apt) — host-installed, **not** a container | GPU passthrough into containers | Required. Install on the WSL2 *Linux* side, not Windows. Configure with `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`. **HIGH confidence.** |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| `tsx` | Fast TS runner for dev (`tsx watch src/index.ts`) | Replaces `ts-node` for v5+; no decorator metadata overhead. |
| `tsup` | Bundle TS to ESM + CJS for production image | Single-step `tsup src/index.ts --format esm --target node22` — small `dist/`, fast cold start. |
| `vitest` | Unit + integration tests | Plays well with native fetch / undici mocks; pair with `msw` for upstream-backend stubs. |
| `pino-pretty` | Pretty logs in dev | **Dev only.** Pipe `node dist/index.js | pino-pretty` — never bundled into the prod image. |
| `eslint` + `@typescript-eslint` v8+ | Lint | Flat-config (`eslint.config.js`) — required for ESLint 9+. |
| `@biomejs/biome` (optional alternative) | Lint+format in one binary | Worth considering instead of ESLint+Prettier — much faster, fewer configs. |
| `husky` + `lint-staged` | Pre-commit hooks | Optional but cheap insurance. |
## Installation
# Router project
# Core
# Dev
## NVIDIA Container Toolkit — exact 2026 setup
### Host install (Ubuntu 22.04/24.04 or WSL2 Ubuntu)
# 1) Add NVIDIA's apt repo (signed)
# 2) Register nvidia runtime with Docker
# 3) Verify
### WSL2 specifics
- **Do NOT install a Linux NVIDIA driver inside WSL.** The Windows host driver projects `libcuda.so` into WSL automatically.
- Install the **Windows-side** NVIDIA driver with WSL support, then run the toolkit install above inside the WSL distro.
- If using Docker Desktop ≥ 4.34, you can enable Settings → Resources → Advanced → "Enable GPU passthrough" and skip the in-WSL toolkit install — but for a Compose-driven server I still recommend native Docker in WSL with the toolkit so the deploy is portable to bare Linux.
### Compose v2 GPU reservation — modern syntax (use this)
- `capabilities: [gpu]` is **required**; `compute,utility` are added implicitly. Add `[gpu, video]` if a runtime needs NVENC.
- `count: all` reserves every visible GPU. With one GPU, `count: 1` is equivalent.
- `device_ids` and `count` are mutually exclusive.
### Compose v2 — legacy syntax (avoid for new projects, but works)
## Compose snippet — full stack skeleton
# docker-compose.yml — local-llms platform
## Multi-stage Dockerfile pattern — router
# router/Dockerfile
# syntax=docker/dockerfile:1.7
# --- 1) deps (cached separately) ---
# --- 2) build ---
# --- 3) prod deps only ---
# --- 4) runtime ---
## Streaming gotchas — Fastify + SSE
## Ollama Cloud — API surface (2026)
| Property | Value |
|----------|-------|
| Endpoint base | `https://ollama.com` |
| Native chat | `POST https://ollama.com/api/chat` (Ollama-shaped JSON) |
| Generate | `POST https://ollama.com/api/generate` |
| **OpenAI-compatible** | `POST https://ollama.com/v1/chat/completions`, `/v1/embeddings`, `/v1/models` (same compat layer as local Ollama) |
| Auth | `Authorization: Bearer $OLLAMA_API_KEY` (single header — **different from local Ollama which has no auth**) |
| Available cloud models | `gpt-oss:120b-cloud`, `gpt-oss:20b-cloud`, plus catalog at `ollama.com/search?c=cloud` (DeepSeek-R1, Qwen3, Kimi, GLM, etc. — list moves; resolve at runtime via `/api/tags`) |
| SDK use | The `openai` Node SDK works directly: `new OpenAI({ baseURL: 'https://ollama.com/v1', apiKey: process.env.OLLAMA_API_KEY })` |
| Confidence | **HIGH** for endpoint and auth (verified via `docs.ollama.com/api/authentication` and `docs.ollama.com/cloud`). MEDIUM for the exact set of cloud-only model tags — that list updates frequently. |
## Model formats per runtime — what to actually download
### Ollama
- **Use the Ollama model registry**: `ollama pull qwen2.5:14b-instruct-q4_K_M`, `llama3.1:8b-instruct-q5_K_M`, `nomic-embed-text`, `bge-m3`.
- Stored under `/root/.ollama/models` inside the container — mount the `ollama_models` volume.
- Auto-quantizes to whatever tag you pull; no manual GGUF wrangling.
- For 16 GB VRAM: 13B–14B at `q4_K_M`, 7B–8B at `q5_K_M` or `q8_0`, plus an embedding model concurrently (Ollama unloads/loads as needed).
### llama.cpp-server
- **GGUF files** placed in the mounted `/models` volume. Source from HuggingFace (e.g. `bartowski/...-GGUF`, `unsloth/...-GGUF`, official org GGUFs).
- **Recommended quants for 16 GB**:
- One server instance = one model. Run multiple llama.cpp services in Compose if you need multiple GGUFs hot, **but they will fight for VRAM** — usually better to use Ollama (which swaps models) or `llama-swap` (proxy that auto-loads/unloads llama.cpp instances).
### vLLM
- **HuggingFace model IDs**, not local paths. vLLM downloads to `~/.cache/huggingface` (mount `hf_cache` volume).
- **Recommended for 16 GB**:
- **Quantization flag**: `--quantization awq_marlin` for AWQ models (fastest kernel in vLLM as of 2026); `gptq_marlin` for GPTQ. Avoid `bitsandbytes` and direct GGUF — poor performance/compat in vLLM.
- **VRAM tuning**: `--gpu-memory-utilization 0.85` and `--max-model-len 8192` are safe defaults for a 16 GB card; raise either at the cost of OOM risk during long requests.
- Don't try to run a 13B+ model in vLLM on 16 GB — pick AWQ 7B/8B or push the 13B+ to llama.cpp or Ollama Cloud.
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Fastify | Hono | If migrating to Bun/Cloudflare Workers later; Hono is edge-native. Fastify wins on Node-only with mature plugin ecosystem and zod integration. |
| Fastify | Express 5 | Never for a streaming-heavy router — Express's middleware model and lack of native async makes SSE error handling brittle. |
| OpenAI Node SDK v6 | Hand-rolled `fetch` proxy | If you only need raw passthrough with zero translation. The SDK is worth it for typed Stream events when you need to *transform* (e.g., re-emit OpenAI chunks as Anthropic events). |
| `@anthropic-ai/sdk` (types) | Hand-rolled type defs | Don't — Anthropic's wire format evolves (tool_use vs tool_result deltas, beta features). Pin the SDK and re-export its types. |
| llama.cpp-server | `llama-cpp-python` server | Python ecosystem if you want LangChain integration in the same image. Slower than the C++ server, larger image. |
| vLLM | TGI (HuggingFace) | TGI has slipped behind vLLM on throughput and PagedAttention quality through 2025–2026; license is more permissive but ecosystem is smaller now. Pick TGI only if you need its specific RoPE/Bedrock features. |
| vLLM | TensorRT-LLM | Higher peak throughput on Hopper/Ampere, but much heavier ops (engine compilation per model, NVIDIA-only tooling). Skip for a single-host hobby/personal stack. |
| vLLM | SGLang | Strong contender in 2026 — better structured output + radix attention. Worth re-evaluating on a v2 milestone, but vLLM has the broader model coverage today. |
| Valkey | Redis 8 | Only if you need bundled vector sets / RedisJSON. For rate-limit + cache, Valkey wins on license clarity. |
| Postgres 17 | Postgres 18 | Wait until pgvector / Open WebUI explicitly support 18 in their pinned manifests. |
| Traefik v3 | nginx + acme.sh / Caddy | Caddy is fine for trivial setups. Traefik wins for **Docker label-based dynamic config** — you don't restart it when adding services. nginx requires templated config + reload glue and is a step backwards here. |
| Traefik | Nginx Proxy Manager | NPM is GUI-driven and great for non-developers; for an IaC Compose stack, Traefik labels are more reproducible. |
| `fastify-sse-v2` | Native `reply.raw.write()` | Possible but you reimplement headers, retry, heartbeat, and event ID logic. Not worth it. |
| Drizzle ORM | Prisma | Prisma's codegen step + schema language adds friction for a small service. Drizzle is closer to writing SQL with TS types. Pick Prisma if you also want Studio. |
| Drizzle ORM | `pg` directly | Fine if your queries are five hand-written ones. Not worth the ORM if you don't need migrations. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `node:22-alpine` for the router | musl libc breaks `bcrypt`/`pg-native`/some optional native deps; opaque debugging | `node:22-bookworm-slim` |
| `:latest` tags in production Compose | Silent format/API breakage on `docker compose pull` | Pinned semver or build tags (`v0.20.2-cu129-ubuntu2404`, `v3.7`, `0.5.7`) |
| Express + `express-sse` | Express middleware ordering + lack of native async makes upstream-stream cancellation messy | Fastify + `fastify-sse-v2` |
| `ts-node` | Slower cold start than `tsx`, decorator metadata pitfalls | `tsx` for dev, `tsup` for build |
| `--gpus all` in Compose `services.X.gpus:` | Inconsistent across Compose versions; deprecated path | `deploy.resources.reservations.devices` (modern) or `runtime: nvidia` (legacy but stable) |
| Installing NVIDIA Linux driver inside WSL2 | Will conflict with Windows driver projection | Install Windows NVIDIA driver only, then toolkit in WSL |
| Compress middleware on SSE | gzip buffering will hold chunks until flush, breaking streaming UX | Disable compression for `/v1/chat/completions` and `/v1/messages` routes |
| Running multiple vLLM instances on one 16 GB GPU | They each pre-allocate KV cache from `--gpu-memory-utilization` | Use Ollama (auto-swap) or one vLLM with multiple LoRAs (`--enable-lora`) |
| `redis:latest` (also: Redis 8 if avoiding AGPLv3) | Tri-license including AGPLv3; surprises if this code ever ships externally | `valkey/valkey:8-alpine` (BSD-3) |
| `traefik:v2.x` | v2 is in deprecation; `tlsChallenge` config syntax differs; smaller ecosystem now | `traefik:v3.7` |
| Direct browser → router CORS without auth | Bearer token in `Authorization` header from browser code = leaked token | Browser hits Open WebUI, Open WebUI hits router server-to-server |
## Stack Patterns by Variant
- Drop Open WebUI, Postgres, Valkey, Traefik for v0.
- Keep Ollama + llama.cpp + vLLM + router.
- Expose router on `localhost:3000` directly; auth via bearer token.
- Add Postgres when you need persistent usage logs; add Valkey when rate-limit becomes useful; add Traefik+Open WebUI when you want HTTPS + UI.
- This matches the PROJECT.md "platform vs lean MVP" tradeoff already flagged.
- Run only **one** GPU-bound runtime "hot" at a time — use `llama-swap` (`mostlygeek/llama-swap`) to multiplex llama.cpp instances on demand.
- Or rely on Ollama's built-in model swapping and use vLLM only for the one HF-AWQ model you serve continuously.
- Separate Compose project (`compose.train.yml`) with `unsloth` or `axolotl` images.
- Share `hf_cache` volume read-only with vLLM/llama.cpp; never write GGUFs into the inference path while training.
## Version Compatibility
| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `fastify@5.x` | `fastify-sse-v2@^4`, `@bram-dc/fastify-type-provider-zod@^7` | Fastify v5 broke type-provider internals; the original `turkerdev/fastify-type-provider-zod` targets v4 — use the v5 fork. |
| `openai@^6` | Node ≥ 18 | Native `fetch`/`Request` types; Node 22 LTS is the safe target. |
| `@anthropic-ai/sdk@^0.95` | TypeScript ≥ 4.9, Node ≥ 20 LTS | Per official SDK README. |
| `vllm/vllm-openai:v0.20.2-cu129` | Host driver supporting CUDA 12.9 (NVIDIA driver ≥ 555.x recommended) | If host driver is older (5xx series < 555), pick a `cu124` or `cu126` tag instead. |
| `ghcr.io/ggml-org/llama.cpp:server-cuda` | Host driver compatible with CUDA 12 (≥ 530.x typically) | The `:server-cuda13` variant exists for newer drivers. |
| `ollama/ollama` | NVIDIA Container Toolkit + driver supporting CUDA 12 | No model registry compat issues — Ollama auto-converts on pull. |
| `postgres:17-alpine` + `pgvector` | `pgvector/pgvector:pg17` is the integrated image | Plain `postgres:17` does not have pgvector — switch image, don't try to install at runtime. |
| `traefik:v3.7` + Docker provider | Docker Engine ≥ 24 | Dynamic discovery works on Docker socket mount; no plugin needed. |
## Sources
- `/fastify/fastify` (Context7) — v5 API, type providers, SSE headers — **HIGH**
- `/openai/openai-node` (Context7), versions `v6_1_0` available — streaming chat completions, raw vs helper streams — **HIGH**
- `/anthropics/anthropic-sdk-typescript` (Context7) — `messages.stream()`, MessageStream events, tool use streaming — **HIGH**
- `/vllm-project/vllm` (Context7) — `vllm/vllm-openai` Docker image, `--runtime nvidia --gpus all` examples — **HIGH**
- `/ollama/ollama` (Context7) — Docker GPU setup, NVIDIA toolkit configuration commands — **HIGH**
- `/ggml-org/llama.cpp` (Context7) — `ghcr.io/ggml-org/llama.cpp:server-cuda` image, CUDA 12/13 variants — **HIGH**
- `/traefik/traefik` (Context7) — v3.7 Docker Compose example with entrypoints, ACME, dashboard — **HIGH**
- `/mpetrunic/fastify-sse-v2` (Context7) — async-iterable SSE pattern — **HIGH**
- `/websites/ollama` (Context7) — Cloud API auth (`Authorization: Bearer $OLLAMA_API_KEY`), `https://ollama.com/api/chat`, cloud model variants `gpt-oss:120b-cloud` — **HIGH**
- [Docker Compose GPU support docs](https://docs.docker.com/compose/how-tos/gpu-support/) — modern reservation syntax — **HIGH**
- [NVIDIA Container Toolkit install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) — apt repo + `nvidia-ctk runtime configure` — **HIGH**
- [CUDA on WSL User Guide](https://docs.nvidia.com/cuda/wsl-user-guide/index.html) — "do not install Linux NVIDIA driver in WSL" — **HIGH**
- [Docker Hub vllm/vllm-openai tags](https://hub.docker.com/r/vllm/vllm-openai/tags) — current `v0.20.2-cu129-ubuntu2404` — **HIGH** (verified 2026-05-09)
- [npm fastify](https://www.npmjs.com/package/fastify) — 5.8.5 published 2026-04-14 — **HIGH**
- [npm openai](https://www.npmjs.com/package/openai) — v6.30.0 published 2026-03-16 — **HIGH**
- [npm @anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) — 0.95.1 published 2026-05-07 — **HIGH**
- [Traefik releases](https://github.com/traefik/traefik/releases) — v3.7.0 published 2026-05-05 — **HIGH**
- [Open WebUI Connect a Provider docs](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/) — multi-connection config, model prefix — **HIGH**
- [Valkey vs Redis 2026 comparison](https://dev.to/synsun/redis-vs-valkey-in-2026-what-the-license-fork-actually-changed-1kni) — license / governance / 2026 momentum — **MEDIUM** (community blog, but reflects broader signal: AWS/GCP migration to Valkey)
- [Anthropic streaming docs](https://platform.claude.com/docs/en/build-with-claude/streaming) — Anthropic SSE event names — **HIGH**
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) — `/v1/chat/completions`, `/v1/embeddings`, `/v1/models` — **HIGH**
- [llama.cpp quantization README](https://github.com/ggml-org/llama.cpp/blob/master/tools/quantize/README.md) — Q4_K_M / Q5_K_M sizes and quality tradeoffs — **HIGH**
- [vLLM quantization docs](https://docs.vllm.ai/en/latest/features/quantization/) — AWQ + Marlin kernel recommendations — **HIGH**
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
