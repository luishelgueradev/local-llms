---
phase: 4
slug: anthropic-surface-v1-messages-tool-calling-vision
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-13
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 1.x (existing in `router/`) |
| **Config file** | `router/vitest.config.ts` |
| **Quick run command** | `cd router && pnpm test --run --reporter=basic translation/` |
| **Full suite command** | `cd router && pnpm test --run` |
| **Estimated runtime** | ~25 seconds full suite (Phase 2 baseline ~12 s; Phase 4 adds ~12 s for translation + messages routes) |

---

## Sampling Rate

- **After every task commit:** Run quick run command for the touched translator (`translation/openai-in.test.ts`, `translation/anthropic-in.test.ts`, etc.) or the touched route (`integration/messages.nonstream.test.ts`).
- **After every plan wave:** Run full suite command.
- **Before `/gsd-verify-work`:** Full suite must be green; `bin/smoke-test-router.sh` Phase 4 section must pass against a running Ollama with `llama3.2:3b-instruct-q4_K_M` + `llama3.2-vision:11b-instruct-q4_K_M` pulled.
- **Max feedback latency:** ~3 seconds for the translator quick-run; ~25 seconds for the full suite.

---

## Per-Task Verification Map

> Populated by the planner per-plan. One row per task. `Test Type` ∈ {unit, integration, golden, smoke, manual}. `File Exists` is ✅ when the test target lives in the repo at planning time, ❌ W0 when Wave 0 must scaffold it.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 4-01-01 | 01 | 1 | — | — | — | unit | `cd router && pnpm test --run translation/` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Phase 4 introduces an entirely new `router/src/translation/` subsystem; Wave 0 scaffolds its test surface.

- [ ] `router/tests/translation/openai-in.test.ts` — stubs for ANTHR-04, ANTHR-08, TOOL-01..04 (OpenAI → canonical translation)
- [ ] `router/tests/translation/openai-out.test.ts` — stubs for canonical → OpenAI response + delta stream
- [ ] `router/tests/translation/anthropic-in.test.ts` — stubs for ANTHR-03, ANTHR-04, ANTHR-05, ANTHR-08, TOOL-01..04 (Anthropic → canonical translation; role-alternation refusal)
- [ ] `router/tests/translation/anthropic-out.test.ts` — stubs for ANTHR-01, ANTHR-06, ANTHR-07 (canonical → Anthropic Message + typed SSE event stream; `input_json_delta` shape; `output_tokens` location)
- [ ] `router/tests/translation/ollama-native-out.test.ts` — stubs for VISION-01, VISION-03 (canonical image blocks → native `/api/chat` shape with bare-base64 `images: [...]`)
- [ ] `router/tests/translation/golden/` — fixture directory tree (01-single-tool/, 02-parallel-tools/, 03-is-error-tool-result/, 04-tool-choice-required/, 05-tool-choice-specific/, 06-tool-choice-none/, 07-vision-base64/, 08-vision-url/, 09-disable-parallel-tool-use/) with input-openai.json / input-anthropic.json / canonical.json / output-openai.json / output-anthropic.json per scenario
- [ ] `router/tests/translation/golden.test.ts` — runner that iterates fixtures and asserts identity round-trips for TOOL-05
- [ ] `router/tests/integration/messages.nonstream.test.ts` — stubs for ANTHR-01..05, ANTHR-08, VISION-02 (route + zod + adapter wiring; capability gate; `anthropic-version` echo)
- [ ] `router/tests/integration/messages.stream.test.ts` — stubs for ANTHR-06, ANTHR-07, TOOL-01..04 (typed SSE event order; `input_json_delta` chunking; parallel `tool_use` round-trip; mid-stream `event: error` frame)
- [ ] `router/tests/integration/messages.count-tokens.test.ts` — stubs for ANTHR-02 (response shape; per-image overhead formula; URL-image fallback constant)

*Existing infrastructure (vitest, msw, undici-mocked Ollama from Phase 2/3) covers the runner. No new framework install required.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Vision happy-path with real `llama3.2-vision` model | VISION-01, VISION-03 | Requires a running Ollama with the 7.8 GB model pulled; CI hosts won't have GPU + 16 GB VRAM | `bin/smoke-test-router.sh` Phase 4 vision block — POST a base64 PNG + "what is in this image?" to `/v1/messages` against router→Ollama; expect a coherent text response within ~12 s. Verify `X-Token-Count-Method` header present. |
| Real-model end-of-stream `output_tokens` accuracy | ANTHR-07 | Requires a running model; mock can fake any number | Smoke test: stream `POST /v1/messages stream:true` with a 50-token prompt; tee SSE to file; assert the final `message_delta.usage.output_tokens` is within ±2 of `wc -w` on the assembled text. |
| Open WebUI compatibility against `/v1/messages` | (informational; Open WebUI uses `/v1/chat/completions`) | Open WebUI does not speak Anthropic protocol natively in v0.9 | Skip in Phase 4 (Phase 6 territory). Document the limitation in README. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify (translation tasks are unit-test-heavy, so this should hold naturally)
- [ ] Wave 0 covers all MISSING references (10 new test files + golden fixture tree)
- [ ] No watch-mode flags (always `--run` for CI determinism)
- [ ] Feedback latency < 30s (full suite measured)
- [ ] `nyquist_compliant: true` set in frontmatter (after planner fills the Per-Task Verification Map)

**Approval:** pending
