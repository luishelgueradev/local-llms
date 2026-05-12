# Phase 2: MVP Vertical Slice — Router + Ollama + SSE - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in 02-CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-12
**Phase:** 02-mvp-vertical-slice-router-ollama-sse
**Areas discussed:** Project layout & build pipeline, Upstream call pattern to Ollama, Error envelope & failure-mode semantics, Test boundary for Phase 2

---

## Project layout & build pipeline

### Q1 — Where does the router code live?

| Option | Description | Selected |
|---|---|---|
| `router/` subdirectory (Recommended) | Top-level `router/` with its own package.json, tsconfig, src/, Dockerfile. Compose builds from `./router`. Mirrors CLAUDE.md multi-stage Dockerfile. Natural monorepo for future siblings. | ✓ |
| Top-level (no subdir) | package.json + src/ + Dockerfile at repo root. Simpler now; awkward when v2 adds another project. | |
| `services/router/` | Same as `router/` but under `services/`. Forward-looking but extra nesting for one service. | |

**User's choice:** `router/` subdirectory.

### Q2 — Docker build pipeline?

| Option | Description | Selected |
|---|---|---|
| Multi-stage: deps → build → prod-deps → runtime (Recommended) | CLAUDE.md pattern; tsup build; final image `node:22-bookworm-slim`. Smallest image, fast cold start. | ✓ |
| Single-stage, build outside container | Build dist/ on host/CI, COPY into image. Worse reproducibility. | |
| Single-stage build+run | tsx watch at runtime in one image. Ships dev deps in prod. | |

**User's choice:** Multi-stage.

### Q3 — Dev workflow?

| Option | Description | Selected |
|---|---|---|
| tsx watch + bind-mounted src/ (Recommended) | Compose dev profile bind-mounts `./router/src`, `tsx watch src/index.ts`. Prod is multi-stage build. | ✓ |
| Rebuild image on every change | No bind mount; `docker compose build && up -d` each change. Painful loop. | |
| Run router on host (no container) | npm run dev on host. Dev-prod gap bites. | |
| You decide | — | |

**User's choice:** tsx watch + bind-mounted src/.

### Q4 — Phase 2 host port?

| Option | Description | Selected |
|---|---|---|
| Yes — bind `127.0.0.1:3000:3000` (Recommended) | Mirrors Phase 1 Ollama pattern. Off-LAN. Drop Ollama's host port; Phase 6 removes router's. | ✓ |
| No — `app` + `backend` networks only | Curl via sidecar container. More authentic but high friction. | |
| Both — keep Ollama's port too | Two surfaces published; easy to forget removal. | |

**User's choice:** Bind `127.0.0.1:3000:3000`; remove Ollama's `127.0.0.1:11434:11434`.

**Notes:** Compose comment in Phase 1 already pre-flagged dropping Ollama's port. Cleanup happens in Phase 2.

---

## Upstream call pattern to Ollama

### Q1 — Client pattern to Ollama?

| Option | Description | Selected |
|---|---|---|
| openai Node SDK pointed at Ollama /v1 (Recommended) | `new OpenAI({ baseURL: 'http://ollama:11434/v1', ... })`. Typed Stream events. Reused for vLLM (P7) + Cloud (P8). | ✓ |
| Native Ollama /api/chat | Ollama-shape JSON in and out; we translate. More control; needed for vision (P4). | |
| Hand-rolled fetch + undici | Zero SDK deps. Most work. | |
| openai SDK now + native client added in P4 | Pragmatic split; not what's asked of Phase 2. | |

**User's choice:** openai Node SDK pointed at Ollama `/v1`.

**Notes:** Phase 4 will add a parallel native `/api/chat` client specifically for Ollama vision per PITFALLS Pitfall 8.

### Q2 — Registry-to-backend dispatch shape?

| Option | Description | Selected |
|---|---|---|
| BackendAdapter interface from day one (Recommended) | One impl now (OllamaOpenAIAdapter); Phase 3 + Phase 8 plug in cleanly. Phase 3 SC1 enforced. | ✓ |
| Inline call now, refactor in Phase 3 | Risk: Phase 3 spends time on the refactor. | |
| You decide | — | |

**User's choice:** BackendAdapter from day one.

### Q3 — Usage tokens in stream responses?

| Option | Description | Selected |
|---|---|---|
| Pass through Ollama's usage in final chunk (Recommended) | `stream_options.include_usage: true`; satisfies OAI-05. No router-side tokenization. | ✓ |
| Always synthesize router-side | Tokenizer lib; doesn't match upstream's real cost. | |
| Best-effort: pass if present, else zero | Leaves OAI-05 partially failing. | |

**User's choice:** Pass through; do not synthesize.

### Q4 — `models.yaml` schema forward-compatibility?

| Option | Description | Selected |
|---|---|---|
| Forward-compatible schema, Phase 2 ignores unused fields (Recommended) | Optional fields accepted now; Phase 3+ tighten validation. Avoids YAML rewrites. | ✓ |
| Minimal now, expand per phase | Each phase migrates entries; clean but YAML rewrites. | |
| Full P3+ schema accepted now, enforced when phase lands | Slight risk of premature schema; zod tweak is cheap. | |

**User's choice:** Forward-compatible schema.

---

## Error envelope & failure-mode semantics

### Q1 — Error JSON shape in Phase 2?

| Option | Description | Selected |
|---|---|---|
| OpenAI-shape only; P4 adds Anthropic shape on its route (Recommended) | Per-route envelopes match the route's protocol. SDKs parse natively. | ✓ |
| Canonical internal error + per-route serializer | More upfront design; Phase 4 win. | |
| Identical shape everywhere | Anthropic SDKs won't parse. | |

**User's choice:** OpenAI-shape only in Phase 2; Anthropic shape lands in Phase 4.

### Q2 — Mid-stream error wire shape?

| Option | Description | Selected |
|---|---|---|
| `event: error` SSE frame + `data: [DONE]` + end stream (Recommended) | Compatible with OpenAI SDK stream-error semantics. | ✓ |
| Abruptly close response | Truncation w/o reason. | |
| Send error as a regular `data:` delta | Looks like a normal chunk; bad for parsers. | |

**User's choice:** SSE `event: error` then `[DONE]`.

### Q3 — Status map + per-case logging?

| Option | Description | Selected |
|---|---|---|
| Status map locked + per-case pino log line (Recommended) | 401/400/404/502/504 split; pino warn for client errors, error for upstream. Hot-reload validation = keep old. | ✓ |
| Fastify default + 5xx everything | Conflates auth-fail with upstream-down. | |
| You decide | — | |

**User's choice:** Status map locked (see 02-CONTEXT.md D-C3 table for full map).

### Q4 — Abort propagation wiring?

| Option | Description | Selected |
|---|---|---|
| `req.raw.on('close')` triggers `controller.abort()` with typed reason (Recommended) | PITFALLS Pitfall 13 pattern; signal passed to openai SDK → undici closes upstream TCP. | ✓ |
| Rely on undici keep-alive + GC | Hung GPU; fails SC3. | |
| Recommended + explicit heartbeat-timer clear on close | Same as recommended in behavior; explicit cleanup noted. | |

**User's choice:** `req.raw.on('close')` triggers abort, AND the SSE 15s heartbeat timer is explicitly cleared in the close handler (flagged so the planner doesn't miss it).

---

## Test boundary for Phase 2

### Q1 — Test surfaces?

| Option | Description | Selected |
|---|---|---|
| Both: vitest in router/ + bin/smoke-test-router.sh (Recommended) | vitest covers zod, hot-reload, auth, abort wiring, error serialization with msw. Bash covers real-Ollama abort + redaction grep. | ✓ |
| vitest only | Loses real-Ollama abort SC. | |
| Bash only | No unit coverage on hot-reload + zod + redaction. | |
| vitest + testcontainers | Heavyweight; overkill for Phase 2. | |

**User's choice:** Both — vitest + bash.

### Q2 — How is redaction (SC5) verified?

| Option | Description | Selected |
|---|---|---|
| vitest unit test + bash post-flight grep (Recommended) | Two layers: unit catches per-commit, bash satisfies the literal SC5. | ✓ |
| Bash grep only | Slow regression detection. | |
| vitest only | Doesn't satisfy literal SC5 (`docker compose logs router | grep ...`). | |

**User's choice:** Both vitest + bash.

### Q3 — How is abort propagation (SC3) verified?

| Option | Description | Selected |
|---|---|---|
| Bash smoke against real Ollama + `nvidia-smi` (Recommended) | curl --max-time 2; wait; assert no active generation. Reuses Phase 1 nvidia-smi patterns. | ✓ |
| vitest with msw + spy on AbortSignal | Doesn't prove actual upstream stopped. | |
| Both | Vitest catches regressions early; bash catches end-to-end behavior. | |

**User's choice:** Bash smoke + nvidia-smi (vitest still tests the router-side abort plumbing per Q1).

### Q4 — Smoke-test script location?

| Option | Description | Selected |
|---|---|---|
| `bin/smoke-test-router.sh`, run after `compose up` (Recommended) | Mirrors `bin/smoke-test-gpu.sh` conventions; documented in README. | ✓ |
| `router/test/e2e/*.sh` via package.json script | Couples to Node tooling; breaks bin/ convention. | |
| `router/scripts/smoke.sh` + bin/ wrapper | Extra indirection. | |

**User's choice:** `bin/smoke-test-router.sh`.

---

## Claude's Discretion

User explicitly accepted the recommended option in every question, plus delegated these specifics to Claude / the planner:

- Pino logger config details (timestamp shape, base fields, transport in dev).
- Whether to use `@bram-dc/fastify-type-provider-zod` vs hand-rolled zod parsers (recommend the fork per CLAUDE.md).
- Fastify route file layout (`src/routes/v1/chat-completions.ts` vs `src/api/openai/chat.ts`).
- `fs.watch` debounce window (suggest 200–500 ms) and atomic-swap details.
- Upstream request timeout default (suggest 60s connect; no read timeout on the streaming body).
- ESLint vs Biome (CLAUDE.md lists both; recommend Biome for speed).
- vitest + msw config files, test directory layout.
- `bin/smoke-test-router.sh` log format / color / sections (match `bin/smoke-test-gpu.sh`).
- README updates for the new "verify the router" step.
- Whether to ship a `Makefile` / `justfile` / `bin/up.sh` wrapper.

## Deferred Ideas

- **Native Ollama `/api/chat` client** → Phase 4 (Ollama vision, per PITFALLS Pitfall 8).
- **Anthropic-shape error envelope** → Phase 4 (`/v1/messages`).
- **`GET /v1/models`, `/readyz`, per-backend probes** → Phase 3.
- **Per-backend concurrency caps + 429/queue** → Phase 3 (ROUTE-07).
- **Postgres `request_log` + `/metrics`** → Phase 5.
- **`X-Agent-Id` log surfacing** → Phase 5 (ROUTE-09).
- **`X-Model-Backend` response header** → Phase 8 (ROUTE-10).
- **Compose `profiles: [ollama | llamacpp | vllm]`** → Phase 3.
- **Removing router's host port behind Traefik** → Phase 6.
- **Dockerized integration tests via `testcontainers`** → revisit at Phase 5 (Postgres) where real-DB integration has higher ROI.
- **Hot-reload-triggered in-flight request retry/rejection policy** → Phase 3+ refinement.
