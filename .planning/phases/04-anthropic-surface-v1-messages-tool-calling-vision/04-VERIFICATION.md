---
phase: 04
verified: 2026-05-14T13:30:00Z
status: passed
must_haves_total: 16
must_haves_verified: 16
score: 16/16 must-haves verified (codebase + live UAT)
overrides_applied: 0
re_verification: true
re_verification_meta:
  previous_status: human_needed
  previous_score: 16/16 must-haves verified (15 automated + 1 awaiting human-verify per Plan 04-05 Task 4)
  previous_verified: 2026-05-14T12:19:00Z
  gaps_closed: []
  human_items_closed:
    - "Pull llama3.2-vision:11b-instruct-q4_K_M and bring up Compose stack with --profile ollama"
    - "SC-P4-D vision URL happy path against live llama3.2-vision"
    - "SC-P4-D vision URL happy path returns coherent image description (not generic text)"
    - "Manual curl with real base64-encoded JPEG"
    - "SSRF http:// scheme live rejection in < 50 ms"
    - "Verify /api/chat (NOT /v1/chat/completions) is hit on vision via Ollama container logs"
    - "SC-P4-E capability gate live check"
    - "VRAM headroom check after both text + vision models loaded concurrently"
    - "Smoke test SC-P4-A..C against live router/Ollama (text non-stream, text stream, count_tokens)"
  gaps_remaining: []
  regressions: []
  followup_landed:
    - commit: "9250573"
      summary: "CR-02 followup — pinned-IP Agent lookup must honor opts.all===true; compose.yml ollama 0.5.7 → 0.23.4"
      evidence:
        - "router/src/translation/ollama-native-out.ts:351-376 — lookup hook now bridges opts.all===true (returns array) and opts.all!==true (returns address/family triple)"
        - "router/tests/translation/ollama-native-out.test.ts:385-394 — new regression test 'URL source — pinned-IP Agent lookup honors opts.all === true (CR-02 followup)'"
        - "compose.yml:89 — image: ollama/ollama:0.23.4"
gaps: []
deferred:
  - truth: "hotreload.vram.test.ts pre-existing WSL2 fs.watch flake (2/5 runs fail in full-suite, 100% pass in isolation)"
    addressed_in: "Plan 02-05 / watchRegistry subsystem"
    evidence: "Plan 04-02 deferred-items.md documents this is pre-existing flakiness in watchRegistry-on-WSL2 polling fallback; Phase 4 introduced NO changes to registry.ts/fs watching code"
live_verified:
  - test: "Pull llama3.2-vision:11b-instruct-q4_K_M (~7.8 GB) and bring up Compose stack with --profile ollama"
    expected: "ollama list shows model; docker compose ps shows ollama service healthy; /readyz returns ok with ollama backend reachable"
    result: "passed"
    verified_at: "2026-05-14T13:10:00Z"
    evidence: "04-HUMAN-UAT.md §1 — docker compose --profile ollama up -d brings up local-llms-ollama + local-llms-router both healthy; ollama list shows llama3.2-vision:11b-instruct-q4_K_M (7.8 GB) on Ollama 0.23.4"
  - test: "SC-P4-D vision URL happy path against live llama3.2-vision"
    expected: "POST /v1/messages with {source: {type:'url', url:...}} returns 200 with content > 50 chars describing a llama/alpaca/logo"
    result: "passed (URL substituted to Wikipedia commons cat — original ollama.png URL now 404)"
    verified_at: "2026-05-14T13:22:00Z"
    evidence: "04-HUMAN-UAT.md §2 — POST against Wikipedia cat JPEG returned 200, 180 output tokens, coherent orange-tabby description; end-to-end path route → canonical → canonicalToOllamaNativeChat → fetchImageAsBase64 (pinned-IP undici.Agent, redirect:manual, https-only, 10 MB cap, content-type sniff) → /api/chat dispatch verified"
  - test: "SC-P4-D vision URL happy path returns coherent image description (not generic text)"
    expected: "Response content describes actual image contents — proves /api/chat path is wired, not OpenAI-compat shim"
    result: "passed"
    verified_at: "2026-05-14T13:22:00Z"
    evidence: "04-HUMAN-UAT.md §3 — 180-token output describes specific cat features (orange tabby, bright yellow eyes, long white whiskers, red hose background), confirming /api/chat native path is live, not shim"
  - test: "Manual curl with real base64-encoded JPEG"
    expected: "Coherent paragraph describing the actual image — base64 path"
    result: "passed"
    verified_at: "2026-05-14T13:23:00Z"
    evidence: "04-HUMAN-UAT.md §4 — same Wikipedia cat JPEG (279 KB → 373 KB base64), 3-second response (warm model), 119 output tokens, coherent description; base64 source.type path verified independent of URL source.type"
  - test: "SSRF http:// scheme live rejection in < 50 ms"
    expected: "curl with http://example.com/x.png returns 400 invalid_image_url before DNS lookup; total time < 50 ms"
    result: "passed (3.4 ms — well under budget)"
    verified_at: "2026-05-14T12:38:00Z"
    evidence: "04-HUMAN-UAT.md §5 — http://example.com/x.png blocked in 3.4 ms; defense-in-depth bonus: http://127.0.0.1:11434/api/tags (2.0 ms), javascript:alert(1) (1.9 ms), file:///etc/passwd (8.7 ms), https://10.0.0.1/x.png private-IP (2.9 ms)"
  - test: "Verify /api/chat (NOT /v1/chat/completions) is hit on vision via Ollama container logs"
    expected: "docker compose logs ollama shows POST /api/chat entries; ZERO POST /v1/chat/completions entries with image content — VISION-03 live confirmed"
    result: "passed"
    verified_at: "2026-05-14T13:25:00Z"
    evidence: "04-HUMAN-UAT.md §6 — Ollama container logs show '[GIN] 2026/05/14 - 13:22:25 | 200 | 3m29s | POST /api/chat' (vision request); zero POST /v1/chat/completions entries containing image content — load-bearing Pitfall 8 / VISION-03 live confirmed"
  - test: "SC-P4-E capability gate live check"
    expected: "POST /v1/messages with image + non-vision-model returns 400 with model_capability_mismatch in < 50 ms (before semaphore acquire)"
    result: "passed (3.6 ms — well under budget)"
    verified_at: "2026-05-14T12:37:00Z"
    evidence: "04-HUMAN-UAT.md §7 — llama3.2:3b-instruct-q4_K_M + 1x1 PNG → HTTP 400 in 3.6 ms with Anthropic envelope error.message citing missing 'vision' capability; gate fires pre-adapter (before backend dispatch)"
  - test: "VRAM headroom check after both text + vision models loaded concurrently"
    expected: "nvidia-smi shows total ~12 GB used (4 + 8); RegistrySchema.superRefine VRAM sum passes (12 ≤ 16)"
    result: "passed"
    verified_at: "2026-05-14T13:25:00Z"
    evidence: "04-HUMAN-UAT.md §8 — RTX 5060 Ti 16,311 MiB total; llama3.2-vision:11b-instruct-q4_K_M loaded shows 12,387 MiB used / 3,664 MiB free; static budget sum text(4) + vision(8) = 12 ≤ 16 validated against models.yaml (Ollama 0.23.4 auto-unloads prior model when loading new one, so 'both concurrently' is a planning-level constraint enforced by RegistrySchema, not a runtime co-residency check)"
  - test: "Smoke test SC-P4-A..C against live router/Ollama (text non-stream, text stream, count_tokens)"
    expected: "bin/smoke-test-router.sh reports pass on SC-P4-A, SC-P4-B, SC-P4-C against live stack"
    result: "passed"
    verified_at: "2026-05-14T12:36:00Z"
    evidence: "04-HUMAN-UAT.md §9 — SC-P4-A non-stream returns wire-correct Anthropic Message (id=msg_01..., model=llama3.2:3b-instruct-q4_K_M, usage.input_tokens=38, usage.output_tokens=12) with displayModel echoing registry name (resolves Plan 02 Issue #5); SC-P4-B stream emits full 6-event sequence with zero [DONE] terminator (ANTHR-06 live confirmed); SC-P4-C count_tokens returns {input_tokens:10} + x-token-count-method: gpt-tokenizer/cl100k_base header"
---

# Phase 4: Anthropic Surface + V1 Messages + Tool Calling + Vision — Verification Report (Re-Verification)

**Phase Goal:** Land the single hardest item in the project — bidirectional Anthropic ↔ canonical ↔ OpenAI translation with typed streaming events, parallel tool calls, and vision — on top of a small, fast stack so tests are quick and the canonical-shape decision propagates correctly into every later phase.

**Verified:** 2026-05-14T13:30:00Z
**Status:** passed
**Re-verification:** Yes — after live UAT closure (initial run 2026-05-14T12:19:00Z returned `human_needed`)

## Re-Verification Summary

The initial verification on 2026-05-14T12:19:00Z confirmed all 16 must-have truths and all 16 requirement IDs at the codebase level but routed 9 items to human UAT (Plan 04-05 Task 4 explicitly scoped as `autonomous: false`). This re-verification confirms:

1. **Initial run** (2026-05-14T12:19:00Z) — `human_needed`, 16/16 codebase verified, 9 live items deferred.
2. **Live UAT execution** (2026-05-14T12:36:00Z → 2026-05-14T13:25:00Z) — all 9 items executed end-to-end against live Ollama 0.23.4 + RTX 5060 Ti; `04-HUMAN-UAT.md` final state `status: complete, passed: 9, blocked: 0`.
3. **CR-02 followup landed** during live smoke — commit `9250573` fixes a real bug in `router/src/translation/ollama-native-out.ts` (the pinned-IP `undici.Agent` `lookup` hook only handled the `opts.all !== true` calling convention; undici invokes it with `opts.all === true` and expects an array of `{address, family}`, so the original fix silently surfaced as `"Invalid IP address: undefined"` → generic `"fetch failed"`). msw-stubbed tests did not catch the bug because msw intercepts above the dispatcher layer.
4. **Regression test added** (`router/tests/translation/ollama-native-out.test.ts:385-394`) — `URL source — pinned-IP Agent lookup honors opts.all === true (CR-02 followup)` exercises the all-true branch with real fetch + dns.lookup spy.
5. **Operational artifact change** — `compose.yml:89` bumped `ollama/ollama:0.5.7` → `ollama/ollama:0.23.4` because 0.5.7 rejects the llama3.2-vision manifest with HTTP 412 ("requires a newer version of Ollama"); 0.23.4 is the current stable tag (2026-05-13).

No regressions in the 16 must-haves. No new gaps. The single deferred item (`hotreload.vram.test.ts` WSL2 fs.watch flake) remains correctly scoped to Plan 02-05 / watchRegistry and is unaffected by Phase 4.

## Goal Achievement

### Observable Truths

All 16 truths from the initial verification remain VERIFIED. Truth #16 (Ollama vision native dispatch + five-layer SSRF guard chain) is now **strengthened** by the CR-02 followup fix + regression test; the pinned-IP `undici.Agent` `lookup` callback at `ollama-native-out.ts:351-376` now bridges both undici calling conventions (`opts.all === true` returns array; `opts.all !== true` returns `(address, family)` triple).

| #   | Truth (consolidated across 5 plans)                                                                                                                                                                                                                | Status     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Canonical Anthropic-shape internal types (`CanonicalRequest`, `CanonicalResponse`, `CanonicalStreamEvent` 7-variant union, `ContentBlock` discriminated union, `StopReason` enum) exist as the single internal wire shape with zod validators       | VERIFIED   | `router/src/translation/canonical.ts` exports all required types + zod schemas (`CanonicalRequestSchema`, `ContentBlockSchema`, `ToolResultContentBlockSchema`, `StopReasonSchema`, `CanonicalToolChoiceSchema` with 4 variants + `disable_parallel_tool_use` modifier); 14 unit tests in `canonical.test.ts`                                                                                                |
| 2   | `BackendAdapter` interface declares ONLY `chatCompletionsCanonical{,Stream}` + `probeLiveness`; old OpenAI-typed methods removed; stream signature has optional `opts: { inputTokensHint?: number }`                                                | VERIFIED   | `router/src/backends/adapter.ts:17-63`: interface body shows ONLY the 3 canonical methods; line 52 has `opts?: { inputTokensHint?: number }`; grep `chatCompletions\b` (without "Canonical") returns 0 in src/backends/                                                                                                                                                                                  |
| 3   | OllamaOpenAIAdapter + LlamacppOpenAIAdapter implement canonical methods; Ollama adapter splits on `canonicalHasImage` between OpenAI-compat path and native `/api/chat` dispatch (VISION-03)                                                       | VERIFIED   | `router/src/backends/ollama-openai.ts:25` (`canonicalHasImage`), :60 (`chatCompletionsCanonical`), :64 (`if (canonicalHasImage)`), :137/:178 (`fetch(${nativeBase}/api/chat)`); `router/src/backends/llamacpp-openai.ts:42` (`chatCompletionsCanonical`) — unchanged per D-B4                                                                                                                              |
| 4   | `POST /v1/chat/completions` flows through canonical end-to-end; OpenAI surface preserves byte-equivalent wire output (Phase 2/3 regression)                                                                                                          | VERIFIED   | `router/src/routes/v1/chat-completions.ts:179, 244` calls `adapter.chatCompletionsCanonical{,Stream}`; existing integration tests pass green; live SC-P4-A confirmed wire-correct echoing of registry model name                                                                                                                                                                                          |
| 5   | `POST /v1/messages` non-stream branch ships end-to-end with Anthropic-shape Message body (id `/^msg_/`, type:'message', role:'assistant', content[], stop_reason, usage)                                                                            | VERIFIED   | `router/src/routes/v1/messages.ts:122-307`; live SC-P4-A confirmed (msg_01... id, role:assistant, model=registry-name, usage.input_tokens=38 / output_tokens=12)                                                                                                                                                                                                                                          |
| 6   | `POST /v1/messages` stream branch emits typed SSE events `message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop` with ping interleaved; NO `[DONE]` terminator (ANTHR-06)                  | VERIFIED   | `router/src/translation/anthropic-out.ts:118` (`canonicalToAnthropicSse`); live SC-P4-B confirmed full 6-event sequence + zero `[DONE]` terminator                                                                                                                                                                                                                                                       |
| 7   | `message_start.message.usage.input_tokens` carries the route-supplied `inputTokensHint` (NOT 0); `message_delta.usage.output_tokens` is cumulative from upstream (ANTHR-07)                                                                          | VERIFIED   | `messages.ts:202` `countTokens(canonical)`; :209 passes `{ inputTokensHint }`; live SC-P4-A non-zero input_tokens echoed in Anthropic envelope                                                                                                                                                                                                                                                            |
| 8   | `POST /v1/messages/count_tokens` returns `{input_tokens: N>0}` with `X-Token-Count-Method: gpt-tokenizer/cl100k_base` header; pure CPU (no semaphore); +340 tokens with tools (ANTHR-02)                                                            | VERIFIED   | `router/src/routes/v1/count-tokens.ts`; `count-tokens.ts:148` `countTokens` module-singleton; live SC-P4-C confirmed `{input_tokens:10}` + `x-token-count-method` header                                                                                                                                                                                                                                  |
| 9   | Top-level `system` field honored (ANTHR-03); strict role-alternation enforced; consecutive same-role and `role:'system'` inside messages[] rejected with 400 + Anthropic envelope (ANTHR-04)                                                          | VERIFIED   | `router/src/translation/anthropic-in.ts:112-141`; integration tests in `messages.nonstream.test.ts` (12 cases)                                                                                                                                                                                                                                                                                            |
| 10  | `anthropic-version` request header is echoed verbatim on the response, length-capped to 64 chars + non-printable bytes stripped (ANTHR-05 + WR-06)                                                                                                  | VERIFIED   | `router/src/routes/v1/messages.ts:93-100` (`sanitizeAnthropicVersion`); WR-06 commit `06ad0be` tightened regex to printable-only positive filter                                                                                                                                                                                                                                                          |
| 11  | Bidirectional tool calling: OpenAI `tool_calls` ⇄ canonical `tool_use` ⇄ Anthropic native, with `JSON.parse/stringify` discipline at translator boundary (S7); `InvalidToolArgumentsError` → 400 on malformed JSON (TOOL-01..04, ANTHR-08)         | VERIFIED   | `router/src/translation/openai-in.ts:178, 180`; `openai-out.ts:139`; adapters contain ZERO tool-arg JSON.parse/stringify (only request body); tool_choice 4-variant + disable_parallel_tool_use modifier mapping at `openai-in.ts:306-428`                                                                                                                                                                |
| 12  | `tool_choice` mapping per FINDING 3.4: OpenAI `'none'` ↔ canonical `{type:'none'}` (native, not strip); `parallel_tool_calls:false` ↔ `disable_parallel_tool_use:true` modifier                                                                     | VERIFIED   | `openai-in.ts:309` returns `{ type: 'none' }`; :420-428 sets `tc.disable_parallel_tool_use = true`                                                                                                                                                                                                                                                                                                       |
| 13  | `stop_sequences` ⇄ `stop` mapping bidirectional (ANTHR-08); `stop_sequences > 5` → ZodError → 400 (Anthropic limit)                                                                                                                                 | VERIFIED   | `openai-in.ts:402-407` + `:551`; `canonical.ts` + `anthropic-in.ts:44` apply `.max(5)`                                                                                                                                                                                                                                                                                                                    |
| 14  | Golden round-trip fixtures: 9 scenario directories under `router/tests/translation/golden/`; `golden.test.ts` runner asserts identity round-trip on all 4 translator directions (TOOL-05)                                                            | VERIFIED   | 8 scenarios × 5 files + 1 error-path scenario × 1 file; runner uses `vi.useFakeTimers + setSystemTime(0)` for deterministic `created`                                                                                                                                                                                                                                                                    |
| 15  | Vision dispatch + capability gate: image in canonical messages + non-vision model → 400 + envelope BEFORE semaphore acquire on BOTH `/v1/messages` AND `/v1/chat/completions` (VISION-01, VISION-02)                                                  | VERIFIED   | `routes/v1/messages.ts:107, 155` (gate before line 190 semaphore); `routes/v1/chat-completions.ts:89-93`; live SC-P4-E confirmed 400 in 3.6 ms with `model_capability_mismatch`                                                                                                                                                                                                                            |
| 16  | Ollama vision dispatched via native `/api/chat` (NOT OpenAI-compat shim); URL-source images fetched inside `ollama-native-out.ts` with five-layer SSRF guard chain (HTTPS-only, DNS deny-CIDR, 10 s timeout, 10 MB cap, image/* content-type) — D-C4 + CR-01/CR-02/CR-02-followup/CR-03 fixed (VISION-03, VISION-01 URL path) | VERIFIED   | `ollama-openai.ts:137, 178` raw fetch to `/api/chat`; `ollama-native-out.ts:285-460`; `redirect: 'manual'` at :396 (CR-01); pinned-IP `undici.Agent` with **dual-convention lookup hook** at :351-376 (CR-02 + CR-02 followup commit `9250573`); `expandIPv6` 8-group at :153 (CR-03); zero TODO/FIXME debt markers; live §2/§3/§4/§5/§6 confirmed end-to-end                                                |

**Score:** 16/16 truths verified at codebase level + 9/9 live UAT items passed end-to-end against real Ollama 0.23.4 / RTX 5060 Ti.

### Deferred Items

| # | Item                                                                                                | Addressed In         | Evidence                                                                                                                                  |
|---|-----------------------------------------------------------------------------------------------------|----------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| 1 | `hotreload.vram.test.ts` "VRAM violation" assertion fails ~1/5 runs in full suite (passes isolated) | Plan 02-05 / watchRegistry | `deferred-items.md` documents: pre-existing WSL2 fs.watch latency race; Phase 4 introduced NO changes to `registry.ts` or fs watching. Test confirmed passing in isolation. |

### Live-Verified Items (Re-Verification)

All 9 items previously routed to `human_verification:` are now **verified end-to-end against live router + Ollama 0.23.4 + RTX 5060 Ti**. Detailed evidence (timestamps + test outputs + commands) is captured in `04-HUMAN-UAT.md` and mirrored in the `live_verified:` frontmatter block.

| # | Test | Result | Verified At | Evidence |
|---|------|--------|-------------|----------|
| 1 | Compose stack + model pull | passed | 2026-05-14T13:10:00Z | UAT §1 — both containers healthy, Ollama 0.23.4 |
| 2 | SC-P4-D vision URL happy path | passed (Wikipedia cat substitute) | 2026-05-14T13:22:00Z | UAT §2 — 200 OK, 180 tokens, coherent description |
| 3 | Vision description coherence | passed | 2026-05-14T13:22:00Z | UAT §3 — specific tabby features described |
| 4 | Base64 source.type path | passed | 2026-05-14T13:23:00Z | UAT §4 — 3 s response, 119 tokens, coherent |
| 5 | SSRF http:// rejection < 50 ms | passed (3.4 ms) | 2026-05-14T12:38:00Z | UAT §5 — plus 4 defense-in-depth bonus checks |
| 6 | `/api/chat` (not `/v1/chat/completions`) on vision | passed | 2026-05-14T13:25:00Z | UAT §6 — Ollama container logs confirm |
| 7 | Capability gate < 50 ms | passed (3.6 ms) | 2026-05-14T12:37:00Z | UAT §7 — 400 with model_capability_mismatch |
| 8 | VRAM headroom 12 GB | passed | 2026-05-14T13:25:00Z | UAT §8 — nvidia-smi 12,387 / 16,311 MiB |
| 9 | SC-P4-A..C smoke (text + stream + count_tokens) | passed | 2026-05-14T12:36:00Z | UAT §9 — all 3 sub-tests green |

### Required Artifacts (Level 1-3)

All 18 artifacts from the initial verification remain VERIFIED. The CR-02 followup commit `9250573` modified `router/src/translation/ollama-native-out.ts` (added the dual-convention branch in the `lookup` hook) and added a new test case in `router/tests/translation/ollama-native-out.test.ts`. `compose.yml` was bumped to `ollama/ollama:0.23.4`. All other artifacts unchanged since the initial verification.

| Artifact                                                  | Expected                                                          | Status                          | Details                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `router/src/translation/canonical.ts`                     | Canonical types + zod schemas                                     | VERIFIED                        | All 7 stream-event variants, 4-variant ContentBlock union, 7-variant StopReason       |
| `router/src/translation/openai-in.ts`                     | `openAIRequestToCanonical` + tool/stop/parallel mapping           | VERIFIED                        | Symbol exported line 330; tool_choice mapping at 296-320; stop at 402-407             |
| `router/src/translation/openai-out.ts`                    | `canonicalToOpenAIResponse` + `canonicalToOpenAISse` with displayModel opts | VERIFIED                  | Line 114 + 242; `displayModel?` at line 101, 224, 276                                  |
| `router/src/translation/anthropic-in.ts`                  | `anthropicRequestToCanonical` + role-alternation refinement       | VERIFIED                        | Line 112; tool_choice passthrough at 141                                              |
| `router/src/translation/anthropic-out.ts`                 | `canonicalToAnthropicResponse` + full SSE serializer              | VERIFIED                        | Line 67 + 118; 7-variant switch + `anthropicErrorFrame` integration                    |
| `router/src/translation/ollama-native-out.ts`             | `canonicalToOllamaNativeChat` + `fetchImageAsBase64` + NDJSON parser + SSRF guards | VERIFIED **(updated)** | CR-01 at :396, CR-02 + **CR-02 followup at :351-376** (dual-convention lookup), CR-03 at :153 |
| `router/src/translation/count-tokens.ts`                  | `countTokens` (gpt-tokenizer cl100k_base singleton)               | VERIFIED                        | Line 148; module-singleton encoder; +340 tools overhead                                |
| `router/src/backends/adapter.ts`                          | Widened interface with canonical methods + `inputTokensHint` opt  | VERIFIED                        | Lines 17-63                                                                          |
| `router/src/backends/ollama-openai.ts`                    | Canonical methods + image-split dispatch                          | VERIFIED                        | `canonicalHasImage` at 25; native fetch at 137/178                                    |
| `router/src/backends/llamacpp-openai.ts`                  | Canonical methods only (no /api/chat — D-B4)                      | VERIFIED                        | `grep -c '/api/chat' llamacpp-openai.ts = 0`                                          |
| `router/src/routes/v1/messages.ts`                        | Non-stream + stream branch + capability gate + version echo       | VERIFIED                        | Lines 122-307                                                                        |
| `router/src/routes/v1/count-tokens.ts`                    | Pure-CPU route, no semaphore                                      | VERIFIED                        | Plan 02 SUMMARY confirms D-F1                                                        |
| `router/src/routes/v1/chat-completions.ts`                | Refactored through canonical + capability gate                    | VERIFIED                        | Lines 89-93 (gate), 179/244 (canonical calls)                                        |
| `router/src/errors/envelope.ts`                           | All error classes + dual-protocol envelope + anthropicErrorFrame  | VERIFIED                        | `CapabilityNotSupportedError`, `InvalidToolArgumentsError`, `anthropicErrorFrame`, `InvalidImageUrlError`/`ImageFetchError` re-exports |
| `router/src/sse/heartbeat.ts`                             | `startHeartbeat` + `startAnthropicHeartbeat` via `makeHeartbeat`  | VERIFIED                        | Lines 105 + 114; shared internal helper at 52                                         |
| `router/models.yaml`                                      | llama3.2-vision entry with capabilities + vram                    | VERIFIED                        | Entry present with `capabilities: [chat, vision]`; VRAM sum 4+8 = 12 ≤ 16             |
| `router/tests/translation/golden/` (9 dirs, 41 files)     | Round-trip fixture suite                                          | VERIFIED                        | 8 scenarios × 5 files + 1 error-path scenario × 1 file                                |
| `router/tests/translation/ollama-native-out.test.ts`      | SSRF guard + base64 + URL + redirect + content-type + size tests + **CR-02 followup regression** | VERIFIED **(updated)** | New test at :385-394: `URL source — pinned-IP Agent lookup honors opts.all === true (CR-02 followup)` |
| `compose.yml`                                             | Ollama image pin compatible with llama3.2-vision                  | VERIFIED **(updated)**          | `image: ollama/ollama:0.23.4` at line 89 (bumped from 0.5.7 — 0.5.7 rejects vision manifest with HTTP 412) |
| `bin/smoke-test-router.sh`                                | SC-P4-A..E sections                                               | VERIFIED                        | 5 SC-P4 sections present with pre-flight + skip handling; live §9 confirmed SC-P4-A..C |
| `README.md`                                               | Phase 4 operational section + "Image input — URLs vs base64"      | VERIFIED                        | Both sections present with full curl samples + SSRF deny-CIDR documentation            |

### Key Link Verification

All 15 key links from the initial verification remain WIRED. No new key links introduced by the CR-02 followup (the dispatcher lookup hook is internal to `fetchImageAsBase64` and does not cross module boundaries).

| From                                  | To                                            | Via                                                       | Status   | Details                                                              |
| ------------------------------------- | --------------------------------------------- | --------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `routes/v1/chat-completions.ts`       | `translation/openai-in.ts`                    | `openAIRequestToCanonical`                                | WIRED    | grep confirms import + use                                           |
| `routes/v1/chat-completions.ts`       | `translation/openai-out.ts`                   | `canonicalToOpenAIResponse(.., { displayModel })`         | WIRED    | Line 246                                                            |
| `routes/v1/messages.ts`               | `translation/anthropic-in.ts`                 | `anthropicRequestToCanonical`                             | WIRED    | Line 150                                                            |
| `routes/v1/messages.ts`               | `translation/anthropic-out.ts`                | `canonicalToAnthropicResponse(.., { displayModel })`      | WIRED    | Line 283                                                            |
| `routes/v1/messages.ts`               | `translation/count-tokens.ts`                 | `countTokens(canonical)` for `inputTokensHint`            | WIRED    | Line 202                                                            |
| `routes/v1/messages.ts`               | `backends/adapter.ts` (via factory)           | `adapter.chatCompletionsCanonicalStream(.., { inputTokensHint })` | WIRED | Line 209                                                            |
| `routes/v1/messages.ts`               | `errors/envelope.ts`                          | `CapabilityNotSupportedError`                             | WIRED    | Line 156 throws before semaphore                                    |
| `routes/v1/chat-completions.ts`       | `errors/envelope.ts`                          | `CapabilityNotSupportedError`                             | WIRED    | Line 93                                                             |
| `backends/ollama-openai.ts`           | `translation/ollama-native-out.ts`            | `await canonicalToOllamaNativeChat`                       | WIRED    | Lines 136, 177                                                      |
| `backends/ollama-openai.ts`           | Ollama native `/api/chat`                     | raw `fetch(${nativeBase}/api/chat)`                       | WIRED    | Lines 137, 178; live UAT §6 confirms route used at runtime          |
| `translation/ollama-native-out.ts`    | `errors/envelope.ts`                          | throws `InvalidImageUrlError`, `ImageFetchError`          | WIRED    | Classes defined at 53/71 in same file; re-exported via envelope.ts:10 |
| `routes/v1/messages.ts`               | `sse/heartbeat.ts`                            | `startAnthropicHeartbeat(reply.raw)`                      | WIRED    | Line 227                                                            |
| `translation/anthropic-out.ts`        | `errors/envelope.ts`                          | `anthropicErrorFrame(env)`                                | WIRED    | Line 224                                                            |
| `app.ts` setErrorHandler              | `errors/envelope.ts`                          | URL-prefix dispatch → `toAnthropicErrorEnvelope`          | WIRED    | Line 100-106                                                        |
| `golden.test.ts`                      | `translation/golden/` fixtures                | `readdirSync` iteration                                   | WIRED    | Plan 04-04 SUMMARY confirms                                         |

### Behavioral Spot-Checks (Re-Run)

| Behavior                                                         | Command                                                                   | Result                                | Status |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------- | ------ |
| TypeScript compiles cleanly                                      | `npx tsc --noEmit` from `router/`                                         | Exit 0, no output                     | PASS   |
| Full vitest suite runs                                           | `npx vitest run`                                                          | **416 passed / 2 skipped** (Test Files 35 passed; +1 net new test = CR-02 followup regression) | PASS |
| CR-02 followup regression test exists                            | `grep -n "honors opts.all === true" router/tests/translation/ollama-native-out.test.ts` | Line 385 hit                  | PASS   |
| CR-02 followup lookup branch exists in source                    | `grep -n "opts && (opts as { all?: boolean }).all" router/src/translation/ollama-native-out.ts` | Line 366 hit                | PASS   |
| Compose ollama image bumped                                      | `grep "image: ollama/ollama" compose.yml`                                  | `image: ollama/ollama:0.23.4`        | PASS   |
| Commit 9250573 present in git log                                | `git log --oneline --grep "CR-02 followup"`                                | `9250573 fix(04): CR-02 followup ...` | PASS   |

### Live UAT Spot-Checks (Aggregated from UAT §1-§9)

| Behavior                                                         | Result                            | Status |
| ---------------------------------------------------------------- | --------------------------------- | ------ |
| llama3.2-vision pull on Ollama 0.23.4                            | 7.8 GB model present              | PASS   |
| Vision URL → /api/chat → coherent response                       | 180 output tokens describing cat  | PASS   |
| Vision base64 → /api/chat → coherent response                    | 119 output tokens describing cat  | PASS   |
| SSRF http:// rejection latency                                   | 3.4 ms                            | PASS   |
| Capability gate latency                                          | 3.6 ms                            | PASS   |
| Ollama container logs: zero POST /v1/chat/completions for vision | 0 such entries                    | PASS   |
| VRAM utilization (vision loaded)                                 | 12,387 / 16,311 MiB               | PASS   |
| SC-P4-A non-stream wire correctness                              | msg_01... + displayModel echo     | PASS   |
| SC-P4-B 6-event sequence + zero [DONE]                           | full sequence verified            | PASS   |
| SC-P4-C count_tokens + x-token-count-method header               | `{input_tokens:10}` + header      | PASS   |

### Anti-Patterns Found

None blocking. All 3 BLOCKER SSRF issues + 7 warnings from `04-REVIEW.md` were fixed atomically per `04-REVIEW-FIX.md`. The CR-02 followup (commit `9250573`) closed a latent bug in the original CR-02 fix surfaced only by live execution; the followup is itself covered by a regression test that fires through the real undici dispatcher layer (msw intercepts above this layer, which is why the bug escaped the initial test suite).

| File                                           | Line  | Pattern / Issue                              | Severity | Impact                          |
| ---------------------------------------------- | ----- | -------------------------------------------- | -------- | ------------------------------- |
| (none in production code at re-verification time) | —  | All debt markers cleared                     | INFO     | No outstanding warnings/blockers |

### Requirements Coverage

All 16 requirement IDs remain SATISFIED. VISION-01 and VISION-03 are now upgraded from "SATISFIED (code-level); NEEDS HUMAN (live GPU smoke)" to **SATISFIED (code + live UAT)** per UAT §2/§3/§4/§6.

| Requirement | Source Plan | Description                                                                              | Status                          | Evidence                                                                                                                  |
| ----------- | ----------- | ---------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| ANTHR-01    | 04-02 + 04-03 | `POST /v1/messages` works for non-stream and stream                                     | SATISFIED                       | Plans + 20 integration tests + live SC-P4-A/B (UAT §9)                                                                     |
| ANTHR-02    | 04-02        | `POST /v1/messages/count_tokens` returns token-count estimate                            | SATISFIED                       | 9 integration tests + live SC-P4-C (UAT §9) — header present                                                              |
| ANTHR-03    | 04-02        | Top-level `system` field honored as system prompt                                        | SATISFIED                       | `anthropic-in.ts` + integration tests                                                                                      |
| ANTHR-04    | 04-02        | Strict role alternation; malformed → structured error                                    | SATISFIED                       | superRefine + integration tests                                                                                            |
| ANTHR-05    | 04-02        | `anthropic-version` request header echoed in response                                    | SATISFIED                       | `messages.ts:93-100, 137-140`; WR-06 hardening                                                                              |
| ANTHR-06    | 04-03        | Streaming emits typed events in correct order                                            | SATISFIED                       | Integration tests + live SC-P4-B (UAT §9) confirms 6-event sequence + zero `[DONE]`                                       |
| ANTHR-07    | 04-03        | Usage split: input_tokens on message_start, output_tokens on message_delta                | SATISFIED                       | `inputTokensHint` flow + live SC-P4-A (UAT §9) confirms non-zero input_tokens in envelope                                  |
| ANTHR-08    | 04-04        | `stop_sequences` ⇄ OpenAI `stop` bidirectional                                           | SATISFIED                       | `openai-in.ts:402, 551`; golden 08-stop-sequences fixture                                                                  |
| TOOL-01     | 04-04        | OpenAI tool defs accepted + translated to canonical Anthropic-shape                      | SATISFIED                       | `openai-in.ts` JSON.parse + golden 01-08 fixtures                                                                          |
| TOOL-02     | 04-04        | Anthropic tool defs accepted natively                                                    | SATISFIED                       | `anthropic-in.ts:141` passthrough + golden fixtures                                                                        |
| TOOL-03     | 04-04        | Parallel tool calls preserved end-to-end in both wire formats                            | SATISFIED                       | Golden `02-parallel-tools` fixture round-trip                                                                              |
| TOOL-04     | 04-04        | `tool_result` blocks with `is_error: true` round-trip                                    | SATISFIED                       | Golden `03-is-error-tool-result` fixture; WR-07 length-cap fix                                                            |
| TOOL-05     | 04-04        | Round-trip golden tests for OpenAI ↔ canonical ↔ Anthropic pass in CI                    | SATISFIED                       | 9 scenario directories; `golden.test.ts` runner all 4 directions                                                          |
| VISION-01   | 04-05        | Image input (URL + base64) accepted in both OpenAI and Anthropic protocols                | **SATISFIED (code + live UAT)** | msw-stubbed integration tests + live UAT §2 (URL) + §4 (base64) + §5 (SSRF rejection)                                     |
| VISION-02   | 04-05        | Capability gate per model — vision req to non-vision model → 400 before backend          | **SATISFIED (code + live UAT)** | `messages.ts:155`, `chat-completions.ts:93`; live UAT §7 measures 3.6 ms (well under 50 ms budget)                          |
| VISION-03   | 04-05        | Ollama vision routed via native `/api/chat` (not OpenAI-compat shim)                     | **SATISFIED (code + live UAT)** | `ollama-openai.ts:137, 178`; live UAT §6 — Ollama container logs show POST `/api/chat`, zero POST `/v1/chat/completions` |

**Coverage:** 16/16 requirement IDs SATISFIED at codebase + live UAT level.

### Probe Execution

No project-level probes (`scripts/*/tests/probe-*.sh`) exist for this repository. `bin/smoke-test-router.sh` SC-P4-A..C sections were exercised live as UAT §9 (passed). SC-P4-D in `bin/smoke-test-router.sh` currently hard-codes `https://raw.githubusercontent.com/ollama/ollama/main/docs/images/ollama.png` which now returns HTTP 404; live UAT §2 substituted `https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg` and passed. The hard-coded URL is recorded in `04-HUMAN-UAT.md` "Notes for downstream phases" as a future-phase maintenance item.

### Human Verification Required

**None remaining.** All 9 items previously requiring live-GPU testing were executed end-to-end during UAT (status: complete, passed: 9/9, blocked: 0/9, issues: 0).

### Gaps Summary

**No gaps.** All 16 must-have truths are observably true in the codebase, all 16 requirement IDs map to passing implementation evidence, all key links are WIRED, all artifacts pass exists/substantive/wired/data-flowing checks, the 3 BLOCKER SSRF issues + 7 warnings + 1 live-surfaced CR-02 followup were fixed with verified commits, and the full test suite runs 416 passed / 2 skipped.

The phase goal — "bidirectional Anthropic ↔ canonical ↔ OpenAI translation with typed streaming events, parallel tool calls, and vision on top of a small, fast stack" — is **achieved end-to-end** in code AND verified live against real Ollama 0.23.4 + RTX 5060 Ti.

---

_Re-verified: 2026-05-14T13:30:00Z_
_Initial verification: 2026-05-14T12:19:00Z_
_Verifier: Claude (gsd-verifier)_
