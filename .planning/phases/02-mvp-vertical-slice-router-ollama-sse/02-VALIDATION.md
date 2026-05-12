---
phase: 02
slug: mvp-vertical-slice-router-ollama-sse
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-12
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Detailed framework + per-requirement test map lives in `02-RESEARCH.md` §Validation Architecture (verified live against Ollama 0.5.7 on 2026-05-12). This file is the executor-facing contract; the planner extends `## Per-Task Verification Map` once tasks are minted.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `vitest@^2.14.6` (pinned via `router/package.json`) |
| **Mock library** | `msw@^2.14.6` (upstream Ollama HTTP stubs) |
| **Config file** | `router/vitest.config.ts` (Wave 0 — does not exist yet) |
| **Quick run command** | `cd router && npm run test:unit` |
| **Full suite command** | `cd router && npm test` |
| **End-to-end (real Ollama, real GPU)** | `bash bin/smoke-test-router.sh` |
| **Estimated runtime — quick** | < 5 s |
| **Estimated runtime — full vitest** | < 30 s (no Docker) |
| **Estimated runtime — bash smoke** | < 30 s including SC3 abort assertion (≈2 s wait) |

---

## Sampling Rate

- **After every task commit:** Run `cd router && npm run test:unit` (vitest unit only — sub-5s targeting files in the commit).
- **After every plan wave:** Run `cd router && npm test` (full vitest suite) AND `bash bin/smoke-test-router.sh` (real Ollama, real GPU).
- **Before `/gsd-verify-work`:** Both commands above must be green PLUS a manual `curl -N` from a different shell, killed mid-stream, with `nvidia-smi --loop-ms=500` observed for ~3 s — eyes-on confirmation that SC3 actually drops GPU util.
- **Max feedback latency:** 5 seconds for unit; 30 seconds for full suite + smoke.

---

## Per-Task Verification Map

> Populated by the planner once tasks are minted. The mapping below is the requirement→test backbone (from `02-RESEARCH.md` §Validation Architecture); the planner annotates each task with the right cell.

| Req / SC | Test type | Automated command | File exists |
|---------|-----------|-------------------|-------------|
| **SC1** stream chat with usage in final chunk | bash smoke + integration | `bash bin/smoke-test-router.sh` and `cd router && npx vitest run tests/integration/chat-completions.stream.test.ts -t 'forwards each upstream chunk verbatim'` | ❌ W0 |
| **SC2** non-stream chat with usage | integration + bash smoke | `cd router && npx vitest run tests/integration/chat-completions.nonstream.test.ts` and `bash bin/smoke-test-router.sh` | ❌ W0 |
| **SC3** mid-stream abort returns GPU to idle ~1 s | bash smoke + integration | `bash bin/smoke-test-router.sh` (kill-mid-stream + `/api/ps` poll) and `cd router && npx vitest run tests/integration/chat-completions.stream.test.ts -t 'aborts upstream on client disconnect'` | ❌ W0 |
| **SC4** registry zod-validated, hot-reload, /healthz unauth, model endpoints required | unit + integration | `cd router && npx vitest run tests/unit/registry.test.ts tests/integration/auth.test.ts tests/integration/hotreload.test.ts` | ❌ W0 |
| **SC5** zero `bearer\|authorization` matches in container logs | bash smoke (final assertion) | `docker compose logs router 2>&1 \| grep -ciE 'bearer [a-z0-9_]+\|authorization:[[:space:]]*bearer'` returns `0` | ❌ W0 |
| **ROUTE-01** Fastify v5 on Node 22 LTS in Compose | bash smoke pre-flight | `docker compose ps router` healthy + `node --version` returns v22.x | ❌ W0 |
| **ROUTE-02** zod-validated registry + hot-reload | unit + integration | `cd router && npx vitest run tests/unit/registry.test.ts tests/integration/hotreload.test.ts` | ❌ W0 |
| **ROUTE-03** constant-time bearer compare | unit | `cd router && npx vitest run tests/unit/bearer.test.ts` | ❌ W0 |
| **ROUTE-04** /healthz unauthenticated, model endpoints required | integration | `cd router && npx vitest run tests/integration/auth.test.ts` | ❌ W0 |
| **ROUTE-05** pino redact authorization/cookie/*.apiKey | unit + bash smoke | `cd router && npx vitest run tests/unit/log/redact.test.ts` + bash smoke SC5 assertion | ❌ W0 |
| **ROUTE-08** 15 s heartbeat, backpressure, abort | unit + integration | `cd router && npx vitest run tests/unit/sse/heartbeat.test.ts tests/unit/sse/backpressure.test.ts` (abort coverage via SC3) | ❌ W0 |
| **OAI-01** chat completions stream + non-stream | covered by SC1 + SC2 | as above | ❌ W0 |
| **OAI-04** OpenAI delta wire format | integration (snapshot) | `cd router && npx vitest run tests/integration/chat-completions.stream.test.ts -t 'wire format snapshot'` | ❌ W0 |
| **OAI-05** token usage in non-stream + final SSE chunk | covered by SC1 + SC2 | as above | ❌ W0 |

*Status legend: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky · `W0` = file does not exist yet, created in Wave 0*

---

## Wave 0 Requirements

The router project doesn't exist yet — Wave 0 (project scaffold) creates everything below.

- [ ] `router/package.json` — install block from RESEARCH.md §Standard Stack
- [ ] `router/tsconfig.json` — `target: es2023`, `module: nodenext`, `strict: true`, `verbatimModuleSyntax: true`
- [ ] `router/vitest.config.ts` — `test: { include: ['tests/**/*.test.ts'], environment: 'node' }`
- [ ] `router/biome.json` (or `eslint.config.js`) — flat config (planner picks; CLAUDE.md endorses Biome)
- [ ] `router/tsup.config.ts` — `{ entry: ['src/index.ts'], format: 'esm', target: 'node22', clean: true, sourcemap: true }`
- [ ] `router/tests/msw/handlers.ts` — msw v2 handlers emitting OpenAI-shape SSE chunks identical to live Ollama (use the chunk shape verified in 02-RESEARCH.md)
- [ ] `router/tests/setup.ts` — vitest `beforeAll`/`afterAll` to start/stop msw server
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
- [ ] `bin/smoke-test-router.sh` — bash script anchoring SC1, SC2, SC3, SC5 against real Ollama. Mirror `bin/smoke-test-gpu.sh` style (`set -uo pipefail`, FAILURES counter, sectioned output, exit 0/1).

*This is the first phase that introduces the router codebase — there is no pre-existing test infrastructure to extend.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Visual confirmation that GPU drops to idle within ~1 s after killing a streaming request | SC3 | bash smoke checks `/api/ps` `expires_at` countdown — but the *user-perceived* "GPU stops doing work" is best confirmed by `nvidia-smi --loop-ms=500` watching utilization fall | 1. Start `nvidia-smi --loop-ms=500` in shell A. 2. In shell B: `curl -N -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/chat/completions -d '{"model":"llama3.2:3b-instruct-q4_K_M","messages":[{"role":"user","content":"write a long essay about cats"}],"stream":true}'`. 3. Wait 2 s, Ctrl-C. 4. Watch GPU util drop in shell A within ~1 s. |
| `models.yaml` hot-reload visibly works on the host | SC4 | bash smoke writes-then-reads via the API, but the operator should also see the registry update without restart from a normal editor save | 1. Edit `router/models.yaml` (e.g., add a comment). 2. Save. 3. `docker compose logs --tail 20 router` should show `registry reloaded` (or equivalent log line) within 500 ms. 4. `curl http://localhost:3000/healthz` continues to return 200 throughout. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references in the per-task map
- [ ] No watch-mode flags (`vitest --watch` forbidden in CI/verify paths)
- [ ] Feedback latency < 30 s (full suite + bash smoke)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
