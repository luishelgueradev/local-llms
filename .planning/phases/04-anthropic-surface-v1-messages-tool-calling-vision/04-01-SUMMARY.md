---
phase: 04-anthropic-surface-v1-messages-tool-calling-vision
plan: 01
subsystem: api
tags:
  - canonical-shape
  - anthropic-translation
  - openai-translation
  - zod
  - ulid
  - sse

# Dependency graph
requires:
  - phase: 02-mvp-vertical-slice-router-ollama-sse
    provides: OllamaOpenAIAdapter, OpenAI SSE wire format, error envelope, AbortController plumbing
  - phase: 03-multi-backend-dispatch-llama-cpp-registry-hardening
    provides: LlamacppOpenAIAdapter, AdapterFactory, BackendSemaphore, probeLiveness, registry hardening
provides:
  - Canonical Anthropic-shape internal request/response/stream-event types in router/src/translation/canonical.ts
  - openai-in / openai-out translators with full text-only behavior + image-block mapping
  - anthropic-in / anthropic-out / ollama-native-out translator skeletons (full impls land in Plans 02/03/05)
  - BackendAdapter interface widened to chatCompletionsCanonical{,Stream} — old OpenAI-typed methods removed
  - OllamaOpenAIAdapter + LlamacppOpenAIAdapter implement the canonical entry points (OpenAI-compat path only; Plan 05 lands the Ollama vision branch)
  - /v1/chat/completions route flows through canonical end-to-end; Phase 2/3 OpenAI integration tests stay byte-equivalent
  - Wave-0 test scaffolds for all 7 translator-side test files (canonical/openai-in/openai-out/anthropic-in/anthropic-out/ollama-native-out/golden)
  - ULID-prefixed id helpers (newMessageId, newToolUseId) with monotonicFactory for in-ms ordering
affects:
  - 04-02-anthropic-route-count-tokens
  - 04-03-anthropic-streaming
  - 04-04-tool-calling
  - 04-05-vision-routing
  - 07-vllm-embeddings
  - 08-ollama-cloud-fallback

# Tech tracking
tech-stack:
  added:
    - ulid@^3.0.2
  patterns:
    - Canonical Anthropic-shape internal representation (D-A1); strict superset of OpenAI; adapter speaks ONE wire shape
    - One-translator-per-direction file layout under router/src/translation/ (D-A2)
    - Both /v1/chat/completions and /v1/messages flow through canonical (D-A3) — no single-hop OpenAI↔Anthropic anywhere
    - Adapters NEVER import openai/resources types in their signatures (D-A4)
    - Non-enumerable _upstreamId / _upstreamInputTokens carriers (Object.defineProperty, enumerable:false) for protocol-id and prompt_tokens preservation without polluting the canonical schema or JSON.stringify (T-04-A2 mitigation pattern)
    - Pattern S8: ULID-prefixed ids (msg_<ulid> + toolu_<ulid>) with monotonicFactory for tight-loop ordering

key-files:
  created:
    - router/src/translation/canonical.ts
    - router/src/translation/openai-in.ts
    - router/src/translation/openai-out.ts
    - router/src/translation/anthropic-in.ts
    - router/src/translation/anthropic-out.ts
    - router/src/translation/ollama-native-out.ts
    - router/tests/translation/canonical.test.ts
    - router/tests/translation/openai-in.test.ts
    - router/tests/translation/openai-out.test.ts
    - router/tests/translation/anthropic-in.test.ts
    - router/tests/translation/anthropic-out.test.ts
    - router/tests/translation/ollama-native-out.test.ts
    - router/tests/translation/golden.test.ts
    - router/tests/translation/golden/.gitkeep
  modified:
    - router/src/backends/adapter.ts
    - router/src/backends/ollama-openai.ts
    - router/src/backends/llamacpp-openai.ts
    - router/src/routes/v1/chat-completions.ts
    - router/tests/unit/factory.test.ts
    - router/tests/integration/chat-completions.stream.test.ts
    - router/package.json

key-decisions:
  - "ToolResultContentBlockSchema is a separate discriminated union (text+image only) instead of using z.lazy() back into the top-level ContentBlockSchema — zod v4 z.discriminatedUnion can't traverse z.lazy forward-references for discriminator resolution, and Anthropic's wire format restricts tool_result.content to text/image blocks anyway"
  - "_upstreamInputTokens carrier on message_delta.usage (non-enumerable) preserves Phase 2/3 OpenAI prompt_tokens semantics until Plan 03 wires a route-supplied inputTokensHint per the plan's must_haves bullet"
  - "Adapter interface change deferred from Task 1 to Task 3 (Rule 3 deviation) so each task's tsc verify gate could pass; the plan's Task 1 done criterion 'adapter.ts no longer references openai/resources types' is satisfied at Task 3 grep gate"
  - "vitest 4.x renamed --reporter=basic (CLI error: 'Failed to load custom Reporter from basic'); ran without the flag — output is still single-line per file, contract-compatible with the plan's verify intent"

patterns-established:
  - "Canonical translation seam: route → openAIRequestToCanonical / anthropicRequestToCanonical → adapter.chatCompletionsCanonical{,Stream} → canonicalToOpenAIResponse|Sse / canonicalToAnthropicResponse|Sse → wire"
  - "Adapter widening lifecycle: Phase 3 added probeLiveness, Phase 4 swaps the chat methods, Phase 7/8 add new adapter classes without changing the interface"
  - "Non-enumerable carrier properties (Object.defineProperty + enumerable:false) for protocol-specific metadata that must NOT appear in canonical JSON serialization but must round-trip through the translator stack"
  - "Inverse-direction helper in the same translator file (openai-in.ts exports both openAIRequestToCanonical AND canonicalToOpenAIChatCompletionParams) — keeps the OpenAI↔canonical mapping co-located"

requirements-completed: []

# Metrics
duration: 14min
completed: 2026-05-13
---

# Phase 4 Plan 01: Canonical Anthropic-Shape Translation Foundation Summary

**Canonical Anthropic-shape translation layer (zod-validated CanonicalRequest/Response + 7-variant stream event union + 5 protocol translators) replaces the OpenAI-typed BackendAdapter so every subsequent Phase 4 plan can build on a single internal wire shape without any single-hop OpenAI↔Anthropic translation.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-05-13T19:54:00Z
- **Completed:** 2026-05-13T20:08:37Z
- **Tasks:** 3/3
- **Files created:** 14
- **Files modified:** 7
- **Total lines added:** 1961
- **Total lines removed:** 127

## Accomplishments

- Landed the canonical type surface (CanonicalRequest, CanonicalResponse, ContentBlock discriminated union with 4 variants, CanonicalStreamEvent union with 7 variants, StopReason enum with 7 values, plus inverse helpers — see `canonical.ts` exports below)
- Both OpenAI translators (`openai-in.ts` / `openai-out.ts`) ship with full text-only + image-block behavior plus the inverse helpers (`canonicalToOpenAIChatCompletionParams`, `openAIChatCompletionToCanonical`, `openAIChunksToCanonicalEvents`) used by the adapters
- BackendAdapter widening: `chatCompletions` / `chatCompletionsStream` removed from the interface; `chatCompletionsCanonical` / `chatCompletionsCanonicalStream` are the sole entry points. Both OllamaOpenAIAdapter + LlamacppOpenAIAdapter re-implemented against the canonical shape with constructors + probeLiveness byte-identical
- `/v1/chat/completions` route refactored to flow through canonical with the AbortController + onClose + safeRelease + semaphore + heartbeat + sseCleanup plumbing unchanged byte-for-byte from Phase 3
- All 206 vitest cases across 30 test files green (36 translation + 170 prior Phase 2/3 / unit tests); zero regressions against the Phase 2/3 integration suite

## Task Commits

Each task was committed atomically:

1. **Task 1: Add canonical types + zod schemas + ULID id helpers** — `f7f938a` (feat)
2. **Task 2: Implement openai-in / openai-out + scaffold remaining translators** — `fa47f98` (feat)
3. **Task 3: Wire both adapters + refactor /v1/chat/completions** — `61c8a91` (refactor)

## Canonical Type Surface Area

Exports from `router/src/translation/canonical.ts`:

### Zod schemas
- `TextBlockSchema`, `ImageSourceSchema`, `ImageBlockSchema`, `ToolUseBlockSchema`
- `ToolResultContentBlockSchema` (text+image discriminated union — used inside ToolResultBlock.content), `ToolResultBlockSchema`
- `ContentBlockSchema` (top-level 4-variant discriminated union)
- `CanonicalMessageSchema` (with string→[text block] transform), `CanonicalToolSchema`, `CanonicalToolChoiceSchema` (4-variant: auto/any/tool/none + disable_parallel_tool_use modifier)
- `StopReasonSchema` (7 variants per FINDING 3.9), `CanonicalRequestSchema`, `CanonicalResponseSchema`

### TS type aliases (z.infer)
- `TextBlock`, `ImageBlock`, `ToolUseBlock`, `ToolResultBlock`, `ContentBlock`
- `CanonicalMessage`, `CanonicalTool`, `CanonicalToolChoice`
- `StopReason`, `CanonicalRequest`, `CanonicalResponse`

### Stream event types (TS-only, internal — not zod-validated)
- `ContentBlockDelta` (text_delta + input_json_delta)
- `CanonicalStreamEvent` (7-variant: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop, ping)

### ULID helpers
- `newMessageId()` → `msg_<ulid>` (Pattern S8, D-E3)
- `newToolUseId()` → `toolu_<ulid>` (Pattern S8, D-E4)

## Adapter Widening Verification (grep results)

```
GATE 1 (old methods in production code):           0   PASS
GATE 2 (adapter.ts openai/resources imports):       0   PASS
GATE 3 (route imports canonical translators):       OK + OK  PASS
GATE 4 (ollama-openai canonical imports):           1   PASS
GATE 4 (llamacpp-openai canonical imports):         1   PASS
ulid in package.json:                               ^3.0.2  PASS
```

## Test Count Delta

- Phase 2/3 baseline: 28 test files / 170 tests / 2 skipped
- Plan 04-01 after: 30 test files / 206 tests / 2 skipped
- Translation-only: 7 test files / 36 tests
- All green; full suite runtime ~5.3s, translation-only ~0.5s

## Decisions Made

- **ToolResultBlock content uses a separate discriminated union (`ToolResultContentBlockSchema` — text+image only) instead of z.lazy back into the top-level ContentBlockSchema.** Zod v4's `z.discriminatedUnion` cannot traverse `z.lazy()` forward-references for discriminator resolution (compile error: `_zod.propValues' are incompatible between these types`). Anthropic's wire format restricts tool_result.content to text/image blocks anyway, so the structural restriction is faithful — no real expressiveness lost.
- **`_upstreamInputTokens` non-enumerable carrier on `message_delta.usage`** — the canonical event type cannot expose `input_tokens` on `message_delta` (Anthropic's wire format puts input_tokens on message_start only, output_tokens on message_delta). To preserve Phase 2/3 wire equivalence (existing integration test asserts `usage.prompt_tokens === 7` on the OpenAI surface), `openAIChunksToCanonicalEvents` attaches the upstream `prompt_tokens` via `Object.defineProperty(..., enumerable:false)`. `canonicalToOpenAISse` reads the carrier when composing the final usage chunk. Plan 03 swaps to a route-supplied `inputTokensHint` so message_start can carry the right value from the start (per the plan's must_haves bullet about Plan 03 wiring).
- **Adapter interface change deferred from Task 1 to Task 3 (Rule 3 deviation).** The plan's Task 1 action says to remove old methods from adapter.ts immediately, but Task 1's verify gate is `tsc --noEmit` — which fails until Tasks 2+3 land the new translators + adapter implementations. Pragmatic resolution: Task 1 ships canonical.ts + tests (tsc + canonical.test.ts green); Task 3 ships the adapter.ts swap + adapter implementations + route refactor atomically (tsc + full integration suite green). The plan's Task 3 grep gate verifies the end state.
- **vitest CLI flag drift.** The plan specifies `--reporter=basic` in every verify command; vitest 4.x renamed this reporter (`Failed to load custom Reporter from basic`). Ran the tests without the flag — output is still single-line-per-file by default and contract-compatible with the plan's verify intent.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Adapter interface change deferred from Task 1 to Task 3**
- **Found during:** Task 1 verify (`npx tsc --noEmit`)
- **Issue:** The plan's Task 1 action says to edit `adapter.ts` to remove OpenAI-typed methods immediately, but doing so before Tasks 2+3 leaves the existing OllamaOpenAIAdapter / LlamacppOpenAIAdapter / chat-completions.ts route un-typeable — `tsc --noEmit` fails with "missing properties chatCompletionsCanonical / chatCompletionsCanonicalStream". Task 1's verify gate cannot pass under the literal action ordering.
- **Fix:** Keep `adapter.ts` on the Phase 3 shape for Task 1 (canonical.ts + tests only); apply the interface swap atomically with the adapter implementations + route refactor in Task 3. The plan's Task 3 verify + grep gates still gate the end state (`grep -c "from 'openai/resources/chat/completions'" router/src/backends/adapter.ts` is 0; old method names absent from production code).
- **Files modified:** None additional — same files as plan; just re-sequenced.
- **Verification:** Final `tsc --noEmit` + full vitest run + all 4 plan grep gates green.
- **Committed in:** `61c8a91` (Task 3)

**2. [Rule 1 - Bug] Lost prompt_tokens on streaming /v1/chat/completions usage chunk**
- **Found during:** Task 3 verify (`npx vitest run tests/integration/chat-completions`)
- **Issue:** Initial `openAIChunksToCanonicalEvents` impl emitted `message_start` with `input_tokens: 0` and `canonicalToOpenAISse` composed the final usage chunk from that captured value — but the existing Phase 2 integration test (`chat-completions.stream.test.ts:123`) asserts `usageChunk.usage.prompt_tokens === 7` from the upstream's final usage chunk. The plan's Task 3 done criterion explicitly says "Existing Phase 2/3 integration suite ... is fully green after refactor — same wire output for /v1/chat/completions". The canonical event union forbids `input_tokens` on message_delta (Anthropic semantics).
- **Fix:** Added a `_upstreamInputTokens` non-enumerable carrier on `message_delta.usage` via `Object.defineProperty(..., enumerable:false)` (same pattern as `_upstreamId` on canonical responses — T-04-A2 mitigation pattern). `openAIChunksToCanonicalEvents` attaches the upstream `prompt_tokens` when the upstream usage chunk arrives; `canonicalToOpenAISse` reads the carrier when composing the wire-format final usage chunk. Plan 03 will swap to a route-supplied `inputTokensHint` per the plan's must_haves bullet ("Plan 03 wires the route-supplied inputTokensHint so the final value at the route boundary is correct").
- **Files modified:** `router/src/translation/openai-out.ts`
- **Verification:** `chat-completions.stream.test.ts > final non-[DONE] chunk has usage.{prompt_tokens,completion_tokens,total_tokens}` now passes with `prompt_tokens=7, completion_tokens=3, total_tokens=10`. Full suite green.
- **Committed in:** `61c8a91` (Task 3)

**3. [Rule 1 - Bug] Phase 2/3 test scaffolding referenced removed BackendAdapter method names**
- **Found during:** Task 3 verify (`npx tsc --noEmit`)
- **Issue:** `tests/unit/factory.test.ts` asserted `typeof adapter.chatCompletions === 'function'` / `typeof adapter.chatCompletionsStream === 'function'`; `tests/integration/chat-completions.stream.test.ts` declared a `MockAbortAdapter implements BackendAdapter` with the old OpenAI-typed methods. Both fail tsc immediately after the adapter.ts widening lands. Required to keep the existing Phase 2/3 suite green (plan must_haves bullet 5).
- **Fix:** factory.test.ts asserts the new method names; MockAbortAdapter rewritten to implement `chatCompletionsCanonical` / `chatCompletionsCanonicalStream` with synthesized canonical stream events (`message_start` → many `content_block_delta {text_delta}` → `message_stop`).
- **Files modified:** `router/tests/unit/factory.test.ts`, `router/tests/integration/chat-completions.stream.test.ts`
- **Verification:** Both files now type-check and pass; SC3 abort propagation assertion preserved.
- **Committed in:** `61c8a91` (Task 3)

---

**Total deviations:** 3 auto-fixed (1 Rule 3 sequencing, 2 Rule 1 regression fixes caused by the planned refactor).
**Impact on plan:** All three are scope-conforming — the refactor is exactly what the plan called for; the deviations only re-sequence work to fit per-task tsc gates and add the `_upstreamInputTokens` carrier to satisfy the plan's "Phase 2/3 integration suite stays green" requirement. No scope creep.

## Issues Encountered

- **Zod v4 + recursive discriminated union:** `z.lazy()` doesn't expose `_zod.propValues` for `z.discriminatedUnion` discriminator resolution, surfaced as `TS2345: Argument of type ... is not assignable to parameter of type 'readonly [$ZodTypeDiscriminable<"type">, ...]'`. Resolved by promoting the recursive case (`ToolResultBlock.content` containing `ContentBlock[]`) to a non-recursive sub-union (`ToolResultContentBlockSchema` — text + image only), which is faithful to Anthropic's actual wire-format restriction.
- **vitest 4.x `--reporter=basic` removal:** Plan-specified flag fails at boot (`ERR_LOAD_URL: Failed to load url basic`). Ran without the flag; output is functionally equivalent.

## User Setup Required

None — no external service configuration required for this plan.

## Forward-Handoff Notes for Plan 02

### Where `openAIChunksToCanonicalEvents` needs the input_tokens revisit

`router/src/translation/openai-out.ts` line ~310 in the `openAIChunksToCanonicalEvents` async generator:

```ts
if (!started) {
  started = true;
  const startMessage: CanonicalResponse = {
    ...
    usage: { input_tokens: 0, output_tokens: 1 },   // ← Plan 03 fixes
  };
```

Plan 03 should:
1. Add an `inputTokensHint?: number` field to the `OpenAIChunksToCanonicalOpts` interface.
2. Pre-count input tokens in the route handler (or earlier in the adapter) using `gpt-tokenizer` (cl100k_base — the tokenizer Plan 02 introduces for `/v1/messages/count_tokens` per D-E1) and pass via `inputTokensHint`.
3. Use the hint instead of `0` on `message_start.message.usage.input_tokens`.
4. Drop the `_upstreamInputTokens` non-enumerable carrier on `message_delta.usage` — it's a temporary bridge while the canonical stream lacks the correct `input_tokens` on `message_start`.

### Tokenizer module loading (forward-compat with Plan 02)

`canonical.ts` does NOT load `gpt-tokenizer` yet. Plan 02 (D-E1) loads the cl100k_base encoder at module-load (one singleton, no per-request cost) for `/v1/messages/count_tokens`. The natural home is `router/src/translation/count-tokens.ts` (new file) — keeping it in a sibling translator file rather than `canonical.ts` so `canonical.ts` stays free of network-relevant cost (small bundle for downstream consumers).

### ULID monotonic factory behavior under tests

`newMessageId()` and `newToolUseId()` share ONE module-level `monotonicFactory()` instance. Within a single Node process this guarantees lexicographic ordering across both helpers in the same millisecond (verified by `canonical.test.ts > newMessageId is monotonic within the same ms`). Plan 02's `/v1/messages` route + count_tokens stub can rely on this — no per-request factory needed.

### Adapter-side helpers Plan 04 may want to reuse

`openai-in.ts` exports `canonicalToOpenAIChatCompletionParams(canonical)` — used by both adapters to translate canonical → OpenAI body. Plan 04 (TOOL-01..04) should extend THIS function (not duplicate it) to add `tools` / `tool_choice` / `parallel_tool_calls` mapping. Same for `openai-out.ts`'s `openAIChatCompletionToCanonical` / `openAIChunksToCanonicalEvents` (add tool_use → tool_calls + input_json_delta partial args).

## Next Plan Readiness

Plan 02 can now:
- Import `CanonicalRequest` / `CanonicalResponse` / `CanonicalStreamEvent` from `router/src/translation/canonical.js` — types are stable.
- Use `anthropicRequestToCanonical` from `router/src/translation/anthropic-in.js` as the base — extend with role-alternation refinement + tool_result-before-text ordering.
- Use `canonicalToAnthropicResponse` from `router/src/translation/anthropic-out.js` (identity map) for the non-stream `/v1/messages` branch.
- Call `adapter.chatCompletionsCanonical(canonical, signal)` — the seam is in place; both Ollama + llama.cpp adapters honor it.
- The Wave-0 test scaffolds at `router/tests/translation/anthropic-{in,out}.test.ts` + `router/tests/translation/count-tokens.test.ts` (Plan 02 creates) are ready to extend.

Plan 03 can take over the streaming work on top of `canonicalToAnthropicSse` (currently a Plan 01 stub — emits `{event:'message_stop'}` per input event).

Plan 04 can extend `openai-in.ts` / `openai-out.ts` with tools. Plan 05 can flesh out `ollama-native-out.ts` with the URL-fetch + base64-strip + images[] vision path.

## Self-Check: PASSED

Verified:
- All 21 files (14 created, 7 modified) exist on disk.
- All 3 task commits present in `git log`: `f7f938a` (Task 1), `fa47f98` (Task 2), `61c8a91` (Task 3).
- Final `npx tsc --noEmit` exits clean.
- `npx vitest run` shows 30 test files / 206 passed / 2 skipped.
- All 4 plan grep gates green (no old method names in production code, no openai/resources import in adapter.ts, route imports canonical translators, adapters import canonical types).
- ulid@^3.0.2 in `router/package.json` dependencies.

---
*Phase: 04-anthropic-surface-v1-messages-tool-calling-vision*
*Plan: 04-01*
*Completed: 2026-05-13*
