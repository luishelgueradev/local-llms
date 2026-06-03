---
status: complete
phase: 19-embeddingprovider-formalization-observability-hardening
source: [19-VERIFICATION.md]
started: 2026-06-01T22:55:00Z
updated: 2026-06-03T01:25:24Z
---

## Current Test

[testing complete]

## Tests

### 1. Vitest full suite
expected: 1271+ passed, 0 failed (modulo 1 pre-existing flaky hotreload.vram.test.ts that passes in isolation)
result: pass
notes: Ran `cd router && npx vitest run` at commit a9800fb. Result: 1271 passed / 1 failed / 39 skipped / 2 todo across 131 files. Failed test is `tests/integration/hotreload.vram.test.ts` — confirmed to be the documented pre-existing flake (passes 3/3 in isolation, documented across Phase 16/17/18 STATE.md narratives).

### 2. TypeScript compilation
expected: Exit 0 — no TypeScript errors
result: pass
notes: Ran `cd router && npx tsc --noEmit` at commit a9800fb. Exit code 0.

### 3. Smoke test end-to-end (live stack)
expected: Phase 19 section prints PASS for OBSV-02-LIVE; RESS-WITH-TOOLS prints PASS (when OLLAMA_API_KEY set) or SKIP (when absent)
result: issue
reported: "RESS-WITH-TOOLS failed: DELTA_OK=0 COMPLETED_OK=1 — function_call_arguments.delta event was NOT emitted on the cloud SSE stream for gpt-oss:20b-cloud, even though the completed event with incomplete:tool_calls did fire. OBSV-02-LIVE passed cleanly."
severity: major
notes: |
  Phase 19 gates split:
    - OBSV-02-LIVE: PASS — /metrics has no /_id$/ labels (live parser)
    - RESS-WITH-TOOLS: FAIL — only completed event reached SSE consumer, no function_call_arguments.delta

  Body head captured by smoke script:
    retry: 3000
    event: response.created
    data: {"type":"response.created","sequence_number":0,...,"model":"gpt-oss:20b-cloud",...}
    ...
    (delta event missing; completed event with incomplete:tool_calls present)

  Run command: `bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210 --profile dev`
  Stack: full compose stack up, OLLAMA_API_KEY set, gpt-oss:20b-cloud present in models.yaml (line 266).
  Other smoke-script failures observed (Phase 3.A ollama empty body / Phase 3.B llamacpp profile / Phase 4 /v1/messages empty) occur during the script's mid-run `--profile ollama`/`--profile llamacpp` compose-swap section and are pre-existing — not introduced by Phase 19. Scope of this gap is RESS-WITH-TOOLS only.

### 4. OBSV-04 PG-gated migration re-verify
expected: 8 passed (7 original Phase 18 + 1 new Phase 19 OBSV-04 describe block)
result: pass
notes: |
  Ran via one-shot node container on the data network:
    docker run --rm --network local-llms_data -v $(pwd)/router:/app -w /app \
      -e PG_TESTS=1 -e ROUTER_DATABASE_URL=postgresql://app:***@postgres:5432/router \
      node:22-bookworm-slim node_modules/.bin/vitest run tests/integration/migrations/0007-hook-log.test.ts
  Result: 8 passed in tests/integration/migrations/0007-hook-log.test.ts (1.61s).

## Summary

total: 4
passed: 3
issues: 1
pending: 0
skipped: 0
blocked: 0

## Gaps

- truth: "Phase 19 RESS-WITH-TOOLS smoke gate emits function_call_arguments.delta on cloud SSE for gpt-oss:20b-cloud (with OLLAMA_API_KEY set + model in models.yaml)"
  status: failed
  reason: "User-observed: RESS-WITH-TOOLS failed during full smoke run — DELTA_OK=0, COMPLETED_OK=1; no function_call_arguments.delta event reached the SSE consumer, but the completed{incomplete:tool_calls} event did. Stack healthy, key + model present."
  severity: major
  test: 3
  root_cause: ""     # Filled by diagnosis
  artifacts: []      # Filled by diagnosis
  missing: []        # Filled by diagnosis
  debug_session: ""  # Filled by diagnosis
