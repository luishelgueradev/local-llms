---
phase: 16
slug: v1-responses-streaming-tool-calls
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-31
---

# Phase 16 — Validation Strategy

> Per-phase validation contract for `/v1/responses` streaming + tool calls.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `vitest@^4.1.6` (already installed) |
| **Config file** | `router/vitest.config.ts` (existing — unit + integration projects) |
| **Quick run command** | `cd router && npx vitest run tests/translation/responses-stream.test.ts` |
| **Full suite command** | `cd router && npm test && npm run typecheck` |
| **Estimated runtime** | ~3s (unit translator) / ~15s (full suite + integration) |

---

## Sampling Rate

- **Per task commit:** `cd router && npx vitest run tests/translation/responses-stream.test.ts` (~2s)
- **Per wave merge:** `cd router && npx vitest run tests/translation/responses-stream* tests/routes/responses-stream* tests/routes/responses.test.ts` + replay Phase 14/15 integration suites
- **Phase gate:** Full `npm test` + `npm run typecheck` green + `bin/smoke-test-router.sh` new RESS section PASS before `/gsd:verify-work`
- **Max feedback latency:** 30 s

---

## Per-Requirement Verification Map

| Req ID | Behavior | Test Type | Automated Command | File Exists | Status |
|--------|----------|-----------|-------------------|-------------|--------|
| RESS-01 | Streaming `/v1/responses` emits 9 canonical text events in order | unit (translator) + integration (route) | `npx vitest run tests/translation/responses-stream.test.ts -t "text-only sequence"` + `npx vitest run tests/routes/responses-stream.test.ts -t "RESS-01"` | ❌ W0 | ⬜ pending |
| RESS-02 | `sequence_number` monotonic + `response.completed` is last event | unit + integration | `npx vitest run tests/translation/responses-stream.test.ts -t "sequence number invariant"` | ❌ W0 | ⬜ pending |
| RESS-03 | Tool-call stream emits `function_call_arguments.delta` + `done` + `response.completed.status='incomplete'` + `incomplete_details.reason='tool_calls'` | unit + integration | `npx vitest run tests/translation/responses-stream.test.ts -t "tool-call"` + `tests/routes/responses-stream.test.ts -t "RESS-03"` | ❌ W0 | ⬜ pending |
| RESS-04 | Golden fixtures parseable via openai@6.x SDK's `ResponseStream` consumer | unit (golden) | `npx vitest run tests/translation/golden/responses-stream/*` | ❌ W0 | ⬜ pending |
| RESS-05 | Reuse path: fastify-sse-v2, heartbeats, abort, idempotency, X-Cost-Cents on header | integration | `npx vitest run tests/routes/responses-stream.test.ts -t "RESS-05"` | ❌ W0 | ⬜ pending |
| P9-02 (non-stream regression) | Existing v0.10.0 non-streaming `/v1/responses` body byte-identical | golden | extend `tests/routes/responses.test.ts -t "SDK-compat regression"` with snapshot | ✅ existing | ⬜ pending |
| P3-03 (last-event invariant) | Last non-comment SSE event is `response.completed` (success) or `response.failed` (error) | integration | `npx vitest run tests/routes/responses-stream.test.ts -t "response.completed always last"` | ❌ W0 | ⬜ pending |
| P3-04 (heartbeat is comment) | grep gate: no `data:.*heartbeat` in src | smoke + lint | `! grep -rE 'reply\.raw\.write.*heartbeat' router/src/` + smoke section | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `router/tests/translation/responses-stream.test.ts` — unit tests for `OutputItemStateMachine` + `canonicalToResponsesSse` translator (~25 cases per RESEARCH §"Recommended Test Matrix")
- [ ] `router/tests/translation/golden/responses-stream/01-simple-text.json`
- [ ] `router/tests/translation/golden/responses-stream/02-tool-call.json`
- [ ] `router/tests/translation/golden/responses-stream/03-text-then-tool.json`
- [ ] `router/tests/translation/golden/responses-stream/04-multi-delta-text.json`
- [ ] `router/tests/translation/golden/responses-stream/05-failed-mid-stream.json`
- [ ] `router/tests/translation/golden/responses-stream/06-aborted-mid-stream.json`
- [ ] `router/tests/routes/responses-stream.test.ts` — RESS-01..05 + idempotency leader/follower
- [ ] `router/tests/routes/golden/responses-nonstream-v0.10.0.json` — P9-02 regression fixture
- [ ] `bin/smoke-test-router.sh` — new RESS section (initialize → stream → assert `response.completed` last event)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| n8n consumes `/v1/responses` streaming end-to-end | RESS-01..05 | Requires running n8n with the new Responses node | After Phase 16 merge: in n8n, add Responses node with stream=true; confirm text + tool_calls surface correctly. |

---

## Validation Sign-Off

- [ ] All RESS-01..05 + P3-03 + P3-04 + P9-02 covered by automated tests
- [ ] All 6 golden fixtures landed
- [ ] No watch-mode flags in CI
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set after Wave 0 ships

**Approval:** pending
