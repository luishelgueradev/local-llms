---
phase: 19-embeddingprovider-formalization-observability-hardening
plan: 08
reviewed: 2026-06-02T00:00:00Z
depth: standard
files_reviewed: 3
files_reviewed_list:
  - router/src/translation/openai-out.ts
  - router/src/translation/__tests__/openai-out.tool-call-streaming.test.ts
  - bin/smoke-test-router.sh
findings:
  critical: 0
  warning: 4
  info: 3
  total: 7
status: issues_found
---

# Phase 19-08: Code Review Report

**Reviewed:** 2026-06-02
**Depth:** standard
**Files Reviewed:** 3
**Status:** issues_found

## Summary

Plan 19-08 lands the upstream `delta.tool_calls[]` translation branch in `openAIChunksToCanonicalEvents`, a 4-case vitest regression net, and a one-line `tool_choice:"required"` hardening of the `RESS-WITH-TOOLS` smoke gate. The translator change is byte-precisely placed and the unit-test net covers the four nominal patterns. Type-safety and shape contracts are mostly preserved.

However the diff perpetuates one downstream contract defect (the translator's design for case (d) — interleaved tool_calls at distinct block indices — collides with the single-slot FSM in `responses-stream.ts`, silently losing the first parallel tool call), carries dead state (`argsBuffer` is written every chunk but never read), and propagates a pre-existing bash-trap clobbering pattern in the smoke test. The vitest cases also lean heavily on `as unknown as …` escape hatches that bypass the shape check the suite is meant to enforce.

Scope fence is honored: `responses-stream.ts`, `package.json`, `package-lock.json`, and milestone metadata are untouched.

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: Case (d) — parallel `tool_calls` at distinct block indices collide with single-slot FSM (silent data loss downstream)

**File:** `router/src/translation/openai-out.ts:613-656`
**Issue:** The translator opens tool_use block 2 (`content_block_start`) **before** closing tool_use block 1 (no intervening `content_block_stop` is emitted between two parallel `tool_calls` that arrive in the same chunk — see case (d) in the new test). This matches the plan's stated invariant "interleaved tool_calls with different index values produce independent canonical content blocks at distinct block indices" — but the downstream FSM at `router/src/translation/responses-stream.ts:309-318` is single-slotted (`fsm = { kind: 'function_call', itemId, outputIndex, callId, name, argsAccumulated: '' }`). When the second `content_block_start(tool_use)` arrives without a prior `content_block_stop` for block 1, the FSM **overwrites** the in-flight block-1 state. Block 1's accumulated `argsAccumulated` is dropped; only one `response.output_item.done` ever fires; `outputItems[]` ends up missing one of the two parallel tool calls in `response.completed.output[]`.

The unit test verifies what the translator emits in isolation, but never wires the events through `responsesCanonicalEventsToSse`, so the test passes while real downstream behavior loses data on parallel tool calls.

**Note on out-of-scope fence:** The plan fences `responses-stream.ts` — but the fix here belongs in the *translator*, not the FSM. Either (a) close-before-open for tool_use blocks too (serialize parallel tool calls into sequential canonical blocks, same pattern used for the text→tool_use transition at lines 635-638), or (b) the case (d) test should additionally pipe through `responsesCanonicalEventsToSse` and assert both `response.output_item.done` events are emitted.

**Fix:**
```typescript
// Before opening a new tool_use block, close ALL previously-opened tool_use blocks
// to satisfy the responses-stream FSM single-slot invariant.
if (!state.opened) {
  if (textBlockOpen) {
    yield { type: 'content_block_stop', index: 0 };
    textBlockOpen = false;
  }
  // NEW: close any previously-opened tool_use blocks so the FSM sees them
  // as fully closed before the next opens.
  for (const [, prev] of toolCallState) {
    if (prev !== state && prev.opened) {
      yield { type: 'content_block_stop', index: prev.blockIndex };
      prev.opened = false;
    }
  }
  yield {
    type: 'content_block_start',
    index: state.blockIndex,
    content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
  };
  state.opened = true;
}
```

Then extend the case (d) test to assert the per-block `content_block_stop` ordering: `stop(1)` MUST appear before `start(2)`.

---

### WR-02: `argsBuffer` is dead state — written on every fragment, never read

**File:** `router/src/translation/openai-out.ts:547,626,648`
**Issue:** The per-`tool_call.index` state record declares `argsBuffer: string`, initializes it to `''`, and appends every non-empty fragment via `state.argsBuffer += argFrag` — but the field is never read anywhere in this file or downstream (the FSM does its own accumulation in `argsAccumulated`). This is unused state that wastes one allocation + concatenation per fragment on the hot streaming path, and signals to readers that something downstream depends on it when nothing does.

**Fix:** Remove `argsBuffer` from the record type and the two write sites:
```typescript
const toolCallState = new Map<
  number,
  { id: string; name: string; blockIndex: number; opened: boolean }
>();
// ...
state = { id: tc.id, name: tc.function.name, blockIndex, opened: false };
// ...
// drop `state.argsBuffer += argFrag;` — the input_json_delta event itself carries the fragment.
```

---

### WR-03: New `trap 'rm -f' EXIT` at line 2583 clobbers earlier traps (tempfile leaks)

**File:** `bin/smoke-test-router.sh:2583`
**Issue:** Line 2583 — `trap 'rm -f "${RESS_TOOLS_FILE}"' EXIT` — installs a NEW EXIT trap that replaces the existing one. Earlier traps at lines 2218 (`RESS_TMP`) and 2318 (`RESP1_FILE`) are silently dropped, leaking `/tmp/ress-smoke-*.sse` and `/tmp/sess-smoke-*.txt` files on any subsequent abnormal exit after line 2583 fires. The "Append-only trap so we don't blow away earlier traps" comment at line 2217 is already factually wrong for the chain at 2218 → 2318; the new 2583 trap perpetuates the bug.

This is pre-existing behavior, but 19-08 propagates the broken pattern. If the script aborts during/after the RESS-WITH-TOOLS gate, only `RESS_TOOLS_FILE` is removed; the two earlier tempfiles are orphaned.

**Fix:** Use a single accumulating cleanup variable:
```bash
# At top of script, near line 186:
CLEANUP_FILES=()
cleanup_files() { for f in "${CLEANUP_FILES[@]}"; do rm -f "$f"; done; }
trap cleanup_files EXIT

# Each site:
RESS_TOOLS_FILE=$(mktemp /tmp/ress-tools-XXXXXX.txt)
CLEANUP_FILES+=("${RESS_TOOLS_FILE}")
# (drop the per-site `trap 'rm -f ...' EXIT` lines)
```

---

### WR-04: Vitest cases lean on `as unknown as ChatCompletionChunk['choices'][number]['delta']` — bypasses the shape check the tests claim to enforce

**File:** `router/src/translation/__tests__/openai-out.tool-call-streaming.test.ts:50, 150, 166, 182, 357`
**Issue:** Every test fixture casts the synthetic delta through `as unknown as …` (and the whole chunk through `as ChatCompletionChunk`). This silences TypeScript's structural check entirely — if the OpenAI SDK changes `ChatCompletionChunk` (e.g., adds a required field, renames `tool_calls`, changes the index type), the tests stay green while the production translator silently fails. The double-cast `as unknown as ChatCompletionChunk['choices'][number]['delta']` is a documented TypeScript escape hatch that should be used reluctantly; here it appears at every test fixture because the `delta.tool_calls` shape is being asserted as it would arrive from the wire.

The SDK already exposes `ChatCompletionChunk['choices'][number]['delta']['tool_calls']` natively — the tests should be constructable WITHOUT bypassing the type. The shape is `Array<{ index, id?, type?, function? }>` and that matches what the test fixtures declare.

**Fix:** Build the chunk fixtures with a typed helper that satisfies the SDK type directly:
```typescript
import type { ChatCompletionChunk } from 'openai/resources/chat/completions.js';

function chunk(delta: ChatCompletionChunk.Choice.Delta, finish_reason: ChatCompletionChunk.Choice['finish_reason'] = null, usage?: ChatCompletionChunk['usage']): ChatCompletionChunk {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'x',
    choices: usage ? [] : [{ index: 0, delta, finish_reason, logprobs: null }],
    ...(usage ? { usage } : {}),
  };
}
```
…then each case site is `chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_X', type: 'function', function: { name: 'get_time', arguments: '{}' } }] }, 'tool_calls')` with no casts.

## Info

### IN-01: `nextToolBlockIndex` initialization is misleading; comment claims "starts at 0" but the pre-increment makes the first allocated index 1

**File:** `router/src/translation/openai-out.ts:480, 549, 622`
**Issue:** The header comment (line 480) says "`nextToolBlockIndex` starts at 0 (text block reserves index 0)". The init is `let nextToolBlockIndex = 0`. But the consumer is `const blockIndex = ++nextToolBlockIndex` (pre-increment), so the **first** tool_use block gets `blockIndex = 1`. Reading the line in isolation, a reviewer would expect post-increment to allocate `0` and then bump to `1`. The semantics are correct (text reserves 0, tools start at 1) but the variable name + initialization invite confusion.

**Fix:** Initialize at `-1` and use post-increment, or rename to `lastToolBlockIndex` so pre-increment reads naturally:
```typescript
let lastAllocatedToolBlockIndex = 0; // text reserves index 0
// ...
const blockIndex = ++lastAllocatedToolBlockIndex; // first call yields 1, then 2, ...
```

---

### IN-02: Case (b) does not verify the empty-string fragment is silently swallowed

**File:** `router/src/translation/__tests__/openai-out.tool-call-streaming.test.ts:131-249`
**Issue:** Case (b)'s narrative comment (lines 221-222) says "Chunk 1's empty-string args fragment produces NO delta event per the contract", and the test asserts the total count of `content_block_delta` events is 2 (one per non-empty fragment). But the test does NOT explicitly verify that an empty-string `arguments` fragment is the contract path — if the translator were to emit an empty `input_json_delta` for chunk 1, the count would jump to 3 and the test would fail, which is fine. But the test couples the empty-string semantics to the total count. A more direct assertion would explicitly verify that the only `partial_json` values present are the two non-empty fragments AND that none is the empty string. Today's assertion accidentally passes both contracts.

**Fix:** Add an explicit check:
```typescript
const partialJsonValues = cbDeltas.map((d) =>
  d.delta.type === 'input_json_delta' ? d.delta.partial_json : null
);
expect(partialJsonValues).not.toContain('');
expect(partialJsonValues).toEqual(['{"loc', 'ation":"Paris"}']);
```

---

### IN-03: Plan-19-08 docstring at lines 476-483 cites only the debug file; would benefit from a one-line behavior contract for downstream consumers

**File:** `router/src/translation/openai-out.ts:472-484`
**Issue:** The docstring explains the per-iteration state shape and references `.planning/debug/ress-with-tools-empty-output.md` for the bug history — but does NOT state the wire contract a downstream FSM relies on: "every `content_block_start(tool_use)` is paired with a `content_block_stop` at the same `index` before `message_delta`, AND no two tool_use blocks are simultaneously open." Future maintainers extending this function for additional adapters need this invariant called out explicitly so they don't accidentally interleave.

**Fix:** Add a one-line sentence to the docstring summarizing the wire contract:
> Wire contract: each `content_block_start{ type:'tool_use', index:K }` is matched by `content_block_stop{ index:K }` before `message_delta`. The translator allocates block indices monotonically; text block reserves index 0. Two tool_use blocks MAY be opened simultaneously when the upstream emits parallel `tool_calls` in one chunk — but see WR-01 for the FSM-compat concern.

---

_Reviewed: 2026-06-02_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
