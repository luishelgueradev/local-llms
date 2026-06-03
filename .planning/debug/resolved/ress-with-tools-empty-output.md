---
status: resolved
trigger: "Smoke gate RESS-WITH-TOOLS fails when OLLAMA_API_KEY is exported: /v1/responses streaming completion event has output: [] and zero function_call_arguments.delta events, even though incomplete_details.reason='tool_calls' and usage.output_tokens>0."
goal: find_and_fix
created: 2026-06-02T10:48:33Z
updated: 2026-06-02T11:20:00Z
resolved: 2026-06-03T02:30:00Z
resolved_by: "Plan 19-09 (commit 7afbd96) — deployment-only rebuild closed the gap"
diagnosed: 2026-06-02T11:20:00Z
---

## Current Focus

hypothesis: **CONFIRMED.** Lead (L1) — the OpenAI-chunks → canonical streaming translator in `router/src/translation/openai-out.ts` (function `openAIChunksToCanonicalEvents`, lines 525-615) handles ONLY `choice.delta.content` (text). It has NO branch for `choice.delta.tool_calls[]`. The upstream `chat.completion.chunk` carrying the tool_call delta is silently dropped at the OpenAI-→-canonical boundary. The only signal that survives is `finish_reason: "tool_calls"`, which maps to canonical `stop_reason: "tool_use"`, which the Responses FSM (`responses-stream.ts:454,470`) reads to set `status:"incomplete"` + `incomplete_details.reason:"tool_calls"` — with an EMPTY `outputItems[]` because no canonical `content_block_start (tool_use)` ever fired.

  The author of `openai-out.ts` actually documented the gap explicitly at lines 476-481:

      // NOTE: tool_use chunk-to-canonical translation is not added here in Plan 04-04 —
      // [...] Upstream tool_calls in OpenAI chunks would require accumulating arguments
      // fragments across chunks before emitting input_json_delta canonical events;
      // that's a follow-up since the current adapters (Ollama, llama.cpp) handle
      // tool_calls via the non-stream response branch in practice.

  That assumption is wrong for the `/v1/responses` SSE surface introduced in Phase 16 (RESS-01..05): it ALWAYS streams when `stream:true`, and gpt-oss:20b-cloud reliably emits the tool_call delta inside a single chunk (verified 5/5 upstream runs). So the surface has never produced a function_call output item, with or without empty arguments — the bug fires whether arguments are `{}` or `{"foo":1}`.

test: Verified by three orthogonal captures.

  (T1) Direct upstream capture against `https://ollama.com/v1/chat/completions` (`/tmp/upstream-raw-run-1..5.txt`): with `tool_choice:"required"`, 5/5 runs emit a SINGLE chunk carrying `delta.tool_calls:[{id, index:0, type:"function", function:{name:"get_time", arguments:"{}"}}]` AND `finish_reason:"tool_calls"`. Upstream is well-behaved.

  (T2) Router-emitted SSE capture (`/tmp/router-run-1..5.txt`): 5 runs through `http://127.0.0.1:3210/v1/responses` with the same payload. 3/5 took the tool-call path on the router (the model occasionally returns text even with `tool_choice:"required"` on this gpt-oss SKU). ALL 3 tool-path runs produced: `fcad=0 fcdone=0 oia_fn=0` (zero function_call events of any kind) and a completed payload with `status=incomplete reason=tool_calls out_len=0`. Exactly the bug shape the operator reported.

  (T3) Static-read of `openai-out.ts` function body (lines 538-615): the only `case` for `choice.delta.*` is text content via `deltaContent = choice?.delta?.content`. There is no read of `choice.delta.tool_calls`. The function `openAIFinishToCanonicalStop` (line 508) DOES map `finish_reason:'tool_calls'` → canonical `stop_reason:'tool_use'`, which is why the FSM's `isToolCall` flag fires but `outputItems[]` stays empty — exactly the asymmetry the operator observed.

expecting: All three predictions held. The bug is router-side. Empty-args (`{}`) is NOT a red herring — the bug fires the same way for any args because the entire `delta.tool_calls[]` branch is missing, not just an empty-args edge case.

next_action: Resolution recommends a code fix in `openai-out.ts` (option A1) plus an optional smoke-gate clarification (option A2). Awaiting operator decision via AskUserQuestion: (1) apply the router-side fix now, (2) plan the fix as a Phase 19 follow-up gap, or (3) hand back for manual implementation.

## Symptoms

expected: |
  The smoke gate `RESS-WITH-TOOLS` at `bin/smoke-test-router.sh:2589-2620` sends a streaming `/v1/responses` request with a function-calling cloud model (`gpt-oss:20b-cloud`) and a single `get_time` tool. It asserts that BOTH of these are present in the SSE stream:
    1. At least one `event: response.function_call_arguments.delta`
    2. A `response.completed` event whose payload contains `"status":"incomplete"` AND `"reason":"tool_calls"`
  When OLLAMA_API_KEY is exported, the gate should pass.

actual: |
  When OLLAMA_API_KEY is exported and the operator runs the smoke harness (or hits the router directly via curl), the streaming response shows:
    - The `response.completed` event's payload has `output: []` (EMPTY) even though `usage.output_tokens` is non-zero (observed 106 and 135 across two captures by the operator; 27..47 across 5 reproductions by the debugger).
    - `incomplete_details.reason` IS `"tool_calls"` — the upstream signaled tool-use intent.
    - ZERO `response.function_call_arguments.delta` events emitted.
    - ZERO `response.output_item.added` events for a function_call item.
  With `tool_choice:"required"`, the empty-output tool-call path is hit ~60% of the time on this gpt-oss:20b-cloud SKU (3/5 in the debugger's batch; non-deterministic). Without `tool_choice:"required"`, the model is even more likely to drift to a plain-text response.

errors: |
  Captured `response.completed` payload (relevant subset):
    {
      "status": "incomplete",
      "incomplete_details": { "reason": "tool_calls" },
      "output": [],
      "usage": {
        "input_tokens": 0,
        "output_tokens": 135,
        "total_tokens": 135
      }
    }

reproduction: |
  export OLLAMA_API_KEY=$(grep -E '^OLLAMA_API_KEY=' .env | head -1 | sed 's/^OLLAMA_API_KEY=//' | tr -d '"' | tr -d "'")
  TOKEN=$(grep -E '^ROUTER_BEARER_TOKEN=' .env | head -1 | sed 's/^ROUTER_BEARER_TOKEN=//' | tr -d '"' | tr -d "'")
  curl -sS -N --max-time 60 -X POST "http://127.0.0.1:3210/v1/responses" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{
      "stream": true,
      "model": "gpt-oss:20b-cloud",
      "input": "Call get_time to fetch the current UTC time.",
      "tools": [{
        "type": "function",
        "name": "get_time",
        "description": "Get the current UTC time in ISO-8601 format.",
        "parameters": {"type":"object","properties":{},"required":[]}
      }],
      "tool_choice": "required"
    }'

started: |
  The gate was added by commit 7ffbba3 (feat(19-06): smoke Phase 19 section — OBSV-02-LIVE + RESS-WITH-TOOLS + cite lines).
  First observed failing during the Phase 19 review smoke verification loop iter 2 (2026-06-02), the first iteration where OLLAMA_API_KEY was deliberately exported. Iter 1 and iter 3 (default invocation, no OLLAMA_API_KEY exported) are green because the gate is skipped when the key is absent.
  NOT introduced by Phase 19 — Phase 19 only touched embeddings, observability, and the smoke script's OBSV-02-LIVE invocation. The /v1/responses streaming surface is from Phase 16 (RESS-01..05). The bug pre-dates Phase 19 by months: it has been latent since Plan 04-04 made the explicit decision to defer upstream-tool_calls streaming translation (openai-out.ts:476-481). The smoke gate added in Phase 19 surfaced the latent bug for the first time.

## Scope + Context

- **Goal:** find_and_fix (default; the operator can decide to stop at the root-cause report or proceed to a fix; no auto-commit of production changes without explicit confirmation).
- **Logs + artifacts produced during investigation:**
  - `/tmp/upstream-raw-tool-call.txt` — single direct upstream capture (this run, the model chose text not tool — `finish_reason:"stop"`, demonstrating the model's non-determinism).
  - `/tmp/upstream-raw-run-1.txt` .. `/tmp/upstream-raw-run-5.txt` — 5 successive direct upstream captures with `tool_choice:"required"`; ALL 5 emit `delta.tool_calls` in a single chunk.
  - `/tmp/router-emitted-stream.txt` — single direct router capture (this run, model also returned text).
  - `/tmp/router-run-1.txt` .. `/tmp/router-run-5.txt` — 5 successive router captures via `127.0.0.1:3210/v1/responses` with `tool_choice:"required"`; 3/5 hit the tool path, ALL 3 show the bug shape.

## Suspect Surfaces (initial leads — verify, don't assume)

1. **`router/src/translation/responses-stream.ts`** — Phase 16 canonical-event → `/v1/responses` SSE translator. Lines 320–417 handle `content_block_start` / `content_block_delta` / `content_block_stop` for function_call items. ✅ VERIFIED CORRECT during this investigation. The FSM does the right thing IF it ever receives canonical `content_block_start (tool_use)` → `content_block_delta (input_json_delta)` → `content_block_stop`. It NEVER does in the bug path.

2. **OpenAI-chunks → canonical translator** — located at `router/src/translation/openai-out.ts`, function `openAIChunksToCanonicalEvents` lines 525-615. ✅ **THIS IS THE ROOT CAUSE SITE.** No `delta.tool_calls[]` branch exists; only `delta.content` (text) is handled. Documented as a deferred follow-up at lines 476-481.

3. **`outputItems.push(completedItem)` site in responses-stream.ts:408** — ✅ verified correct. The function_call branch at lines 410-440 also pushes via `outputItems.push(completedItem)` at line 438. The issue is upstream of this site: `content_block_stop` for the function_call never reaches the FSM because no `content_block_start (tool_use)` ever fires.

4. **Ollama Cloud's raw chunks** — ✅ VERIFIED. The upstream IS well-behaved: `delta.tool_calls:[{id, index, type:"function", function:{name, arguments:"{}"}}]` arrives in a single chunk with `finish_reason:"tool_calls"`. 5/5 runs confirmed. **Eliminates hypothesis L2.**

## Acceptance / Done-when

(A) **Router-side bug** — translator drops the function_call item when args are empty. ✅ **THIS BRANCH FIRED.** The bug is broader than empty-args: ALL upstream tool_calls are dropped (empty args is a coincidental symptom of the smoke-gate's example tool having no parameters). Fix scope: add a `delta.tool_calls[]` handling branch to `openAIChunksToCanonicalEvents`.

(B) **Upstream behavior** — Ollama Cloud's gpt-oss:20b-cloud does not emit tool_call chunks. ❌ ELIMINATED — 5/5 upstream runs emit the tool_call delta correctly.

(C) **Smoke-gate logic bug** — chained `&& grep -q` interaction. ❌ ELIMINATED — the gate logic at `bin/smoke-test-router.sh:2601-2615` is correct; it genuinely returns COMPLETED_OK=0 because the router does not emit the events. (Side note: the gate doesn't pass `tool_choice:"required"`, so even after the router fix lands the gate may flake on this gpt-oss SKU's non-determinism. Recommend the operator harden the gate by adding `"tool_choice":"required"` to the body, then it should be 60-70% reliable per the empirical rate observed.)

## Eliminated

- hypothesis: "Ollama Cloud's gpt-oss:20b-cloud does not emit tool_call chunks at all (or emits malformed ones) for empty-arg tools."
  evidence: |
    5 successive direct captures of `https://ollama.com/v1/chat/completions` with `{"stream":true, "tool_choice":"required", "tools":[{...get_time...}]}` (`/tmp/upstream-raw-run-1..5.txt`). Every run emitted exactly ONE choices-bearing chunk carrying:
      "delta":{"role":"assistant","content":"","tool_calls":[{"id":"call_XXX","index":0,"type":"function","function":{"name":"get_time","arguments":"{}"}}]},
      "finish_reason":"tool_calls"
    followed by the usage-only chunk and `data: [DONE]`. The upstream wire shape is clean, fragmented-free, and matches the OpenAI Chat Completions streaming spec for tool calls. There is nothing for the router to "miss" due to malformed input.
  timestamp: 2026-06-02T11:05:00Z

- hypothesis: "Smoke-gate shell logic / pipefail / grep interaction breaks the `DELTA_OK && COMPLETED_OK` chain on iter 2 while direct repro on the same stack shows the substrings present."
  evidence: |
    Read of `bin/smoke-test-router.sh:2573-2622`. The gate's two assertions are simple single-pattern greps on a file (`grep -q PATTERN "${RESS_TOOLS_FILE}"`), each setting a separate `_OK` flag. No piping, no pipefail subtleties, no env-dependent shelling. The chained `if [[ DELTA_OK -eq 1 && COMPLETED_OK -eq 1 ]]` is the only conjunction and it's a Bash arithmetic-conditional inside `[[ ]]`. Direct router capture in this investigation (`/tmp/router-run-1..5.txt`) confirmed `fcad=0` (zero `response.function_call_arguments.delta` events) on every tool-path run — the gate is correctly reporting the absence of events, not masking a different issue.
  timestamp: 2026-06-02T11:10:00Z

## Evidence

- timestamp: 2026-06-02T10:50:00Z
  checked: |
    File map of `router/src/translation/` — `find` to enumerate translators, then `grep -rn "tool_call"` across the directory to catalog every site that mentions tool_calls or tool_use.
  found: |
    9 translation files: `openai-out.ts`, `anthropic-out.ts`, `responses-stream.ts`, `ollama-native-out.ts`, `openai-in.ts`, `anthropic-in.ts`, `canonical.ts`, `count-tokens.ts`, `jsonValidation.ts`.
    `responses-stream.ts` has the FSM that emits `/v1/responses` events. Lines 309-336 handle `content_block_start` of type `tool_use` (FSM transition idle → function_call, emits `response.output_item.added`). Lines 357-369 handle `content_block_delta` of type `input_json_delta` (emits `response.function_call_arguments.delta`). Lines 410-440 handle `content_block_stop` for the function_call branch (emits `response.function_call_arguments.done` + `response.output_item.done` and pushes the completed item into `outputItems[]` which is serialized into `response.completed.output[]` at line 469).
    `openai-out.ts` has `openAIChunksToCanonicalEvents` at line 525 — the upstream-OpenAI-chunks-to-canonical streaming translator. Comment at lines 476-481 EXPLICITLY documents that upstream tool_calls are NOT translated to canonical events here, citing the Plan 04-04 decision to defer.
  implication: |
    The Responses FSM is correctly wired to PRODUCE function_call events IF it receives canonical tool_use content blocks. The upstream-chunks-to-canonical translator is the only seam where a delta.tool_calls[] would need to be converted into canonical `content_block_start (tool_use)` + `input_json_delta` + `content_block_stop` events. If that conversion is missing, the FSM stays in the `idle` state during the tool-call segment and never produces function_call events — exactly the bug shape.

- timestamp: 2026-06-02T10:55:00Z
  checked: |
    Static read of `openAIChunksToCanonicalEvents` body (`openai-out.ts:525-615`).
  found: |
    The function iterates `chunks`, emits `message_start` on the first chunk (line 539), captures `finish_reason` from any choices-bearing chunk (line 564), and emits text content_blocks ONLY when `deltaContent !== ''` (line 568). The only delta field read from `choice.delta` is `.content` (`deltaContent = typeof choice?.delta?.content === 'string' ? choice.delta.content : '';` at line 561). There is no read of `choice.delta.tool_calls`. The terminator emits `message_delta` with `stop_reason: openAIFinishToCanonicalStop(upstreamFinishReason)` (line 596) — and `openAIFinishToCanonicalStop` at line 514 maps `'tool_calls' → 'tool_use'`. So when the upstream's last chunk has `finish_reason:'tool_calls'`, the canonical message_delta carries `stop_reason:'tool_use'`, which is what `responses-stream.ts:454,470` reads to flip `isToolCall = true` and emit `incompleteDetails: { reason: 'tool_calls' }`. But because no `content_block_start (tool_use)` ever fired, `outputItems[]` stays empty.
  implication: |
    Root cause site identified with byte-level precision. The fix needs to add a `delta.tool_calls[]` handling branch that:
      1. On first sighting of `delta.tool_calls[i].id` + `delta.tool_calls[i].function.name` (or `index`), emit canonical `content_block_start` of type `tool_use` with `id` (matching upstream call_id), `name`, and `input: {}`.
      2. On each subsequent fragment of `delta.tool_calls[i].function.arguments`, emit canonical `content_block_delta` with `type: 'input_json_delta'` and `partial_json: <fragment>`.
      3. When the upstream segment terminates (either next non-tool delta, or finish_reason set), emit canonical `content_block_stop` for that index.
    Per the upstream capture (T1), in practice for gpt-oss:20b-cloud the entire tool_call arrives in a SINGLE chunk (id + name + complete arguments string), so the implementation can be simple: single chunk → emit start + (optional delta if arguments non-empty) + stop atomically.

- timestamp: 2026-06-02T11:00:00Z
  test_id: T1
  checked: |
    Direct upstream capture against `https://ollama.com/v1/chat/completions` to settle hypothesis L2 (upstream behavior). 5 runs with identical payload + tool_choice:"required".
    $ for i in 1..5: curl -sS -N -X POST https://ollama.com/v1/chat/completions \
        -H "Authorization: Bearer ${OLLAMA_API_KEY}" \
        -H "Content-Type: application/json" \
        -d '{"stream":true,"stream_options":{"include_usage":true},"model":"gpt-oss:20b-cloud","messages":[{"role":"user","content":"Call get_time to fetch the current UTC time."}],"tools":[{"type":"function","function":{"name":"get_time","description":"...","parameters":{...}}}],"tool_choice":"required"}'
  found: |
    All 5 runs emit a SINGLE choices-bearing chunk with the complete tool_call:
      "delta":{
        "role":"assistant",
        "content":"",
        "tool_calls":[{
          "id":"call_n2bhetfy" (varies per run),
          "index":0,
          "type":"function",
          "function":{"name":"get_time","arguments":"{}"}
        }]
      },
      "finish_reason":"tool_calls"
    Followed by usage-only chunk (`choices:[], usage:{...}`) and `data: [DONE]`. Token counts: 27, 28, 28, 47, 33.
    A separate single-run direct upstream capture WITHOUT tool_choice (default `tool_choice:"auto"`) showed the model producing only reasoning chunks (the gpt-oss `delta.reasoning` chain-of-thought scratchpad) and then `finish_reason:"stop"` — no tool_call at all, no text answer either (model "thought" then stopped without acting). This confirms the operator's note about non-determinism and motivates the smoke-gate adding `tool_choice:"required"`.
  implication: |
    L2 eliminated decisively. Upstream is well-formed and reliable when `tool_choice:"required"` is set. The router has no excuse — the data is there, it's just being ignored at the openAIChunksToCanonicalEvents boundary.

- timestamp: 2026-06-02T11:10:00Z
  test_id: T2
  checked: |
    Direct router capture via `http://127.0.0.1:3210/v1/responses` to verify the bug fires through the full router pipeline. 5 runs with identical payload + tool_choice:"required". Per-run event-type tallies extracted via grep:
      fcad   = count of `event: response.function_call_arguments.delta`
      fcdone = count of `event: response.function_call_arguments.done`
      oia_fn = count of `response.output_item.added.*function_call`
    Plus parsed completion payload (status, incomplete_details.reason, len(output)).
  found: |
      run 1: fcad=0 fcdone=0 oia_fn=0 | incomplete | tool_calls | out_len=0    ← BUG path
      run 2: fcad=0 fcdone=0 oia_fn=0 | completed   | None      | out_len=1    ← text path
      run 3: fcad=0 fcdone=0 oia_fn=0 | completed   | None      | out_len=1    ← text path
      run 4: fcad=0 fcdone=0 oia_fn=0 | incomplete | tool_calls | out_len=0    ← BUG path
      run 5: fcad=0 fcdone=0 oia_fn=0 | incomplete | tool_calls | out_len=0    ← BUG path
    3/5 (60%) hit the tool-call path on the router; all 3 produced ZERO function_call events of any kind and an empty `output[]` with `status=incomplete reason=tool_calls`. Exactly the operator's reported bug shape.
  implication: |
    Live reproduction confirmed at the router boundary. The bug is in the router, not in the smoke gate, not in the upstream. The smoke-gate's hit rate at the operator's tested invocation (which does NOT pass tool_choice:"required") will be even lower than 60% — the gate will flake on top of the bug, which is why iter 2's failure surfaced cleanly. Even with `tool_choice:"required"` added to the gate, the router fix must land first for the gate to be passable.

- timestamp: 2026-06-02T11:15:00Z
  checked: |
    Verify Acceptance branch (A) by considering exactly what fix wire-shape would make the smoke gate pass and the bug report reproducer emit a populated output[].
  found: |
    After fix, the canonical event stream from `openAIChunksToCanonicalEvents` for the bug repro should look like:
      message_start
      content_block_start { index: 1, content_block: { type: 'tool_use', id: 'call_XXX', name: 'get_time', input: {} } }
      content_block_delta { index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }   // optional but useful
      content_block_stop  { index: 1 }
      message_delta       { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: N } }
      message_stop
    This drives the responses-stream FSM through: idle → function_call (output_item.added emitted) → function_call_arguments.delta (emitted) → function_call_arguments.done + output_item.done (emitted; outputItems.push(...)) → message_stop sees outputItems with 1 entry → response.completed emits output: [<function_call item>] with status:'incomplete', incomplete_details.reason:'tool_calls', incomplete_details.* preserved by the existing FSM logic.
    The smoke gate's two greps both pass: `response.function_call_arguments.delta` matches (DELTA_OK=1); `"status":"incomplete"` + `"reason":"tool_calls"` both match the completed payload (COMPLETED_OK=1).
    Edge case (empty-args): when upstream's `function.arguments` is `"{}"`, emitting `content_block_delta` with `partial_json: '{}'` is technically correct per the OpenAI Responses API (deltas can be the entire arguments string), and the FSM accumulates it into `argsAccumulated` and emits it via `function_call_arguments.delta` — so the smoke gate's delta-event requirement is satisfied even for empty arguments. NO smoke-gate relaxation is needed.
  implication: |
    Fix is straightforward and unambiguous. No API contract changes. No client-visible breakage (today the surface emits zero events for the function_call output item; after fix it emits the spec-compliant sequence — strictly additive for clients that ignore function_call). The fix can land as a single targeted edit to `openAIChunksToCanonicalEvents` with a Vitest unit test that drives a synthetic upstream chunk stream and asserts the canonical event sequence.

## VALIDATION COMPLETE

**Diagnosis:** confirmed router-side bug (Acceptance branch A) at `router/src/translation/openai-out.ts:525-615` (`openAIChunksToCanonicalEvents`).

**Mechanism:** the function reads only `choice.delta.content` (text). It has no branch for `choice.delta.tool_calls[]`. Upstream tool_call deltas pass through and are silently dropped at this seam, while the surviving `finish_reason:'tool_calls'` signal maps to canonical `stop_reason:'tool_use'`, which the Responses FSM (`responses-stream.ts:454,470`) reads to set `status:"incomplete"` + `incomplete_details.reason:"tool_calls"` — with the `outputItems[]` array still empty because no `content_block_start (tool_use)` ever fired.

**Scope:** the bug affects ALL upstream-OpenAI-compatible adapters (`ollama-cloud.ts`, `ollama-openai.ts`, `llamacpp-openai.ts`, `vllm-openai.ts`) when streaming tool calls. It is NOT specific to empty arguments and is NOT specific to gpt-oss:20b-cloud — the operator just happened to surface it via a smoke gate using a no-parameter tool. Any cloud or local model that emits `delta.tool_calls[]` over OpenAI-compat streaming hits the same dead seam.

**Out of scope (confirmed by `openAIChatCompletionToCanonical` static read at lines 177-222):** the NON-streaming OpenAI-compat translator (`openAIChatCompletionToCanonical`) also drops `message.tool_calls[]` — it only reads `message.content`. That is a sibling bug on the non-streaming path, NOT triggered by this smoke gate, and worth a follow-up debug session if any non-stream tool-calling client is in use. The `ollama-native-out.ts` adapter has its own non-stream tool_calls handling (line 93) so the native Ollama path may already work end-to-end; not investigated.

## Resolution

root_cause: |
  The OpenAI-chunks → canonical streaming translator at `router/src/translation/openai-out.ts:525-615` (function `openAIChunksToCanonicalEvents`) has no code path for `choice.delta.tool_calls[]`. It only translates `choice.delta.content` (text deltas) into canonical `content_block_start (text)` + `content_block_delta (text_delta)` + `content_block_stop` events. When the upstream OpenAI-compat backend (Ollama Cloud, vLLM, llama.cpp-server, local Ollama via /v1) emits a streaming tool_call as `delta.tool_calls[i]` with `function.name` + `function.arguments`, those fields are silently ignored. Only the trailing `finish_reason:'tool_calls'` (captured at openai-out.ts:564 and mapped to canonical `stop_reason:'tool_use'` at line 596) survives.

  Downstream of this seam, the Responses FSM at `responses-stream.ts:454,470` reads canonical `stop_reason:'tool_use'` to set `isToolCall=true`, which produces `response.completed { status:'incomplete', incomplete_details:{ reason:'tool_calls' } }`. But because no canonical `content_block_start (tool_use)` ever reached the FSM, `outputItems[]` stays empty and `response.completed.response.output` is serialized as `[]`. Hence the operator's observed symptom: `status:"incomplete"` + `reason:"tool_calls"` (truthful) BUT `output:[]` (silently lossy).

  The gap is documented in-line at `openai-out.ts:476-481` ("Upstream tool_calls in OpenAI chunks would require accumulating arguments fragments across chunks before emitting input_json_delta canonical events; that's a follow-up since the current adapters (Ollama, llama.cpp) handle tool_calls via the non-stream response branch in practice"). That assumption held for Phase 4/5/12/13 routes that used non-streaming tool calls for these backends. It was invalidated by Phase 16 (RESS-01..05), which introduced the `/v1/responses` streaming surface that ALWAYS streams when `stream:true` — the deferred follow-up was never picked up. The Phase 19 smoke gate `RESS-WITH-TOOLS` (added in commit 7ffbba3 on the Phase 19-06 plan) is the first verification surface that exercises this seam in CI/smoke; it surfaced the latent bug for the first time when the operator deliberately exported `OLLAMA_API_KEY` during the iter-2 smoke loop.

  The bug is NOT specific to empty-args tools — it fires for any upstream tool_call regardless of arguments shape. The smoke gate's `get_time` tool with empty parameters is a coincidental but representative example; the same bug would fire for a `get_weather({"location":"Paris"})` tool.

fix: |
  **Recommended (A1, router-side fix):** extend `openAIChunksToCanonicalEvents` in `router/src/translation/openai-out.ts` to translate `choice.delta.tool_calls[]` into canonical tool_use content_block events. The translator already accumulates state across chunks (it tracks `started`, `textBlockOpen`, `upstreamFinishReason`); it just needs to also track per-tool-call state keyed by `tool_call.index` (the OpenAI spec's index of the slot in the parallel `tool_calls[]` array).

  Pseudocode:
      // module-local state inside the for-await loop:
      const toolCallState = new Map<number, { id: string; name: string; argsBuffer: string; blockIndex: number; opened: boolean }>();
      let nextBlockIndex = 0; // 0 reserved for the text block (if any); tool_use blocks get 1,2,...

      // inside the chunk loop, after the text-delta branch:
      const toolCallsDelta = choice?.delta?.tool_calls as Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }> | undefined;
      if (Array.isArray(toolCallsDelta)) {
        for (const tc of toolCallsDelta) {
          let state = toolCallState.get(tc.index);
          // First sighting: register id + name + open the canonical content_block.
          if (!state) {
            if (!tc.id || !tc.function?.name) {
              // Defensive: if upstream sends a tool_call delta with no id/name, skip until id+name arrive in a later chunk.
              continue;
            }
            const blockIndex = ++nextBlockIndex; // text was at 0
            state = { id: tc.id, name: tc.function.name, argsBuffer: '', blockIndex, opened: false };
            toolCallState.set(tc.index, state);
          }
          if (!state.opened) {
            // Close any open text block first.
            if (textBlockOpen) {
              yield { type: 'content_block_stop', index: 0 };
              textBlockOpen = false;
            }
            yield {
              type: 'content_block_start',
              index: state.blockIndex,
              content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
            };
            state.opened = true;
          }
          const argFrag = tc.function?.arguments;
          if (typeof argFrag === 'string' && argFrag.length > 0) {
            state.argsBuffer += argFrag;
            yield {
              type: 'content_block_delta',
              index: state.blockIndex,
              delta: { type: 'input_json_delta', partial_json: argFrag },
            };
          }
        }
      }

      // when usage-only chunk arrives (existing code at line 584), BEFORE message_delta,
      // close all open tool_use blocks:
      for (const [, state] of toolCallState) {
        if (state.opened) {
          yield { type: 'content_block_stop', index: state.blockIndex };
        }
      }

  Why this works for the bug repro (gpt-oss:20b-cloud, single-chunk tool_call):
    - The upstream's single choices-bearing chunk arrives with `delta.tool_calls:[{index:0, id:"call_XXX", type:"function", function:{name:"get_time", arguments:"{}"}}]` AND `finish_reason:"tool_calls"`.
    - The new branch sees `tc.index=0` first time, registers state, closes any text block (none open), emits `content_block_start` of type tool_use at `index=1`.
    - The new branch sees `argFrag="{}"`, length 2, accumulates and emits `content_block_delta` with `partial_json:"{}"`. ← This makes `response.function_call_arguments.delta` fire in the responses-stream FSM, satisfying the smoke gate's first assertion.
    - When the usage chunk arrives (next chunk), the cleanup loop closes the open tool_use block. The existing message_delta code then emits `stop_reason:'tool_use'`. The FSM emits `function_call_arguments.done` + `output_item.done` + pushes into `outputItems[]`. message_stop emits `response.completed` with status:'incomplete', incomplete_details.reason:'tool_calls', AND `output:[<function_call item>]` — populated.

  **Optional (A2, smoke-gate hardening):** add `"tool_choice":"required"` to the smoke gate's body at `bin/smoke-test-router.sh:2598` (current body omits `tool_choice`, so the model decides; with this gpt-oss SKU it picks text ~40% of the time per the live measurement). This makes the gate ~60% reliable empirically; without it the gate will flake even after the router fix lands. Note: even with `tool_choice:"required"`, the gpt-oss:20b-cloud model occasionally produces a text response (2/5 runs in the test batch did so); the smoke gate may want to retry up to 3 times before failing, or accept the small flake rate.

  **NOT recommended (A3):** loosening the smoke gate to accept `output:[]` when `usage.output_tokens > 0` — this would mask the real bug forever and leave clients (Unsloth Studio, n8n LangChain nodes, etc.) silently broken on cloud tool-use streaming. Reject.

verification: |
  After A1 lands, verify with the bug reproducer:

    export OLLAMA_API_KEY=$(...)
    TOKEN=$(...)
    for i in 1 2 3 4 5; do
      curl -sS -N --max-time 60 -X POST "http://127.0.0.1:3210/v1/responses" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/json" \
        -d '{"stream":true,"model":"gpt-oss:20b-cloud","input":"Call get_time to fetch the current UTC time.","tools":[{"type":"function","name":"get_time","description":"...","parameters":{"type":"object","properties":{},"required":[]}}],"tool_choice":"required"}' \
        > /tmp/router-postfix-run-$i.txt
      echo "run $i: fcad=$(grep -c 'event: response.function_call_arguments.delta' /tmp/router-postfix-run-$i.txt) fcdone=$(grep -c 'event: response.function_call_arguments.done' /tmp/router-postfix-run-$i.txt) oia_fn=$(grep -c 'response.output_item.added.*function_call' /tmp/router-postfix-run-$i.txt)"
    done

  Expected after fix: on every run that takes the tool-call path (~60% of runs per the SKU's non-determinism), all three counters are ≥1 (fcad≥1, fcdone≥1, oia_fn≥1). The `response.completed` payload should show `output:[{type:'function_call', name:'get_time', arguments:'{}', call_id:'call_XXX', ...}]` with `status:'incomplete', incomplete_details.reason:'tool_calls'`.

  Add a Vitest unit test under `router/src/translation/__tests__/openai-out.tool-call-streaming.test.ts` that drives a synthetic async-iterable of `ChatCompletionChunk`s including a `delta.tool_calls[0]` slot, asserts the canonical event sequence (content_block_start type:tool_use → content_block_delta type:input_json_delta → content_block_stop → message_delta with stop_reason:'tool_use' → message_stop), and covers two cases: single-chunk full tool_call (gpt-oss pattern) and fragmented tool_call across multiple chunks (OpenAI proper pattern, where `function.arguments` arrives in pieces).

  After both A1 and A2 land, re-run `bin/smoke-test-router.sh` with `OLLAMA_API_KEY` exported and confirm `RESS-WITH-TOOLS` passes.

files_changed: []  # not yet applied — awaiting operator decision
