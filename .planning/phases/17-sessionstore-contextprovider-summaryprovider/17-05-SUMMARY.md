---
phase: 17
plan: 05
subsystem: providers/middleware/config
tags: [summary-provider, sessionid-prehandler, env-schema, model-entry-schema, models-yaml, buildappopts, count-tokens-warmup, ctxp-04, sump-01, sump-02, sump-03, sess-05, sess-06, pitfall-17-i]
requires:
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-01-SUMMARY.md
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-03-SUMMARY.md
  - .planning/phases/17-sessionstore-contextprovider-summaryprovider/17-04-SUMMARY.md
  - router/src/providers/session-store.ts
  - router/src/providers/session-errors.ts
  - router/src/providers/context-provider.ts
  - router/src/translation/count-tokens.ts
provides:
  - "SummaryProvider interface + NoopSummaryProvider (SUMP-01..03 + P6-01 BLOCK) — Plan 17-06 imports `import { NoopSummaryProvider, type SummaryProvider } from '../providers/summary-provider.js'` and uses Noop as the fallback when BuildAppOpts.summaryProvider is undefined."
  - "sessionIdPreHandler middleware + module-augmented `req.sessionId?: string` (SESS-05/06) — Plan 17-06 route session-attach reads `req.sessionId` to gate the loadHistory call; SESS-06 silent-NULL on absent header preserves Phase 16 byte-identical wire behavior."
  - "EnvSchema.SESSION_TTL_DAYS (Q2 RESOLVED) — Plan 17-07 production composition threads `env.SESSION_TTL_DAYS * 86400` into PostgresSessionStore.createSession ttl_seconds default."
  - "ModelEntrySchema.ctx_size + context_strategy (CTXP-04) — ContextProvider (Plan 17-04) already reads these via `entry.ctx_size ?? 8192` + `entry.context_strategy ?? 'sliding-window'` cast; the Zod widening makes those `??` fallbacks belt-and-suspenders."
  - "models.yaml CONTEXT WINDOW operator banner (CTXP-04 docs) — comment-only; no entry modifications; no Valkey cache invalidation required."
  - "BuildAppOpts widened with 4 optional Phase-17 fields (sessionStore + contextProvider + summaryProvider + sessionIdPreHandler) — Plan 17-06 routes destructure these via `opts.contextProvider ?? new DefaultContextProvider` etc., and Plan 17-07 production composition threads the real instances."
  - "countTokens boot warmup (Pitfall 17-I) — cl100k_base BPE tables warmed once at app construction; first session-attached request no longer eats ~50-200 ms tokenizer-init latency."
affects:
  - 17-06-PLAN.md (route wire-up) — can now reach for the 4 new BuildAppOpts fields + the validated `req.sessionId` field; the SUMP-03 BLOCK Noop pattern is the canonical fallback when `opts.summaryProvider` is undefined.
  - 17-07-PLAN.md (production composition + verification harness) — thread `env.SESSION_TTL_DAYS`, build `PostgresSessionStore` + `DefaultContextProvider` + `NoopSummaryProvider`, and pass them as opts. The P9-02 golden-snapshot SESS-06 regression test in Plan 17-07 verifies the byte-identical contract that Task 3's full-suite green run already smoke-tested.
tech-stack:
  added: []
  patterns:
    - "Middleware preHandler template repeated for a third time (after agentId + scopedIds): module augmentation + anchored regex constant + first-wins header extraction (RFC 9110 §5.3) + throw-vs-silent-NULL policy. sessionId picks the STRICT path (throw on regex fail) per the operational-load-bearing rationale; scopedIds is the MIXED case (strict on tenant/project, silent on workload_class)."
    - "Zod widening with .default() (not .optional() with `??` callsite fallback) — second instance (Phase 14 policy block was the first). Makes the inferred type require the field; literal-constructed fixtures must supply explicit values, parse-time entries pick up defaults automatically. Trade-off: a Rule-3 chore of updating fixtures vs. the elimination of `??` fallbacks at every callsite."
    - "BuildAppOpts optional-widening (4 new ?-prefix fields) — preserves byte-identical wire behavior for existing test fixtures (SESS-06 regression contract). Plans add fields here freely as long as defaults preserve old behavior."
    - "Boot-time CPU warmup pattern (countTokens) — when a CPU-bounded module has lazy-loaded state, warm it once at boot with a minimal valid input so the first request doesn't pay the init cost. try/catch wrapped — non-fatal failure surfaces as warn log, not boot failure."
key-files:
  created:
    - router/src/providers/summary-provider.ts
    - router/src/middleware/sessionId.ts
  modified:
    - router/src/config/env.ts
    - router/src/config/registry.ts
    - router/models.yaml
    - .env.example
    - router/src/app.ts
    - router/tests/providers/summary-provider.test.ts
    - router/tests/middleware/sessionId.test.ts
    - router/tests/config/registry-ctx.test.ts
    - router/tests/unit/factory.test.ts
    - router/tests/unit/mcp/host/tools/create-embedding.test.ts
    - router/tests/unit/mcp/host/tools/list-models.test.ts
    - router/tests/unit/mcp/host/tools/rerank.test.ts
    - router/tests/unit/registry.test.ts
key-decisions:
  - "Rule-3 fixture sync — adding ctx_size + context_strategy to ModelEntrySchema with .default() (not .optional()) made the two fields appear as REQUIRED on the inferred ModelEntry type. Five test-fixture files (factory.test.ts + list-models.test.ts + create-embedding.test.ts + rerank.test.ts + registry.test.ts) construct ModelEntry literals and now need to supply both fields. The fix is mechanical and was applied in Task 3; YAML-parsed entries are unaffected because Zod populates defaults at parse time. No behavior change — the literal fixtures were already using ctx_size=8192-equivalent assumptions."
  - "STRICT path for invalid X-Session-ID (PATTERNS line 97) — diverges from scopedIds.ts which silent-NULLs invalid X-Workload-Class. Rationale: session ID is operationally load-bearing (scopes loadHistory + appendTurn at the privileged-write boundary); a malformed value is a caller bug deserving a 400, not silently-dropped metadata. Same rationale family as D-15 (agent_id strict) vs D-11 (workload_class silent)."
  - "countTokens warmup placement — between the X-Model-Backend onSend hook and the first route registration (registerHealthz). Earlier (before MCP plugin registration) would be acceptable; later (after route registration) would defeat the purpose because the first inflight request could land before the warmup completes. Current placement is the simplest spot that still beats any inflight request."
  - "models.yaml banner placement — after POLICY PRIMITIVES, before backends: section. Groups all v0.11.0 stanzas together in operator-facing yaml; mirrors Phase 14's banner placement decision."
  - "SESSION_TTL_DAYS schema position — appended at the END of EnvSchema, after the Phase 15 MCP_* block (chronological order). Placing it inside the MCP block would mis-suggest a coupling; appending preserves the audit trail that each Phase added env vars in order. No reorganization of existing fields."
requirements-completed: [SUMP-01, SUMP-02, SUMP-03, CTXP-04, SESS-05, SESS-06]
duration: 10m 24s
duration_seconds: 624
completed: 2026-06-01T03:27:42Z
tasks_completed: 3
files_created: 2
files_modified: 12
---

# Phase 17 Plan 05: SummaryProvider + sessionIdPreHandler + EnvSchema/ModelEntrySchema widening + models.yaml banner + BuildAppOpts widening + countTokens warmup Summary

**Supporting wiring layer for Phase 17 — 2 new files (244 lines) + 12 modified files (4 production + 5 test fixtures + 3 docs/yaml/env-example), 19 new real `it()` assertions across 3 test files (5 SUMP + 6 SESS + 8 CTXP), and the SESS-06 byte-identical regression contract verified by 1068 passing tests (was 1049 pre-plan).**

## Performance

- **Duration:** 10m 24s (624s)
- **Started:** 2026-06-01T03:17:18Z
- **Completed:** 2026-06-01T03:27:42Z
- **Tasks:** 3 (no checkpoints; fully autonomous)
- **Files created:** 2 (`router/src/providers/summary-provider.ts` 137 lines, `router/src/middleware/sessionId.ts` 107 lines)
- **Files modified:** 12 (4 production + 5 test fixtures + 3 docs/yaml/env-example — see Files table below)

## Task Commits

1. **Task 1: SummaryProvider + sessionIdPreHandler + unit tests** — `501f2a0` (feat)
2. **Task 2: EnvSchema + ModelEntrySchema widening + models.yaml banner + .env.example + registry-ctx tests** — `a047ff7` (feat)
3. **Task 3: BuildAppOpts widening + sessionIdPreHandler registration + countTokens warmup + Rule-3 fixture sync** — `2a70a55` (feat)

## Files Created (2)

| File | Lines | Purpose |
|------|-------|---------|
| `router/src/providers/summary-provider.ts` | 137 | `SummaryProvider` interface + `SummarizeOpts` + `SummarizeResult` + `NoopSummaryProvider` default (SUMP-01..03). Header docblock cites Frame-03 binding (no model-based default), SUMP-03 BLOCK defensive guard, and the strategic frame ("router exposes seam, downstream supplies impl"). |
| `router/src/middleware/sessionId.ts` | 107 | `sessionIdPreHandler` + module-augmented `req.sessionId?: string` (SESS-05/06). Header docblock cites HOOK-ORDERING DEPENDENCY (after agentIdPreHandler), CRITICAL DIVERGENCE from scopedIds (strict-only path), SESS-06 stateless contract, and ReDoS analysis. Regex `/^[A-Za-z0-9._:-]{1,128}$/` (verbatim). |

## Files Modified (12)

| File | Change | Notes |
|------|--------|-------|
| `router/src/config/env.ts` | +7 lines | SESSION_TTL_DAYS line 125 — `z.coerce.number().int().min(1).default(7)`. Q2 RESOLVED. |
| `router/src/config/registry.ts` | +13 lines | ctx_size line 73, context_strategy line 74 — Zod widening with built-in `.default(...)` (NOT `.optional()`). CTXP-04. |
| `router/models.yaml` | +35 lines | CONTEXT WINDOW banner lines 61-95 (comment-only — no entry modifications). |
| `.env.example` | +9 lines | Phase 17 SESSION_TTL_DAYS docblock at end (lines 321-326). |
| `router/src/app.ts` | +57 lines | 4 imports + BuildAppOpts widening (lines 138-175 — 4 new optional fields) + sessionIdPreHandler registration (line 383, AFTER agentIdPreHandler) + countTokens warmup (lines 808-831). |
| `router/tests/providers/summary-provider.test.ts` | +149 / -27 | 5 it.todo → 5 real `it()` covering interface shape (expectTypeOf), Noop empty result, no-fetch invariant (vi.spyOn(globalThis.fetch)), SUMP-03 null gate, caller-flag honor. |
| `router/tests/middleware/sessionId.test.ts` | +77 / -7 | 6 it.todo → 6 real `it()` covering absent header silent-NULL, valid stamp, control-chars throw, length-cap (128 boundary + 129 reject), RFC 9110 §5.3 first-wins, empty-string throw. |
| `router/tests/config/registry-ctx.test.ts` | +71 / -9 | 8 it.todo → 8 real `it()` covering ctx_size + context_strategy defaults, explicit overrides, ZodError on positive()/integer()/enum() violations. |
| `router/tests/unit/factory.test.ts` | +10 lines | Rule-3 fixture sync — 5 fixture helpers gained `ctx_size: 8192, context_strategy: 'sliding-window'`. |
| `router/tests/unit/mcp/host/tools/create-embedding.test.ts` | +3 lines | Rule-3 fixture sync — EMBED_ENTRY literal. |
| `router/tests/unit/mcp/host/tools/list-models.test.ts` | +9 lines | Rule-3 fixture sync — 3 ModelEntry literals (CHAT_LOCAL, EMBED_LOCAL, CLOUD_DENIED). |
| `router/tests/unit/mcp/host/tools/rerank.test.ts` | +3 lines | Rule-3 fixture sync — RERANK_ENTRY literal. |
| `router/tests/unit/registry.test.ts` | +6 lines | Rule-3 fixture sync — inline ModelEntry constructed inside `_swap atomically` test. |

## EnvSchema: SESSION_TTL_DAYS (Q2 RESOLVED)

```typescript
// router/src/config/env.ts:120-125
  // Phase 17 (v0.11.0 — SESS-04 / Q2 RESOLVED): default TTL for new sessions
  // (sliding-window per Q6 RESOLVED — refreshed on every successful appendTurn).
  // Min 1 day; a value < 1 is operator misconfiguration (a 0-day TTL means
  // every session expires immediately and loadHistory always returns []).
  // Threaded into PostgresSessionStore.createSession via the production
  // composition root (Plan 17-07).
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).default(7),
```

## ModelEntrySchema: ctx_size + context_strategy (CTXP-04)

```typescript
// router/src/config/registry.ts:63-74
  // Phase 17 (v0.11.0 — CTXP-04): per-model context window + strategy.
  // ... (rationale block)
  ctx_size: z.number().int().positive().default(8192),
  context_strategy: z.enum(['truncate', 'sliding-window']).default('sliding-window'),
```

- `ctx_size` at line 73.
- `context_strategy` at line 74.
- Critical: NOT wrapped in `.optional()` — keys may be omitted in YAML but the parsed value is always populated.

## models.yaml: CONTEXT WINDOW Banner Range

Lines **61–95** (comment-only; no entry modifications):

- Line 61: opening `─` rule.
- Line 62: `# CONTEXT WINDOW (Phase 17 — v0.11.0 — CTXP-04)` (matches the acceptance grep gate verbatim).
- Lines 63–94: doc text (ctx_size + context_strategy explanations + example block).
- Line 95: closing `─` rule.

The banner is placed AFTER the POLICY PRIMITIVES block (lines 1–59) and BEFORE the `backends:` section (line 97). This groups all v0.11.0 stanzas logically.

**Operator hot-edit note:** because this commit ONLY adds a comment block to `models.yaml` (no schema-affecting changes), the Valkey cache-invalidation dance (`valkey-cli DEL 'model-registry:*' && docker compose up -d --force-recreate router` per `project_models_yaml_hot_edit.md`) is NOT required for this commit. The hot-edit dance applies when entry-level fields change. Operators adding `ctx_size: ...` or `context_strategy: ...` to specific entries DO need it.

## app.ts: BuildAppOpts Widening + preHandler Registration Order + countTokens Warmup

### BuildAppOpts new fields (lines 138-175)

- Line 151: `sessionStore?: SessionStore;`
- Line 159: `contextProvider?: ContextProvider;`
- Line 167: `summaryProvider?: SummaryProvider;`
- Line 175: `sessionIdPreHandler?: preHandlerAsyncHookHandler;`

All four are `?`-prefixed (optional) — SESS-06 byte-identical regression contract.

### preHandler registration order (3 `app.addHook('preHandler', ...)` calls)

```
Line 364: app.addHook('preHandler', opts.scopedIdsPreHandler ?? defaultScopedIdsPreHandler);
Line 372: app.addHook('preHandler', opts.agentIdPreHandler   ?? defaultAgentIdPreHandler);
Line 383: app.addHook('preHandler', opts.sessionIdPreHandler ?? defaultSessionIdPreHandler);
```

Fastify v5 preserves `addHook('preHandler', ...)` registration order; first-registered runs first. Order rationale:
- `scopedIds` first because `agentId` needs `req.tenantId / req.projectId / req.workloadClass` for the pino `.child()` enrichment.
- `sessionId` last because the route session-attach reads `req.agentId` to scope `SessionStore.loadHistory` (P4-03 anti-leak boundary).

### countTokens boot warmup (Pitfall 17-I)

Lines **808-831** (between the `onSend` hook and the first route registration `registerHealthz`):

```typescript
// router/src/app.ts:825-829
  try {
    countTokens({
      model: 'warmup',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'warmup' }] }],
    });
  } catch (warmupErr) {
    app.log.warn({ err: warmupErr }, 'countTokens warmup failed (non-fatal ...)');
  }
```

Try/catch wrapped — failures are non-fatal warns. The minimal `CanonicalRequest` exercises the real `encode()` path so the cl100k_base BPE dictionary is loaded into RAM before any user request lands.

## .env.example Update Path

Repo-root `/home/luis/proyectos/local-llms/.env.example` (NOT `router/.env.example`). The MCP-block precedent (Phase 15) used the same path, so this plan follows suit. Added the SESSION_TTL_DAYS docblock at lines 321-326 (after the Phase 15 MCP block, at the end of the file).

## SESS-06 Byte-Identical Regression Evidence

| Layer | Test files | Pre-plan pass | Post-plan pass | Delta |
|------|-----------|--------------:|---------------:|------:|
| All Phase 14/15/16 integration suite | `tests/integration/**/*.test.ts` | 223 | 223 | 0 |
| Full vitest suite | all tests | 1049 pass / 31 skipped / 27 todo | 1068 pass / 31 skipped / 19 todo | +19 it() lit up (5 SUMP + 6 SESS + 8 CTXP); 0 regressions |

19 new `it()` assertions lit up across the 3 Wave-0 test files; 0 existing tests regressed. The byte-identical contract is preserved because:
- `sessionIdPreHandler` is silent-NULL on absent header (req.sessionId stays undefined).
- All 4 new BuildAppOpts fields are optional; existing test fixtures build apps without them and observe identical behavior.
- The route handlers in Plan 17-06 (deferred) will short-circuit when `req.sessionId === undefined`. Until Plan 17-06 lands, the routes don't read `req.sessionId` at all, so the new preHandler is a pure observer.

## 3 Test Files Flipped: 19 Real Assertions; 0 Todos Remain

| Test file | Before | After |
|----------|-------:|------:|
| `tests/providers/summary-provider.test.ts` | 0 it() / 5 it.todo | 5 it() / 0 it.todo |
| `tests/middleware/sessionId.test.ts` | 0 it() / 6 it.todo | 6 it() / 0 it.todo |
| `tests/config/registry-ctx.test.ts` | 0 it() / 8 it.todo | 8 it() / 0 it.todo |
| **TOTAL** | **0 / 19** | **19 / 0** |

## Deviations from Plan

### Rule 3 — auto-fix blocking issues

**1. [Rule 3 — Blocking type errors] ModelEntrySchema widening cascaded to 5 literal-constructed test fixtures**
- **Found during:** Task 3 (running `npx tsc --noEmit` after the Task 2 schema widening landed).
- **Issue:** Adding `ctx_size` + `context_strategy` with `.default(8192)` / `.default('sliding-window')` (not `.optional()`) makes both fields REQUIRED on the inferred `ModelEntry` TS type. Five existing test-fixture files construct `ModelEntry` literals (`tests/unit/factory.test.ts`, `tests/unit/mcp/host/tools/list-models.test.ts`, `tests/unit/mcp/host/tools/create-embedding.test.ts`, `tests/unit/mcp/host/tools/rerank.test.ts`, `tests/unit/registry.test.ts`) and now fail to type-check.
- **Fix:** Added `ctx_size: 8192` + `context_strategy: 'sliding-window'` to each literal-constructed ModelEntry (8 sites across 5 files). No behavior change — the new fields match the values the fixtures were implicitly assuming via the previous absence + downstream `?? 8192` fallback in context-provider.ts.
- **Files modified:** 5 test files (listed in Files Modified table).
- **Commit:** Bundled into Task 3's commit `2a70a55` (the fix landed alongside the widening's transitive consumer in app.ts, which is the single change that exposed the cascade).

### No Rule 1 / Rule 2 / Rule 4 deviations

The implementation matched the PLAN.md `<action>` sketches verbatim. The Rule-3 fix is the only deviation, and it's the inevitable consequence of choosing `.default()` over `.optional()` for the schema widening — a deliberate decision (CTXP-04 wants the fields ALWAYS populated on the inferred type so route handlers / ContextProvider don't carry `??` fallbacks at every callsite).

## Verification Gates (Acceptance Criteria from PLAN.md)

| Gate | Target | Actual | Status |
|------|--------|--------|--------|
| `tests/providers/summary-provider.test.ts` | 5 real `it()` / 0 todos | 5 pass / 0 todos | ✓ |
| `tests/middleware/sessionId.test.ts` | 6 real `it()` / 0 todos | 6 pass / 0 todos | ✓ |
| `tests/config/registry-ctx.test.ts` | 8 real `it()` / 0 todos | 8 pass / 0 todos | ✓ |
| `tsc --noEmit` exits 0 (or no NEW diagnostics) | 0 new | 0 new (pre-existing `fakes.ts:184` unchanged — documented in 17-04 SUMMARY) | ✓ |
| `grep -nE "^export.*NoopSummaryProvider" src/providers/summary-provider.ts` | 1 line | 1 line (line 123) | ✓ |
| `grep -nE "InvalidSessionIdError" src/middleware/sessionId.ts` | ≥ 2 lines | 5 lines (import + 4 in code/comments) | ✓ |
| `grep -nE "declare module 'fastify'" src/middleware/sessionId.ts` | 1 line | 1 line (line 40) | ✓ |
| `grep -nE "SESSION_ID_RE = /\^\[A-Za-z0-9._:-\]\{1,128\}\$/" src/middleware/sessionId.ts` | 1 line | 1 line (line 59) | ✓ |
| `grep -nE "ctx_size.*positive\(\).default\(8192\)" src/config/registry.ts` | 1 line | 1 line (line 73) | ✓ |
| `grep -nE "SESSION_TTL_DAYS" src/config/env.ts` | 1 line | 1 line (line 125) | ✓ |
| `grep -nE "CONTEXT WINDOW.*Phase 17" models.yaml` | 1 line | 1 line (line 62) | ✓ |
| `grep -nE "addHook\('preHandler'.*sessionIdPreHandler" src/app.ts` | 1 line | 1 line (line 383) | ✓ |
| `grep -nE "Phase 17.*BuildAppOpts" src/app.ts` | ≥ 1 line | 4 lines (one docblock header per new field) | ✓ |
| `grep -cE "addHook\('preHandler'" src/app.ts` | ≥ Phase 16 baseline (2) | 3 (scopedIds + agentId + sessionId) | ✓ |
| Full vitest suite passes (no regressions) | 0 regressions | 1068 pass / 31 skipped / 19 todo (was 1049/31/27 — 19 new it() lit up; 0 existing failures) | ✓ |
| Phase 14/15/16 integration tests (SESS-06 regression contract) | 0 regressions | 223 pass / 19 skipped (zero deltas vs pre-plan) | ✓ |

## Issues Encountered

- **Pre-existing `tests/fakes.ts:184` TS error** — Documented in 17-04 SUMMARY line 231. Not introduced by this plan; will be addressed when Plan 17-06 widens `tests/fakes.ts` to add the `makeFakeContextProvider` / `makeFakeSummaryProvider` factories.
- **Pre-existing `hotreload.vram` test flake** — Not observed in this plan's full-suite run; not introduced by this plan.

## Next Phase Readiness

Plan 17-06 (route wire-up across `/v1/chat/completions`, `/v1/responses`, `/v1/messages`) can:
- `import { NoopSummaryProvider, type SummaryProvider } from '../providers/summary-provider.js'` and fall back to Noop when `opts.summaryProvider` is undefined.
- Read `req.sessionId` (now module-augmented) to gate the session-attach block; SESS-06 short-circuit when undefined.
- Destructure `opts.sessionStore` / `opts.contextProvider` / `opts.summaryProvider` from BuildAppOpts and use them with Noop / default fallbacks.
- Trust that `req.agentId` is stamped BEFORE the session-attach block runs (preHandler order: scopedIds → agentId → sessionId → route).
- Trust that the first-request cl100k_base latency cost is paid at boot, not in the request handler.

Plan 17-07 (production composition) can:
- Thread `env.SESSION_TTL_DAYS` into `PostgresSessionStore` opts.
- Construct `DefaultContextProvider` (Plan 17-04), `PostgresSessionStore` (Plan 17-03), `NoopSummaryProvider` (this plan), and pass all three through `BuildAppOpts`.
- Ship the P9-02 SESS-06 byte-identical golden-snapshot regression test (the smoke evidence in this SUMMARY is already strong; P9-02 makes it explicit).

## Self-Check: PASSED

- `router/src/providers/summary-provider.ts` exists ✓
- `router/src/middleware/sessionId.ts` exists ✓
- `git log --oneline | grep 501f2a0` → Task 1 commit found ✓
- `git log --oneline | grep a047ff7` → Task 2 commit found ✓
- `git log --oneline | grep 2a70a55` → Task 3 commit found ✓
- 5+6+8 = 19/19 active it() pass; 0 it.todo remain across the 3 flipped test files ✓
- All grep gates resolved (NoopSummaryProvider export, InvalidSessionIdError ≥ 2, declare-module fastify, regex verbatim, ctx_size + SESSION_TTL_DAYS + CONTEXT WINDOW banner present, sessionIdPreHandler registered, BuildAppOpts widening docblocks present, 3 addHook preHandler calls) ✓
- `tsc --noEmit` 0 new diagnostics on the new files ✓
- 0 file deletions across all three commits ✓
- Full suite: 1068 pass + 31 skipped + 19 todo (was 1049/31/27 — 19 new it() lit up; 0 existing failures) ✓
- Phase 14/15/16 integration tests: 223 pass / 19 skipped (SESS-06 byte-identical regression contract preserved) ✓

---
*Phase: 17-sessionstore-contextprovider-summaryprovider*
*Plan: 05*
*Completed: 2026-06-01*
