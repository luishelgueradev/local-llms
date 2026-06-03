---
phase: 21-v0.12.0-post-ship-hygiene
phase_number: 21
phase_name: v0.12.0 Post-ship Hygiene
version: v0.12.0
generated_at: 2026-06-03T17:15:00Z
generated_by: post-Phase-20 unattended audit (session paused at 65% context)
mode: gap-closure
source_findings: .planning/OVERNIGHT-REPORT.md + audit-open + deferred-items.md
requires_user_review: false (decisions are forced by audit findings, no gray areas)
---

# Phase 21: v0.12.0 Post-ship Hygiene

> **For the next session:** This phase has TWO plans (21-01 + 21-02). All decisions are LOCKED — the audit identified 4 concrete findings with concrete fixes. No discuss-phase needed. Read this CONTEXT.md, then dispatch the two executors and run the re-audit.

## Scope

Resolve the 4 findings from the post-Phase-20 unattended audit (commit `6c4e246` was the closeout) before archiving v0.12.0. Pattern: same as Phases 19-08/19-09 (gap-closure within an already-shipped phase's milestone).

## The 4 findings + their fixes

### Finding 1 — 🟡 Router adapter cold-load timeout (Plan 21-01)

**Symptom:** When qwen2.5:7b is NOT in VRAM and a consumer hits the router, the adapter aborts at ~45s with `APIConnectionTimeoutError` → 504 `upstream_timeout` to client. Ollama needs ~50-55s for the cold-load on this WSL2 + shared-GPU box.

**Root cause (confirmed):** `router/src/clients/http-dispatcher.ts` lines 46-47:
```typescript
const HEADERS_TIMEOUT_MS = 45_000;
const BODY_TIMEOUT_MS = 45_000;
```

These were set defensively when DNS-threadpool starvation was the bottleneck (debug session `.planning/debug/resolved/router-504-stale-sockets.md`). The c-ares `caresLookup` fix from that session is now the primary protection against DNS hangs, so the 45s ceiling can safely raise.

**Fix (Plan 21-01):** Change both constants to `180_000` (3 min). Margin over real cold-load (~55s) with 3× buffer for momentary system load (Whisper + concurrent users). Stays well under SDK timeout of 300_000ms.

**Plan 21-01 scope:**
- Edit `router/src/clients/http-dispatcher.ts` lines 46-47: change `45_000` → `180_000`
- Update the comment block lines 1-50 to reflect the new value + rationale (c-ares lookup is the real fix; 45s was over-conservative)
- Add a unit test that asserts `HEADERS_TIMEOUT_MS >= 120_000` and `BODY_TIMEOUT_MS >= 120_000` (regression gate — future changes must justify)
- Add an integration test that verifies cold-load works end-to-end: spawn router with a known-cold model alias, send chat completions request, assert response within 60s (NOT 45s)
  - If creating a real cold-load test is too expensive, document a smoke gate addition in `bin/smoke-test-router.sh` instead
- Rebuild + deploy via `bash bin/deploy-router.sh full`
- Verify cold-load fix: `docker exec local-llms-ollama ollama stop qwen2.5:7b-instruct-q4_K_M; sleep 2; time curl --max-time 90 -H "Authorization: Bearer $TOKEN" -X POST http://127.0.0.1:3210/v1/chat/completions -d '{"model":"chat-local","messages":[{"role":"user","content":"ok"}],"max_tokens":5}'` — should succeed in ~50-60s (not 504 at 45s)
- Re-warm qwen2.5:7b after test so the live router stays usable
- Commit: `fix(21-01): raise undici headersTimeout 45s→180s for Ollama cold-load (audit finding)`

**Risk:** Touches hot path (every chat request). Test thoroughly. If something regresses, revert: `git revert HEAD && bash bin/deploy-router.sh full`.

**REQ-ID:** HYG-01

### Finding 2 — 🟢 `bin/smoke-test-router.sh --profile prod` curl-not-in-image

**Already documented:** `.planning/phases/20-model-catalog-hygiene-external-consumer-dx/deferred-items.md` lines 47-59

**Fix:** Add `curl` to the runtime stage of `router/Dockerfile`. ~2 lines (`RUN apk add --no-cache curl` if alpine, or `apt-get install -y curl` if debian — check Dockerfile base). Then `bash bin/deploy-router.sh full` to rebuild.

**Verify:** `docker exec local-llms-router which curl` returns a path. `bash bin/deploy-router.sh check` runs smoke without the "curl: not found" error.

**REQ-ID:** HYG-02

### Finding 3 — 🟢 Phase 3/Phase 7 smoke gates expect llamacpp model

**Already documented:** `.planning/phases/20-model-catalog-hygiene-external-consumer-dx/deferred-items.md` lines 9-34

**Fix:** In `bin/smoke-test-router.sh`:
- Phase 3 multi-backend test (lines ~543-554): add soft-skip when no enabled llamacpp model exists in `/v1/models`. Pattern:
  ```bash
  if ! curl -sf -H "Authorization: Bearer $TOKEN" "${ROUTER_URL}/v1/models" | jq -e '.data[] | select(.id | contains("llamacpp"))' > /dev/null; then
    skip "Phase 3 multi-backend test (no llamacpp models enabled — Wave 0 disabled)"
    continue
  fi
  ```
- Phase 7 capability gate test: same pattern, use enabled-model fixture (e.g., `chat-local` which is always enabled)

**Verify:** `bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210` exits 0 (or with only intentional skips, no fails) for Phase 3 + Phase 7.

**REQ-ID:** HYG-03

### Finding 4 — 🟢 Vitest sweep timeout flakes under load

**Symptom:** Full vitest sweep occasionally flakes 2-3 tests with timeout 5000ms when system is loaded (Ollama hot + Whisper + concurrent CLI scripts). Tests pass cleanly in isolation.

**Fix:** In `router/vitest.config.ts`, add `testTimeout: 10000` to the config (10s default — 2× current). 1-line addition.

**Verify:** `cd router && npx vitest run` finishes with 0 fails even under load.

**REQ-ID:** HYG-04

## Plan 21-02 scope (bundle of findings 2 + 3 + 4)

All three are script/config-only fixes. Bundle into ONE plan with 3 atomic tasks → 3 atomic commits. No new source code, no router rebuild needed (except for Finding 2 which requires Dockerfile change → 1 rebuild).

Sequence:
1. Task 1 — Dockerfile curl + smoke prod fix (rebuild required)
2. Task 2 — smoke Phase 3 + Phase 7 llamacpp guards (script-only)
3. Task 3 — vitest testTimeout default (1-line config)

Commit message: `fix(21-02): smoke + vitest hygiene (HYG-02, HYG-03, HYG-04)`

## Execution order

```bash
# Session start
cd /home/luis/proyectos/local-llms
# Read this CONTEXT.md (you already did if you're reading this)

# Spawn executor for Plan 21-01 (adapter timeout — meaty)
# Note: 21-01 PLAN.md doesn't exist yet; the executor can use this CONTEXT.md
# as the source-of-truth instead, since all decisions are LOCKED here.

# After 21-01 ships + verifies:
# Spawn executor for Plan 21-02 (smoke + vitest bundle)

# After both ship:
# Spawn gsd-verifier for Phase 21 (verify HYG-01..04 all green)

# After verify passes:
# /gsd:complete-milestone v0.12.0
#   → archives v0.12.0 (Phase 20 + Phase 21 both shipped)
#   → git tag v0.12.0
#   → REQUIREMENTS.md fresh for next milestone
```

## REQUIREMENTS.md additions needed

Add a `### Post-ship Hygiene (HYG) — 4 requirements` block to `.planning/REQUIREMENTS.md` mirror what the Phase 20 plans did:

| ID | Description | Status |
|----|-------------|--------|
| HYG-01 | `router/src/clients/http-dispatcher.ts` undici headers/body timeouts raised from 45s → ≥180s; cold-load of qwen2.5:7b (≥50s on WSL2) completes without `upstream_timeout`. Regression test asserts the constants stay ≥120_000. | Planned (Phase 21 / Plan 21-01) |
| HYG-02 | `router/Dockerfile` runtime stage includes `curl`; `bin/smoke-test-router.sh --profile prod` runs via `docker exec router curl ...` without "curl: not found". | Planned (Phase 21 / Plan 21-02) |
| HYG-03 | `bin/smoke-test-router.sh` Phase 3 + Phase 7 sections soft-skip when no llamacpp model is enabled in `/v1/models` (Wave 0 of Phase 20 disabled them). | Planned (Phase 21 / Plan 21-02) |
| HYG-04 | `router/vitest.config.ts` sets `testTimeout: 10000` to eliminate flake-under-load on the full sweep. | Planned (Phase 21 / Plan 21-02) |

And add to the Traceability table.

## STATE.md update needed

Frontmatter:
```yaml
status: in_progress           # change from milestone_complete
last_activity: "<new entry about Phase 21 opening>"
current_phase: 21
current_phase_name: v0.12.0 Post-ship Hygiene
progress:
  total_phases: 2             # was 1 (now Phase 20 + Phase 21)
  completed_phases: 1
  total_plans: 9              # was 7 (now + 21-01 + 21-02)
  completed_plans: 7
  percent: 78
```

## Things NOT in scope (out-of-scope, do NOT do)

- ❌ Touch Phase 20 artifacts (PLANs, SUMMARYs, VERIFICATION) — they're done and signed
- ❌ Rename any alias or touch models.yaml — D-02 LOCKED stays
- ❌ Touch `router/src/routes/v1/embeddings.ts` — P7-01 invariant
- ❌ Add new metric labels with `_id` suffix — POL-06 invariant
- ❌ Update tunnel deployment separately — the rebuild from 21-01 will propagate
- ❌ Reopen the discuss-phase for any of these findings — they're forced fixes from audit, no gray areas

## Verification gates (must hold for Phase 21 PASS)

1. HYG-01: cold-load probe (~55s) does NOT 504; existing warm-path (~1s) unaffected
2. HYG-02: `docker exec local-llms-router curl --version` returns 0
3. HYG-03: `bin/smoke-test-router.sh --router-url http://127.0.0.1:3210` exits 0 for Phase 3 + Phase 7 sections (skip-OK or pass)
4. HYG-04: `cd router && npx vitest run` exits 0 (no flake fails)
5. Pre-existing invariants unchanged:
   - P7-01: embeddings.ts SHA byte-identical to baseline `598b364...69404`
   - POL-06: no `_id$` labels in /metrics
   - MCPS-06: no StdioServerTransport in runtime
   - Phase 19 RESS-WITH-TOOLS smoke gate PASS

## References

- Audit findings: `.planning/OVERNIGHT-REPORT.md` (last session's report)
- Existing deferred items: `.planning/phases/20-model-catalog-hygiene-external-consumer-dx/deferred-items.md`
- Adapter source: `router/src/clients/http-dispatcher.ts` (the 45s constants)
- Debug session that originally set 45s: `.planning/debug/resolved/router-504-stale-sockets.md`
- Phase 20 ship state: `.planning/phases/20-model-catalog-hygiene-external-consumer-dx/20-VERIFICATION.md`
- Memory `feedback_vram_test_pollution.md` — relevant for HYG-01 testing (do NOT pollute VRAM with stop-model probes)
- Plan 19-09 / commit `cf49ef4` — reference pattern for Docker rebuild + valkey DEL + force-recreate dance
