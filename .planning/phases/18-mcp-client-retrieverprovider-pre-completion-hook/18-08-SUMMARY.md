---
phase: 18-mcp-client-retrieverprovider-pre-completion-hook
plan: 08
subsystem: phase-wrap-up
tags:
  - smoke-section
  - deploy-docs
  - readme-docs
  - state-roadmap-requirements
  - hook-test-flips
  - hooklog-recordoutcome-wirethrough
  - phase-18-shipped
dependency_graph:
  requires:
    - "router/src/routes/v1/helpers/pre-completion.ts (Plan 18-07 — runPreCompletionAndInjectMcpTools)"
    - "router/src/hooks/pre-completion.ts (Plan 18-06 — runHookChain + HookLogEntry shape)"
    - "router/src/mcp/client/registry.ts (Plan 18-04 — makeMcpClientRegistry)"
    - "router/db/migrations/0007_request_log_hook_log.sql (Plan 18-02 — JSONB column applied to live PG)"
    - "All Phase 17 Plan 17-07 wrap-up patterns (smoke section + DEPLOY/README section structure)"
  provides:
    - "bin/smoke-test-router.sh Phase 18 section (6 PASS gates)"
    - "DEPLOY.md MCP Client + Pre-Completion Hooks operator section"
    - "README.md MCP Client + Hooks consumer section"
    - ".planning/STATE.md Phase 18 SHIPPED metadata (5/6 phases + 42/48 reqs)"
    - ".planning/ROADMAP.md Phase 18 row complete + 8/8 plans + progress table"
    - ".planning/REQUIREMENTS.md coverage line + footer timestamp update"
    - ".planning/phases/18-mcp-client-retrieverprovider-pre-completion-hook/deferred-items.md (live tunnel rebuild + Frame-01 ongoing reminder)"
    - "router/src/metrics/recordOutcome.ts OutcomeContext.hookLog field (Rule-2 gap closure)"
    - "router/src/routes/v1/{chat-completions,messages,responses}.ts safeRecord req.hookLog wire-through"
    - "5 test files with 35 it.todo → real it() flips (hook-config-validation, hook-position, hook-metrics, hook-and-mcp-coexist, hook-log-audit)"
  affects:
    - "Phase 19 EmbeddingProvider planning (uses Frame-01 + composition-root pattern locked in by Phase 18)"
    - "Live deployment rollout (operator action — docker compose up -d --build --force-recreate router)"
tech_stack:
  added: []
  patterns:
    - "Phase-end smoke section (6 PASS gates: 4 BLOCK invariants + 2 cross-phase invariants — Phase 15/16 pattern)"
    - "Capturing-fake BufferedWriter for audit-shape tests (instead of PG_TESTS=1 gate when JSONB serialization is downstream)"
    - "safeRecord empty-array → undefined mapping for NULL-column semantics (`req.hookLog?.length` gate)"
key_files:
  created:
    - ".planning/phases/18-mcp-client-retrieverprovider-pre-completion-hook/18-08-SUMMARY.md"
  modified:
    - "bin/smoke-test-router.sh"
    - "DEPLOY.md"
    - "README.md"
    - ".planning/STATE.md"
    - ".planning/ROADMAP.md"
    - ".planning/REQUIREMENTS.md"
    - ".planning/phases/18-mcp-client-retrieverprovider-pre-completion-hook/deferred-items.md"
    - "router/src/metrics/recordOutcome.ts"
    - "router/src/routes/v1/chat-completions.ts"
    - "router/src/routes/v1/messages.ts"
    - "router/src/routes/v1/responses.ts"
    - "router/tests/hooks/hook-config-validation.test.ts"
    - "router/tests/integration/hook-position.integration.test.ts"
    - "router/tests/integration/hook-metrics.integration.test.ts"
    - "router/tests/integration/hook-and-mcp-coexist.integration.test.ts"
    - "router/tests/integration/hook-log-audit.integration.test.ts"
decisions:
  - "Capturing-fake BufferedWriter pattern for hook-log-audit.integration.test.ts (35-test batch). The Drizzle/pg JSONB serialization is downstream of recordOutcome and already covered by the PG-gated tests/integration/migrations/0007-hook-log.test.ts INSERT/SELECT round-trip. Gating the audit-shape tests on PG_TESTS=1 would have left 10 cases skipped in CI for the rest of the phase, and the audit invariants (SHA256-only, redactBearer applied, status enum, declaration order) are observable at the recordOutcome boundary without Postgres. The pattern is reusable for EMBP-/OBSV-tests in Phase 19."
  - "Rule-2 wire-through: req.hookLog → ctx.hookLog → request_log.hook_log JSONB. The Plan 18-06 SUMMARY documented runHookChain populating req.hookLog, and Plan 18-07 SUMMARY noted the route safeRecord closures should forward it, but the actual safeRecord widening was never landed — discovered when writing the hook-log-audit tests and the JSONB column persisted as undefined. RETR-04 is a hard requirement (audit trail invariant), so this counts as a Rule-2 gap closure ('missing essential features for correctness') rather than a deviation."
  - "Empty array → NULL column semantic: 'no hooks ran' is distinct from 'an empty chain ran'. The route safeRecord wrapper maps `req.hookLog?.length > 0 ? req.hookLog : undefined` so an empty array becomes a NULL column. This matches the schema-by-convention intent in the PG-gated migration test (`hook_log is NULLABLE — NULL means 'no hooks ran'`)."
  - "Hook-position helper Map key gate is route-only, NOT entry-only: a hook registered for /v1/messages does NOT fire on /v1/chat/completions (verified by 'hook NEVER fires when no Map entry for routeKey' test). The model entry's pre_completion_hooks field is a future extension point — current behavior fires ALL hooks registered for the route, regardless of model. This is consistent with Frame-01: hooks are opt-in via code at the composition root, not via YAML."
metrics:
  duration: "~25 minutes (Task 1 smoke+docs + Task 2 test flips + wire-through + STATE/ROADMAP/REQUIREMENTS wrap-up)"
  completed_date: "2026-06-01"
  commits: 2
  files_created: 1
  files_modified: 16
  net_lines_added: ~2100
  net_lines_removed: ~30
---

# Phase 18 Plan 08: Phase 18 wrap-up — smoke + docs + test flips + STATE wrap-up Summary

One-liner: Closed Phase 18 with the live-tunnel smoke section + DEPLOY/README operator+consumer docs + 35 deferred Wave-0 hook test flips + the Rule-2 req.hookLog → request_log.hook_log JSONB wire-through gap closure + STATE/ROADMAP/REQUIREMENTS Phase 18 SHIPPED metadata — 12/12 requirements + 12/12 BLOCK pitfalls verified.

## What changed

### Task 1: Smoke section + DEPLOY/README docs (commit `ecc7e75`)

**`bin/smoke-test-router.sh`** — new Phase 18 section between Phase 17 SESSION and the final summary banner. 6 PASS gates wired against `${ROUTER_URL}`:

| Gate | BLOCK | Check |
|------|-------|-------|
| 1 | P9-01 | `docker compose exec postgres psql -tAc "SELECT 1 FROM information_schema.columns WHERE table_name='request_log' AND column_name='hook_log'"` returns `1` |
| 2 | P2-01 | `curl -sS -o /dev/null -w '%{http_code}' "${ROUTER_URL}/readyz"` returns `200` |
| 3 | POL-06 | `/metrics` scrape — Phase 18 metric families have no `_id` labels (OR no child series yet, which is Frame-01-consistent on a hook-free production) |
| 4 | Frame-01 | `grep -rE 'class \w+RetrieverProvider' router/src/ | grep -v providers/retriever-provider.ts | wc -l` = 0 AND `implements RetrieverProvider` = 0 |
| 5 | P2-04 | `grep -rE 'req\.headers|request\.headers' router/src/mcp/client/ | wc -l` = 0 |
| 6 | P9-02 | `npx vitest run tests/routes/responses.test.ts -t "P9-02"` passes (soft-skip when run from host without router/node_modules) |

Final summary banner updated to cite `Phase 2/3/4/5/7/8/12/13/15/16/17/18 router verification: COMPLETE.` and `bash -n bin/smoke-test-router.sh` exits 0.

**`DEPLOY.md`** — new `## MCP Client + Pre-Completion Hooks (Phase 18 — v0.11.0)` section between Phase 17 SESSION section and Backups. Sections:

- Strategic frame citation (binding): "Retrieval Interfaces, not Retrieval Logic" · "Memory Abstraction Layer, not Memory implementation".
- Production composition: ZERO retriever implementations; empty `preCompletionHooks: Map` literal in `router/src/index.ts`.
- `mcp_servers:` Zod schema docs: alias `/^[a-z0-9_]{1,32}$/`, transport=`streamable-http` v0.11.0 lock, auth_type=`none|bearer` with required `auth_value` when bearer, `timeout_ms` default `10_000`, `tool_filter` default `['*']`.
- Per-model `mcp_servers_enabled` + `pre_completion_hooks` references.
- Hot-edit recipe citing `project_models_yaml_hot_edit.md` (valkey-cli DEL + `docker compose up -d --force-recreate router`).
- Plan 18-07's `watchRegistry.onReload` automatic hot-reload cache invalidation.
- Hook registration table: name + retriever + timeout_ms + on_timeout + max_chars + top_k? + buildRequest? — `on_timeout` REQUIRED per P5-01 BLOCK.
- on_timeout decision tree: 'fail-open' (augmentation) vs 'fail-closed' (authorization).
- Boot-time validator code snippet.
- RETR-04 hook_log JSONB audit shape with SHA256-only P5-05 privacy invariant.
- Observability surface table: `router_hook_duration_ms` Histogram with buckets `[10, 50, 100, 250, 500, 1000, 2000, 5000]` ms + `router_mcp_tool_calls_external_total` Counter CLIENT-surface distinct from Phase 15 SERVER-surface.
- Auth boundary P2-04 BLOCK grep-gate citation.
- MCPC-04 loop cap.
- Verification matrix mapping ROADMAP SC-1..6 → enforcing tests.

**`README.md`** — new `## MCP Client + Hooks (v0.11.0)` consumer section between Sessions and Operacion:

- Strategic frame as block-quote citation.
- ZERO retriever implementations production statement.
- Quick-reference bullet list (mcp_servers YAML / per-model opt-in / pre_completion_hooks code-only registration / X-Hook-Error semantics / hook_log audit / loop cap / stream caveat).
- Auth isolation P2-04 BLOCK summary.
- Frame-01 BLOCK invariant restatement.
- Cross-reference link to DEPLOY.md operator section.

### Task 2: 35 deferred hook test flips + Rule-2 wire-through (commit `b4eee2b`)

**Rule-2 gap closure** — `req.hookLog` was being populated by `runPreCompletionAndInjectMcpTools` but no code path was forwarding it to `request_log.hook_log` JSONB. RETR-04 is a hard requirement (audit invariant). 4 source files widened:

1. **`router/src/metrics/recordOutcome.ts`** — `OutcomeContext` gains `hookLog?: HookLogEntry[]` field; row-builder forwards as `RequestLogInsert.hook_log` (null when undefined).
2. **`router/src/routes/v1/chat-completions.ts`** — `safeRecord` closure reads `req.hookLog` BEFORE dispatching `opts.recordOutcome`. Empty-array → undefined so NULL column persists "no hooks ran" distinct from "empty chain ran".
3. **`router/src/routes/v1/messages.ts`** — same shape.
4. **`router/src/routes/v1/responses.ts`** — same shape.

**35 deferred Wave-0 it.todo → real it()** across 5 test files. Tests use a capturing-fake `BufferedWriter` (the production buffered writer's `push()` shimmed to collect rows in memory) instead of `PG_TESTS=1` gating — structurally equivalent because `recordOutcome` is the single producer of `RequestLogInsert` rows and JSONB serialization is downstream (covered separately by `tests/integration/migrations/0007-hook-log.test.ts` PG-gated INSERT/SELECT).

| File | Cases | Coverage |
|------|-------|----------|
| `tests/hooks/hook-config-validation.test.ts` | 6 + 1 sentinel | RETR-03 / P5-01: HookConfigError on missing/undefined on_timeout; valid 'fail-open'/'fail-closed' boot success; envelope code; multi-hook validation |
| `tests/integration/hook-position.integration.test.ts` | 8 | RETR-02: hook AFTER ContextProvider + BEFORE adapter on all 3 routes; fence lands in canonical.system NOT canonical.messages (CTXP-03); routeKey Map gate; capability-gate ordering |
| `tests/integration/hook-metrics.integration.test.ts` | 5 | P5-02: router_hook_duration_ms{hook_name, status} ok/timeout/error; bucket layout exposed in scrape; POL-06 label-name allowlist |
| `tests/integration/hook-and-mcp-coexist.integration.test.ts` | 6 | RETR-06 / P5-04: hook fires once outside MCP loop; canonical.tools[] carries prefixed tools; canonical.system carries fence; MCP tool routes through loop with prefix stripped; both metric families fire on same request |
| `tests/integration/hook-log-audit.integration.test.ts` | 10 | RETR-04: hook_log JSONB shape + SHA256 context_hash + P5-05 SECRET_CONTENT-grade leak test + redactBearer in error_message + status enum coverage + empty Map → NULL + multi-hook declaration order |

**Test sweep on the 5 flipped files**: 36 passed / 0 failed / 0 skipped / 0 todo.

## Verification

### Final phase gate (all PASS)

| Gate | Command | Result |
|------|---------|--------|
| Type check | `npx tsc --noEmit` | exit 0 — zero diagnostics across `router/src/` + `router/tests/` |
| Cardinality CI | `node --import tsx scripts/check-prometheus-cardinality.ts` (from router/) | `cardinality-check: OK — no /_id$/ labels found` |
| Smoke parse | `bash -n bin/smoke-test-router.sh` | exit 0 |
| Frame-01 grep gate (class) | `grep -rE "class \w+RetrieverProvider" src/ \| grep -v providers/retriever-provider.ts \| wc -l` | 0 |
| Frame-01 grep gate (implements) | `grep -rE "implements RetrieverProvider" src/ \| wc -l` | 0 |
| Frame-01 grep gate (NoopRetrieverProvider) | `grep -rE "NoopRetrieverProvider" src/ \| wc -l` | 0 |
| P2-04 grep gate | `grep -rE "req\.headers\|request\.headers" src/mcp/client/ \| wc -l` | 0 |
| P9-01 journal grep | `grep '"idx": 7' db/migrations/meta/_journal.json \| wc -l` | 1 |
| P7-01 embeddings baseline | `tests/unit/grep-gates/embeddings-untouched.test.ts` | PASS (SHA-256 unchanged) |

### Full vitest sweep

`npx vitest run` (full suite, parallel): **1253 passed / 2 failed / 38 skipped / 2 todo** across **125 test files passed + 1 failed + 3 skipped**.

The 2 failures are the pre-existing `tests/integration/hotreload.vram.test.ts` flake under full-suite parallel load — passes 3/3 in isolation (verified). This flake pre-existed Plan 18-08 (Phase 16+ baseline) and is documented in `deferred-items.md` from Plan 18-05.

### 12 BLOCK pitfalls verification matrix

| BLOCK | Verified by |
|-------|-------------|
| P2-01 (lazy MCP connect) | `mcp-client-lazy-boot.integration.test.ts` + smoke gate 2 (`/readyz` 200 with unreachable mcp_servers) |
| P2-02 (prefix routing) | `mcp-client-prefix-routing.integration.test.ts` |
| P2-03 (sanitize tool name + description) | `sanitize.test.ts` |
| P2-04 (no inbound bearer to MCP) | `mcp-client-auth-isolation.integration.test.ts` + smoke gate 5 + grep gate |
| P2-05 (tool description truncate) | `sanitize.test.ts` |
| P5-01 (on_timeout required) | **`hook-config-validation.test.ts` — 6 cases flipped this plan** |
| P5-02 (Promise.race no-leak) | `promise-race-timeout.test.ts` + **`hook-metrics.integration.test.ts` — 5 cases flipped this plan** |
| P5-03 (fence + 4000 cap) | `inject.test.ts` + **`hook-log-audit.integration.test.ts` truncated-status case flipped this plan** |
| P5-04 (hook + MCP coexist) | **`hook-and-mcp-coexist.integration.test.ts` — 6 cases flipped this plan** |
| P5-05 (SHA256-only audit) | **`hook-log-audit.integration.test.ts` SENTINEL_DOC_CONTENT leak test flipped this plan** |
| P7-01 (embeddings untouched) | `embeddings-untouched.test.ts` (SHA-256 baseline) |
| P9-01 (migration 0007 atomic tuple) | `migration-journal.test.ts` (idx=7 grep) + `0007-hook-log.test.ts` (PG-gated) |
| P9-02 (byte-identical golden) | Phase 16 `responses.test.ts -t "P9-02"` — STILL PASSES across Phase 18 wire-up |
| Frame-01 BLOCK | `no-default-retriever.test.ts` + smoke gate 4 + production `new Map()` literal in `index.ts` |

### 6 ROADMAP success criteria verification

| SC | Test |
|----|------|
| SC-1 (lazy boot) | `tests/integration/mcp-client-lazy-boot.integration.test.ts` + smoke gate 2 |
| SC-2 (prefix routing) | `tests/integration/mcp-client-prefix-routing.integration.test.ts` |
| SC-3 (fail-open vs fail-closed) | `tests/integration/hook-position.integration.test.ts` + `tests/hooks/hook-config-validation.test.ts` |
| SC-4 (hook_log JSONB audit) | `tests/integration/hook-log-audit.integration.test.ts` (10 cases) + smoke gate 1 |
| SC-5 (embeddings unchanged) | `tests/unit/grep-gates/embeddings-untouched.test.ts` |
| SC-6 (hook + MCP coexist) | `tests/integration/hook-and-mcp-coexist.integration.test.ts` |

### STATE.md regression check

Per user memory `project_gapclosure_state_regression.md` — verified Phase 14/15/16/17 entries are PRESERVED VERBATIM in the body chain (the new Phase 18 SHIPPED entry is the new top paragraph; previous entries shifted into `**Previous Last Updated:**` and `(Previous: ...)` chains intact). No prior-phase content was edited or summarized away.

### Live tunnel rollout (pending)

The production composition (`makeMcpClientRegistry` + empty `preCompletionHooks: Map` + onClose disposeAll + `req.hookLog` wire-through) is NOT yet rolled out to https://local-llms.luishelguera.dev. Operator action tracked in `deferred-items.md`:

```bash
docker compose up -d --build --force-recreate router
```

After rollout, all 6 Phase 18 smoke gates should print PASS against the live endpoint.

## Deviations from Plan

### Rule-2 gap closure: req.hookLog → recordOutcome wire-through

- **Found during:** Task 2 (writing `hook-log-audit.integration.test.ts`)
- **Issue:** `runPreCompletionAndInjectMcpTools` stashes `req.hookLog = hook_log` but no code path forwards it into `OutcomeContext.hookLog` → `RequestLogInsert.hook_log`. The audit JSONB column was being persisted as undefined regardless of whether hooks ran.
- **Fix:** Widened `OutcomeContext` with `hookLog?: HookLogEntry[]`; row-builder forwards. All 3 routes' `safeRecord` closures read `req.hookLog` BEFORE dispatching, with empty-array → undefined mapping.
- **Why Rule 2:** RETR-04 is a hard requirement (audit trail invariant); missing this is "missing essential features for correctness."
- **Files modified:** `router/src/metrics/recordOutcome.ts`, `router/src/routes/v1/chat-completions.ts`, `router/src/routes/v1/messages.ts`, `router/src/routes/v1/responses.ts`
- **Commit:** `b4eee2b`

### User-prompt scope expansion: 35 deferred hook tests

- **Found during:** Plan execution
- **Issue:** Plan 18-08 PLAN.md tasks 1-2 are smoke + DEPLOY/README + STATE wrap-up only. The 35 Wave-0 hook test flips were documented as DEFERRED in Plan 18-07 SUMMARY but the user prompt explicitly added them to this plan's `<critical_constraints>`.
- **Fix:** Flipped all 35 across the 5 test files. Capturing-fake `BufferedWriter` pattern avoided gating 10 hook-log-audit cases on `PG_TESTS=1`. Wired the Rule-2 gap closure as a prerequisite for the audit tests to actually verify the JSONB column.
- **Files modified:** `tests/hooks/hook-config-validation.test.ts`, `tests/integration/hook-position.integration.test.ts`, `tests/integration/hook-metrics.integration.test.ts`, `tests/integration/hook-and-mcp-coexist.integration.test.ts`, `tests/integration/hook-log-audit.integration.test.ts`
- **Commit:** `b4eee2b`

## Threat Flags

No new threat surface introduced. The Rule-2 wire-through (`req.hookLog` → `recordOutcome` → JSONB) carries the same threat surface as the Phase 18 hook audit chain itself (already covered by the Plan 18-06 threat model — SHA256-only, redactBearer applied, never full retrieved content in audit).

## Commits

- `ecc7e75 docs(18-08): smoke MCP-CLIENT+HOOK section + DEPLOY/README operator+consumer docs` — Task 1
- `b4eee2b feat(18-08): flip 35 deferred hook tests + wire req.hookLog → recordOutcome → request_log.hook_log` — Task 2

A final Phase 18 SHIPPED metadata commit follows this SUMMARY (covers STATE.md + ROADMAP.md + REQUIREMENTS.md + deferred-items.md + 18-08-SUMMARY.md).

## Self-Check: PASSED

- File `bin/smoke-test-router.sh` modified with new Phase 18 section.
- File `DEPLOY.md` modified with new `## MCP Client + Pre-Completion Hooks (Phase 18 — v0.11.0)` section.
- File `README.md` modified with new `## MCP Client + Hooks (v0.11.0)` section.
- File `.planning/phases/18-mcp-client-retrieverprovider-pre-completion-hook/deferred-items.md` extended with live tunnel rebuild + Frame-01 ongoing reminder + Phase 19+ carry-overs.
- File `.planning/STATE.md` updated with frontmatter `completed_phases: 5`, `percent: 83`; body new top paragraph; Active Decisions new top entry; Active Todos `/gsd:plan-phase 19` + Phase 18 rebuild todo.
- File `.planning/ROADMAP.md` updated with Phase 18 row `[x] ✅ 2026-06-01` + Plans 8/8 + Progress table row Complete + 2026-06-01.
- File `.planning/REQUIREMENTS.md` Coverage line shows `42/48 Complete / 6 Pending (EMBP × 2 + OBSV × 4)` + footer timestamp updated.
- Commit `ecc7e75` present in `git log`.
- Commit `b4eee2b` present in `git log`.
- `npx tsc --noEmit` exits 0.
- `bash -n bin/smoke-test-router.sh` exits 0.
- Cardinality CI guard PASSES.
- All 5 grep gates (Frame-01 ×3 + P2-04 + P9-01) green.
- Full vitest: 1253 passed / 2 failed (hotreload.vram pre-existing flake) / 38 skipped / 2 todo.
- 36 passed across the 5 flipped test files (sentinel + 35 deferred cases).
- 12/12 BLOCK pitfalls verified by automated tests + grep gates.
- 6/6 ROADMAP SCs verified by tests.
- STATE.md regression check: Phase 14/15/16/17 entries PRESERVED VERBATIM in body chain.
