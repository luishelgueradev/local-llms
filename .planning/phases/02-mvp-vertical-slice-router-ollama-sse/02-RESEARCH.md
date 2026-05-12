# Phase 2: MVP Vertical Slice — Router + Ollama + SSE — Research

**Researched:** 2026-05-12
**Domain:** Fastify v5 + TypeScript router exposing OpenAI-compatible `POST /v1/chat/completions` (stream + non-stream) over Ollama via the openai SDK v6, with bearer auth, SSE streaming, abort propagation, pino redaction, and `models.yaml` hot-reload.
**Confidence:** HIGH overall. Two key facts verified empirically against the live Phase 1 Ollama 0.5.7 instance: (a) `stream_options.include_usage: true` IS honored by Ollama 0.5.7's OpenAI-compat shim — final chunk has `choices: []` + `usage: {prompt_tokens, completion_tokens, total_tokens}` followed by `data: [DONE]`; (b) non-stream responses populate `usage.*` natively. Both verified against the running container `local-llms-ollama` on this host. Belt-and-suspenders fallback (read native `prompt_eval_count`/`eval_count` off `/api/chat`'s final `done:true` event) is documented but not required.

## Summary

The phase is a vertical slice — bearer-auth, healthz, non-stream chat, stream chat, registry hot-reload — built on a stack that is fully pinned and verified. **Every non-trivial primitive (SSE plumbing, openai SDK iteration, AbortController propagation, pino redaction, fastify-type-provider-zod wiring) has a known-correct shape; the planner's job is to compose them, not to discover them.** [VERIFIED: live probe to ollama:11434 + Context7 lookups against /openai/openai-node, /fastify/fastify, /pinojs/pino, github.com/bram-dc/fastify-type-provider-zod]

The two architectural seams that pay off in later phases are: (1) the `BackendAdapter` interface (D-B2 — Phase 3 adds llama.cpp without router code change), and (2) the per-route OpenAI error-envelope format (D-C1 — Phase 4 adds Anthropic-shape envelopes side-by-side without retrofit). Phase 2 ships exactly one impl of each (`OllamaOpenAIAdapter`, OpenAI envelope) but lays the seam.

The single load-bearing concern is the abort chain (D-C4, SC3): `req.raw.on('close')` → `AbortController.abort()` → `chat.completions.create({ signal })` → undici closes upstream TCP → Ollama stops generating. Forgetting any link silently fails SC3 (GPU keeps generating for a dead client). The heartbeat MUST be cleared in the same close handler, or the response stays open after the client hangs up.

**Primary recommendation:** Build the router as four thin vertical slices in this order — (1) bootstrap + healthz + auth + Compose wiring; (2) registry load + zod schema + `BackendAdapter` interface + non-stream chat; (3) stream chat with full abort chain + heartbeat + pino redact; (4) `fs.watch` hot-reload + `bin/smoke-test-router.sh`. Each slice ends with a runnable curl assertion. No "build infra first, then API" — that defeats the MVP-vertical-slice mode.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Project layout & build pipeline**
- **D-A1:** Router code lives in a top-level **`router/`** subdirectory with its own `package.json`, `tsconfig.json`, `src/`, and `Dockerfile`. Treats the repo as a natural monorepo so later milestones (fine-tuning, etc.) can drop sibling services in cleanly.
- **D-A2:** **Multi-stage Dockerfile** exactly per `CLAUDE.md` "Multi-stage Dockerfile pattern — router":
  - Stage 1 (`deps`): `npm ci` (cached layer).
  - Stage 2 (`build`): `tsup src/index.ts --format esm --target node22` → `dist/`.
  - Stage 3 (`prod-deps`): `npm ci --omit=dev` to a clean `node_modules/`.
  - Stage 4 (`runtime`): `node:22-bookworm-slim` + `dist/` + prod `node_modules/`. Entrypoint `node dist/index.js`.
  No `node:22-alpine` anywhere (standing anti-pattern in STATE.md).
- **D-A3:** Dev workflow uses `tsx watch src/index.ts` with `./router/src` bind-mounted into the container. Either via a `compose.override.yml` (not committed, gitignored) or a Compose `profiles: [dev]` block — planner picks which keeps the contract cleanest. Production image is always the multi-stage build.
- **D-A4:** Phase 2 publishes the router on **`127.0.0.1:3000:3000`** (localhost-only, off-LAN). Ollama's host port from Phase 1 (`127.0.0.1:11434:11434`) is removed in the same phase — the router becomes the only externally-reachable surface. Phase 6 (Traefik) removes the router's host port too.

**Upstream call pattern to Ollama**
- **D-B1:** Router talks to Ollama through the **`openai` Node SDK** (v6.x) pointed at Ollama's OpenAI-compat endpoint: `new OpenAI({ baseURL: 'http://ollama:11434/v1', apiKey: 'ollama' })`. `apiKey` is a non-empty placeholder. Same SDK pattern reused in Phase 7 (vLLM) and Phase 8 (Ollama Cloud). Phase 4 will introduce a parallel native `/api/chat` client for Ollama vision per PITFALLS Pitfall 8.
- **D-B2:** **`BackendAdapter` interface** defined from day one, even though Phase 2 only ships `OllamaOpenAIAdapter`. Phase 3 adds `LlamacppOpenAIAdapter`. Phase 8 adds `OllamaCloudAdapter`.
- **D-B3:** **Usage tokens** are passed through from Ollama, not synthesized router-side. Set `stream_options.include_usage: true` on every upstream OpenAI-compat call; re-emit `prompt_tokens`/`completion_tokens`/`total_tokens` in the final SSE chunk (and in the non-stream response body). Belt-and-suspenders: also be capable of reading Ollama's native `prompt_eval_count`/`eval_count` off the final `done:true` event of `/api/chat` (deferred to Phase 4 unless `include_usage` regresses).
- **D-B4:** **`models.yaml` schema is forward-compatible.** Zod schema accepts the optional fields that Phase 3+ need (`capabilities`, `vram_budget_gb`, `concurrency`, `max_model_len`, `profile`) but Phase 2 reads only `name`, `backend`, `backend_url`, `backend_model`.

**Error envelope & failure-mode semantics**
- **D-C1:** **Per-route error envelopes.** Phase 2's `/v1/chat/completions` and `/healthz` emit the OpenAI shape: `{ "error": { "message": "...", "type": "...", "code": "...", "param": null } }`. Phase 4's `/v1/messages` will emit the Anthropic shape.
- **D-C2:** **Mid-stream error frame.** Once SSE has begun and HTTP is `200 OK`, an upstream/router failure emits:
  ```
  event: error
  data: {"error":{"message":"...","type":"...","code":"..."}}

  data: [DONE]

  ```
  Then `reply.raw.end()`.
- **D-C3:** **Locked HTTP status / log map** (verbatim — CONTEXT.md §decisions §D-C3 table; planner copies into 02-PLAN.md):

  | Failure case | HTTP status | pino level | Log notes |
  |---|---|---|---|
  | Bearer auth fail | `401` | `warn` | NEVER log the supplied token; pino redact must already mask `authorization` |
  | Zod request validation fail | `400` | `warn` | Full zod issue list in `meta` |
  | Unknown model in registry | `404` | `warn` | Model name + list of registered names |
  | Upstream connection refused | `502` | `error` | Backend name, URL |
  | Upstream HTTP 5xx | `502` | `error` | Include upstream status + body excerpt |
  | Upstream / request timeout | `504` | `error` | Backend name, timeout value |
  | Mid-stream upstream error (HTTP already 200) | n/a (SSE) | `error` | `req.id`, byte count emitted, time-to-error |
  | `models.yaml` hot-reload validation fail | n/a | `error` | Keep previous registry in memory — DO NOT crash, DO NOT swap in invalid registry |

- **D-C4:** **Abort propagation contract.** `const controller = new AbortController(); req.raw.on('close', () => controller.abort(new Error('client-disconnect')));` then pass `controller.signal` into `chat.completions.create({ ..., signal })`. **Heartbeat MUST be cleared in the same close handler** (and on normal stream completion).

### Claude's Discretion
- Exact pino logger config (timestamp shape, base fields, transport in dev) — keep readable, follow Fastify v5 conventions (pass options, not an instance).
- Whether to use `@bram-dc/fastify-type-provider-zod` or hand-rolled zod parsers — CLAUDE.md endorses the fork; planner picks. (Recommendation: **use the fork** — see §"Fastify v5 + SSE wiring" below. It costs ~50 LOC of glue and pays off massively in Phase 4 when Anthropic schemas land.)
- Fastify route file layout (`src/routes/v1/chat-completions.ts` vs `src/api/openai/chat.ts`) — pick one and apply consistently. (Recommendation: `src/routes/v1/chat-completions.ts` mirrors the URL path 1:1 — easier to grep "where does /v1/chat/completions live".)
- `fs.watch` debounce window (suggest 200–500 ms) and atomic-swap implementation detail. (Recommendation: 250 ms — see CONTEXT.md §specifics; matches editor save-twice quirk window.)
- Upstream request timeout default — suggest 60s for streaming connect, no read timeout for the streaming body itself. Planner picks specifics. (Recommendation: pass `timeout: 60_000` to the `OpenAI` constructor — applies to header/connect; streaming bodies pass through unchanged because undici uses chunked encoding without bodyTimeout.)
- ESLint vs Biome — CLAUDE.md lists both; pick one (recommend Biome for speed) and document.
- `vitest` + `msw` config files, test directory layout. (Recommendation: `router/tests/unit/`, `router/tests/integration/`, `router/vitest.config.ts` at root, `msw` server in `router/tests/msw/`.)
- `bin/smoke-test-router.sh` log format details (color, sections) — match `bin/smoke-test-gpu.sh` conventions.
- README updates to document the new "verify the router works" step.
- Whether to ship a `Makefile` / `justfile` / `bin/up.sh` wrapper for ergonomics — not required.

### Deferred Ideas (OUT OF SCOPE for Phase 2)
- **Native Ollama `/api/chat` client** — needed for Ollama vision per PITFALLS Pitfall 8. Lands in **Phase 4** alongside the Anthropic surface + vision support.
- **Anthropic-shape error envelope** — `{ "type": "error", "error": { "type", "message" } }`. Lands in **Phase 4**.
- **`GET /v1/models`** capability listing + `/readyz` aggregator + per-backend liveness probes — **Phase 3**.
- **Per-backend concurrency caps + 429 / queue behavior** — **Phase 3** (ROUTE-07).
- **`request_log` Postgres writes + `/metrics`** — **Phase 5**.
- **`X-Agent-Id` request header surfaced into logs** — **Phase 5** (ROUTE-09).
- **`X-Model-Backend` response header** — **Phase 8** (ROUTE-10).
- **Compose `profiles: [ollama | llamacpp | vllm]`** — **Phase 3**.
- **Removing the router's host port and putting it behind Traefik** — **Phase 6**.
- **dockerized integration tests via `testcontainers`** — considered, not adopted for Phase 2.
- **Hot-reload triggering an in-flight request retry / rejection policy** — Phase 2's hot-reload only affects new requests; in-flight requests keep the registry snapshot they were dispatched with.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| **ROUTE-01** | Fastify v5 + TypeScript router runs as its own Compose service on Node 22 LTS (`node:22-bookworm-slim`) | §Multi-stage Dockerfile (D-A2); §Compose integration; live host has `node v22.22.2`, `docker 29.4.2`, `compose v5.1.3` (verified) |
| **ROUTE-02** | `models.yaml` is the single source of truth for model → backend mapping; zod-validated at load; hot-reloaded via `fs.watch` | §Registry load + hot-reload; sample `models.yaml` schema with first concrete entry; debounce + atomic-swap pattern |
| **ROUTE-03** | Bearer-token authentication is enforced on all model endpoints with a constant-time string compare | §Bearer auth — code shape with `crypto.timingSafeEqual` + length-padding to defeat timing leaks |
| **ROUTE-04** | `/healthz` returns 200 without authentication; `/readyz` returns 200 only when configured backends are reachable | §Bearer auth (skip-list pattern); §Compose integration (healthcheck command). NOTE: `/readyz` aggregator is **deferred to Phase 3**; Phase 2 ships `/healthz` only (CONTEXT.md confirms) |
| **ROUTE-05** | pino logger redacts `authorization`, `cookie`, and `*.apiKey` fields from every log record | §Pino redact config — exact `redact:` paths array verified against /pinojs/pino docs |
| **ROUTE-08** | SSE infrastructure works end-to-end: 15s heartbeat, backpressure via `reply.raw.write()` return-value check + `'drain'` await, `req.raw.on('close')` aborts the upstream `AbortController` | §Fastify v5 + SSE wiring; §Streaming chat completions through openai SDK v6; §Abort propagation chain |
| **OAI-01** | `POST /v1/chat/completions` works for non-stream and stream against every local backend | §Streaming chat completions; non-stream pattern; both verified directly against Ollama 0.5.7 in this research session |
| **OAI-04** | SSE responses follow the OpenAI `delta`-based wire format | §Streaming chat completions — every chunk forwarded verbatim; trailing `data: [DONE]` synthesized by router (Ollama emits it but spec compliance recommends router synthesizes for non-Ollama backends in later phases) |
| **OAI-05** | Token usage is echoed in non-stream responses (`prompt_tokens`, `completion_tokens`, `total_tokens`) and in the final SSE chunk for streams | §Ollama OpenAI-compat behavior — empirically verified Ollama 0.5.7 emits the usage chunk when `stream_options.include_usage: true` is sent |
</phase_requirements>

## Architectural Responsibility Map

For Phase 2 the relevant tiers reduce to three: **Compose orchestration** (host networks, ports, volumes), **Router service** (the single new long-running process), and **Ollama backend** (already running from Phase 1).

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Bearer auth check | Router (preHandler hook) | — | Edge of the model surface; never delegated to Ollama (which has no auth on the local socket). |
| `/healthz` (unauthenticated) | Router | Compose (healthcheck command) | The auth-skip route; consumed by Compose `healthcheck:` and `depends_on: { router: { condition: service_healthy } }` for the smoke-test gate. |
| `models.yaml` parse + hot-reload | Router (registry module) | Compose (bind mount: `./router/models.yaml:/app/models.yaml:ro`) | Bind-mounting the host file is what makes `fs.watch` see edits without container restart. |
| Request validation (zod) | Router (route schema via type provider) | — | Caught before the upstream SDK is even imported. |
| Backend resolution (model → adapter) | Router (registry lookup) | — | Phase 2: trivial 1:1 map. The seam exists for Phase 3 multi-backend. |
| Upstream chat call | Router (OllamaOpenAIAdapter) | Ollama backend (`/v1/chat/completions`) | SDK is the client; Ollama is the server. Same pattern reused for vLLM (Phase 7) and Ollama Cloud (Phase 8). |
| SSE wire emission | Router (`fastify-sse-v2` + reply.raw glue) | — | Headers are set by the plugin; `data:` lines are formed by JSON.stringify-ing chunks; final `data: [DONE]` is synthesized by the router (not relayed) for forward-compat. |
| Abort propagation | Router (`AbortController` + SDK `signal`) | undici (transitive — closes the upstream TCP) | The chain is the load-bearing primitive for SC3. Forget any link → SC3 silently fails. |
| Heartbeat (15 s) | Router (setInterval inside the SSE handler) | — | Started after first byte written; cleared in `req.raw.on('close')` AND on normal stream completion. |
| Log redaction | Router (pino `redact:` option) | — | Configured at the root logger so it applies everywhere (Fastify access logs, route handlers, error handlers). |
| Container build / runtime | Compose (`build: ./router`) + multi-stage Dockerfile | — | Production = 4-stage build; dev = `tsx watch` via override (D-A3). |
| Host port publish | Compose (`127.0.0.1:3000:3000`) | — | Localhost-only until Phase 6 puts Traefik in front. |

**Tier sanity-check for the planner:** Anything labeled "Router" lives in `router/src/`. Anything labeled "Compose" is an edit to `compose.yml` (D-12 says single file). Nothing in Phase 2 lives in a separate Compose override file *for production* — only the dev profile (D-A3) may.

## Standard Stack

### Core (verified against npm 2026-05-12)

| Library | Version | Purpose | Why Standard | Verified |
|---------|---------|---------|--------------|----------|
| `node` | `22.22.2` (host) / `node:22-bookworm-slim` (image) | Runtime | Active LTS through April 2027; native `fetch`; `node:22-alpine` is on the standing rejection list (musl + native deps) | `node --version` on host returned `v22.22.2` [VERIFIED] |
| `fastify` | `^5.8.5` | HTTP framework | Fastify v5 current major; native async iterables + first-class pino integration; SSE-friendly via plugin | `npm view fastify version` → `5.8.5` [VERIFIED npm registry] |
| `typescript` | `^5.6` | Type safety | Required minimum for `@anthropic-ai/sdk` (Phase 4) and `openai` v6; `verbatimModuleSyntax` catches SDK-import footguns | [CITED CLAUDE.md] |
| `openai` | `^6.37.0` | Outbound client to Ollama via OpenAI-compat | Returns `Stream<ChatCompletionChunk>` async iterable; supports `signal` for AbortController; `client.chat.completions.create({ stream: true, stream_options: { include_usage: true } })` is the exact call shape | `npm view openai version` → `6.37.0` (newer than CONTEXT.md's `^6.30.0` floor — semver-compatible) [VERIFIED] |
| `zod` | `^4.4.3` | Schema validation | v4 import path is `from 'zod/v4'`; required by `@bram-dc/fastify-type-provider-zod@^7` | `npm view zod version` → `4.4.3` [VERIFIED] |
| `fastify-sse-v2` | `^4.2.2` | SSE plugin (`reply.sse(asyncIterable)`) | The async-iterable API is exactly what we need to forward `Stream<ChatCompletionChunk>`; sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` automatically | `npm view fastify-sse-v2 version` → `4.2.2` (newer than CONTEXT.md's `^4.2.1` floor — patch-level only) [VERIFIED] |
| `@bram-dc/fastify-type-provider-zod` | `^7.0.1` | Wires zod into Fastify route schemas | The actively-maintained Fastify-5 fork; original `turkerdev/fastify-type-provider-zod` targets Fastify 4 | `npm view @bram-dc/fastify-type-provider-zod version` → `7.0.1` [VERIFIED] |
| `pino` | `^10.3.1` (transitive via Fastify v5) | Structured JSON logging | Default Fastify logger; `redact:` option supports nested wildcards (`req.headers.authorization`, `*.apiKey`) | `npm view pino version` → `10.3.1` (Fastify v5 transitive — no need to pin directly) [VERIFIED] |
| `js-yaml` | `^4.1.1` | Parse `models.yaml` | Industry standard; small surface; `load()` + `safeLoad`-style behavior is default | `npm view js-yaml version` → `4.1.1` [VERIFIED] |
| `@types/js-yaml` | `^4` | Types for js-yaml | — | [CITED CLAUDE.md install block] |

### Supporting / Dev

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tsx` | `^4.21.0` | TS runner for dev (`tsx watch src/index.ts`) | D-A3 — bind-mounted dev container | [VERIFIED npm] |
| `tsup` | `^8.5.1` | Bundle TS to ESM for prod | D-A2 stage 2: `tsup src/index.ts --format esm --target node22 --out-dir dist` | [VERIFIED npm] |
| `vitest` | `^2.14.6` | Unit + integration tests | Plays well with `msw` for upstream stubs | [VERIFIED npm] |
| `msw` | `^2.0.0` (any v2.x; latest `2.14.6` works) | Mock upstream Ollama in integration tests | `setupServer()` lets vitest run the Fastify app end-to-end with a fake `http://ollama:11434/v1/chat/completions` upstream | [VERIFIED npm — `2.14.6`] |
| `pino-pretty` | `^11.x` | Pretty-print pino in dev only | NEVER bundle into the prod image (CLAUDE.md anti-pattern) | [CITED CLAUDE.md] |
| `@biomejs/biome` | latest | Lint+format in one binary | CLAUDE.md endorses it as alternative to ESLint+Prettier; faster, fewer configs | [CITED CLAUDE.md] |
| `@types/node` | `^22` | Node 22 types | — | [CITED CLAUDE.md] |

### Alternatives Considered (do not use)

| Instead of | Could Use | Why we don't |
|------------|-----------|--------------|
| `fastify-sse-v2` | Native `reply.raw.writeHead` + manual `data:` lines | You'd reimplement headers, retry-id, heartbeat, error frame — the plugin is ~16× more downloaded than `@fastify/sse` and battle-tested. (PITFALLS Pitfall 4 mentions both raw and plugin paths; plugin wins for our re-emission-of-async-iterable use case.) |
| `openai` SDK v6 | Hand-rolled `fetch` to `http://ollama:11434/v1/chat/completions` | The SDK gives us `Stream<ChatCompletionChunk>` typed iteration + `signal` propagation + APIUserAbortError semantics for free. The same client is reused in Phase 7 (vLLM) and Phase 8 (Ollama Cloud) with only `baseURL` changing — no rewrite. |
| `@bram-dc/fastify-type-provider-zod` | Hand-rolled `zod.parse()` calls in route handlers | The type provider gives compile-time `request.body` typing AND request validation in one step. With three routes (healthz/non-stream/stream) it's borderline; with Phase 4's Anthropic schemas added, the seam is essential. Adopt now. |
| `turkerdev/fastify-type-provider-zod` | `@bram-dc/fastify-type-provider-zod` (the fork) | Original targets Fastify 4 — broke on v5 type-provider internals. Fork is the actively-maintained v5 build. |
| `node:22-alpine` | `node:22-bookworm-slim` | musl + native deps (pg-native, bcrypt) breaks opaquely. STATE.md anti-pattern. |
| `Express` + `express-sse` | `Fastify` + `fastify-sse-v2` | Express middleware ordering + non-native async makes upstream-stream cancellation brittle. STATE.md / STACK.md "What NOT to Use". |
| `ts-node` | `tsx` for dev, `tsup` for build | Slower cold start; decorator metadata pitfalls. STATE.md / STACK.md. |

**Installation (lift verbatim into `router/package.json`):**

```bash
cd router && npm init -y

# Production deps
npm install \
  fastify@^5.8.5 \
  fastify-sse-v2@^4.2.2 \
  @bram-dc/fastify-type-provider-zod@^7.0.1 \
  zod@^4.4.3 \
  openai@^6.37.0 \
  js-yaml@^4.1.1

# Dev deps
npm install -D \
  typescript@^5.6 \
  @types/node@^22 \
  @types/js-yaml@^4 \
  tsx@^4.21.0 \
  tsup@^8.5.1 \
  vitest@^2.14.6 \
  msw@^2.14.6 \
  pino-pretty@^11 \
  @biomejs/biome@latest
```

**Note:** `pino` is a transitive dep of Fastify v5 — do NOT pin it directly. Fastify chooses the matching pino major version. [VERIFIED Fastify v5 changelog]

## Architecture Patterns

### System Architecture Diagram

```
              Phase 2 — vertical slice (no Traefik, no Postgres, no Open WebUI yet)

  agent (curl, n8n, SDK)
        │  HTTP, Authorization: Bearer $ROUTER_BEARER_TOKEN
        │  POST /v1/chat/completions  { model, messages, stream? }
        │
        ▼
   127.0.0.1:3000 ───── compose port publish (localhost-only — D-A4)
        │
   ┌────────────────────────────────────────────────┐
   │  router service (this phase's deliverable)     │
   │                                                │
   │  preHandler:  bearer auth check                │
   │  (skip on /healthz only — ROUTE-04)            │
   │      │                                         │
   │      ▼                                         │
   │  route /v1/chat/completions  (zod schema)      │
   │      │                                         │
   │      ├──► registry.resolve(model)              │
   │      │      │                                  │
   │      │      ▼                                  │
   │      │   models.yaml (zod-validated, in-mem)   │
   │      │   ── fs.watch(./models.yaml) ─►         │
   │      │      debounce 250ms → atomic swap       │
   │      │                                         │
   │      ├──► OllamaOpenAIAdapter                  │
   │      │     (BackendAdapter impl — D-B2)        │
   │      │      │                                  │
   │      │      ▼                                  │
   │      │   openai SDK v6                         │
   │      │   new OpenAI({                          │
   │      │     baseURL: 'http://ollama:11434/v1',  │
   │      │     apiKey:  'ollama' (placeholder)     │
   │      │   })                                    │
   │      │      │                                  │
   │      │      ├── stream:false ──► await         │
   │      │      │      .create(...) → ChatCompletion│
   │      │      │      → reply.send(json)          │
   │      │      │                                  │
   │      │      └── stream:true ──► async for      │
   │      │             of Stream<ChatCompletion-   │
   │      │             Chunk> with                 │
   │      │             stream_options.include_usage│
   │      │                                         │
   │      ▼                                         │
   │  reply.sse(asyncIterable):                     │
   │     for each chunk → yield { data: JSON }      │
   │     final → yield { data: '[DONE]' }           │
   │     start 15s heartbeat (`: keep-alive\n\n`)   │
   │     register req.raw.on('close', ...) →        │
   │        controller.abort() + clearInterval      │
   │                                                │
   │  pino logger (root):                           │
   │     redact: ['req.headers.authorization',      │
   │              'req.headers.cookie',             │
   │              '*.apiKey', '*.api_key',          │
   │              'headers.authorization']          │
   └────────────────────────────────────────────────┘
        │  HTTP (no auth — D-B1 placeholder apiKey)
        │  AbortSignal propagated via undici
        ▼
   ollama service (already up from Phase 1, now no host port)
        │
        │  /v1/chat/completions (OpenAI-compat shim) — VERIFIED in this research session
        │  - emits delta chunks
        │  - emits final chunk with choices:[] + usage:{prompt,completion,total} when
        │    stream_options.include_usage is true
        │  - emits its own data: [DONE] (we synthesize ours regardless for forward-compat)
        ▼
   GPU (CUDA passthrough verified by Phase 1 preflight)
   model: llama3.2:3b-instruct-q4_K_M (resident in 3.1 GB VRAM)

  data flow on client kill:
    curl client closes TCP
      → Fastify req.raw 'close' fires
      → controller.abort() called
      → openai SDK's `signal` triggers APIUserAbortError on the for-await loop
      → undici closes upstream socket
      → Ollama observes connection drop, releases the GPU slot within ~1s
      → router clears heartbeat interval, ends reply.raw if not already ended
```

### Recommended Project Structure

```
router/
├── package.json                  # the install block above
├── tsconfig.json                 # node22 target, ESM, strict
├── tsup.config.ts                # ESM, target node22, no minify (debuggability)
├── biome.json                    # lint+format (or eslint.config.js if planner picks ESLint)
├── Dockerfile                    # 4-stage per CLAUDE.md (D-A2)
├── .dockerignore                 # at minimum: node_modules, dist, .env*
├── models.yaml                   # bind-mounted into /app/models.yaml:ro at runtime (ROUTE-02)
├── src/
│   ├── index.ts                  # bootstrap: build app + listen + signal handlers
│   ├── app.ts                    # buildApp(): pino, register plugin, attach hooks, return Fastify
│   ├── config/
│   │   ├── env.ts                # zod-validated env (ROUTER_BEARER_TOKEN, OLLAMA_URL, PORT, LOG_LEVEL)
│   │   └── registry.ts           # models.yaml load + fs.watch + zod schema + atomic swap
│   ├── auth/
│   │   └── bearer.ts             # preHandler hook + crypto.timingSafeEqual + skip-list
│   ├── backends/
│   │   ├── adapter.ts            # BackendAdapter interface (D-B2)
│   │   └── ollama-openai.ts      # OllamaOpenAIAdapter — wraps openai SDK
│   ├── routes/
│   │   ├── healthz.ts            # GET /healthz — 200 {status:"ok"} unauthenticated
│   │   └── v1/
│   │       └── chat-completions.ts  # POST /v1/chat/completions — non-stream + stream branches
│   ├── sse/
│   │   ├── stream.ts             # async generator: chunk → SSE event; synthesize [DONE]; emit error frame (D-C2)
│   │   └── heartbeat.ts          # 15s heartbeat helper with .stop() that the close handler calls
│   ├── errors/
│   │   └── envelope.ts           # OpenAI error envelope helpers (D-C1) — both pre-stream (JSON 4xx/5xx) and mid-stream (D-C2)
│   └── log/
│       └── logger.ts             # pino options object: level, base, redact, serializers
└── tests/
    ├── unit/
    │   ├── bearer.test.ts        # constant-time compare, length-padding, missing/wrong header
    │   ├── registry.test.ts      # zod schema (forward-compat fields accepted), resolve, hot-reload race
    │   ├── envelope.test.ts      # error envelope shape (incl. mid-stream)
    │   └── stream.test.ts        # SSE generator: chunks → event lines; synthesizes [DONE]; emits error frame
    ├── integration/
    │   ├── chat-completions.stream.test.ts    # full Fastify app + msw mocking ollama → SC1 wire shape
    │   ├── chat-completions.nonstream.test.ts # full Fastify app + msw → SC2 wire shape
    │   ├── auth.test.ts                       # 401 on missing/wrong bearer; 200 on /healthz with no auth
    │   └── hotreload.test.ts                  # write models.yaml, await debounce, assert new model resolves
    └── msw/
        └── handlers.ts           # msw handlers that emit OpenAI-shape SSE chunks identically to Ollama
```

**Why this layout:** Routes file = URL path (greppable). `backends/` is the seam Phase 3 widens (drop in `llamacpp-openai.ts`). `sse/` and `errors/` are pure functions that get unit-tested without Fastify. `tests/integration/` runs the full app with msw — fast (no Docker), proves wire format, but doesn't replace the bash smoke test.

### Pattern 1: Fastify v5 + zod type provider + SSE (the boilerplate)

**What:** Bootstrap Fastify with the zod type provider and the SSE plugin, both registered before any route declaration.

**When to use:** Every route in this phase.

**Example:**

```typescript
// router/src/app.ts
// Source: github.com/bram-dc/fastify-type-provider-zod (verified 2026-05-12),
//         github.com/mpetrunic/fastify-sse-v2 (verified 2026-05-12)
import Fastify, { type FastifyInstance } from 'fastify';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import { loggerOptions } from './log/logger.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,        // pass OPTIONS, not an instance — Fastify v5 contract
    bodyLimit: 8 * 1024 * 1024,   // 8 MB; Phase 4 vision blows past 1 MB easily
    trustProxy: false,            // Phase 6 (Traefik) flips this to true
  });

  // Register zod type provider compilers BEFORE route declarations
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register SSE plugin (no options — defaults are fine)
  await app.register(FastifySSEPlugin);

  // Now use withTypeProvider on every route declaration
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // ... register routes on `typed` (or use plugins that accept the typed instance)
  return app;
}
```

### Pattern 2: BackendAdapter interface (D-B2)

**What:** Abstract the upstream call so Phase 3 can drop in `LlamacppOpenAIAdapter` with no router code change.

**When to use:** Every upstream chat call goes through `adapter.chatCompletions(...)` or `adapter.chatCompletionsStream(...)`.

**Example:**

```typescript
// router/src/backends/adapter.ts
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
} from 'openai/resources/chat/completions';

export interface BackendAdapter {
  /** Non-stream call. Returns the full ChatCompletion or throws. */
  chatCompletions(
    req: ChatCompletionCreateParams,
    signal: AbortSignal,
  ): Promise<ChatCompletion>;

  /** Streaming call. Returns an async iterable of typed chunks. */
  chatCompletionsStream(
    req: ChatCompletionCreateParams,
    signal: AbortSignal,
  ): AsyncIterable<ChatCompletionChunk>;
}

// router/src/backends/ollama-openai.ts
// Source: Context7 /openai/openai-node — chat.completions.create stream + signal
import OpenAI from 'openai';
import type { BackendAdapter } from './adapter.js';

export class OllamaOpenAIAdapter implements BackendAdapter {
  private readonly client: OpenAI;

  constructor(baseURL: string) {
    // baseURL example: 'http://ollama:11434/v1'
    // apiKey is a non-empty placeholder per D-B1; local Ollama ignores it.
    this.client = new OpenAI({ baseURL, apiKey: 'ollama', timeout: 60_000 });
  }

  async chatCompletions(req, signal) {
    return this.client.chat.completions.create(
      { ...req, stream: false },
      { signal },
    );
  }

  chatCompletionsStream(req, signal) {
    // Returning the Stream as an AsyncIterable — for-await yields ChatCompletionChunk
    // The SDK throws APIUserAbortError on the for-await loop when signal aborts.
    // Setting stream_options.include_usage causes the final chunk to be
    //   { id, object, created, model, system_fingerprint,
    //     choices: [], usage: { prompt_tokens, completion_tokens, total_tokens } }
    // followed by Ollama's own data:[DONE]. (verified empirically against ollama 0.5.7-0)
    return this.client.chat.completions.create(
      {
        ...req,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );
  }
}
```

### Pattern 3: SSE handler with abort + heartbeat (the load-bearing code)

**What:** The full close-handler / heartbeat / abort wiring in one place. This is SC3.

**When to use:** Inside the streaming branch of `POST /v1/chat/completions`.

**Example:**

```typescript
// router/src/routes/v1/chat-completions.ts (streaming branch only — see plan for full route)
// Sources:
//   - github.com/mpetrunic/fastify-sse-v2 (reply.sse async iterable; verified 2026-05-12)
//   - Context7 /openai/openai-node (signal + APIUserAbortError; verified 2026-05-12)
//   - PITFALLS Pitfall 13 (abort propagation), Pitfall 4 (heartbeat + no compress)
async function streamHandler(req, reply, adapter, params) {
  const controller = new AbortController();

  // 1. Wire client disconnect → upstream abort. THE single most important line for SC3.
  //    Use req.raw.on('close') NOT req.raw.on('aborted') — 'close' fires for both
  //    client disconnect AND normal completion; 'aborted' is HTTP/1.1-specific.
  const onClose = () => {
    controller.abort(new Error('client-disconnect'));
    heartbeat.stop();
  };
  req.raw.once('close', onClose);

  // 2. Open upstream stream with the signal
  let upstream: AsyncIterable<ChatCompletionChunk>;
  try {
    upstream = adapter.chatCompletionsStream(params, controller.signal);
  } catch (err) {
    // Pre-stream error: HTTP not yet 200. Use D-C1 envelope.
    req.raw.off('close', onClose);
    return reply.code(mapToHttpStatus(err)).send(toOpenAIErrorEnvelope(err));
  }

  // 3. Start heartbeat AFTER first byte (SSE plugin sets headers + flushes on first yield)
  //    The heartbeat helper writes ': keep-alive\n\n' (a comment line — pings without payload)
  //    every 15s and exposes .stop() so the close handler can clear it.
  const heartbeat = startHeartbeat(reply.raw, 15_000);

  // 4. Pipe upstream chunks through the SSE plugin's async-iterable consumer
  await reply.sse((async function* () {
    try {
      for await (const chunk of upstream) {
        yield { data: JSON.stringify(chunk) };
      }
      // Synthesize the OpenAI [DONE] terminator regardless of what upstream emitted —
      // future backends (vLLM, llama.cpp) may or may not emit it. Wire-format consistency.
      yield { data: '[DONE]' };
    } catch (err) {
      // Mid-stream error: HTTP is already 200. Emit D-C2 frame, then [DONE], then close.
      // APIUserAbortError from a client disconnect should NOT emit an error frame —
      // the client is gone, there's nobody to receive it.
      if (controller.signal.aborted) {
        // No-op — let the iterator end normally; reply.sse will close the response.
        return;
      }
      yield {
        event: 'error',
        data: JSON.stringify(toOpenAIErrorEnvelope(err)),
      };
      yield { data: '[DONE]' };
      // pino at error level — D-C3 row "Mid-stream upstream error"
      req.log.error(
        { err, bytesEmitted: heartbeat.bytesSinceStart, msSinceStart: heartbeat.msSinceStart },
        'mid-stream upstream error',
      );
    } finally {
      // Belt-and-suspenders: stop heartbeat in finally too.
      heartbeat.stop();
      req.raw.off('close', onClose);
    }
  })());
}
```

### Pattern 4: pino redact + Fastify v5 logger (ROUTE-05)

**What:** Pass an OPTIONS object to `Fastify({ logger: ... })`. Do NOT instantiate pino yourself and pass the instance — Fastify v5 changed this contract. [CITED Fastify v5 changelog + Context7 /fastify/fastify]

**Example:**

```typescript
// router/src/log/logger.ts
// Source: Context7 /pinojs/pino — redact paths support nested wildcards
//         Context7 /fastify/fastify — Logger.md
import type { FastifyServerOptions } from 'fastify';

export const loggerOptions: FastifyServerOptions['logger'] = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'router', phase: 2 },
  redact: {
    paths: [
      // Inbound request headers (Fastify's default req serializer includes these)
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["proxy-authorization"]',
      // Body fields that might carry an apiKey (defensive — we don't accept them in Phase 2,
      // but if a future route does, redact-by-default beats redact-by-remembering)
      '*.apiKey',
      '*.api_key',
      // Top-level forms (when an err object is logged with a `headers` field at the root)
      'headers.authorization',
      'headers.cookie',
    ],
    censor: '[REDACTED]',
    // Do NOT use `remove: true` — leaving '[REDACTED]' in the log proves the redaction is
    // active (vs. the field never being present, which is ambiguous evidence). The SC5
    // grep test specifically asserts ZERO matches for "bearer|authorization" string content,
    // not "the key is absent".
  },
  // Dev pretty-print — guarded by NODE_ENV so prod stays JSON
  ...(process.env.NODE_ENV !== 'production'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } }
    : {}),
};
```

**Critical:** the `redact` paths form is the OBJECT form (`{ paths, censor }`) — the simpler array form (`redact: ['req.headers.authorization']`) works too but doesn't let you control censor text. The SC5 grep test needs neither — it asserts the absence of the *value* `bearer ...` / `authorization: ...`, not the key name. [VERIFIED Context7 /pinojs/pino redaction docs]

### Anti-Patterns to Avoid

- **Buffering the upstream stream into a single string before sending it down.** Defeats SSE entirely. PITFALLS Pitfall 4. The pattern in §Pattern 3 forwards each chunk immediately — `for await (const chunk of upstream) { yield { data: JSON.stringify(chunk) }; }`. Never `await stream.finalChatCompletion()` or accumulate.
- **Using `compress` middleware on `/v1/chat/completions`.** gzip buffering holds chunks until flush boundary. STATE.md anti-pattern + PITFALLS Pitfall 4. We don't register `@fastify/compress` at all in Phase 2; if we ever do, exclude streaming routes via the plugin's `customTypes` filter.
- **`req.raw.on('aborted')` instead of `req.raw.on('close')`.** `'aborted'` is HTTP/1.1-only and doesn't fire on H/2 client disconnect (Phase 6 lands H/2 via Traefik). `'close'` fires for both abnormal disconnect AND normal end-of-response — guard with `controller.signal.aborted` if you need to distinguish.
- **Forgetting to clear `setInterval` for the heartbeat.** Memory + open-handle leak; in Node 22 the process won't exit cleanly during shutdown. The §Pattern 3 helper exposes `.stop()` and the close handler calls it. Belt-and-suspenders: also clear in the iterator's `finally`.
- **Hand-rolling SSE headers when `fastify-sse-v2` is registered.** The plugin sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` automatically when `reply.sse()` is invoked. Setting them yourself before calling `reply.sse()` causes "headers already sent" errors.
- **Logging the request body or full upstream chunks at info level.** Even with redact configured for headers, an `err.config.headers.authorization` deep in an error object can slip through redact paths. Default to `req.log.warn({ err, model, backend }, 'failed')` — tag fields explicitly, don't dump objects.
- **`new OpenAI({ apiKey: '' })` or `new OpenAI({})`.** SDK v6 throws at construction time on empty apiKey. D-B1 specifies `apiKey: 'ollama'` as the placeholder.
- **Plain `=== ` for the bearer check.** Timing-leaks the token's prefix-match length. Use `crypto.timingSafeEqual` with length-padding (see §Bearer auth pattern below).
- **Mounting `models.yaml` as a Docker volume (named) instead of a bind mount.** `fs.watch` on a docker-managed volume mount is unreliable across drivers. Bind-mount `./router/models.yaml:/app/models.yaml:ro` so host edits are seen by the container's `fs.watch`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OpenAI streaming wire format | Manual `data: {...}\n\n` framing + `[DONE]` synthesis + retry-id + heartbeat | `fastify-sse-v2` `reply.sse(asyncIterable)` | Plugin handles the framing, the plugin sets the right headers, our async generator just yields `{data: ...}` events. |
| Iterating an upstream OpenAI-compat stream | Raw `fetch` + `ReadableStream` reader + manual parsing of `data:` lines + JSON.parse + handling of `[DONE]` | `client.chat.completions.create({ stream: true })` from openai SDK v6 | SDK returns a typed `Stream<ChatCompletionChunk>` async iterable; handles parsing, partial chunks, error frames, and the `[DONE]` terminator. |
| AbortController → upstream socket close | Custom undici dispatcher + manual TCP teardown | Pass `signal: controller.signal` as the second arg to `client.chat.completions.create(..., { signal })`. SDK forwards to undici, undici closes the socket. | One line. The chain is already correct end-to-end. |
| Constant-time bearer compare | Naïve `===` on `req.headers.authorization` | `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))` after length-padding both buffers | `===` short-circuits on first mismatched byte, leaking token prefix length. `timingSafeEqual` requires equal-length buffers; pad both to a fixed length first, then compare. |
| YAML parsing | Hand-rolled `String.split('\n').map(...)` | `js-yaml` `load(string)` (or its safer `loadAll`) | Industry-standard; `load()` rejects YAML 1.1 implicit booleans correctly; one source of correctness. |
| File watch debounce + atomic swap | Custom `fs.watchFile` polling + manual race handling | `node:fs.watch(path, listener)` + lodash-style debounce (or hand-roll a 10-line debounce) + a `let registry: Registry` reassignment under no lock (single-threaded JS) | `fs.watch` is correct on Linux for bind-mounted files; the debounce window of 250 ms covers editor save-twice (truncate-then-write) quirks; the "atomic swap" is just `registry = newRegistry` because Node is single-threaded. |
| HTTP error envelope | Custom JSON shapes per error case | A single `toOpenAIErrorEnvelope(err)` helper that returns `{ error: { message, type, code, param: null } }` per D-C1 | One shape, one place to update when D-C1 evolves; a switch over `err.constructor.name` maps known types (`OpenAIError`, `APIConnectionError`, `APIError`, `APIUserAbortError`, `ZodError`, custom `RegistryUnknownModelError`) → envelope. |
| Pino redaction | Manual `JSON.stringify` + regex on log messages | `pino({ redact: { paths: [...], censor: '[REDACTED]' } })` | Path-based; supports nested + wildcard (`*.apiKey`); applied at log-record-construction time, before any transport sees the bytes. Regex on output strings is too late and brittle. |
| Fastify route schema validation | Custom `if (!body.model) reply.code(400).send(...)` per route | zod schemas attached via `@bram-dc/fastify-type-provider-zod` | Validation + TypeScript-typed `request.body` + automatic 400 with structured error issues — one declaration. |

**Key insight:** Phase 2's load-bearing primitives (SSE framing, streaming SDK iteration, abort propagation, redaction) all have well-tested implementations in the chosen stack. The router code is composition glue, not re-implementation. **If you find yourself writing a parser, a state machine, or a custom timeout, you're going off the path.**

## Runtime State Inventory

Phase 2 is a greenfield-code phase that *adds* a new service to an existing Compose stack. There is no rename / refactor / migration of existing data. The only "runtime state inventory" item that matters is: **Phase 1 left an open host port on Ollama (`127.0.0.1:11434:11434`); Phase 2 removes it in the same compose.yml edit that adds the router service.**

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — router is stateless in Phase 2 (Postgres lands in Phase 5). The Ollama model `llama3.2:3b-instruct-q4_K_M` is already pulled and resident in `/srv/local-llms/models-gguf/ollama/` (verified `/api/ps`: 3.31 GB on GPU). | None. |
| Live service config | None added by Phase 2; Phase 1's compose.yml is the substrate. | Edit compose.yml: add `router:` service block; **REMOVE** Ollama's `ports: ["127.0.0.1:11434:11434"]` block (the comment in compose.yml already pre-announces this — verified line 110-114). |
| OS-registered state | None — router runs as a Compose service, not a systemd unit / Task Scheduler entry. | None. |
| Secrets / env vars | `ROUTER_BEARER_TOKEN` slot is already declared in `.env.example` and populated in `.env` (verified). Format: `local-llms_<hex32>` per Phase 1 D-14. | Wire it through compose.yml `environment:` → router container env. **No new top-level env keys needed for Phase 2.** |
| Build artifacts / installed packages | None — `router/` directory does not yet exist (verified). | Create `router/` with `package.json` + the install block above. The first `docker compose up router` triggers the multi-stage build. |

**The canonical question — "After every file in the repo is updated, what runtime systems still have the old string cached, stored, or registered?"** — has the answer **"nothing"** for this phase. The only runtime state that changes is Ollama losing its host port (which is a clean removal, not a name change).

## Common Pitfalls

### Pitfall 1: SSE buffering — first byte arrives, then nothing for 30+ seconds

**What goes wrong:** `curl -N` shows the connection establish, headers come through, then no `data:` chunks until generation completes — at which point all chunks arrive at once.

**Why it happens:** Either (a) we accidentally registered `@fastify/compress`, which gzip-buffers SSE, or (b) we set `Content-Type: application/json` somewhere upstream of `reply.sse()`, which routes through Fastify's JSON serializer (which buffers).

**How to avoid:** Do NOT register `@fastify/compress` in Phase 2 at all. Use `reply.sse(asyncIterable)` exclusively for streaming routes; do not call `reply.send(...)` after `reply.sse(...)` (the plugin already calls `reply.raw.end()` when the iterable completes). Verified by curl-N to the running router on `127.0.0.1:3000`.

**Warning signs:** `curl -N -v` shows headers without `Transfer-Encoding: chunked`. `Content-Type` in response is anything other than `text/event-stream`. Generation takes its full duration before any output appears.

### Pitfall 2: `req.raw.on('close')` fires but Ollama keeps generating (SC3 silent fail)

**What goes wrong:** Killing curl mid-stream — `nvidia-smi --loop-ms=500` shows GPU util at 100% for many seconds after the disconnect. SC3 silently fails.

**Why it happens (most common):** the AbortController was created but its `signal` was never passed to `client.chat.completions.create({ ..., signal })`. The SDK then has no way to abort the upstream — it just keeps reading until upstream ends naturally.

**How to avoid:** Mandatory unit + integration test:
- Unit: spy on the SDK call, assert `signal` is one of the args.
- Integration (msw): start a stream that emits one chunk every 200 ms; abort the controller after 300 ms; assert the iterator exits with `APIUserAbortError` within ~50 ms.
- Bash smoke (`bin/smoke-test-router.sh`): kill the curl PID mid-stream; poll `docker compose exec ollama curl -fsS http://localhost:11434/api/ps` and assert no model is in the "running" state with high VRAM utilization (or, more directly, that GPU util has dropped — but `/api/ps` is more deterministic).

**Warning signs:** Cancel a `curl -N` after seeing 2-3 chunks. Watch `nvidia-smi --loop-ms=500` in another window. If GPU util doesn't drop within ~1 s, the chain is broken.

### Pitfall 3: Heartbeat keeps the response alive after the client disconnects

**What goes wrong:** `req.raw.on('close')` fires, but the Fastify `reply` is never finalized because the heartbeat `setInterval` keeps writing `: keep-alive\n\n` to a closed socket. Eventually `reply.raw.write()` throws `EPIPE` and crashes the request handler. In production this looks like an intermittent 500 with no useful log.

**Why it happens:** the close handler aborts the upstream but forgets to `clearInterval` the heartbeat.

**How to avoid:** D-C4 is explicit about this. The code shape in §Pattern 3 above clears the heartbeat in BOTH (a) the `req.raw.on('close')` handler AND (b) the iterator's `finally` block. Belt-and-suspenders: if either fires, the interval stops.

**Warning signs:** `EPIPE` errors in router logs after a curl disconnect. `process._getActiveHandles().length` doesn't return to baseline after a request completes.

### Pitfall 4: `stream_options.include_usage` silently ignored

**What goes wrong:** The final SSE chunk has `choices: [...]` with `finish_reason: 'stop'` but no `usage` field. SC1 fails because `prompt_tokens`/`completion_tokens`/`total_tokens` are missing.

**Why it happens (in our case): NOT happening.** Empirically verified in this research session against the live `local-llms-ollama` (Ollama 0.5.7-0-ga420a45-dirty): with `stream_options.include_usage: true` set, Ollama emits an extra final chunk with `choices: []` AND `usage: {prompt_tokens: 32, completion_tokens: 5, total_tokens: 37}` BEFORE its own `data: [DONE]`. So Phase 2's behavior is correct out-of-the-box on the deployed Ollama version. [VERIFIED: live probe]

**How to avoid:** Send `stream_options.include_usage: true` on every upstream call (not just when the client requests stream — the SDK strips it from non-stream calls). Test the wire format in an integration test by reading the second-to-last chunk of the iterator and asserting `usage.prompt_tokens > 0`.

**Belt-and-suspenders fallback (NOT NEEDED for Phase 2 but documented for Phase 3+ / regression):** If a future Ollama version regresses on `include_usage`, swap the `OllamaOpenAIAdapter` to call native `POST /api/chat` directly with `stream: true`. The native API's final event is `{...,"done":true,"prompt_eval_count":N,"eval_count":M}`. Map `prompt_eval_count` → `prompt_tokens`, `eval_count` → `completion_tokens`. This is on Phase 4's plate anyway (vision needs the native API per Pitfall 8). Phase 2 does NOT implement this fallback.

**Warning signs:** SC1 assertion fails on `total_tokens > 0`. Inspect the final non-`[DONE]` chunk of the SSE response — if `choices` is non-empty and `usage` is missing, the upstream regressed.

### Pitfall 5: Bearer token leaks into logs (SC5 silent fail)

**What goes wrong:** `docker compose logs router | grep -iE "bearer|authorization"` returns matches. Token rotation is then the only remediation.

**Why it happens:** Either (a) pino redact wasn't configured (default is no redaction), or (b) it was configured but a code path serializes a request object via a different path (e.g., `req.log.info({ rawHeaders: req.raw.rawHeaders }, '...')` — `rawHeaders` isn't covered by `req.headers.authorization`), or (c) a custom error handler dumps the raw request via JSON.stringify.

**How to avoid:** D-C3 + D-C5 — pino redact configured at the root logger from the very first commit (see §Pattern 4). Add a CI assertion in the smoke test: after running a representative streaming session, `docker compose logs router 2>&1 | grep -ciE "bearer [a-z0-9_]+|authorization:" | grep -q '^0$'`. Note: also redact `req.headers.cookie` (Phase 2 doesn't use cookies, but agents might send them) and `*.apiKey` / `*.api_key` defensively for body fields.

**Warning signs:** A log line containing the actual token value or the literal string `Bearer ` followed by anything. In CI, the smoke test asserts zero matches.

### Pitfall 6: `models.yaml` hot-reload validates partial reads

**What goes wrong:** The user saves `models.yaml` mid-edit; `fs.watch` fires; the parser sees a half-written file; zod fails; the registry crashes (or, worse, swaps in an empty registry).

**Why it happens:** Editors often write YAML files in two ops — truncate-to-zero, then write content. If `fs.watch` fires after the truncate but before the write, `js-yaml.load('')` returns `undefined` (zod fails). If the editor uses rename-and-replace, `fs.watch` may fire on the rename, see the new file, parse it correctly — but then fire again on attribute changes and re-parse.

**How to avoid:** Three guards stacked:
1. **Debounce 250 ms** on the `fs.watch` listener. Editor save-twice quirks settle within ~100 ms; 250 ms gives margin without making interactive edits feel laggy.
2. **Validate before swap.** Parse + zod-validate the new content into a fresh `Registry` object; only then assign `currentRegistry = newRegistry`. If validation throws, log at `error` per D-C3 row "models.yaml hot-reload validation fail" and KEEP the previous registry in memory.
3. **Atomic assignment.** In single-threaded JS, the assignment `currentRegistry = next` is atomic relative to other request handlers — no mutex needed. (If we were multi-process, we'd need IPC; we're not.)

**Test pattern (vitest):**
```ts
// tests/integration/hotreload.test.ts
test('hot reload swaps registry without crashing on partial reads', async () => {
  // 1. start app with initial models.yaml (one model)
  // 2. write a partial yaml string (no closing brace) to models.yaml
  // 3. wait > 250 ms (debounce window)
  // 4. write the full new yaml (two models)
  // 5. wait > 250 ms
  // 6. assert resolve('new-model') succeeds
  // 7. assert app.log captured one error (the partial write) and one info (the swap)
});
```

**Warning signs:** "Cannot read properties of undefined (reading 'models')" in router logs after a save. Registry empty after edit.

### Pitfall 7: `fs.watch` doesn't fire on the bind-mounted file inside the container

**What goes wrong:** Editing `router/models.yaml` on the host doesn't trigger any router log line, even after 1+ s.

**Why it happens:** Two sub-cases:
- (a) The mount is a *named volume* instead of a *bind mount*. Named volumes use a different driver and `fs.watch` events don't propagate cleanly.
- (b) On WSL2 + Docker Desktop, edits to host files go through the 9P/virtio-9p layer and `fs.watch` may report only `change` events (no `rename`), or may coalesce/drop events under sustained writes.

**How to avoid:**
- Use a bind mount: `./router/models.yaml:/app/models.yaml:ro`. The `:ro` is fine — `fs.watch` reads, doesn't write.
- For WSL2 robustness, listen to BOTH `'change'` and `'rename'` events from `fs.watch` (it returns a single watcher; both event types come through the same listener). If reliability is still flaky, fall back to `fs.watchFile(path, { interval: 1000 }, ...)` which polls — heavier, but guaranteed to work everywhere.

**Test pattern:** the integration test should run against the actual on-disk file with `fs.watch` (not a mock). If the test is flaky on the dev's machine, that's a real signal.

**Warning signs:** Save the file, no log. Modify, no log. But `kill -SIGHUP <pid>` (manual reload pseudo-trigger) works. → `fs.watch` isn't firing; switch to `fs.watchFile`.

### Pitfall 8: openai SDK throws `APIUserAbortError` and we treat it as a real error

**What goes wrong:** Every client disconnect creates an error-level log line and an SSE `event: error` frame for nobody to read. The 100% baseline error rate is now "client disconnects".

**Why it happens:** When `signal.abort()` fires, the SDK's `for-await` loop throws `APIUserAbortError`. Naïve `try/catch` treats it like any other error.

**How to avoid:** Check `controller.signal.aborted` before emitting an error frame (see §Pattern 3 — the iterator's `catch` block early-returns when `aborted` is true). Optionally check `err instanceof APIUserAbortError` for the explicit type — but `signal.aborted` is more reliable because `APIUserAbortError`'s exact import path varies between SDK minor versions.

**Test pattern:** abort the controller after 300 ms of streaming; assert (a) the SSE response ends without an `event: error` frame and (b) no `error`-level log line was emitted.

**Warning signs:** Log explosion correlating with curl users hitting Ctrl-C. The router thinks every disconnect is a 500.

## Code Examples

### Bearer auth — constant-time compare with length-padding

```typescript
// router/src/auth/bearer.ts
// Source: Node crypto docs — timingSafeEqual requires equal-length buffers
import { timingSafeEqual, randomBytes } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

const PUBLIC_PATHS = new Set(['/healthz']);

export function makeBearerHook(expectedToken: string) {
  // Pre-compute a buffer of the expected token to compare against.
  const expectedBuf = Buffer.from(expectedToken, 'utf8');

  // A pad buffer of the same length we use when the supplied token is shorter
  // (so timingSafeEqual still has equal-length inputs). The pad is random per
  // process; we never compare against it for a "win", we just use it to keep
  // the comparison constant-time when lengths differ.
  const padBuf = randomBytes(expectedBuf.length);

  return async function bearerPreHandler(req: FastifyRequest, reply: FastifyReply) {
    if (PUBLIC_PATHS.has(req.url.split('?')[0]!)) return;

    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      // Do NOT log the supplied value — D-C3 row "Bearer auth fail"
      req.log.warn({ url: req.url, hasHeader: typeof auth === 'string' }, 'auth: missing or malformed bearer header');
      return reply.code(401).send({
        error: { message: 'Missing or malformed Authorization header', type: 'authentication_error', code: 'unauthorized', param: null },
      });
    }

    const supplied = auth.slice('Bearer '.length);
    const suppliedBuf = Buffer.from(supplied, 'utf8');

    // If lengths differ, compare both against the pad (constant-time false).
    // If lengths match, compare against the real expected.
    let ok = false;
    if (suppliedBuf.length === expectedBuf.length) {
      ok = timingSafeEqual(suppliedBuf, expectedBuf);
    } else {
      // Pad/truncate to expectedBuf.length so timingSafeEqual doesn't throw,
      // and ALSO compare against padBuf so the comparison still runs (constant time).
      const sized = Buffer.alloc(expectedBuf.length);
      suppliedBuf.copy(sized, 0, 0, Math.min(suppliedBuf.length, expectedBuf.length));
      // The two compares both run; result is always false because lengths differ.
      timingSafeEqual(sized, padBuf);
      ok = false;
    }

    if (!ok) {
      req.log.warn({ url: req.url }, 'auth: bearer mismatch');
      return reply.code(401).send({
        error: { message: 'Invalid bearer token', type: 'authentication_error', code: 'unauthorized', param: null },
      });
    }
  };
}
```

### `models.yaml` — schema + first concrete entry (forward-compat)

```yaml
# router/models.yaml
# Phase 2 reads only: name, backend, backend_url, backend_model
# Phase 3+ optional fields are present and accepted by zod but ignored at runtime.
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    # --- forward-compat (D-B4) — accepted, not consumed in Phase 2 ---
    capabilities: [chat]
    vram_budget_gb: 4
    concurrency: 2
    max_model_len: 8192
    profile: ollama
```

```typescript
// router/src/config/registry.ts (schema only — full module includes loader + watcher)
// Source: zod v4 import path 'zod/v4' — required by @bram-dc/fastify-type-provider-zod@^7
import { z } from 'zod/v4';

export const ModelEntrySchema = z.object({
  // Phase 2 — read
  name: z.string().min(1),
  backend: z.enum(['ollama']),                           // Phase 3 widens to ['ollama','llamacpp']; Phase 8 adds 'ollama-cloud'
  backend_url: z.string().url(),
  backend_model: z.string().min(1),
  // Phase 3+ — accept but ignore (forward-compat per D-B4)
  capabilities: z.array(z.enum(['chat', 'embeddings', 'vision', 'tools'])).optional(),
  vram_budget_gb: z.number().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  max_model_len: z.number().int().positive().optional(),
  profile: z.string().optional(),
});

export const RegistrySchema = z.object({
  models: z.array(ModelEntrySchema).min(1),
});

export type Registry = z.infer<typeof RegistrySchema>;
```

### Mid-stream error frame (D-C2) — exact wire bytes

```
event: error
data: {"error":{"message":"upstream connection reset","type":"upstream_error","code":"econnreset"}}

data: [DONE]

```

(Two trailing newlines after each `data:` line, blank line between events. The terminal `[DONE]` marker on its own line is OpenAI convention; clients use it to know the stream ended cleanly even on error.)

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Fastify v4 + `turkerdev/fastify-type-provider-zod` | Fastify v5 + `@bram-dc/fastify-type-provider-zod@^7` | Fastify 5 GA in 2024; broke v4 type-provider internals | Use the fork; the original never updated for v5 |
| openai SDK v4 (`openai.createChatCompletion(...)`) | openai SDK v6 (`client.chat.completions.create(...)`) | v5 GA late 2024; v6 mar 2026 | v6 has built-in streaming async iterables + `signal` support natively |
| Pino instance passed to Fastify (`Fastify({ logger: pino(opts) })`) | Pino options passed to Fastify (`Fastify({ logger: opts })`) | Fastify v5 changed the contract | DON'T pass an instance — Fastify constructs pino from options to control transports correctly |
| `zod` import (`import { z } from 'zod'`) | `zod/v4` import (`import { z } from 'zod/v4'`) | zod v4 introduced subpath exports | The type provider requires the v4 path; mixing causes "ZodType<unknown>" inference |
| Express + `express-sse` | Fastify + `fastify-sse-v2` | Express's middleware ordering + lack of native async makes SSE error handling brittle | STATE.md anti-pattern |
| `runtime: nvidia` legacy GPU form | `deploy.resources.reservations.devices` | Phase 1 already locked in (D-04) | Phase 2 router has no GPU — irrelevant here, but mentioned for consistency |

**Deprecated/outdated:**
- `ts-node` for dev — replaced by `tsx` (faster cold start, no decorator-metadata pitfalls).
- Hand-rolled SSE in raw `reply.raw.write()` — replaced by `fastify-sse-v2`'s async-iterable API (we still need raw access for the heartbeat — that part isn't deprecated).
- `OPENAI_API_KEY` from environment — Phase 2 hardcodes the placeholder `'ollama'` for the local backend; only Phase 8 (Ollama Cloud) introduces a real API key.

## Assumptions Log

This research was unusually verifiable thanks to the live Phase 1 environment + Context7 / npm availability. The assumptions below are the only items NOT independently verified in this session.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `fastify-sse-v2@^4.2.2` reads `reply.raw.write()` return value to handle backpressure when consuming an async iterable. | Pattern 3 / SSE wiring | Low — even if it doesn't, the iterator pulls one chunk at a time; backpressure manifests as memory growth on slow clients but doesn't break correctness for SC1-5. ROUTE-08 explicitly requires backpressure → planner should add a unit test that consumes a fast-yield iterable through the plugin against a slow socket sink. |
| A2 | `crypto.timingSafeEqual` runs in constant time even when called with same-length pad buffers (i.e., the JIT doesn't optimize it away in the length-mismatch branch). | Bearer auth | Low — Node's implementation is in C++ and explicitly resists timing-attack optimization. But the planner should still add a test with `process.hrtime.bigint()` measurements over many iterations to spot-check. |
| A3 | Ollama 0.5.7 will continue emitting `usage` in the final SSE chunk for the lifetime of Phase 2 (no point-release regression). | Pitfall 4 | Low for Phase 2 timeline; if it regresses we already documented the `/api/chat` fallback. The smoke test asserts the wire shape on every run, so regression is caught immediately. |
| A4 | `node:fs.watch` fires reliably on bind-mounted files inside Docker on WSL2 + Docker Desktop ≥ 4.34 (the most recent on this host). | Pitfall 7 | Medium — historically flaky on WSL2; the Pitfall 7 mitigation (fall back to `fs.watchFile` polling) is the planner's escape hatch. The integration test will surface flakiness immediately. |
| A5 | `compose.yml` line 113-114's host-port block on Ollama can be removed without breaking Phase 1's smoke test. (The Phase 1 smoke test hits `http://127.0.0.1:11434` directly — REMOVING the port WILL break `bin/smoke-test-gpu.sh`.) | Compose integration | **MEDIUM-HIGH** — this needs an explicit test plan. Either: (a) `bin/smoke-test-gpu.sh` is updated to `docker compose exec ollama curl -fsS http://localhost:11434/api/version` (no host port needed); or (b) the Phase 2 plan keeps the host port for backward-compat and removes it as a separate task. The CONTEXT.md is explicit (D-A4) about removal in same phase, so option (a) is correct — the planner MUST update the GPU smoke test in the same phase. |

## Open Questions (RESOLVED)

> All five open questions were resolved during planning and the chosen recommendations are
> applied in the Phase 2 plans (02-01 .. 02-05). Captured here for the audit trail.

1. **RESOLVED — `/healthz` returns synchronous JSON, no upstream probe.** Returns `200 {"status":"ok", "service":"router", "phase":2, "registry_models":N}`. Liveness = "process up + registry parsed at startup". Phase 3's `/readyz` will add the upstream probe. Applied in plan 02-02 (`routes/healthz.ts`).
   - Original framing: should `/healthz` probe Ollama, or return blindly?
   - Rationale: ROUTE-04 separates liveness from readiness; matches Kubernetes/Compose semantics; avoids `/healthz` becoming a DoS pivot through the router.

2. **RESOLVED — Healthcheck uses `node -e fetch`, not curl-in-image.** `node:22-bookworm-slim` doesn't ship curl; rather than +5 MB for `apt-get install -y curl`, use `node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1))"`. Applied in plan 02-01 task 3 (Dockerfile + Compose router service block).
   - Rationale: node is already in the image; healthcheck failing if node itself is broken is correct behavior; one less binary to maintain.

3. **RESOLVED — `@fastify/cors` is NOT registered in Phase 2.** Open WebUI is server-to-server (Phase 6); no browser callers in Phase 2. Picking allowed origins is premature. Applied implicitly across plans 02-01..02-05 (no `@fastify/cors` in `package.json`).
   - Rationale: locking down to `[]` now beats picking origins we don't have yet; Phase 6 (Traefik + Open WebUI) revisits.

4. **RESOLVED — Dev workflow uses `profiles: [dev]` `router-dev` service, NOT a `compose.override.yml` file.** A separate `router-dev` service builds against the Dockerfile's `target: deps` stage (which has `tsx` as a devDep), bind-mounts `./router/src`, and runs `npx tsx watch src/index.ts`. Toggled with `docker compose --profile dev up router-dev`. Applied in plan 02-01 task 3 (Compose `router-dev:` block).
   - Rationale: prod stays minimal (no devDeps in `router:`); dev is explicit; no gitignore friction. The original override-file approach (option a in the plan-checker review) was actively broken because the prod runtime stage strips devDeps and would not have `tsx` available — the profile approach side-steps that footgun.

5. **RESOLVED — `BackendAdapter` `signal` arg is REQUIRED `AbortSignal`, not optional.** Applied in plan 02-03 (`backends/adapter.ts`). Non-stream branch creates an `AbortController` anyway (defensive: if Fastify times out, abort upstream); Phase 3's adapters MUST accept it. Making it optional encourages "I'll wire it later" — the SC3 bug pattern.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js (host, for dev) | `tsx` watch loop on dev box | ✓ | v22.22.2 | — (matches `node:22-bookworm-slim` minor) |
| npm (host, for dev) | install router deps | ✓ | 10.9.7 | — |
| Docker | run router service | ✓ | 29.4.2 | — |
| Docker Compose | orchestrate router + ollama | ✓ | v5.1.3 (note: this is Compose plugin version, not the Compose file format) | — |
| Ollama 0.5.7 service | router talks to it | ✓ HEALTHY | container `local-llms-ollama` UP for 50+ min, port `127.0.0.1:11434` reachable, `/api/version` returns `0.5.7-0-ga420a45-dirty` | — |
| `llama3.2:3b-instruct-q4_K_M` model | smoke test fixture | ✓ RESIDENT | 3.31 GB on GPU per `/api/ps` | — |
| `ROUTER_BEARER_TOKEN` in `.env` | bearer auth | ✓ POPULATED | `local-llms_<hex>` per Phase 1 D-14 | — |
| `node:22-bookworm-slim` Docker image | Dockerfile stages 1, 2, 3, 4 | NOT VERIFIED — will be pulled on first build | — | None — must be available; if Docker Hub is unreachable, planner can ship a digest pin |
| Internet egress (npm registry) | first `npm ci` inside Dockerfile stage 1 | ASSUMED — Phase 1 host pulled `nvidia/cuda` and `ollama/ollama` images successfully | — | None — required to install deps; if offline, plan needs a vendored `node_modules` step |

**Missing dependencies with no fallback:** None — every dependency Phase 2 needs is either present and verified, or is a public-internet pull that Phase 1 already proved works.

**Missing dependencies with fallback:** None.

**Verification commands (planner can include in Plan 01 preflight):**
```bash
docker compose ps ollama --format '{{.Status}}' | grep -q healthy
curl -fsS http://127.0.0.1:11434/api/version >/dev/null
docker compose exec -T ollama ollama list | grep -q 'llama3.2:3b-instruct-q4_K_M'
test -n "$(grep -E '^ROUTER_BEARER_TOKEN=.+' .env)"
```

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `vitest@^2.14.6` (pinned via `router/package.json`) |
| Config file | `router/vitest.config.ts` (TBD by Wave 0 — see "Wave 0 Gaps" below) |
| Mock library | `msw@^2.14.6` for upstream Ollama HTTP stubs |
| Quick run command | `cd router && npm run test:unit` (vitest run on `tests/unit/**/*.test.ts`) |
| Full suite command | `cd router && npm test` (vitest run on `tests/**/*.test.ts`) |
| Bash smoke (proves end-to-end against real Ollama) | `bash bin/smoke-test-router.sh` (new file, mirrors `bin/smoke-test-gpu.sh` style) |

### Phase Requirements → Test Map

Each row maps a phase requirement and/or success criterion to the **smallest** test that would catch a regression. The bash smoke test is the integration anchor (real Ollama, real GPU); vitest+msw covers the wire-format contract without Docker; vitest unit tests cover pure functions.

| Req / SC | Behavior to verify | Test type | Automated command | File exists? |
|--------|----------|-----------|-------------------|-------------|
| **SC1** (stream chat with usage in final chunk) | `curl -N -H "Authorization: Bearer $T" /v1/chat/completions` with `stream:true` emits OpenAI `data:` chunks <1s apart, ends with usage chunk + `data: [DONE]` | bash smoke | `bash bin/smoke-test-router.sh` | ❌ Wave 0 — new file |
| **SC1** (wire shape — fast unit-level coverage) | A msw-mocked stream of 5 OpenAI-shape chunks + final usage chunk passes through router unchanged | integration (vitest+msw) | `cd router && npx vitest run tests/integration/chat-completions.stream.test.ts -t 'forwards each upstream chunk verbatim'` | ❌ Wave 0 |
| **SC2** (non-stream chat with usage) | `POST /v1/chat/completions` with `stream:false` returns `{choices:[...], usage:{prompt_tokens, completion_tokens, total_tokens}}` | integration (vitest+msw) | `cd router && npx vitest run tests/integration/chat-completions.nonstream.test.ts` | ❌ Wave 0 |
| **SC2** (real Ollama wire shape) | bash smoke also asserts non-stream | bash smoke | `bash bin/smoke-test-router.sh --no-stream-only` (or just always run both) | ❌ Wave 0 |
| **SC3** (mid-stream abort returns GPU to idle ~1s) | Kill curl mid-stream; assert `/api/ps` shows model.expires_at countdown completes / GPU util drops within 2s | bash smoke | section of `bin/smoke-test-router.sh` | ❌ Wave 0 |
| **SC3** (abort propagation unit) | mocked SDK call records that `signal` was passed; abort signal causes for-await to throw `APIUserAbortError` | integration (vitest+msw) | `cd router && npx vitest run tests/integration/chat-completions.stream.test.ts -t 'aborts upstream on client disconnect'` | ❌ Wave 0 |
| **SC4** (registry zod-validated, hot-reload, /healthz unauthenticated, all model endpoints require auth) | (a) startup with bad models.yaml exits non-zero with clear error; (b) write-then-read updates resolve(); (c) GET /healthz returns 200 with no auth header; (d) POST /v1/chat/completions returns 401 without auth | unit + integration | `cd router && npx vitest run tests/unit/registry.test.ts tests/integration/auth.test.ts tests/integration/hotreload.test.ts` | ❌ Wave 0 |
| **SC5** (zero log matches for `bearer\|authorization` after a session) | Run a representative streaming session through the smoke test; assert `docker compose logs router 2>&1 \| grep -ciE 'bearer [a-z0-9_]+\|authorization:[[:space:]]*bearer'` is `0` | bash smoke (final assertion) | section of `bin/smoke-test-router.sh` | ❌ Wave 0 |
| **ROUTE-01** (Fastify v5 on Node 22 LTS in Compose) | `docker compose ps router` shows healthy; `node --version` inside container returns v22.x | bash smoke pre-flight | section of `bin/smoke-test-router.sh` | ❌ Wave 0 |
| **ROUTE-02** (zod-validated registry + hot-reload) | covered by SC4 above | as above | as above | as above |
| **ROUTE-03** (constant-time bearer compare) | both correct token (200) and wrong-length token (401) are caught; `crypto.timingSafeEqual` is invoked (spy) | unit | `cd router && npx vitest run tests/unit/bearer.test.ts` | ❌ Wave 0 |
| **ROUTE-04** (/healthz unauthenticated, model endpoints required) | covered by SC4 above | as above | as above | as above |
| **ROUTE-05** (pino redact authorization/cookie/*.apiKey) | covered by SC5 above + a unit test that constructs an err object containing fake auth header and asserts redacted | unit + bash smoke | `cd router && npx vitest run tests/unit/log/redact.test.ts` + bash smoke | ❌ Wave 0 |
| **ROUTE-08** (15s heartbeat, backpressure, abort) | (a) heartbeat helper writes `: keep-alive\n\n` after 15s of silence; (b) backpressure: when raw write returns false, generator awaits `'drain'`; (c) covered by SC3 above for abort | unit | `cd router && npx vitest run tests/unit/sse/heartbeat.test.ts tests/unit/sse/backpressure.test.ts` | ❌ Wave 0 |
| **OAI-01** (chat completions stream + non-stream) | covered by SC1 + SC2 | as above | as above | as above |
| **OAI-04** (OpenAI delta wire format) | a fixed input through msw produces a known SSE byte sequence; snapshot test catches any wire-format drift | integration | `cd router && npx vitest run tests/integration/chat-completions.stream.test.ts -t 'wire format snapshot'` | ❌ Wave 0 |
| **OAI-05** (token usage in non-stream + final SSE chunk) | covered by SC1 + SC2 | as above | as above | as above |

### Sampling Rate

- **Per task commit:** `cd router && npm run test:unit` (vitest unit only — < 5 s typical). Targets all new/edited files in the commit.
- **Per wave merge:** `cd router && npm test` (full vitest suite — < 30 s typical, no Docker). Plus `bash bin/smoke-test-router.sh` (real Ollama — < 30 s typical including the abort assertion's 2s wait).
- **Phase gate (before `/gsd-verify-work`):** All of the above PLUS a manual `curl -N` from a different shell against the live router, kill mid-stream, observe `nvidia-smi --loop-ms=500` for ~3 s. Eyes-on confirmation that SC3 actually drops GPU util.

### Wave 0 Gaps

The router project doesn't exist yet — Wave 0 (project scaffold) creates everything below. **Every test file in the table above is in this list.**

- [ ] `router/package.json` — install block from §Standard Stack
- [ ] `router/tsconfig.json` — `target: es2023`, `module: nodenext`, `strict: true`, `verbatimModuleSyntax: true`
- [ ] `router/vitest.config.ts` — `test: { include: ['tests/**/*.test.ts'], environment: 'node' }`
- [ ] `router/biome.json` (or `eslint.config.js`) — flat config
- [ ] `router/tests/msw/handlers.ts` — msw v2 handlers that emit OpenAI-shape SSE chunks identically to the live Ollama (use the actual chunk shape verified in this research session)
- [ ] `router/tests/setup.ts` — vitest `beforeAll`/`afterAll` to start/stop the msw server
- [ ] `router/tests/unit/bearer.test.ts` — covers ROUTE-03
- [ ] `router/tests/unit/registry.test.ts` — covers ROUTE-02
- [ ] `router/tests/unit/envelope.test.ts` — covers D-C1 + D-C2 envelope shapes
- [ ] `router/tests/unit/sse/heartbeat.test.ts` — covers ROUTE-08 heartbeat
- [ ] `router/tests/unit/sse/stream.test.ts` — covers SSE generator unit
- [ ] `router/tests/unit/log/redact.test.ts` — covers ROUTE-05 redaction unit
- [ ] `router/tests/integration/chat-completions.stream.test.ts` — covers SC1, SC3 (mocked), OAI-04, OAI-05
- [ ] `router/tests/integration/chat-completions.nonstream.test.ts` — covers SC2, OAI-05
- [ ] `router/tests/integration/auth.test.ts` — covers SC4 (auth half), ROUTE-03, ROUTE-04
- [ ] `router/tests/integration/hotreload.test.ts` — covers SC4 (hot-reload half), ROUTE-02
- [ ] `bin/smoke-test-router.sh` — bash script anchoring SC1, SC2, SC3, SC5 against the real running Ollama. Mirror `bin/smoke-test-gpu.sh` style (set -uo pipefail, FAILURES counter, sectioned output, exit 0/1).
- [ ] `router/tsup.config.ts` — `{ entry: ['src/index.ts'], format: 'esm', target: 'node22', clean: true, sourcemap: true }`

*(There are no pre-existing tests to extend — this is the first phase that introduces the router codebase. The test infrastructure is created from zero in Wave 0.)*

## Security Domain

`security_enforcement` is not explicitly disabled in `.planning/config.json` — treat as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Single bearer token from `.env` (D-14) compared via `crypto.timingSafeEqual` (ROUTE-03). Token format `local-llms_<hex32>` makes accidental log leaks searchable (Phase 1 D-14). |
| V3 Session Management | no | Stateless API; no sessions in Phase 2. (Open WebUI's session cookies arrive in Phase 6 and live in OWUI, not the router.) |
| V4 Access Control | yes (single tier) | One token = one permission level. Skip-list for `/healthz` only. No multi-tenant logic per PROJECT.md anti-pattern. |
| V5 Input Validation | yes | zod schemas on every route via `@bram-dc/fastify-type-provider-zod@^7`. Body limit raised to 8 MB (vision in Phase 4); rejected payloads → 400 with structured error per D-C3. |
| V6 Cryptography | yes (auth comparison only) | Use `crypto.timingSafeEqual` from Node's built-in `crypto` — never hand-roll comparison. No additional crypto in Phase 2 (TLS lands at Traefik in Phase 6). |
| V7 Error Handling & Logging | yes | pino `redact` for auth/cookie/apiKey from first commit (ROUTE-05). Error envelopes never include the supplied bearer token. Structured log fields, never stringified raw request objects. |
| V8 Data Protection | partial | Phase 2 has no data at rest (Postgres lands in Phase 5). The `.env` file is gitignored (Phase 1 D-14) and chmod 600 by convention. The bearer token is the only secret. |
| V9 Communication | partial | Localhost-only host port (`127.0.0.1:3000:3000`, D-A4) means traffic stays on loopback in Phase 2. TLS via Traefik in Phase 6. |
| V10 Malicious Code | n/a | No file upload, no code execution surface in Phase 2. |
| V11 Business Logic | yes (light) | Mid-stream error contract (D-C2) prevents the "agent receives partial text, thinks it's complete" UX failure (PITFALLS UX Pitfalls table). The final SSE chunk MUST always end with `data: [DONE]`, including on error. |
| V12 Files & Resources | yes | `models.yaml` is bind-mounted read-only (`:ro`). `fs.watch` is read-only. No file write paths in Phase 2. |
| V13 API & Web Service | yes | OpenAI-compat surface; structured errors (D-C1); request body size cap; consistent `Content-Type: application/json` for non-stream / `text/event-stream` for stream. No CORS in Phase 2 (no browser callers). |
| V14 Configuration | yes | All config from `.env` via zod-validated parser (env.ts). Fail-closed on missing/empty `ROUTER_BEARER_TOKEN`. No hardcoded secrets, no default fallback to "changeme". |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Bearer token leaked into Docker logs | Information Disclosure | pino `redact: ['req.headers.authorization', 'req.headers.cookie', '*.apiKey']` from very first commit; `/healthz` unauthenticated so token never goes into Compose healthcheck command. SC5 grep test in CI. |
| Bearer token timing-leak via `===` compare | Information Disclosure | `crypto.timingSafeEqual` with length-padding (see §Bearer auth code example). |
| Agent retry storm DoS-ing the GPU | Denial of Service | Rate limit deferred to Phase 8 (ROUTE-11). Phase 2 mitigation: abort propagation (SC3) ensures a stuck agent at least doesn't pile up dead generations. |
| Bind-mounted `models.yaml` writable from inside container | Tampering | `:ro` mount. The container can read but not edit registry — registry edits are host-side only. |
| Upstream Ollama returning malformed JSON corrupts router | Tampering | The openai SDK validates each chunk's shape; malformed chunks throw `OpenAIError` which the §Pattern 3 catch maps to mid-stream `event: error` (D-C2). |
| YAML injection via `models.yaml` with executable directives (e.g., `!!js/function`) | Code Execution | Use `js-yaml.load(...)` (default) which already disables custom types; never use `loadAll` with `unsafeLoad: true`. zod schema rejects unknown shapes. |
| Bearer token in `Authorization` header captured by an SSE proxy | Information Disclosure | Phase 2 is localhost-only (D-A4). Phase 6 (Traefik) adds TLS. The token never traverses untrusted networks in Phase 2. |
| Ollama `internal:true` network giving the router cleartext access | Spoofing | `backend` network is `internal: true`; only the router (joining `app` + `backend`) can reach Ollama. Other Compose services can't pivot through. |
| `models.yaml` hot-reload swap-in of malicious entries | Tampering | The file is read from a bind-mounted path that only the host operator can write to. zod validation rejects malformed entries; on validation failure, previous registry is kept (D-C3). |

**Phase 2 deliberately leaves these for later phases:**
- Per-token rate limiting (Phase 8 — ROUTE-11, requires Valkey)
- mTLS / vLLM `--api-key` / Postgres password (Phase 5/7/8 — Phase 2 has no Postgres or vLLM)
- Public-internet exposure (out of scope per PROJECT.md "Public-internet exposure of the router" — Tailscale recommended for remote access)
- Token rotation procedure (Phase 9 — OPS-04)

## Sources

### Primary (HIGH confidence)

- **Live probe (this session, 2026-05-12)** — `curl http://127.0.0.1:11434/v1/chat/completions` with `stream_options.include_usage: true` against running Ollama 0.5.7-0-ga420a45-dirty: confirmed wire shape includes final chunk `{choices:[], usage:{prompt_tokens, completion_tokens, total_tokens}}` followed by `data: [DONE]`. — for §Pitfall 4, §Streaming chat completions, OAI-05.
- **Live probe (this session)** — `curl http://127.0.0.1:11434/v1/chat/completions` with `stream:false`: confirmed `usage:{prompt_tokens, completion_tokens, total_tokens}` populated in non-stream response. — for SC2, OAI-05.
- **Live probe (this session)** — `curl http://127.0.0.1:11434/api/ps`: confirmed model `llama3.2:3b-instruct-q4_K_M` is GPU-resident (3.31 GB `size_vram == size`), Ollama version 0.5.7-0-ga420a45-dirty, `expires_at` countdown active (proves the GPU release path works). — for §Environment Availability, SC3 verification approach.
- **npm registry (verified 2026-05-12)** — `npm view <pkg> version` for fastify, openai, zod, fastify-sse-v2, @bram-dc/fastify-type-provider-zod, @anthropic-ai/sdk, tsup, tsx, vitest, msw, pino, js-yaml. — for §Standard Stack version pins.
- **Context7 `/openai/openai-node` llms.txt** — exact streaming pattern (`for await (const chunk of stream)`), `signal` passing, `APIUserAbortError` semantics, `[DONE]` SDK-handled vs synthesized. — for §Pattern 2, §Pattern 3, §Pitfall 8.
- **Context7 `/pinojs/pino` redaction docs** — `redact: { paths: [...], censor: '...' }` form, nested wildcards, `*.apiKey` syntax. — for §Pattern 4, ROUTE-05.
- **Context7 `/fastify/fastify` Logger.md + Server.md** — Fastify v5 logger contract (pass options not instance), serializer config, redact path semantics. — for §Pattern 4.
- **github.com/bram-dc/fastify-type-provider-zod README (fetched 2026-05-12)** — exact `setValidatorCompiler` / `setSerializerCompiler` / `withTypeProvider<ZodTypeProvider>()` pattern; zod v4 import path requirement. — for §Pattern 1.
- **github.com/mpetrunic/fastify-sse-v2 README (fetched 2026-05-12)** — `FastifySSEPlugin` import, `reply.sse(asyncIterable)` signature, plugin options. — for §Pattern 1, §Pattern 3.

### Secondary (HIGH confidence — synthesis from existing project research)

- **`.planning/research/STACK.md` §"Streaming gotchas — Fastify + SSE"** — backpressure pattern, header set, `req.raw.on('close')` advisory. — for §Pattern 3.
- **`.planning/research/PITFALLS.md` Pitfall 4** — SSE buffering, no-compress on streaming routes, heartbeat, abort. — for §Pitfall 1, §Pitfall 2, §Pitfall 3.
- **`.planning/research/PITFALLS.md` Pitfall 8** — Ollama OpenAI-compat shim quirks; native `/api/chat` is the vision-correct path (deferred to Phase 4). — for §Pitfall 4 fallback.
- **`.planning/research/PITFALLS.md` Pitfall 12** — bearer token in logs; pino redact + healthz unauth. — for §Pitfall 5, ROUTE-05, SC5.
- **`.planning/research/PITFALLS.md` Pitfall 13** — abort propagation chain; long-generation timeouts. — for §Pattern 3, SC3.
- **`.planning/research/ARCHITECTURE.md` §3.1** — request lifecycle for `/v1/chat/completions` (steps a-i). — for §System Architecture Diagram.
- **`.planning/research/SUMMARY.md` §"Phase 2: Vertical-slice MVP"** — MVP definition (lift verbatim into 02-PLAN.md). — for executive summary.
- **`.planning/phases/01-gpu-compose-foundation/01-CONTEXT.md` D-12 (single compose file), D-13 (four networks), D-14 (.env contract)** — substrate the router service appends to. — for §Compose integration in §Architectural Responsibility Map.
- **`compose.yml` (lines 87-162)** — current Ollama service block, including the host-port pre-announcement comment for removal. — for §Runtime State Inventory.
- **`bin/smoke-test-gpu.sh`** — bash conventions (set -uo pipefail, FAILURES counter, sectioned output, color-when-tty). — for `bin/smoke-test-router.sh` design.
- **`CLAUDE.md`** — full stack spec, multi-stage Dockerfile pattern, Streaming gotchas section, all version pins. — substrate.

### Tertiary (MEDIUM confidence — single source, conventional)

- **Ollama OpenAI-compat docs (`docs.ollama.com/api/openai-compatibility`)** — `/v1/chat/completions`, `/v1/embeddings`, `/v1/models` shapes. (We verified the streaming shape empirically; this docs URL backs up the contract.) — for D-B1 baseURL choice.

## Metadata

**Confidence breakdown:**
- Standard stack: **HIGH** — every package version verified against npm registry 2026-05-12; the `@bram-dc/fastify-type-provider-zod` fork API verified against its README in the same session.
- Architecture (router shape, BackendAdapter seam, four-stage Dockerfile): **HIGH** — directly inherited from CONTEXT.md locked decisions + ARCHITECTURE.md §3.1 + STACK.md Multi-stage Dockerfile pattern, all read in this session.
- Streaming + abort + heartbeat: **HIGH** — Context7 confirmed openai SDK v6 `signal` semantics; fastify-sse-v2 README confirmed async-iterable consumer; PITFALLS Pitfall 13 + D-C4 lock the pattern. Live `req.raw.on('close')` behavior is Node-native, not stack-specific.
- Ollama `stream_options.include_usage`: **HIGH** — empirically verified against the running Phase 1 Ollama in this session. The previously-MEDIUM uncertainty is now CLOSED.
- pino redaction: **HIGH** — Context7 confirmed nested-wildcard syntax; D-C3 + D-C5 lock the path list. SC5 is mechanically testable.
- `models.yaml` hot-reload: **MEDIUM** on the WSL2 + Docker Desktop `fs.watch` reliability claim (A4). Mitigation (fall back to `fs.watchFile` polling) is documented; integration test will surface flakiness immediately.
- Bash smoke test design: **HIGH** — full template available in `bin/smoke-test-gpu.sh` to mirror.

**Research date:** 2026-05-12
**Valid until:** 2026-06-12 (30 days for stable stack — Fastify v5 / openai v6 / Ollama 0.5.x are mature; revisit if Ollama jumps to a 0.6 line or the openai SDK ships a v7).

## RESEARCH COMPLETE
