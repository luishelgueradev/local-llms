---
phase: 4
slug: anthropic-surface-v1-messages-tool-calling-vision
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-13
updated: 2026-05-13
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
| **Estimated runtime** | ~25 seconds full suite (Phase 2 baseline ~12 s; Phase 4 adds ~12 s for translation + messages routes + vision URL guard tests) |

---

## Sampling Rate

- **After every task commit:** Run quick run command for the touched translator (`translation/openai-in.test.ts`, `translation/anthropic-in.test.ts`, etc.) or the touched route (`integration/messages.nonstream.test.ts`).
- **After every plan wave:** Run full suite command.
- **Before `/gsd-verify-work`:** Full suite must be green; `bin/smoke-test-router.sh` Phase 4 section must pass against a running Ollama with `llama3.2:3b-instruct-q4_K_M` + `llama3.2-vision:11b-instruct-q4_K_M` pulled.
- **Max feedback latency:** ~3 seconds for the translator quick-run; ~25 seconds for the full suite.

---

## Per-Task Verification Map

> One row per task across the 5 plans (Tasks 3 in Plans 02 + 04 were split into 3a/3b; Plan 05 Task 4 is the human-verify checkpoint). `Test Type` ∈ {unit, integration, golden, smoke, manual}. `File Exists` is ✅ when the test target lives in the repo at planning time, ❌ W0 when Wave 0 (Plan 01) scaffolds it.

| Task ID | Plan | Wave | Requirement(s) | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|----------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 4-01-01 | 01 | 1 | (foundation — no requirement IDs) | T-04-A1, T-04-A2, T-04-A3 | Two-pass zod validation at canonical boundary | unit | `cd router && npm install && npx tsc --noEmit && npx vitest run tests/translation/canonical.test.ts --reporter=basic` | ❌ W0 | ⬜ pending |
| 4-01-02 | 01 | 1 | (foundation — no requirement IDs) | T-04-A1 | Translator owns ZodError → 400 mapping | unit | `cd router && npx tsc --noEmit && npx vitest run tests/translation/ --reporter=basic` | ❌ W0 | ⬜ pending |
| 4-01-03 | 01 | 1 | (foundation — no requirement IDs) | T-04-A1, T-04-A2 | Refactor preserves Phase 2/3 wire output | integration | `cd router && npx tsc --noEmit && npx vitest run tests/integration/chat-completions tests/translation/ --reporter=basic` | ✅ | ⬜ pending |
| 4-02-01 | 02 | 2 | ANTHR-02, ANTHR-03, ANTHR-04 | T-04-04, T-04-04b | gpt-tokenizer singleton; ZodError on role violations | unit | `cd router && npm install && npx tsc --noEmit && npx vitest run tests/translation/anthropic-in.test.ts tests/translation/anthropic-out.test.ts tests/translation/count-tokens.test.ts tests/unit/envelope.test.ts --reporter=basic` | ❌ W0 | ⬜ pending |
| 4-02-02 | 02 | 2 | ANTHR-02, ANTHR-03, ANTHR-04, ANTHR-05 | T-04-05, T-04-MV-1 | URL-prefix-routed envelope; anthropic-version sanitization; capability gate before semaphore | integration | `cd router && npx tsc --noEmit && npx vitest run tests/integration/chat-completions tests/translation/ --reporter=basic && grep -c "registerMessagesRoute\\|registerCountTokensRoute" router/src/app.ts` | ✅ | ⬜ pending |
| 4-02-03a | 02 | 2 | ANTHR-03, ANTHR-04, ANTHR-05 | T-04-05 | All errors on /v1/messages* return Anthropic envelope | integration | `cd router && npx vitest run tests/integration/messages.nonstream.test.ts --reporter=basic` | ❌ W0 | ⬜ pending |
| 4-02-03b | 02 | 2 | ANTHR-02 | T-04-04, T-04-04b | count_tokens does NOT acquire semaphore (D-F1) | integration | `cd router && npx vitest run tests/integration/messages.count-tokens.test.ts --reporter=basic` | ❌ W0 | ⬜ pending |
| 4-03-01 | 03 | 3 | ANTHR-01, ANTHR-06, ANTHR-07 | T-04-S1, T-04-S2 | canonicalToAnthropicSse never emits [DONE]; mid-stream error frame single-shot | unit | `cd router && npx tsc --noEmit && npx vitest run tests/translation/anthropic-out.test.ts tests/unit/sse/heartbeat.test.ts tests/unit/sse/heartbeat.anthropic.test.ts tests/unit/envelope.test.ts --reporter=basic` | ✅ (heartbeat.test.ts) / ❌ W0 (heartbeat.anthropic.test.ts) | ⬜ pending |
| 4-03-02 | 03 | 3 | ANTHR-01, ANTHR-07 | T-04-S1, T-04-S3 | inputTokensHint flows route → adapter → translator (NO route-level event mutation; Issue #6 resolution) | integration | `cd router && npx tsc --noEmit && npx vitest run tests/integration/messages.nonstream.test.ts --reporter=basic && test "$(grep -c 'rewriteInputTokens' router/src/routes/v1/messages.ts)" = "0"` | ✅ | ⬜ pending |
| 4-03-03 | 03 | 3 | ANTHR-01, ANTHR-06, ANTHR-07 | T-04-S1, T-04-S2 | Event order invariant + cumulative output_tokens on message_delta | integration | `cd router && npx vitest run tests/integration/messages.stream.test.ts tests/integration/messages.nonstream.test.ts tests/integration/chat-completions --reporter=basic` | ❌ W0 (messages.stream.test.ts) | ⬜ pending |
| 4-04-01 | 04 | 4 | TOOL-01, TOOL-02, TOOL-03, TOOL-04, ANTHR-08 | T-04-02, T-04-T1 | JSON.parse/stringify lives in translators; tool_choice native {type:'none'} + disable_parallel_tool_use modifier per FINDING 3.4 | unit | `cd router && npx tsc --noEmit && npx vitest run tests/translation/openai-in.test.ts tests/translation/openai-out.test.ts --reporter=basic` | ❌ W0 | ⬜ pending |
| 4-04-02 | 04 | 4 | TOOL-01, TOOL-02, TOOL-03, TOOL-04 | T-04-02, T-04-T1, T-04-T3 | Translator-option seam (displayModel/idOverride) replaces route-level canonical mutation; envelope.ts adds InvalidToolArgumentsError + InvalidImageUrlError + ImageFetchError (the latter two consumed by Plan 05) | unit + integration | `cd router && npx tsc --noEmit && npx vitest run tests/translation/anthropic-in.test.ts tests/translation/anthropic-out.test.ts tests/unit/envelope.test.ts tests/integration/messages.nonstream.test.ts tests/integration/chat-completions --reporter=basic && test "$(grep -RIn 'JSON.parse\\|JSON.stringify' router/src/backends/ \| grep -iE 'tool\|args' \| wc -l)" = "0" && test "$(grep -c 'canonicalResult\\.model = entry\\.name' router/src/routes/v1/messages.ts)" = "0"` | ✅ (extends Plan 02/03 files) | ⬜ pending |
| 4-04-03a | 04 | 4 | TOOL-01, TOOL-02, TOOL-03, TOOL-04, TOOL-05 | T-04-02, T-04-T1 | Golden fixtures prove canonical-shape round-trip identity (scenarios 01–05) | golden | `cd router && npx vitest run tests/translation/golden.test.ts -t "01 single tool\|01-single-tool\|02 parallel\|02-parallel\|03 is-error\|03-is-error\|04 tool-choice-required\|05 tool-choice-specific" --reporter=basic && test "$(ls router/tests/translation/golden/ \| grep -c '^0[1-5]-')" -ge "5"` | ❌ W0 (golden runner + fixtures) | ⬜ pending |
| 4-04-03b | 04 | 4 | ANTHR-08, TOOL-05 | T-04-02, T-04-T1 | Golden fixtures cover tool-choice-none / disable-parallel-tool-use / stop-sequences / malformed-tool-args (scenarios 06–09) | golden | `cd router && npx vitest run tests/translation/golden.test.ts --reporter=basic && test "$(ls router/tests/translation/golden/ \| grep -c '^0[6-9]-')" -ge "4" && test "$(ls router/tests/translation/golden/ \| grep -c '^[0-9][0-9]-')" -ge "9"` | (depends on 4-04-03a) | ⬜ pending |
| 4-05-01 | 05 | 4 | VISION-01, VISION-03 | T-04-01, T-04-V1, T-04-V2 | fetchImageAsBase64 enforces HTTPS-only + DNS deny-CIDR + 10s timeout + 10 MB cap + image/* content-type (locked D-C4) | unit | `cd router && npx tsc --noEmit && npx vitest run tests/translation/ollama-native-out.test.ts tests/unit/envelope.test.ts tests/unit/registry.test.ts tests/unit/registry.vram.test.ts --reporter=basic && grep -q "llama3.2-vision" router/models.yaml` | ❌ W0 | ⬜ pending |
| 4-05-02 | 05 | 4 | VISION-01, VISION-02, VISION-03 | T-04-01, T-04-V1, T-04-V2 | Capability gate fires before semaphore acquire; /api/chat dispatch (NOT /v1/chat/completions) for vision; URL guards return 400 with specific code | integration | `cd router && npx tsc --noEmit && npx vitest run tests/integration tests/translation --reporter=basic && grep -q "CapabilityNotSupportedError" router/src/routes/v1/messages.ts router/src/routes/v1/chat-completions.ts && grep -q "/api/chat" router/src/backends/ollama-openai.ts` | ✅ (extends Plan 02/03 files) | ⬜ pending |
| 4-05-03 | 05 | 4 | VISION-01 | (documentation) | README documents the four SSRF guards + deny-CIDR list verbatim | smoke (grep gate) | `grep -c "^# SC-P4-\\|^echo .*SC-P4" bin/smoke-test-router.sh && grep -q "llama3.2-vision" bin/smoke-test-router.sh README.md && grep -q "anthropic-version" README.md && grep -q "count_tokens" README.md && grep -q "Image input — URLs vs base64\\|Image input -- URLs vs base64" README.md` | ✅ (extends bin/smoke-test-router.sh + README.md) | ⬜ pending |
| 4-05-04 | 05 | 4 | VISION-01, VISION-02, VISION-03 | T-04-01 | Live GPU exercise of /api/chat dispatch + URL-fetch path against public HTTPS image + http://-scheme rejection in <50 ms | manual (checkpoint:human-verify) | `echo "checkpoint:human-verify — see <how-to-verify> for manual steps; no automated assertion at this step"` | manual | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Phase 4 introduces an entirely new `router/src/translation/` subsystem; Wave 0 (Plan 01) scaffolds its test surface. The golden fixture directory is reconciled to Plan 04's actual scenarios.

- [ ] `router/tests/translation/openai-in.test.ts` — stubs for ANTHR-04, ANTHR-08, TOOL-01..04 (OpenAI → canonical translation)
- [ ] `router/tests/translation/openai-out.test.ts` — stubs for canonical → OpenAI response + delta stream
- [ ] `router/tests/translation/anthropic-in.test.ts` — stubs for ANTHR-03, ANTHR-04, ANTHR-05, ANTHR-08, TOOL-01..04 (Anthropic → canonical translation; role-alternation refusal)
- [ ] `router/tests/translation/anthropic-out.test.ts` — stubs for ANTHR-01, ANTHR-06, ANTHR-07 (canonical → Anthropic Message + typed SSE event stream; `input_json_delta` shape; `output_tokens` location)
- [ ] `router/tests/translation/ollama-native-out.test.ts` — stubs for VISION-01, VISION-03 (canonical image blocks → native `/api/chat` shape with bare-base64 `images: [...]`; URL → fetchImageAsBase64 guard branches)
- [ ] `router/tests/translation/golden/` — fixture directory tree with these scenario dirs:
  - `01-single-tool/`
  - `02-parallel-tools/`
  - `03-is-error-tool-result/`
  - `04-tool-choice-required/`
  - `05-tool-choice-specific/`
  - `06-tool-choice-none/`
  - `07-disable-parallel-tool-use/`
  - `08-stop-sequences/`
  - `09-malformed-tool-args/`

  Each scenario has `input-openai.json`, `input-anthropic.json`, `canonical.json`, `output-openai.json`, `output-anthropic.json` (scenario 09 has only `input-openai.json` for the malformed-JSON error path).

  Scenarios formerly listed (`07-vision-base64/`, `08-vision-url/`) are REMOVED from the golden fixture tree — vision behavior is exercised via integration tests (`messages.{nonstream,stream}.test.ts`, `chat-completions.nonstream.test.ts`) and the live smoke test, NOT golden fixtures. The golden suite covers only the canonical-shape round-trip identity that defines TOOL-05.

  Scenarios listed in 04-RESEARCH.md `## Validation Architecture` as `11-system-field`, `13-role-alternation-error`, `15-multimodal-with-tools`, `tool-choice-auto` (default) are covered via unit + integration tests, not golden fixtures: `tests/translation/anthropic-in.test.ts` (role-alternation reject), `tests/translation/count-tokens.test.ts` (system-field tokenization), `tests/integration/messages.nonstream.test.ts` (multimodal-with-tools), and the implicit happy path of scenarios 01–02 (tool-choice-auto is the default). Golden fixtures intentionally cover canonical-shape round-trip identity only — TOOL-05 boundary.
- [ ] `router/tests/translation/golden.test.ts` — runner that iterates fixtures and asserts identity round-trips for TOOL-05 (Plan 04 Task 3a authors the runner; Plan 04 Task 3b populates scenarios 06–09).
- [ ] `router/tests/integration/messages.nonstream.test.ts` — stubs for ANTHR-01..05, ANTHR-08, VISION-02 (route + zod + adapter wiring; capability gate; `anthropic-version` echo; URL-fetch guard branches added in Plan 05)
- [ ] `router/tests/integration/messages.stream.test.ts` — stubs for ANTHR-06, ANTHR-07, TOOL-01..04 (typed SSE event order; `input_json_delta` chunking; parallel `tool_use` round-trip; mid-stream `event: error` frame; URL-fetch stream variant added in Plan 05)
- [ ] `router/tests/integration/messages.count-tokens.test.ts` — stubs for ANTHR-02 (response shape; per-image overhead formula; URL-image fallback constant)
- [ ] `router/tests/unit/sse/heartbeat.anthropic.test.ts` — stubs for the Anthropic ping heartbeat (the directory `router/tests/unit/sse/` already exists alongside `heartbeat.test.ts`; Plan 03 Task 1 populates).

*Existing infrastructure (vitest, msw, undici-mocked Ollama from Phase 2/3) covers the runner. No new framework install required.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Vision happy-path with real `llama3.2-vision` model | VISION-01, VISION-03 | Requires a running Ollama with the 7.8 GB model pulled; CI hosts won't have GPU + 16 GB VRAM | `bin/smoke-test-router.sh` SC-P4-D — POST a `source.type:'url'` pointing at a small stable HTTPS image (Ollama logo from raw.githubusercontent.com) to `/v1/messages` against router→Ollama; expect a coherent text response. Verify `X-Token-Count-Method` header present on SC-P4-C. |
| URL-fetch end-to-end behavior against a real public HTTPS image | VISION-01 | Requires outbound HTTPS network access from the router container | Step 6 of Plan 05 Task 4 human-verify. The MSW-stubbed integration tests cover the URL-fetch path with deterministic body bytes; this live check ensures the public-IP path works against a real CDN — automated via SC-P4-D in the smoke test (with skip semantics if network is unreachable). |
| Real-model end-of-stream `output_tokens` accuracy | ANTHR-07 | Requires a running model; mock can fake any number | Smoke test: stream `POST /v1/messages stream:true` with a 50-token prompt; tee SSE to file; assert the final `message_delta.usage.output_tokens` is within ±2 of `wc -w` on the assembled text. |
| Open WebUI compatibility against `/v1/messages` | (informational; Open WebUI uses `/v1/chat/completions`) | Open WebUI does not speak Anthropic protocol natively in v0.9 | Skip in Phase 4 (Phase 6 territory). Document the limitation in README. |

*Note: prior versions of this file caveated "URLs deferred to v2 — URL happy path not automated." That caveat is REMOVED in this revision — URL happy path IS automated via MSW image stubs in Plan 05 integration tests + Plan 05 unit tests; the live smoke counterpart (SC-P4-D) is the manual check.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (per-task map column populated)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (every task except 4-05-04 has automated; 4-05-04 is the gated checkpoint)
- [x] Wave 0 covers all MISSING references (translation unit tests + 4 integration test files + golden fixture tree + heartbeat.anthropic.test.ts)
- [x] No watch-mode flags (always `--run` for CI determinism)
- [x] Feedback latency < 30s (full suite measured ~25 s)
- [x] `nyquist_compliant: true` set in frontmatter (per-task map populated; consistent with the 5 PLAN.md files after the gap-closure revision)

**Approval:** pending (sign-off after Wave 0 scaffolds land + first task green)
</content>
</invoke>
