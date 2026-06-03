---
plan: 19-09
phase: 19-embeddingprovider-formalization-observability-hardening
type: execute
gap_closure: true
status: complete
shipped: 2026-06-03T02:03:33Z
commit: 7afbd96
tasks_completed: 3
files_modified:
  - .planning/phases/19-embeddingprovider-formalization-observability-hardening/19-HUMAN-UAT.md
key_files:
  modified:
    - path: .planning/phases/19-embeddingprovider-formalization-observability-hardening/19-HUMAN-UAT.md
      change: "frontmatter status: diagnosed → complete; Test 3 result: issue → pass with resolution block; Summary passed: 3 → 4, issues: 1 → 0; Gaps block flipped from open YAML gap entry to 'None'"
  created: []
  deleted: []
docker_state:
  image:
    before:
      created: "2026-06-01T15:42:09.159341743Z"
      digest: "sha256:03bc96409855edc6aef8245c01991595ba40870e528b05eb33b07742d54e6902"
    after:
      created: "2026-06-03T02:00:37.620547989Z"
      digest: "(post-rebuild — see docker image inspect local-llms-router)"
    rollback_tag: "local-llms-router:pre-19-09-rollback (kept; safe to remove now that gate is green)"
  bundle_grep:
    toolCallState:
      before: 0
      after: 5
    input_json_delta:
      before: 0
      after: 6
  container:
    pre_id: "092e48997e63"
    healthz_after_recreate: "200 at t+2s"
smoke_gate:
  result: "PASS — attempt 1 (no re-roll needed)"
  artifact: "/tmp/ress-with-tools-PASS-attempt-1.txt (3584 bytes)"
  evidence:
    - "event: response.function_call_arguments.delta count=1"
    - "event: response.completed count=1"
    - "\"status\":\"incomplete\" count=1"
    - "\"reason\":\"tool_calls\" count=1"
source_invariants:
  openai_out_ts_blob_head: "ae7c17dde0c53df4266ff163c48946e49902e0c8"
  openai_out_ts_blob_aa4a9c6: "ae7c17dde0c53df4266ff163c48946e49902e0c8"
  byte_identical: true
  production_src_diff_since_aa4a9c6: "empty (only router/src/**/__tests__/openai-out.tool-call-streaming.test.ts was added by Plan 19-08 itself in commit 382cb6a — test, not production)"
  milestone_metadata_touched: false
must_haves_status:
  - claim: "Running container built from image with Created ≥ 2026-06-02T12:21:18Z"
    status: passed
  - claim: "/app/dist/index.js contains ≥3 toolCallState markers"
    status: passed
  - claim: "RESS-WITH-TOOLS smoke gate DELTA_OK=1 COMPLETED_OK=1"
    status: passed
  - claim: "19-HUMAN-UAT.md: Test 3 issue→pass, Gap removed, Summary 3→4 passed / 1→0 issues, status: diagnosed→complete"
    status: passed
  - claim: "Zero source-code changes — git diff HEAD~..HEAD -- router/src/ router/Dockerfile compose.yml empty"
    status: passed
  - claim: "openai-out.ts byte-identical to aa4a9c6 blob"
    status: passed
---

# Plan 19-09 — Post-ship deployment fix for RESS-WITH-TOOLS smoke gate

**Outcome:** Closed Phase 19's only remaining UAT gap by rebuilding the `local-llms-router` Docker image so the deployed bundle picks up the Plan 19-08 source fix (`delta.tool_calls[]` translation branch in `openAIChunksToCanonicalEvents`). Zero source-code changes; one commit (`7afbd96`) touching only `19-HUMAN-UAT.md`. Phase 19 / v0.11.0 stay marked SHIPPED in STATE/ROADMAP/REQUIREMENTS.

## What changed (operationally)

| Surface | Before | After |
|---------|--------|-------|
| Image `local-llms-router` Created | `2026-06-01T15:42:09.159341743Z` (≈21h **before** fix commit `aa4a9c6`) | `2026-06-03T02:00:37.620547989Z` (post-fix) |
| `/app/dist/index.js` grep `toolCallState` | **0** | **5** |
| `/app/dist/index.js` grep `input_json_delta` | **0** | **6** |
| Container `local-llms-router` | id `092e48997e63` (stale image) | recreated; `/healthz` 200 at t+2s |
| RESS-WITH-TOOLS smoke gate | `DELTA_OK=0 COMPLETED_OK=1` (silent loss of function_call) | `DELTA_OK=1 COMPLETED_OK=1` (attempt 1) |
| `19-HUMAN-UAT.md` | `status: diagnosed`, 1 open gap, 3/4 pass | `status: complete`, 0 gaps, 4/4 pass |

## Task results

### Task 1 — Rebuild router image + recreate container + verify deployed bundle
- Tagged rollback as `local-llms-router:pre-19-09-rollback` (digest `sha256:03bc96…d54e6902`) before any state change.
- `docker compose build router` finished in ~2m19s (cache-warm `npm ci`, fresh `npm run build`).
- `docker compose up -d --force-recreate router` swapped the container; `/healthz` returned 200 within 2 seconds.
- All three post-rebuild assertions passed (`toolCallState ≥ 3` → got 5; image timestamp ≥ fix-commit time; `input_json_delta` ≥ 1 → got 6).

### Task 2 — RESS-WITH-TOOLS gate against live router (one-retry policy)
- Prereqs OK: `OLLAMA_API_KEY` sourced from `.env`, `ROUTER_BEARER_TOKEN` set, `gpt-oss:20b-cloud` declared in `router/models.yaml`.
- **Attempt 1 returned `DELTA_OK=1 COMPLETED_OK=1` — no re-roll needed.** gpt-oss:20b-cloud's documented 30–40% non-determinism on the tool-call branch did not bite this run.
- All four required SSE strings present in `/tmp/ress-with-tools-PASS-attempt-1.txt` (3584 bytes).

### Task 3 — Flip 19-HUMAN-UAT.md and commit
- Frontmatter: `status: diagnosed` → `status: complete`, `updated:` → `2026-06-03T02:05:00Z`.
- Test 3: `result: issue` → `result: pass`; the prior `reported:` / `severity:` / `notes:` block replaced by a single `resolution:` block citing the pre/post grep counts, image timestamps, and the attempt-1 PASS.
- Summary: `passed: 3 → 4`, `issues: 1 → 0` (totals/pending/skipped/blocked unchanged).
- `## Gaps`: open YAML gap entry replaced by `None — gap closed by Plan 19-09 …`.
- Atomic commit `7afbd96` (`chore(19-09): …`) — one file changed, 11 insertions / 30 deletions. No `router/src/`, `compose.yml`, `STATE.md`, `ROADMAP.md`, or `REQUIREMENTS.md` writes.

## Wire-level proof (excerpts from /tmp/ress-with-tools-PASS-attempt-1.txt)

```
event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta",
       "item_id":"fc_01KT5KF3V4XCAB0CQ2NYGWY2NZ","output_index":1,
       "delta":"{\"method\":\"utc_time\"}","sequence_number":3}
```

```
event: response.completed
data: {"type":"response.completed","sequence_number":6,
       "response":{"id":"resp_01KT5KF3CXBDERDNM35DEQF7T3","object":"response",
                   "status":"incomplete",
                   "incomplete_details":{"reason":"tool_calls"},
                   "model":"gpt-oss:20b-cloud",
                   "output":[{"id":"fc_01KT5KF3V4XCAB0CQ2NYGWY2NZ","type":"function_call",
                              "status":"completed","call_id":"call_kd6wkiiu",
                              "name":"get_time","arguments":"{\"method\":\"utc_time\"}"}],
                   …,
                   "usage":{"input_tokens":0,"output_tokens":120,"total_tokens":120}, …}}
```

Both the streaming `function_call_arguments.delta` AND the terminal `response.completed{incomplete:tool_calls}` events now reach the SSE consumer — this is exactly the wire shape the Phase 19 gate (`bin/smoke-test-router.sh:2573-2625`) is asserting.

## Why this was deployment-only (and not a code regression)

`compose.yml` declares `router: { build: ./router }` with no `image:` pin, so `docker compose up -d` reuses the previously-built local image instead of rebuilding when the source tree changes. Plan 19-08's source fix (`aa4a9c6`, `2026-06-02T12:21:18Z`) landed correctly on disk and passed its unit test suite (`router/src/translation/__tests__/openai-out.tool-call-streaming.test.ts`, 4/4 cases). The running container was built ~21 hours earlier (`2026-06-01T15:42:09Z`), so `/app/dist/index.js` was byte-equivalent to commit `aa4a9c6^` (pre-fix translator) — `delta.tool_calls[]` was simply not being read.

This is an operational hygiene problem, not a Compose-schema bug. Pinning an explicit `image:` tag would not have prevented it; what would prevent recurrence is either:
- A make/just target that wraps `docker compose build router && docker compose up -d --force-recreate router` (the operator-side equivalent of "build & deploy"), or
- A pre-deploy CI check that compares `git rev-parse HEAD:router/src/translation/openai-out.ts` against a marker baked into the running container.

Neither is in scope for Plan 19-09 — flagged in `.planning/debug/phase-19-ress-with-tools-delta.md` as an operational hygiene note for a future plan.

## Source invariants (no production drift)

```
git rev-parse HEAD:router/src/translation/openai-out.ts    = ae7c17dde0c53df4266ff163c48946e49902e0c8
git rev-parse aa4a9c6:router/src/translation/openai-out.ts = ae7c17dde0c53df4266ff163c48946e49902e0c8
```

`git log aa4a9c6..HEAD --oneline -- router/src/*.ts ':!router/src/**/__tests__/**' router/Dockerfile compose.yml` is empty. The single hit when `__tests__/` is included (`382cb6a test(19-08): add openai-out.tool-call-streaming.test.ts`) is a test file added by Plan 19-08 itself — not a Plan 19-09 change, and not production code.

## Milestone metadata preservation

Per the Phase 19 post-ship contract — and per the user's gap-closure STATE regression memory (commit `9194f36` was a STATE restore after a similar regression on Plan 19-08) — Plan 19-09 deliberately did NOT call `phase.complete` and did NOT touch:
- `.planning/STATE.md` (still `status: completed`, milestone `v0.11.0`)
- `.planning/ROADMAP.md` (Phase 19 still `[x] ✅ 2026-06-01 shipped`)
- `.planning/REQUIREMENTS.md` (already 100% coverage)

The orchestrator running this plan also intentionally skipped the workflow's `verify_phase_goal` and `update_roadmap` steps for the same reason — re-running them on an already-shipped phase would regress the milestone metadata.

## Rollback (kept for now; safe to remove)

```
local-llms-router:pre-19-09-rollback
  digest sha256:03bc96409855edc6aef8245c01991595ba40870e528b05eb33b07742d54e6902
  created 2026-06-01T15:42:09Z
```

To remove once the gate is confirmed stable across a few subsequent runs:
```bash
docker image rm local-llms-router:pre-19-09-rollback
```

## Self-Check: PASSED

- ✅ Image timestamp post-rebuild ≥ `2026-06-02T12:21:18Z` (got `2026-06-03T02:00:37Z`)
- ✅ Bundle has `toolCallState` ≥ 3 (got 5) and `input_json_delta` ≥ 1 (got 6)
- ✅ Live `/healthz` returned 200 within budget (2s)
- ✅ Smoke gate PASS on attempt 1; PASS artifact preserved at `/tmp/ress-with-tools-PASS-attempt-1.txt`
- ✅ UAT frontmatter `status: complete`, all 4 tests `result: pass`, `passed: 4`, `issues: 0`, Gaps = None
- ✅ Single atomic commit (`7afbd96`) touches only `19-HUMAN-UAT.md`
- ✅ `openai-out.ts` byte-identical to commit `aa4a9c6` blob
- ✅ STATE.md / ROADMAP.md / REQUIREMENTS.md unchanged; v0.11.0 / Phase 19 stay SHIPPED

## References

- Plan: `.planning/phases/19-embeddingprovider-formalization-observability-hardening/19-09-PLAN.md`
- Diagnosis trail: `.planning/debug/phase-19-ress-with-tools-delta.md`
- UAT (now complete): `.planning/phases/19-embeddingprovider-formalization-observability-hardening/19-HUMAN-UAT.md`
- Source fix (already on disk): commit `aa4a9c6` (`fix(19-08): openAIChunksToCanonicalEvents reads delta.tool_calls[]`)
- Unit tests for the source fix: `router/src/translation/__tests__/openai-out.tool-call-streaming.test.ts` (4 passing)
