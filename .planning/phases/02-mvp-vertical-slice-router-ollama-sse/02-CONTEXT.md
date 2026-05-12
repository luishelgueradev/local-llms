# Phase 2: MVP Vertical Slice — Router + Ollama + SSE - Context

**Gathered:** 2026-05-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Smallest end-to-end thing that proves the architecture: one agent `curl`-streams tokens from a real local Ollama model through a Fastify router, with bearer auth, SSE, abort propagation, pino redaction, and `models.yaml` registry hot-reload — correct from day one.

**Scope:** exactly one HTTP surface (`POST /v1/chat/completions`, OpenAI passthrough), one backend (Ollama via OpenAI-compat `/v1`), one unauthenticated health probe (`/healthz`), one declarative registry (`models.yaml`).

**Explicitly out of Phase 2** (each lives in its own phase per ROADMAP.md):
- `/v1/messages` and Anthropic translation → Phase 4
- `/v1/embeddings` → Phase 7
- `GET /v1/models` + `/readyz` aggregator + per-backend probes → Phase 3
- llama.cpp backend → Phase 3
- vLLM backend → Phase 7
- Ollama Cloud → Phase 8
- Postgres `request_log` and `/metrics` → Phase 5
- Traefik, TLS, four-network enforcement → Phase 6
- Open WebUI → Phase 6
- Rate limit (Valkey), circuit breaker, `Idempotency-Key`, `X-Model-Backend` → Phase 8

**Phase 2 cleanup of Phase 1 walking-skeleton state:**
- Drop Ollama's `127.0.0.1:11434:11434` host port (the comment in `compose.yml` already pre-announces this).
- Replace it with the router's `127.0.0.1:3000:3000` host port (localhost-only, removed in Phase 6 when Traefik lands).

</domain>

<decisions>
## Implementation Decisions

### Project layout & build pipeline
- **D-A1:** Router code lives in a top-level **`router/`** subdirectory with its own `package.json`, `tsconfig.json`, `src/`, and `Dockerfile`. Treats the repo as a natural monorepo so later milestones (fine-tuning, etc.) can drop sibling services in cleanly.
- **D-A2:** **Multi-stage Dockerfile** exactly per `CLAUDE.md` "Multi-stage Dockerfile pattern — router":
  - Stage 1 (`deps`): `npm ci` (cached layer).
  - Stage 2 (`build`): `tsup src/index.ts --format esm --target node22` → `dist/`.
  - Stage 3 (`prod-deps`): `npm ci --omit=dev` to a clean `node_modules/`.
  - Stage 4 (`runtime`): `node:22-bookworm-slim` + `dist/` + prod `node_modules/`. Entrypoint `node dist/index.js`.
  No `node:22-alpine` anywhere (standing anti-pattern in STATE.md).
- **D-A3:** Dev workflow uses `tsx watch src/index.ts` with `./router/src` bind-mounted into the container. Either via a `compose.override.yml` (not committed, gitignored) or a Compose `profiles: [dev]` block — planner picks which keeps the contract cleanest. Production image is always the multi-stage build.
- **D-A4:** Phase 2 publishes the router on **`127.0.0.1:3000:3000`** (localhost-only, off-LAN). Ollama's host port from Phase 1 (`127.0.0.1:11434:11434`) is removed in the same phase — the router becomes the only externally-reachable surface. Phase 6 (Traefik) removes the router's host port too.

### Upstream call pattern to Ollama
- **D-B1:** Router talks to Ollama through the **`openai` Node SDK** (v6.x) pointed at Ollama's OpenAI-compat endpoint:
  ```ts
  new OpenAI({ baseURL: 'http://ollama:11434/v1', apiKey: 'ollama' })
  ```
  `apiKey` is a non-empty placeholder (the SDK requires one; local Ollama ignores it). Same SDK pattern reused in Phase 7 (vLLM) and Phase 8 (Ollama Cloud). Phase 4 will introduce a parallel **native `/api/chat`** client specifically for Ollama vision per PITFALLS Pitfall 8 (the OpenAI-compat shim doesn't carry vision payloads correctly).
- **D-B2:** **`BackendAdapter` interface** defined from day one, even though Phase 2 only ships one impl:
  ```ts
  interface BackendAdapter {
    chatCompletionsStream(req, signal: AbortSignal): AsyncIterable<ChatCompletionChunk>;
    chatCompletions(req, signal: AbortSignal): Promise<ChatCompletion>;
  }
  ```
  Phase 2 ships `OllamaOpenAIAdapter`. Phase 3 adds `LlamacppOpenAIAdapter`. Phase 8 adds `OllamaCloudAdapter`. The seam exists so Phase 3 SC1 ("switching model in body changes which backend serves, no router code change") is achievable without a Phase 3 refactor.
- **D-B3:** **Usage tokens** are passed through from Ollama, not synthesized router-side. Set `stream_options.include_usage: true` on every upstream OpenAI-compat call; re-emit `prompt_tokens`/`completion_tokens`/`total_tokens` in the final SSE chunk (and in the non-stream response body). Satisfies OAI-05 and Success Criterion 1. Phase 4 revisits usage handling for Anthropic `message_start` (input tokens) vs `message_delta` (output tokens) splitting.
- **D-B4:** **`models.yaml` schema is forward-compatible.** Zod schema accepts the optional fields that Phase 3+ need (`capabilities`, `vram_budget_gb`, `concurrency`, `max_model_len`, `profile`) but Phase 2 reads only `name`, `backend`, `backend_url`, `backend_model`. No YAML rewrites between phases — each phase tightens validation and starts consuming new fields.

### Error envelope & failure-mode semantics
- **D-C1:** **Per-route error envelopes that match the route's protocol.** Phase 2's `/v1/chat/completions` and `/healthz` emit the OpenAI shape:
  ```json
  { "error": { "message": "...", "type": "...", "code": "...", "param": null } }
  ```
  Phase 4's `/v1/messages` will emit the Anthropic shape. No cross-protocol translation; each surface matches what its SDK consumers parse natively.
- **D-C2:** **Mid-stream error frame.** Once SSE has begun and the HTTP response is already `200 OK`, an upstream/router failure emits:
  ```
  event: error
  data: {"error":{"message":"...","type":"...","code":"..."}}

  data: [DONE]

  ```
  Then `reply.raw.end()`. Compatible with the OpenAI SDK's stream-error semantics.
- **D-C3:** **Locked HTTP status / log map:**

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

- **D-C4:** **Abort propagation contract:**
  ```ts
  const controller = new AbortController();
  req.raw.on('close', () => controller.abort(new Error('client-disconnect')));
  ```
  The `controller.signal` is passed to the `openai` SDK's `chat.completions.create({ ..., signal })`. SDK forwards to undici, which closes the upstream TCP connection. Per PITFALLS Pitfall 13 + ROUTE-08, this is the load-bearing pattern.
  **Heartbeat cleanup:** the 15s SSE heartbeat is started after the first byte is written and **MUST be cleared** in the same `close` handler (and on normal stream completion). Forgetting this keeps the response alive after client disconnect and silently fails SC3.

### Claude's Discretion
- Exact pino logger config (timestamp shape, base fields, transport in dev) — keep readable, follow Fastify v5 conventions (pass options, not an instance).
- Whether to use `@bram-dc/fastify-type-provider-zod` (the Fastify-5 fork per CLAUDE.md) or hand-rolled zod parsers — CLAUDE.md endorses the fork; planner picks.
- Fastify route file layout (`src/routes/v1/chat-completions.ts` vs `src/api/openai/chat.ts`) — pick one and apply consistently.
- `fs.watch` debounce window (suggest 200–500 ms) and atomic-swap implementation detail.
- Upstream request timeout default — suggest 60s for streaming connect, no read timeout for the streaming body itself (it would kill long generations). Planner picks specifics.
- ESLint vs Biome — CLAUDE.md lists both; pick one (recommend Biome for speed) and document.
- `vitest` + `msw` config files, test directory layout.
- `bin/smoke-test-router.sh` log format details (color, sections) — match `bin/smoke-test-gpu.sh` conventions.
- README updates to document the new "verify the router works" step.
- Whether to ship a `Makefile` / `justfile` / `bin/up.sh` wrapper for ergonomics — not required.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase context (this directory)
- `.planning/phases/02-mvp-vertical-slice-router-ollama-sse/02-CONTEXT.md` — this file (locked decisions D-A1..D-D4)
- `.planning/phases/02-mvp-vertical-slice-router-ollama-sse/02-DISCUSSION-LOG.md` — full discussion audit trail (humans only; not consumed by agents)
- `.planning/phases/01-gpu-compose-foundation/01-CONTEXT.md` — Phase 1 locked decisions (D-01..D-14): host paths, `x-gpu` anchor, four networks, `.env` contract, preflight gates

### Project-level
- `.planning/PROJECT.md` — Core Value, Constraints, Key Decisions, Out-of-Scope
- `.planning/REQUIREMENTS.md` — v1 requirement IDs (this phase covers ROUTE-01, ROUTE-02, ROUTE-03, ROUTE-04, ROUTE-05, ROUTE-08, OAI-01, OAI-04, OAI-05)
- `.planning/ROADMAP.md` §"Phase 2: MVP Vertical Slice — Router + Ollama + SSE" — Goal + 5 Success Criteria (the verification anchor)
- `.planning/STATE.md` — accumulated context, standing anti-patterns to reject (especially: no `:latest`, no `node:22-alpine`, no compress middleware on SSE routes, no public-internet exposure)
- `CLAUDE.md` — full stack spec including the multi-stage Dockerfile pattern (D-A2), Fastify SSE plumbing notes, version pins

### Research (READ BEFORE PLANNING)
- `.planning/research/SUMMARY.md` §"Phase 2: Vertical-slice MVP — Ollama + Fastify router with SSE" — phase rationale + MVP definition (lift verbatim into the plan)
- `.planning/research/STACK.md` §"Core Technologies — Router (Node + Fastify + TypeScript)" — version pins (Fastify 5.8.5, openai 6.30.0, zod 4.x, fastify-sse-v2 4.2.1, @bram-dc/fastify-type-provider-zod 7.0.1)
- `.planning/research/STACK.md` §"Streaming gotchas — Fastify + SSE" — backpressure, heartbeat, abort patterns
- `.planning/research/STACK.md` §"Multi-stage Dockerfile pattern — router" — canonical Dockerfile shape (D-A2)
- `.planning/research/PITFALLS.md` Pitfall 4 — SSE buffering (anti-pattern to reject: `compress` middleware on streaming routes)
- `.planning/research/PITFALLS.md` Pitfall 8 — Ollama vision via OpenAI-compat shim (background for the deferred native `/api/chat` client in Phase 4)
- `.planning/research/PITFALLS.md` Pitfall 12 — bearer token in logs (motivation for D-C3 redaction; pino redact from first commit)
- `.planning/research/PITFALLS.md` Pitfall 13 — abort propagation (motivation for D-C4; load-bearing for SC3)
- `.planning/research/ARCHITECTURE.md` §"four networks (not one)" — router joins `app` + `backend` (Phase 2 wires router into the existing networks; Traefik + `edge` lands in Phase 6)
- `.planning/research/FEATURES.md` — OpenAI + Anthropic surface inventory (Phase 2 implements only the chat-completions subset)

### External docs (verify still current at planning time)
- Fastify v5 docs — `https://fastify.dev/docs/v5/`
- `fastify-sse-v2` docs — `https://github.com/mpetrunic/fastify-sse-v2` (the `reply.sse(asyncIterable)` API)
- `openai` Node SDK v6 streaming guide — `https://github.com/openai/openai-node` (`chat.completions.create({ stream: true })`, AbortSignal usage)
- Ollama OpenAI-compatibility docs — `https://docs.ollama.com/api/openai-compatibility` (verify `stream_options.include_usage` behavior)
- pino redact docs — `https://github.com/pinojs/pino/blob/main/docs/redaction.md`
- zod v4 docs — `https://zod.dev` (the `from 'zod/v4'` import path for Fastify type provider)

### Image / package pins relevant to this phase
- `node:22-bookworm-slim` (final stage of router Dockerfile, NOT `node:22-alpine` per STATE.md anti-pattern list)
- `fastify@^5.8.5`
- `openai@^6.30.0`
- `zod@^4.x`
- `fastify-sse-v2@^4.2.1`
- `@bram-dc/fastify-type-provider-zod@^7.0.1` (the Fastify-5 fork — NOT `turkerdev/fastify-type-provider-zod` which targets v4)
- `pino` (transitive via Fastify v5 — at v9)
- Dev: `tsx`, `tsup`, `vitest`, `msw`, `pino-pretty` (dev-only), Biome or ESLint (Claude's discretion)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`bin/smoke-test-gpu.sh`** — Phase 1's GPU smoke test. The conventions (bash, sections, exit codes, `docker compose exec ollama nvidia-smi` parsing) are the model `bin/smoke-test-router.sh` follows. Reuse the `nvidia-smi` post-flight pattern for the SC3 abort assertion.
- **`bin/preflight-gpu.sh`** — Not directly reused by Phase 2 (router is not a GPU consumer) but the script style (`set -euo pipefail`, `--help`, `--quiet`, color-when-tty) is the project's bash convention.
- **`compose.yml`** — Router service appends here (single-file policy from D-12). Reuses the four declared networks (`backend`, `app`) without inventing new ones. Does NOT reference the `x-gpu` anchor (router has no GPU).
- **`.env` / `.env.example`** — `ROUTER_BEARER_TOKEN` slot is already declared (Phase 1, D-14). Phase 2 wires it through to Compose `environment:`. No new top-level env keys needed for Phase 2.
- **README.md** — Already documents the Phase 1 verify flow. Phase 2 appends a "Verify the router works" section pointing at `bin/smoke-test-router.sh`.

### Established Patterns
- **Pinned image tags everywhere** — `node:22-bookworm-slim` (or its `:bookworm-slim@sha256:...` digest pin at planner discretion); never `:latest`.
- **`bin/*.sh` are the canonical entrypoints** — preflight, smoke-test, bootstrap. Phase 2's smoke-test follows that convention.
- **`/srv/local-llms/` is the canonical data root** — Phase 2 does NOT add a router-data subdir (router is stateless until Phase 5 introduces Postgres).
- **Compose service ordering** — `depends_on: { gpu-preflight: { condition: service_completed_successfully } }` for GPU consumers (router is NOT one); `condition: service_healthy` on Ollama for the router. Mirrors the Phase 1 D-04 / D-05 dependency style.
- **No host ports except localhost-bound during MVP** — Ollama was `127.0.0.1:11434:11434`; router becomes `127.0.0.1:3000:3000`. Phase 6 (Traefik) removes both.

### Integration Points
- **`compose.yml`** — append `router:` service that:
  - builds from `./router`
  - joins `app` + `backend` networks (the only service so far that needs both)
  - publishes `127.0.0.1:3000:3000` (Phase 2 only)
  - mounts `./router/models.yaml:/app/models.yaml:ro` (registry path) — bind mount so `fs.watch` triggers on host edits
  - reads `ROUTER_BEARER_TOKEN` from `.env`
  - declares `depends_on: { ollama: { condition: service_healthy } }`
  - has a `/healthz`-based healthcheck (`curl -fsS http://localhost:3000/healthz`)
- **Same `compose.yml`** — REMOVE Ollama's `ports: ["127.0.0.1:11434:11434"]` (already flagged for removal in the existing comment).
- **`./router/`** — new top-level dir, all router code/config/test lives here.
- **`./bin/smoke-test-router.sh`** — new bash script invoking the router on its host port + asserting against Ollama via `docker compose exec`.
- **README** — append a "Phase 2: verify the router" section.

</code_context>

<specifics>
## Specific Ideas

- **Router service has a curl-based healthcheck** — the official Node images don't ship curl by default; either install it in the runtime stage (small) or use `node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1))"`. Planner picks; both are acceptable.
- **`stream_options.include_usage: true`** must be on every upstream OpenAI-compat call to satisfy OAI-05. Verify Ollama 0.5.7 honors this — if not, the planner needs to capture a `prompt_eval_count` / `eval_count` workaround (read Ollama's native fields off the final `done: true` event). Belt-and-suspenders pattern: parse both forms.
- **`models.yaml` first concrete entry (the one used by Phase 2 smoke test):** name = `llama3.2:3b-instruct-q4_K_M` (the model already pulled in Phase 1), `backend: ollama`, `backend_url: http://ollama:11434/v1`, `backend_model: llama3.2:3b-instruct-q4_K_M`, `capabilities: [chat]` (forward-compat, ignored by Phase 2).
- **Bearer token format** in `.env.example` already documented: `local-llms_<hex32>`. The leading prefix makes accidental log leaks searchable (Phase 1 D-14).
- **Mid-stream error SSE frame example:** `event: error\ndata: {"error":{"message":"upstream connection reset","type":"upstream_error","code":"econnreset"}}\n\ndata: [DONE]\n\n`. Document this in 02-PLAN.md so the planner gets the wire format byte-exact.
- **`fs.watch` debounce ≈ 250 ms.** Editors often write a YAML file twice (truncate → write); single `fs.watch` event would partial-parse. Atomic swap: parse-then-replace the registry reference under a mutex.

</specifics>

<deferred>
## Deferred Ideas

- **Native Ollama `/api/chat` client** — needed for Ollama vision per PITFALLS Pitfall 8. Lands in **Phase 4** alongside the Anthropic surface + vision support.
- **Anthropic-shape error envelope** — `{ "type": "error", "error": { "type", "message" } }`. Lands in **Phase 4** alongside `/v1/messages`.
- **`GET /v1/models`** capability listing + `/readyz` aggregator + per-backend liveness probes — **Phase 3** (multi-backend dispatch hardens the registry seam).
- **Per-backend concurrency caps + 429 / queue behavior** — **Phase 3** (ROUTE-07).
- **`request_log` Postgres writes + `/metrics`** — **Phase 5**.
- **`X-Agent-Id` request header surfaced into logs** — **Phase 5** (ROUTE-09).
- **`X-Model-Backend` response header** — **Phase 8** (ROUTE-10).
- **Compose `profiles: [ollama | llamacpp | vllm]`** — **Phase 3** (D-11 of Phase 1 deferred profiles to Phase 3).
- **Removing the router's host port and putting it behind Traefik** — **Phase 6**.
- **dockerized integration tests via `testcontainers`** — considered, not adopted for Phase 2. Revisit if mocking + bash smoke ever feels too gappy. Phase 5 (Postgres) is the natural moment to revisit because real-DB integration tests have higher ROI.
- **Hot-reload triggering an in-flight request retry / rejection policy** — Phase 2's hot-reload only affects *new* requests; in-flight requests keep the registry snapshot they were dispatched with. If we later want to drain or reject in-flight on registry change, that's a Phase 3+ refinement.

</deferred>

---

*Phase: 2-MVP Vertical Slice — Router + Ollama + SSE*
*Context gathered: 2026-05-12*
