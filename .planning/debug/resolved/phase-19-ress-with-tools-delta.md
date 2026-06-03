---
status: resolved
trigger: "Phase 19 RESS-WITH-TOOLS smoke gate fails: DELTA_OK=0 COMPLETED_OK=1. response.completed event emits with incomplete:tool_calls but ZERO function_call_arguments.delta events reach the SSE consumer. Plan 19-08 fix exists in source — but does it actually run?"
created: 2026-06-03T00:00:00Z
updated: 2026-06-03T01:35:00Z
resolved: 2026-06-03T02:30:00Z
resolved_by: "Plan 19-09 (commit 7afbd96) — deployment-only rebuild closed the gap"
diagnosed: 2026-06-03T01:35:00Z
---

## Current Focus

hypothesis: The Plan 19-08 openai-out.ts tool_calls translation branch is present in source, but either (a) the running container has stale code, (b) the responses-stream.ts FSM does not actually emit `response.function_call_arguments.delta` for canonical `input_json_delta` events with the new ordering, or (c) a downstream issue (compression, buffering, route) drops delta frames while letting later events through.

test: Live curl against /v1/responses with tool_choice:"required" and capture the full SSE stream. Verify whether function_call_arguments.delta events are emitted by the router at the wire level.

expecting:
  - If running container has the fix → expect fcad ≥1 on tool-path runs → bug is downstream of openai-out.ts (responses-stream FSM ordering or route plumbing).
  - If running container is stale → expect fcad=0 → bug is operational (image not rebuilt).
  - If responses-stream emits fcad but the smoke gate sees 0 → bug is in plumbing/route handler.

next_action: Load .env, hit /v1/responses with curl + tool_choice:required, capture body, count event types.

## Symptoms

expected: |
  Smoke gate RESS-WITH-TOOLS at bin/smoke-test-router.sh:2573-2623:
   - Sends /v1/responses streaming with gpt-oss:20b-cloud + get_time tool + tool_choice:"required".
   - Asserts BOTH:
     1. ≥1 `event: response.function_call_arguments.delta`
     2. `response.completed` event payload contains `"status":"incomplete"` AND `"reason":"tool_calls"`.

actual: |
  - DELTA_OK=0 COMPLETED_OK=1 (per user report).
  - response.created emitted.
  - response.completed with incomplete:tool_calls emitted.
  - ZERO response.function_call_arguments.delta events.
  - Body head shows response.created then jumps to completed (truncated at 400 chars, so we can't see what's between).

errors: |
  DELTA_OK=0 COMPLETED_OK=1
  Body head (400 chars):
    retry: 3000
    event: response.created
    data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_01KT5H9W88WFDV1MEEBN6X4Q7Z","object":"response","created_at":1780449865,"status":"in_progress","error":null,"incomplete_details":null,"instructions":null,"max_output_tokens":null,"model":"gpt-oss:20b-cloud","output":[],"output_text":"","parallel_tool_calls":true,"previous_response_id":n...

reproduction: |
  bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210 --profile dev
  (with OLLAMA_API_KEY set)

started: |
  Reported during Phase 19 final UAT (2026-06-03). The Plan 19-08 fix was applied earlier in Phase 19 to address the prior ress-with-tools-empty-output session. So this is either a regression of that fix at runtime (stale container), a new bug introduced by 19-08 itself, or a downstream issue uncovered by 19-08.

## Current Focus (final)

hypothesis: **CONFIRMED — Stale container running pre-fix code.** The Plan 19-08 fix (commit aa4a9c6, 2026-06-02 12:21:18 UTC) IS present in source at `router/src/translation/openai-out.ts:540-704`. But the running router container's compiled bundle `/app/dist/index.js` was built from a docker image dated `2026-06-01 15:42:09 UTC` — ~21 hours BEFORE the fix was committed. The bundle's `openAIChunksToCanonicalEvents` (lines 8999-9080 of the in-container `dist/index.js`) is byte-identical to the pre-fix source (commit aa4a9c6^). Zero occurrences of `toolCallState`, `nextToolBlockIndex`, or "Plan 19-08" appear in the running bundle. The fix never made it past the build boundary.

## Eliminated

- hypothesis: "Plan 19-08 introduced a regression that drops delta events (e.g., ordering issue in responses-stream FSM, buffered yield)."
  evidence: "The compiled `dist/index.js` in the running container has zero markers of Plan 19-08 (no `toolCallState`, no `nextToolBlockIndex`, no `Plan 19-08` comment). The fix code never ran. Source-side unit tests for the fix all pass (4/4 in `openai-out.tool-call-streaming.test.ts`). The bug is identical to the pre-19-08 diagnosis."
  timestamp: 2026-06-03T01:30:00Z

- hypothesis: "Upstream Ollama Cloud is emitting malformed tool_calls (e.g., parens in function name `get_time()` confusing the translator)."
  evidence: "While upstream IS observed emitting `name:\"get_time()\"` with hallucinated nested-arguments in 2/5 runs, this would only matter if the translator was running. The fact that the running translator has NO branch for `delta.tool_calls[]` makes the upstream's exact shape irrelevant — it would be dropped regardless. Set aside as out-of-scope for the immediate gap."
  timestamp: 2026-06-03T01:32:00Z

- hypothesis: "fastify-sse-v2 or some compression middleware is buffering/swallowing delta frames."
  evidence: "No need to investigate. The translator never produces canonical `content_block_delta(input_json_delta)` events for tool-call chunks; therefore no `response.function_call_arguments.delta` events are ever generated to be buffered. The output stream is faithfully transmitting exactly what the translator produces."
  timestamp: 2026-06-03T01:33:00Z

## Evidence

- timestamp: 2026-06-03T01:00:00Z
  checked: |
    Read `router/src/translation/openai-out.ts:472-705` to confirm whether the Plan 19-08 fix is in source.
  found: |
    Lines 476-484 contain Plan 19-08's docstring referencing the fix and ".planning/debug/ress-with-tools-empty-output.md".
    Lines 540-549 declare the `toolCallState` Map and `nextToolBlockIndex`.
    Lines 597-656 implement the `delta.tool_calls[]` translation branch (first-sighting state registration, content_block_start emission, argument-fragment accumulation, input_json_delta emission).
    Lines 663-669 close any open tool_use blocks before emitting message_delta on the usage chunk.
    Lines 692-703 close any still-open tool_use blocks at stream end (post-loop cleanup).
  implication: |
    The fix code is unambiguously present in source. If it were running, runs that took the tool-call path would emit at least content_block_start(tool_use) → content_block_delta(input_json_delta) → content_block_stop, which the responses-stream FSM converts to response.output_item.added → response.function_call_arguments.delta → response.function_call_arguments.done → response.output_item.done.

- timestamp: 2026-06-03T01:05:00Z
  test_id: R1
  checked: |
    Reproduce against the running router. 15 runs (5 batches of 3) of curl POST /v1/responses with stream:true, gpt-oss:20b-cloud, get_time tool, tool_choice:"required".
  found: |
    runs 1-15: fcad (function_call_arguments.delta) = 0 in EVERY run, including runs that took the tool-call path. Runs that hit the tool path (3/15 of those 15: runs 6, 13, plus run 4 which was a degenerate empty completion) produced `status:"incomplete", reason:"tool_calls", output:[]` with `usage.output_tokens > 0` — exactly the pre-19-08 bug shape from .planning/debug/ress-with-tools-empty-output.md. Other runs took the text path (407 / 313 / 458 / 354 / 188 text deltas — all clean, all with output_item.added/done present).
  implication: |
    The bug is identical to pre-19-08. The fix is not running. Two possibilities: (a) container has stale image, (b) source bug regressed silently. Inspect compiled bundle next.

- timestamp: 2026-06-03T01:15:00Z
  test_id: R2
  checked: |
    Inspect the compiled bundle inside the running router container:
    `docker compose exec router sh -c 'grep -c "toolCallState\\|nextToolBlockIndex\\|Plan 19-08" /app/dist/index.js'`
  found: |
    All three counts: 0, 0, 0. Plan 19-08 markers ARE NOT in the running bundle.
    Direct read of `openAIChunksToCanonicalEvents` in the running bundle at lines 8999-9080: the function reads only `choice?.delta?.content`. No `delta.tool_calls` read. No per-tool-call state. No content_block_start of type 'tool_use'. The text-only translator, exactly as before Plan 19-08.
  implication: |
    Confirms the running container is pre-19-08. Now establish WHY.

- timestamp: 2026-06-03T01:20:00Z
  test_id: R3
  checked: |
    Cross-reference image build time vs fix commit time.
    `docker image inspect local-llms-router --format '{{.Created}}'` → 2026-06-01T15:42:09.159Z
    `git log --format='%ad' --date=iso aa4a9c6 -1` → 2026-06-02 12:21:18 +0000 (Plan 19-08 fix commit)
    `stat -c '%y' router/src/translation/openai-out.ts` → 2026-06-02 12:27:20 (working-tree)
  found: |
    Router image is ~21 hours OLDER than the Plan 19-08 fix commit. `docker compose ps` shows the container has been running for 14 minutes — restarted, but on the same stale image. The compose service is `build: ./router` (no `image:` pin), so `docker compose up -d` without `--build` does NOT rebuild — it uses the cached `local-llms-router` image from 2026-06-01.
  implication: |
    Root cause is operational: the image was never rebuilt after Plan 19-08 landed. The smoke gate was committed with the assumption the deployed router contains the fix, but the running container is one image-build generation behind.

- timestamp: 2026-06-03T01:25:00Z
  test_id: R4
  checked: |
    Verify the source-side fix actually works by running its unit tests against TS source (Vitest does its own TS compile via vite — so it reflects current source state, not the container's stale bundle).
    `cd router && npx vitest run src/translation/__tests__/openai-out.tool-call-streaming.test.ts`
  found: |
    Test Files  1 passed (1)
         Tests  4 passed (4)
    All four cases of the 19-08 test suite green: single-chunk tool_call, fragmented args, text + tool_call mix, multiple parallel tool_calls.
  implication: |
    The fix in source is correct and verified. The bug is purely "image not rebuilt." After `docker compose build router && docker compose up -d router` (or `up -d --force-recreate --build router`), the next /v1/responses tool-call run will produce the expected delta events.

- timestamp: 2026-06-03T01:30:00Z
  test_id: R5 (corroboration)
  checked: |
    Independent upstream behavior capture — does Ollama Cloud reliably emit `delta.tool_calls[]` with `tool_choice:"required"`?
  found: |
    5 direct upstream captures vs `https://ollama.com/v1/chat/completions`: 3/5 emit `delta.tool_calls[]` with `finish_reason:"tool_calls"` (well-formed for translation). 2/5 emit text-only or empty (model non-determinism). Note: 2/5 of the tool-emitting runs had hallucinated `name:"get_time()"` (with parens) and bizarre `arguments:"{\"function\":\"get_time\",\"arguments\":{}}"` — a model-quality issue, but the Plan 19-08 translator would still emit canonical events for them (the fix doesn't validate name shape; it just forwards id + name + args from upstream). The smoke gate's `grep -q "event: response.function_call_arguments.delta"` only needs one delta event to pass — it does not care about argument content.
  implication: |
    Upstream is fine. Smoke gate will pass once the rebuild lands, modulo the model's ~40-60% non-determinism on this gpt-oss SKU (an unrelated, pre-existing flakiness that Plan 19-08's `tool_choice:"required"` already mitigates).

## Diagnosis

**Root cause (one sentence):** The Plan 19-08 fix for `openAIChunksToCanonicalEvents` IS in source at `router/src/translation/openai-out.ts:540-704` and passes its unit tests, but the running `local-llms-router` Docker image was built on 2026-06-01 15:42:09 UTC — ~21 hours BEFORE the Plan 19-08 commit (aa4a9c6, 2026-06-02 12:21:18 UTC) — so the compiled `/app/dist/index.js` inside the container has no `delta.tool_calls[]` translation branch, reproducing the pre-fix bug exactly.

**Affected artifacts:**
- `router/Dockerfile` and `compose.yml` — both unchanged; the issue is that no rebuild was triggered between Plan 19-08 landing and the UAT.
- `local-llms-router` Docker image (in-cache) — built 2026-06-01 from a pre-19-08 source tree.
- The running container `local-llms-router` (started from the stale image).
- Indirectly: `bin/smoke-test-router.sh:2573-2623` (the gate) — works correctly; it just hits a router that doesn't have the fix.

**Missing behavior:**
- The running container's `openAIChunksToCanonicalEvents` does NOT translate `choice.delta.tool_calls[]` into canonical `content_block_start(tool_use)` + `content_block_delta(input_json_delta)` + `content_block_stop` events.
- Therefore the responses-stream FSM never sees a tool_use content_block; it only sees `message_delta.stop_reason:'tool_use'` (which still maps to `incomplete:tool_calls` via the FSM's `isToolCall` flag).
- Therefore zero `response.output_item.added` (for function_call), zero `response.function_call_arguments.delta`, zero `response.function_call_arguments.done`, zero `response.output_item.done`, and `response.completed.response.output:[]`.

**Fix direction (not applied per scope of this debug):** Rebuild the router image and recreate the container. The standard incantation per the user's memory `project_models_yaml_hot_edit`-style restart is:
```
docker compose build router
docker compose up -d --force-recreate router
```
After rebuild, re-run `bin/smoke-test-router.sh` with OLLAMA_API_KEY exported. The gate should pass on the first tool-path run (subject to gpt-oss:20b-cloud's ~40-60% tool_choice non-determinism, which `tool_choice:"required"` already partially mitigates).

**No source code changes are required.** The source-side fix exists, passes its tests, and is correct.

## Resolution

root_cause: |
  STALE CONTAINER. Plan 19-08 fix is present and correct in source (`router/src/translation/openai-out.ts:540-704`, commit aa4a9c6 on 2026-06-02 12:21:18 UTC), and its 4 unit tests pass against the source. But the running router container was built from a docker image dated 2026-06-01 15:42:09 UTC — predating the fix by ~21 hours. The compiled `dist/index.js` inside the container has zero occurrences of `toolCallState`, `nextToolBlockIndex`, or the "Plan 19-08" comment marker. The in-container `openAIChunksToCanonicalEvents` (bundle lines 8999-9080) is the exact pre-fix shape: text-only branch, no `delta.tool_calls[]` read. Since `compose.yml` declares `build: ./router` without an `image:` pin, `docker compose up -d` does not rebuild — it uses the cached image. The fix never crossed the source→image→container boundary.

  Reproduction in this session: 15 live curl runs against /v1/responses. 0/15 produced any function_call_arguments.delta event. Runs that took the tool-call path (~20% rate on this run batch) produced exactly the pre-19-08 bug shape: status:"incomplete", reason:"tool_calls", output:[], output_tokens > 0. Identical to .planning/debug/ress-with-tools-empty-output.md observations.

fix: |
  NOT APPLIED per debug-session scope (operator instructed read-only diagnosis). Operator action:
    docker compose build router
    docker compose up -d --force-recreate router
  Then re-run the smoke gate with OLLAMA_API_KEY exported.

verification: |
  After rebuild + recreate, confirm:
    1. `docker compose exec router sh -c 'grep -c "toolCallState" /app/dist/index.js'` returns ≥3.
    2. `docker image inspect local-llms-router --format '{{.Created}}'` returns a timestamp >= 2026-06-02T12:21:18Z.
    3. Re-run the curl repro 10 times; on every tool-call-path run (≥1 in 10 at the gpt-oss SKU's empirical rate), counts: fcad≥1, fcdone≥1, output_item.added(function_call)≥1, output_item.done(function_call)≥1, and response.completed.response.output has length 1 with type "function_call".
    4. `bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210 --profile dev` passes RESS-WITH-TOOLS (modulo model non-determinism — may need 1-2 retries on this SKU).

files_changed: []  # not applied; source-side fix is already committed (aa4a9c6); this is an operational/deployment gap, not a code gap.

