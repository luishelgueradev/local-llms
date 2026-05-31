# Phase 17: SessionStore + ContextProvider + SummaryProvider — Pattern Map

**Mapped:** 2026-05-31
**Files analyzed:** 17 (12 new + 5 modified + tests)
**Analogs found:** 16 / 17 (one true greenfield: provider interface declarations have no per-shape analog, but file-layout + Error-class + `BuildAppOpts`-injection patterns transfer cleanly)

> Scope: Phase 17 introduces three coupled provider abstractions (`SessionStore`, `ContextProvider`, `SummaryProvider`), one new Postgres migration (0006 — `sessions` + `conversation_turns`), one new preHandler (`sessionId.ts`), Zod schema widening on `ModelEntrySchema`, and a single wire-up shape repeated at three routes (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`). Every action below cites a concrete analog already in the codebase. RESEARCH (`17-RESEARCH.md`) carries the design rationale; this document tells the planner *which existing file to imitate, byte-for-byte where possible*.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `router/src/providers/session-store.ts` (NEW) | provider interface | CRUD | (no direct analog — interface-only; closest is `router/src/backends/adapter.ts` shape) | role-only — copy interface idiom + JSDoc cite-style from `request_log.ts` header |
| `router/src/providers/postgres-session-store.ts` (NEW) | service / data-access | CRUD | `router/src/db/bufferedWriter.ts` (header-comment idiom, drizzle table imports, transaction-vs-buffered contrast) | role-match (Postgres tx writer) |
| `router/src/providers/session-errors.ts` (NEW) | error classes | n/a | `router/src/errors/envelope.ts` (lines 278-296 `InvalidAgentIdError`; lines 337-355 `InvalidScopedIdError`) | exact |
| `router/src/providers/context-provider.ts` (NEW) | provider interface + impl | transform | `router/src/translation/count-tokens.ts:148` (consumer of canonical types; same import idiom) | role-only — pure-function transform |
| `router/src/providers/summary-provider.ts` (NEW) | provider interface + Noop impl | event-driven (deferred) | none (truly new seam) — borrow Error-classes + module-header style from `errors/envelope.ts` | role-only |
| `router/src/middleware/sessionId.ts` (NEW) | middleware | request-response | `router/src/middleware/scopedIds.ts` (lines 21-129) — **direct sibling** | **exact** |
| `router/db/migrations/0006_sessions.sql` (NEW) | migration SQL | n/a | `router/db/migrations/0005_request_log_scoped_ids.sql` (CREATE-vs-ALTER differs, but header banner + `statement-breakpoint` + `COMMENT ON COLUMN` idiom carry) | role-match (DDL idiom) |
| `router/src/db/schema/sessions.ts` (NEW) | schema declaration | n/a | `router/src/db/schema/request_log.ts` (lines 16-83) | **exact** (pgTable + index + type re-export) |
| `router/db/migrations/meta/_journal.json` (MOD) | migration journal | n/a | same file at idx=5 (`0005_request_log_scoped_ids` entry, lines 40-46) | **exact** — copy entry shape verbatim, increment idx + tag + when |
| `router/src/db/schema/index.ts` (MOD) | barrel re-export | n/a | same file lines 6-7 | **exact** — append `export { sessions, conversationTurns, ... } from './sessions.js';` |
| `router/src/config/registry.ts` (MOD) | schema widening | n/a | same file lines 53-61 (`policy: z.object({ cloud_allowed: ... })` widening from Phase 14 — POL-02) | **exact** — same `.optional()` widening shape |
| `router/models.yaml` (MOD) | operator-facing config | n/a | same file lines 1-59 (Phase 14 POLICY PRIMITIVES commented banner) | **exact** — append a CONTEXT WINDOW banner stanza of the same shape |
| `router/src/app.ts` (MOD) — `BuildAppOpts` widening + preHandler registration | composition root | wire-up | same file lines 72-234 (BuildAppOpts shape) + lines 321-329 (scopedIds → agentId preHandler ordering) | **exact** |
| `router/src/routes/v1/chat-completions.ts` (MOD) — insert session-attach block | route handler | request-response + streaming | same file lines 156-208 (preflight → adapter scaffolding) + lines 643-735 (sseCleanup closure) | **exact** (self-analog — Phase 17 inserts INTO this file) |
| `router/src/routes/v1/responses.ts` (MOD) | route handler | request-response + streaming | `chat-completions.ts` is the canonical sibling; same applyPreflight idiom at lines 323-337 | **exact** |
| `router/src/routes/v1/messages.ts` (MOD) | route handler | request-response + streaming | `chat-completions.ts`; same applyPreflight idiom at lines 191-228 | **exact** |
| `router/tests/providers/*.test.ts` (NEW, 4 files) | unit tests | n/a | `router/tests/unit/dispatch/preflight.test.ts` (vitest + fakes + casts) | exact (unit-test idiom) |
| `router/tests/integration/migrations/0006-sessions.test.ts` (NEW) | integration test | n/a | (no prior real-PG migration integration test exists) — closest is `router/tests/integration/cloud-spend-daily.test.ts` (real-PG fixture) | role-match |
| `router/tests/routes/session-attach.integration.test.ts` (NEW) | integration test | request-response | `router/tests/routes/idempotency-integration.test.ts` (Phase 8 — three-route fixture w/ shared buildApp) | **exact** (same-shape across 3 routes) |
| `router/tests/db/migration-journal.test.ts` (NEW) | filesystem-assertion test | n/a | `router/tests/migration0005.test.ts` (lines 35-106 — atomic-tuple integrity) + `router/tests/unit/mcp/host/stdio-grep-gate.test.ts` (lines 51-96 — grep-gate idiom) | **exact** (mirror migration0005.test.ts; rename + retarget paths) |
| `router/tests/config/registry-ctx.test.ts` (NEW) | unit test | n/a | `router/src/config/__tests__/registry.policies.test.ts` (Zod-parse unit-test idiom) | **exact** |

---

## Pattern Assignments

### `router/src/middleware/sessionId.ts` (middleware, request-response)

**Analog:** `router/src/middleware/scopedIds.ts` — Phase 14 sibling. **This is the canonical template.** The session ID preHandler is structurally identical: header parse → regex validate → stamp on `req`. Diverges only in the field name, error class, and the fact that ABSENT header is the silent-NULL stateless path (matches scopedIds' `extractScopedId` early-return at line 78).

**Header comment idiom** (copy lines 1-23 of `scopedIds.ts` verbatim, adapt to Phase 17):
```typescript
// router/src/middleware/sessionId.ts — Fastify preHandler for X-Session-ID
// (Phase 17 / v0.11.0 — SESS-05/SESS-06).
//
// HOOK-ORDERING DEPENDENCY:
// This preHandler MUST be registered AFTER agentIdPreHandler in app.ts. The
// session attach block in each route reads req.agentId (stamped by agentId)
// to scope SessionStore.loadHistory — must already be stamped when this hook
// runs.
//
// Module augmentation extends FastifyRequest with sessionId so route files
// type-check without `as any`.
//
// ReDoS analysis: /^[A-Za-z0-9._:-]{1,128}$/ has NO nested quantifiers, NO
// alternation overlap, anchored at both ends, length-bounded {1,128}. Safe.
```

**Module augmentation** (copy structure from `scopedIds.ts:24-43`):
```typescript
declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Phase 17 (v0.11.0 — SESS-05): X-Session-ID validated by sessionIdPreHandler;
     * undefined when header absent (stateless mode per SESS-06).
     */
    sessionId?: string;
  }
}
```

**Regex constant** (copy exactly the shape from `scopedIds.ts:50`):
```typescript
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
```

**preHandler core** (mirror `scopedIds.ts:109-129`):
```typescript
export async function sessionIdPreHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const raw = req.headers['x-session-id'];
  if (raw === undefined) return;                        // SESS-06: stateless
  const value = Array.isArray(raw) ? raw[0] : raw;      // RFC 9110 §5.3 first-wins (scopedIds.ts:82)
  if (typeof value !== 'string' || !SESSION_ID_RE.test(value)) {
    throw new InvalidSessionIdError(typeof value === 'string' ? value : '');
  }
  req.sessionId = value;
}
```

**Critical divergence from scopedIds:** scopedIds treats invalid X-Tenant-ID/X-Project-ID as 400 (D-16) but X-Workload-Class as silent-NULL (D-12). Phase 17 picks the **strict** path — invalid `X-Session-ID` → 400 — because session ID is operationally load-bearing (badly-formed ID = client bug, not opaque metadata). Same rationale as Phase 14's per-ID-class decision (D-15 vs D-11).

---

### `router/src/providers/session-errors.ts` (error classes)

**Analog:** `router/src/errors/envelope.ts` — error class declarations follow an exact shape across the codebase.

**Existing pattern** (`envelope.ts:278-296` for `InvalidAgentIdError`):
```typescript
export class InvalidAgentIdError extends Error {
  readonly code = 'invalid_agent_id';
  readonly httpStatus = 400 as const;
  constructor(public raw: string) {
    super(`X-Agent-Id must match /^[A-Za-z0-9._:-]{1,128}$/`);
    this.name = 'InvalidAgentIdError';
  }
}
```

**Apply to all four Phase 17 errors** (`SessionNotFoundError`, `SessionExpiredError`, `SessionAgentMismatchError`, `InvalidSessionIdError`) — RESEARCH §"Error Classes" lines 322-353 already gives the exact signatures. Match the readonly-field + `this.name` assignment pattern from envelope.ts so `mapToHttpStatus()` + `toOpenAIErrorEnvelope()` instanceof checks work uniformly.

**Wire into the centralized handler** (planner: update `router/src/errors/envelope.ts`):
- Add `mapToHttpStatus` cases for the new errors (mirror `envelope.ts:395` `InvalidAgentIdError → 400`).
- Add the envelope translation for OpenAI + Anthropic surfaces. `InvalidSessionIdError` is the only one that ALWAYS bubbles to a 4xx; the other three are caught locally in the route per RESEARCH §"Route policy for the centralized handler" (lines 357-361).

---

### `router/src/db/schema/sessions.ts` (schema declaration)

**Analog:** `router/src/db/schema/request_log.ts` — Drizzle table declaration with imports, indexes, and type re-export.

**Imports pattern** (`request_log.ts:16-17`):
```typescript
import { sql } from 'drizzle-orm';
import { index, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
```

**For sessions.ts, swap to** (per RESEARCH §"Drizzle Schema" lines 469-536):
```typescript
import { sql } from 'drizzle-orm';
import {
  boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';
```

**Table-declaration idiom** (`request_log.ts:19-79`):
```typescript
export const requestLog = pgTable(
  'request_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    // ... columns ...
  },
  (t) => ({
    idxTsDesc: index('idx_request_log_ts_desc').on(t.ts.desc()),
    idxAgentTs: index('idx_request_log_agent_ts').on(t.agent_id, t.ts.desc()),
    // ... indexes ...
  }),
);
```

**Type re-export** (`request_log.ts:82`):
```typescript
export type RequestLogInsert = typeof requestLog.$inferInsert;
```

For Phase 17 add **both** `$inferSelect` and `$inferInsert` (RESEARCH lines 532-535 — needed because `loadHistory` returns selected rows while `appendTurn` consumes insert shape).

---

### `router/src/db/schema/index.ts` (barrel re-export — MOD)

**Existing pattern** (`index.ts:6-7`):
```typescript
export { requestLog, type RequestLogInsert } from './request_log.js';
export { usageDaily, type UsageDailyInsert } from './usage_daily.js';
```

**Action:** Append two lines for the new module:
```typescript
export { sessions, conversationTurns, type SessionRow, type SessionInsert, type ConversationTurnRow, type ConversationTurnInsert } from './sessions.js';
```

---

### `router/db/migrations/0006_sessions.sql` (migration SQL)

**Analog:** `router/db/migrations/0005_request_log_scoped_ids.sql`

**Header banner pattern** (`0005_request_log_scoped_ids.sql:1-27`):
```sql
-- Migration 0005: request_log scoped-ID columns + workload_class
--   (Phase 14 / v0.11.0 — POL-03/POL-04, migration filename per D-22,
--    columns include workload_class per D-14).
-- [... per-column docstring ...]
-- Idempotent: ADD COLUMN IF NOT EXISTS — re-running this migration is a no-op.
-- Mirrors the 0002_request_log_idempotency_key.sql precedent.
```

For 0006 the create-vs-alter shape differs (0006 creates **two new tables**, 0005 alters one). RESEARCH §"Migration SQL" lines 387-467 gives the full `0006_sessions.sql` body verbatim — copy that into the plan.

**Statement breakpoint marker** (`0005_request_log_scoped_ids.sql:31, 34`):
```sql
ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "tenant_id" text;
--> statement-breakpoint
ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "project_id" text;
```

**0006 must use `--> statement-breakpoint` between every DDL statement** (CREATE TABLE + each index + each COMMENT). The Drizzle migrator splits on this marker — without it, the migration runs as a single transactional statement and any failure rolls back the whole batch silently.

**COMMENT ON COLUMN idiom** (`0005_request_log_scoped_ids.sql:38-43`):
```sql
COMMENT ON COLUMN "request_log"."tenant_id" IS
  'POL-04 (Phase 14): tenant scoping header X-Tenant-ID. Regex /^[A-Za-z0-9._:-]{1,128}$/. Invalid → 400; missing → NULL.';
```

For 0006, mirror exactly per RESEARCH lines 457-466 (cite SESS-03, P4-01, SUMP-03, P4-06 in the column comments).

---

### `router/db/migrations/meta/_journal.json` (MOD — atomic-tuple write)

**Analog:** Same file, entry at idx=5 (lines 40-46):
```json
{
  "idx": 5,
  "version": "7",
  "when": 1780142072840,
  "tag": "0005_request_log_scoped_ids",
  "breakpoints": true
}
```

**Append entry for idx=6** with identical shape:
```json
{
  "idx": 6,
  "version": "7",
  "when": <Date.now() at write time>,
  "tag": "0006_sessions",
  "breakpoints": true
}
```

**P9-01 BLOCK invariant (project memory: `project_drizzle_migration_journal.md`):** The SQL file, the Drizzle schema (`sessions.ts`), AND the `_journal.json` entry are an **indivisible tuple**. Drizzle's migrator silently skips entries not registered in the journal. **The planner MUST group these three writes into a single plan task** — do not split across plans. The test `router/tests/db/migration-journal.test.ts` is the grep gate that enforces this.

---

### `router/src/config/registry.ts` (Zod schema widening — MOD)

**Analog:** Same file lines 53-61 — Phase 14 `policy` field addition (POL-02). This is the canonical Zod-widening pattern in the codebase.

**Existing widening pattern** (`registry.ts:53-62`):
```typescript
  // Phase 14 (v0.11.0 — POL-02, D-02, D-05): per-entry policy block.
  // `cloud_allowed` defaults to true when omitted; gate uses strict `=== false` to fire only when
  // explicitly denied. Local-backend entries can legally set cloud_allowed: false — vacuous but not
  // an error. No passthrough — P8-02 strict-schema discipline.
  policy: z
    .object({
      cloud_allowed: z.boolean().default(true),
    })
    .optional(),
});
```

**For Phase 17 CTXP-04** (insert AFTER the `policy:` block, BEFORE the closing `});`):
```typescript
  // Phase 17 (v0.11.0 — CTXP-04): per-model context window + strategy.
  // Both default to safe values so existing models.yaml entries continue to load
  // without modification. When SessionStore is wired and ContextProvider is active,
  // these drive window trimming.
  ctx_size: z.number().int().positive().default(8192),
  context_strategy: z.enum(['truncate', 'sliding-window']).default('sliding-window'),
});
```

**Critical difference from `policy`:** Phase 17's fields are **not wrapped in an outer `.optional()`** — they have built-in `.default(...)`, so the field key may be omitted but the runtime value is always populated. This is the safer shape for fields the route handler reads unconditionally (no `?? 8192` fallback at the call site).

**No `superRefine` interaction needed** — RESEARCH §"Standard Stack" line 86 confirms the existing VRAM-envelope refinement is independent of these new fields.

---

### `router/models.yaml` (operator-facing — MOD)

**Analog:** Same file, lines 1-59 (Phase 14 POLICY PRIMITIVES commented banner).

**Existing pattern** (`models.yaml:1-15`):
```yaml
# ─────────────────────────────────────────────────────────────────────────────
# POLICY PRIMITIVES (Phase 14 — v0.11.0 — POL-01 / POL-02)
# ─────────────────────────────────────────────────────────────────────────────
#
# Two policy controls are available via a top-level `policies:` section and a
# per-entry `policy:` block.  Both default to ALLOW ALL — an absent or empty
# `policies:` section, and absent `policy:` on any model entry, produce
# identical behavior to the pre-v0.11.0 stack (D-04).
# [...]
```

**For Phase 17**, append a NEW banner block before the `backends:` section (or after the POLICY PRIMITIVES block — operator readability is the only constraint). RESEARCH §"`models.yaml` Stanza" lines 1095-1131 gives the full banner text verbatim. Mirror the Phase 14 banner's:
1. Section header with `─────` rules
2. "(Phase 17 — v0.11.0 — CTXP-04)" label
3. Field-by-field explanation (`ctx_size`, `context_strategy`)
4. Default-behavior note ("Sessions are opt-in: requests without X-Session-ID are stateless")
5. Example block

**Do NOT add the fields to existing entries** (RESEARCH line 1133 — Zod defaults take care of that; operators opt in per entry).

**Operational reminder for the commit (project memory `project_models_yaml_hot_edit.md`):** editing `models.yaml` requires `valkey-cli DEL 'model-registry:*'` + `docker compose up -d --force-recreate router` to pick up. Banner edit alone has zero runtime effect (the registry doesn't re-parse), so no hot-edit dance is needed for *this* commit — but the dance is required when an operator later adds `ctx_size:` to an entry.

---

### `router/src/app.ts` (composition root — MOD)

**Analog:** Same file. Two distinct patterns from this file map onto Phase 17 work.

**(a) `BuildAppOpts` widening pattern** (`app.ts:118-132` — agentIdPreHandler + scopedIdsPreHandler optional injection seam):
```typescript
  /**
   * Plan 05-02 (D-D5 / ROUTE-09) — preHandler that validates X-Agent-Id and
   * attaches req.agentId + decorates req.log child. Defaults to the
   * production agentIdPreHandler; tests override for hook-isolation cases.
   */
  agentIdPreHandler?: preHandlerAsyncHookHandler;
  /**
   * Phase 14 (v0.11.0 — POL-03/04 / D-19): preHandler that extracts ...
   */
  scopedIdsPreHandler?: preHandlerAsyncHookHandler;
```

**For Phase 17**, add three optional opts (RESEARCH lines 1054-1064):
```typescript
  /** Phase 17 (SESS-01) — optional. When undefined, all session attach blocks no-op (SESS-06). */
  sessionStore?: SessionStore;
  /** Phase 17 (CTXP-01) — optional. When undefined, route handler skips ContextProvider. */
  contextProvider?: ContextProvider;
  /** Phase 17 (SUMP-01) — optional. When undefined, falls back to NoopSummaryProvider. */
  summaryProvider?: SummaryProvider;
  /** Phase 17 (SESS-05) — test seam for the X-Session-ID preHandler. */
  sessionIdPreHandler?: preHandlerAsyncHookHandler;
```

**Test-fixture contract (load-bearing for SESS-06):** when ALL Phase 17 opts are undefined, the routes behave byte-identical to Phase 16. This is the regression contract enforced by `tests/routes/session-attach.integration.test.ts -t "stateless mode no DB writes"`.

**(b) preHandler-registration pattern** (`app.ts:313-329`):
```typescript
  // Phase 14 (v0.11.0 — POL-03/04): scoped-ID extraction runs BEFORE the
  // agentId preHandler. Both register at the preHandler hook; Fastify v5
  // preserves addHook('preHandler', ...) registration order — first-registered
  // runs first. [...]
  app.addHook('preHandler', opts.scopedIdsPreHandler ?? defaultScopedIdsPreHandler);

  // Plan 05-02 (D-D5 / ROUTE-09) — X-Agent-Id preHandler runs AFTER bearer
  // auth (onRequest) and BEFORE the route handler. [...]
  app.addHook('preHandler', opts.agentIdPreHandler ?? defaultAgentIdPreHandler);
```

**For Phase 17**, insert AFTER agentIdPreHandler (RESEARCH lines 875-887 — order matters because route session-attach reads `req.agentId`):
```typescript
  // Phase 17 (v0.11.0 — SESS-05/06): X-Session-ID preHandler runs AFTER
  // agentIdPreHandler — session attach inside the route reads req.agentId
  // to scope SessionStore.loadHistory (P4-03 BLOCK). Absent header is
  // silent-NULL — see middleware/sessionId.ts.
  app.addHook('preHandler', opts.sessionIdPreHandler ?? defaultSessionIdPreHandler);
```

**(c) Imports pattern** (`app.ts:45-46` — defaultXxxPreHandler import idiom):
```typescript
import { agentIdPreHandler as defaultAgentIdPreHandler } from './middleware/agentId.js';
import { scopedIdsPreHandler as defaultScopedIdsPreHandler } from './middleware/scopedIds.js';
```

**Add for Phase 17:**
```typescript
import { sessionIdPreHandler as defaultSessionIdPreHandler } from './middleware/sessionId.js';
```

**(d) gpt-tokenizer cold-start warmup** (Pitfall 17-I, RESEARCH lines 1266-1274) — insert one `countTokens(...)` warmup call in `buildApp` AFTER `registry.resolve` is wired (look for the existing scheduler-start sequence). No analog in the codebase yet — this is the only piece of Phase 17 app.ts work without a prior pattern; document the warmup in the comment block above the call.

---

### Route wire-up — applied to all three of `chat-completions.ts`, `responses.ts`, `messages.ts`

**Analog:** `router/src/routes/v1/chat-completions.ts` is the canonical sibling. **The Phase 17 insertion shape is identical across all three** (RESEARCH §"Wire-Up at the Route Layer" lines 870-1051 documents the three-route summary at lines 1044-1051).

**Insertion point #1 — after `applyPreflight` + `entry.backend` stamp + `makeAdapter`, BEFORE canonical-build** (`chat-completions.ts:208-215`):
```typescript
const adapter: BackendAdapter = opts.makeAdapter(entry);

// Plan 04-01 (D-A3, D-F3): translate inbound OpenAI body → canonical [...]
const canonical = openAIRequestToCanonical({ ...body, model: entry.backend_model });
```

**Phase 17 insert** between these two lines — RESEARCH §"Route handler integration" lines 914-1003 gives the full insertion sketch. Key invariants:
- Block is GATED on `req.sessionId && opts.sessionStore && req.agentId` (SESS-06 stateless preservation).
- `createSession` → `loadHistory(session_id, agent_id)` → `contextProvider.provideContext(...)` ordering is fixed.
- **`reply.header('X-Session-ID', req.sessionId)` MUST fire before any `reply.sse(...)` or `reply.send(...)`** (Pitfall 17-D — mirrors the `responses.ts:332` `Retry-After` stamp pattern).
- Session attach errors are CAUGHT LOCALLY, logged at warn, route proceeds stateless (Pitfall 17-B + RESEARCH lines 356-361).

**Insertion point #2 — non-stream path, after `canonicalResult` is assigned, BEFORE `reply.send(...)`** (`chat-completions.ts` non-stream branch — search for `canonicalResult = await adapter.chatCompletions...`):
```typescript
// Phase 17: appendTurn x2 (user + assistant). `await` — non-stream path can block on Postgres
// because the response has not been sent yet. SESS-04's 1s timeout bounds worst-case latency.
if (sessionAttached && req.sessionId && req.agentId && canonicalResult) {
  try {
    await opts.sessionStore.appendTurn(req.sessionId, req.agentId, { role: 'user', content: /* canonicalized last user message */ });
    await opts.sessionStore.appendTurn(req.sessionId, req.agentId, {
      role: 'assistant', content: canonicalResult.content,
      tool_calls: extractToolCalls(canonicalResult), model: entry.name,
      tokens_in: canonicalResult.usage.input_tokens, tokens_out: canonicalResult.usage.output_tokens,
    });
  } catch (appendErr) {
    req.log.warn({ err: appendErr, session_id: req.sessionId }, 'session append unexpected failure');
  }
}
```

**Insertion point #3 — stream path, inside `sseCleanup` closure** (`chat-completions.ts:643-735`). The closure is invoked on stream-done/aborted/error via `canonicalToOpenAISse(...)`'s `onCleanup` arg. Pattern from the existing closure body:
```typescript
const sseCleanup = (final?: { tokensIn: number; tokensOut: number; error?: Error }): void => {
  heartbeat.stop();
  req.raw.socket?.off('close', onClose);
  safeRelease();
  // Plan 08-04 — stream-branch breaker signaling. Fire-and-forget [...]
  if (final?.error !== undefined) {
    void opts.breaker.recordFailure(entry.backend, final.error);
  } else {
    void opts.breaker.recordSuccess(entry.backend);
  }
  // Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — leader-side finalize. Fire-and-forget. [...]
```

**Phase 17 appends to sseCleanup** (mirror the existing `void opts.breaker.recordX(...)` fire-and-forget pattern — Pitfall 17-F mandates NEVER `await` here because it blocks SSE close):
```typescript
  // Phase 17 (SESS-04 + Pitfall 17-F): append turns AFTER stream completes (assistant text known).
  // Fire-and-forget IIFE — never await inside sseCleanup or the SSE close hangs on Postgres latency.
  // SESS-04's 1s timeout inside appendTurn bounds the worst-case wallclock.
  if (!final?.error && sessionAttached && req.sessionId && req.agentId) {
    void (async () => {
      try {
        await opts.sessionStore.appendTurn(req.sessionId!, req.agentId!, { role: 'user', content: /* canonicalized */ });
        await opts.sessionStore.appendTurn(req.sessionId!, req.agentId!, {
          role: 'assistant', content: assembleTextContent(streamedChunks),
          tool_calls: extractToolCallsFromStreamedChunks(streamedChunks),
          model: entry.name, tokens_in: final?.tokensIn, tokens_out: final?.tokensOut,
        });
      } catch (e) {
        req.log.warn({ err: e, session_id: req.sessionId }, 'session append after stream failed');
      }
    })();
  }
};
```

**`responses.ts` divergence** (`responses.ts:323-337`): apply-preflight + adapter idiom is identical; the canonical-build call is `responsesToCanonical(body, entry.backend_model)` instead of `openAIRequestToCanonical`. Pass the ContextProvider's `messages` output as a synthetic `input: messages[]` field on the body so `responsesToCanonical` projects them into the canonical. RESEARCH line 1049 documents this.

**`messages.ts` divergence** (`messages.ts:191-228`): same apply-preflight idiom. Anthropic surface has top-level `system: string` on the request body — merge with `pinnedSystem` from ContextProvider using `\n\n` separator. The body's `messages` array is replaced with `ctxResult.messages`. RESEARCH line 1050 documents this.

---

### `router/src/providers/postgres-session-store.ts` (service, CRUD)

**Analog:** `router/src/db/bufferedWriter.ts` — primary contrast reference. RESEARCH §"Alternatives Considered" line 125 cites it explicitly: "bufferedWriter is fire-and-forget — session truth would be lost on crash before flush. **Pick sync write** (SESS-04 BLOCK; explicitly different pattern). See `router/src/db/bufferedWriter.ts` header comments."

**Imports + Drizzle table-handle pattern** (`bufferedWriter.ts:39`):
```typescript
import { requestLog, type RequestLogInsert } from './schema/index.js';
```

**For Phase 17:**
```typescript
import { sessions, conversationTurns, type SessionRow, type ConversationTurnInsert } from '../db/schema/index.js';
import { and, eq, gt, gte, lt, desc, asc, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
```

**Transaction wrapper + advisory lock** (RESEARCH §"`pg_advisory_xact_lock` SQL Wrapper" lines 544-633 — full implementation sketch). Key shape:
```typescript
await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.session_id}::text))`);
// THEN read MAX(turn_index), THEN insert, THEN update sessions row — all inside one tx.
```

**Promise.race timeout wrapper** (RESEARCH lines 617-633) — fail-open under 1s per SESS-04:
```typescript
const timeoutMs = 1000;
return await Promise.race([appendTurnTx(db, input), timeoutPromise]);
```

**Header-comment idiom** (`bufferedWriter.ts:1-38`) — copy the multi-section header with explicit invariant tags:
```
// router/src/providers/postgres-session-store.ts — synchronous Postgres-backed
// SessionStore (Phase 17 — SESS-01..04).
//
// Invariants encoded here (cross-referenced to RESEARCH 17-RESEARCH.md):
//
//   SESS-03 / P4-03 BLOCK  agent_id is a MANDATORY positional parameter on
//                          loadHistory + appendTurn. WHERE clause unconditionally
//                          includes it; mismatched agent → [] on loadHistory,
//                          throws SessionAgentMismatchError on appendTurn.
//
//   SESS-04                appendTurn is SYNC durable write with 1s timeout.
//                          Promise.race(insertPromise, timeoutPromise). On
//                          timeout: persisted=false; caller proceeds stateless.
//                          Explicitly NOT bufferedWriter pattern — see
//                          db/bufferedWriter.ts header for the contrast.
//
//   P4-02 BLOCK            pg_advisory_xact_lock(hashtext(session_id)) INSIDE
//                          the transaction, BEFORE the SELECT MAX(turn_index).
//                          Lock-first-then-read prevents the race.
//
//   P4-01                  expires_at TIMESTAMPTZ NOT NULL. createSession
//                          computes Date.now()+TTL BEFORE the Drizzle insert
//                          (Pitfall 17-H).
```

---

### `router/src/providers/context-provider.ts` (provider interface + impl)

**Analog:** `router/src/translation/count-tokens.ts:148` — consumer of `CanonicalRequest` and `ContentBlock` types. Module shape is pure-function (no I/O).

**Import idiom** (mirror `count-tokens.ts:28`):
```typescript
import { encode } from 'gpt-tokenizer/encoding/cl100k_base';
```

**For Phase 17 — REUSE `countTokens`, don't re-import gpt-tokenizer:**
```typescript
import { countTokens } from '../translation/count-tokens.js';
import type { CanonicalRequest, CanonicalMessage } from '../translation/canonical.js';
import type { ModelEntry } from '../config/registry.js';
import type { Turn } from './session-store.js';
```

RESEARCH lines 765-778 + Pitfall 17-I make this binding: **do not introduce per-model tokenizer dispatch** ("Don't Hand-Roll" table line 1141). The cl100k_base over-estimation is a deliberate safety margin.

**Implementation reference:** RESEARCH §"Default `sliding-window` strategy" lines 700-761 gives the full implementation. Key invariants:
1. Pinned-system collected BEFORE evictable sliced (CTXP-03).
2. Trim loop pops FRONT of `evictable` (oldest non-system), never `pinnedSystem`.
3. Returned `system` string is `pinnedSystem.join('\n\n')` joined verbatim.
4. Returned `messages[]` contains zero `role: 'system'` entries (canonical-correct — `canonical.ts:109` enum is `['user', 'assistant']`).
5. Incoming messages are PRIVILEGED — Pitfall 17-G — they MUST be in the returned `messages[]` always.

---

### `router/src/providers/session-store.ts` + `summary-provider.ts` (interfaces)

**No structural analog in the codebase.** Pattern guidance:

- **Module-header style** — copy from `errors/envelope.ts` (top-of-file JSDoc) or `db/schema/request_log.ts:1-15` (purpose + authoritative-shape citation + invariant tags).
- **TypeScript interface shape** — copy verbatim from RESEARCH §"SessionStore Interface" lines 155-316 and §"SummaryProvider Interface" lines 802-848 (RESEARCH has lock-quality signatures with full JSDoc).
- **Type re-exports** — when SessionStore re-exports `Turn` etc., follow the pattern at `db/schema/request_log.ts:82` (`export type RequestLogInsert = typeof requestLog.$inferInsert;`).

---

### `router/tests/providers/*.test.ts` (unit tests)

**Analog:** `router/tests/unit/dispatch/preflight.test.ts`

**Test-file header** (`preflight.test.ts:1-24`):
```typescript
/**
 * Phase 15 (v0.11.0 — MCPS-01 / CONTEXT.md D-09): Unit tests for applyPreflight().
 *
 * 7-case matrix covering the canonical pipeline:
 *   registry.resolve → applyPolicyGate → breaker.check
 * [...]
 * Test 1: happy path — closed breaker → {entry, breakerState:'closed'}
 * Test 2: registry.resolve throws RegistryUnknownModelError → propagates verbatim
 * [...]
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
```

**Minimal fixture builder pattern** (`preflight.test.ts:42-80`):
```typescript
function makeEntry(backend: string, policy?: { cloud_allowed: boolean }, name = 'chat-local'): ModelEntry {
  return { name, backend, backend_model: 'qwen2.5:7b', policy } as unknown as ModelEntry;
}
function makeFakeStore(entry: ModelEntry, policies?: Registry['policies']): { store: RegistryStore; resolveSpy; getSpy } {
  // ...
}
```

**Cast idiom** — `as unknown as ModelEntry` to bypass irrelevant Zod-required fields. Phase 17 provider tests should follow the same pattern for `Turn`, `SessionRow`, etc. (RESEARCH §"Validation Architecture" tests).

---

### `router/tests/routes/session-attach.integration.test.ts` (integration test)

**Analog:** `router/tests/routes/idempotency-integration.test.ts` — **the same-test-shape-across-3-routes pattern Phase 17 needs.**

**Header docblock** (`idempotency-integration.test.ts:1-22`):
```typescript
/**
 * Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — Idempotency-Key multiplexer end-to-end.
 *
 * Verifies the wire-level behavior of the Idempotency-Key header across the
 * three routes that accept it (/v1/chat/completions, /v1/messages,
 * /v1/embeddings). [...]
 *
 * Task 2 coverage (5 tests, all non-stream):
 *   Test 1 (chat 5x): adapter called 1x; all 5 responses byte-identical.
 *   Test 2 (messages 3x): adapter called 1x; all 3 responses byte-identical.
 *   Test 3 (embeddings 2x): adapter called 1x; both responses byte-identical.
 * [...]
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
```

**Apply to Phase 17:** The session-attach test verifies the wire-level behavior across `/v1/chat/completions`, `/v1/responses`, `/v1/messages`. Mirror the `Test N (route Mx)` enumeration shape:
- Test 1 (chat 2x same X-Session-ID): second response shows awareness (SC-1).
- Test 2 (messages 2x same X-Session-ID): same SC-1 assertion on Anthropic surface.
- Test 3 (responses 2x same X-Session-ID): same on Responses surface.
- Test 4 (chat, different agent_id): empty history (SC-2).
- Test 5 (chat, no header): zero rows written (SC-4 — byte-identical to Phase 16).
- Test 6 (chat stream, with header): X-Session-ID response header present (SESS-05 stream-path — guards Pitfall 17-D).

**Fake injection idiom** (`agentIdPreHandler.test.ts:1-30`):
```typescript
import { makeFakeBufferedWriter } from '../fakes.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
```
For Phase 17, add `makeFakeSessionStore`, `makeFakeContextProvider`, `makeFakeSummaryProvider` to `tests/fakes.ts` so all integration tests share construction. Mirror the existing `makeFakeBufferedWriter` shape.

---

### `router/tests/db/migration-journal.test.ts` (filesystem-assertion test)

**Analog:** `router/tests/migration0005.test.ts` (lines 35-106) — the P9-01 BLOCK enforcement test. **This is the direct template — mirror line-by-line.**

**Path-resolution idiom** (`migration0005.test.ts:20-33`):
```typescript
const ROUTER_ROOT = path.resolve(__dirname, '..');
const SQL_PATH = path.join(ROUTER_ROOT, 'db/migrations/0005_request_log_scoped_ids.sql');
const JOURNAL_PATH = path.join(ROUTER_ROOT, 'db/migrations/meta/_journal.json');
const SCHEMA_PATH = path.join(ROUTER_ROOT, 'src/db/schema/request_log.ts');
```

For Phase 17, the new path resolution targets `0006_sessions.sql` + `sessions.ts`. Note `__dirname` from `tests/db/...` is one level deeper than `tests/migration0005.test.ts`, so adjust the relative depth.

**Test shape** (`migration0005.test.ts:35-106` — 9 tests):
```typescript
describe('Migration 0005 atomic tuple integrity', () => {
  it('Test 1: SQL file exists', () => { ... });
  it('Test 1: SQL contains ADD COLUMN IF NOT EXISTS "tenant_id"', () => { ... });
  it('Test 2: _journal.json has exactly 6 entries', () => { ... });
  it('Test 2: _journal.json has idx=5 entry with correct tag', () => { ... });
  it('Test 2: _journal.json prior entries idx 0..4 are unchanged', () => { ... });
  it('Test 3: Drizzle schema exports tenant_id text column', () => { ... });
});
```

**For Phase 17**, rewrite as:
- Test 1: SQL file `0006_sessions.sql` exists + contains `CREATE TABLE IF NOT EXISTS "sessions"` + `CREATE TABLE IF NOT EXISTS "conversation_turns"` + `pg_advisory_xact_lock` reference (in COMMENT? — no; advisory lock is in the impl file. Skip that assertion.) + the four `COMMENT ON COLUMN` statements.
- Test 2: `_journal.json` has exactly 7 entries; idx=6 has tag `0006_sessions`, breakpoints=true, version="7"; prior entries idx 0..5 unchanged.
- Test 3: Drizzle schema exports `sessions` + `conversationTurns` pgTable handles + `expires_at` `notNull()` + `has_pending_tool_call` `boolean`.

**Secondary analog:** `router/tests/unit/mcp/host/stdio-grep-gate.test.ts:51-96` — the grep-gate execSync idiom. Phase 17 may want a single grep-gate test inside the new file asserting `router/src/providers/` contains no `bufferedWriter` import (defense-in-depth that the SESS-04 sync-write contract is honored — analogous to MCPS-06's stdio-transport gate).

---

### `router/tests/config/registry-ctx.test.ts` (Zod widening unit test)

**Analog:** `router/src/config/__tests__/registry.policies.test.ts` (lines 1-60 — Phase 14 POL-01/POL-02 Zod-parse unit-test idiom).

**Imports + minimal-fixture pattern** (`registry.policies.test.ts:12-40`):
```typescript
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { RegistrySchema, ModelEntrySchema } from '../registry.js';

const BASE_ENTRY_YAML = `
name: chat-local
backend: ollama
backend_url: http://ollama:11434/v1
backend_model: qwen2.5:7b-instruct-q4_K_M
capabilities: [chat]
vram_budget_gb: 4
`;
```

**For Phase 17 CTXP-04**, mirror the describe-block shape:
```typescript
describe('CTXP-04: ModelEntrySchema — ctx_size + context_strategy widening', () => {
  it('Test 1: absent ctx_size → defaults to 8192', () => { ... });
  it('Test 2: absent context_strategy → defaults to sliding-window', () => { ... });
  it('Test 3: explicit ctx_size: 65536 → parses', () => { ... });
  it('Test 4: explicit context_strategy: truncate → parses', () => { ... });
  it('Test 5: ctx_size: 0 → ZodError (not positive)', () => { ... });
  it('Test 6: ctx_size: -1 → ZodError (not positive)', () => { ... });
  it('Test 7: context_strategy: invalid-name → ZodError', () => { ... });
});
```

**Critical:** The test file path is `router/tests/config/registry-ctx.test.ts` — matches `vitest.config.ts`'s `tests/**/*.test.ts` include pattern. This is the same path-pattern correction documented in `migration0005.test.ts:14` ("Rule 3 deviation: test path moved from src/db/__tests__/ to tests/").

---

## Shared Patterns

### Authentication / preHandler ordering

**Source:** `router/src/app.ts:286-329`
**Apply to:** `sessionIdPreHandler` registration in app.ts

```typescript
// onRequest → preHandler order, Fastify v5 hook lifecycle:
app.addHook('onRequest', /* req._t0 stamp */);
app.addHook('onRequest', makeBearerHook(opts.bearerToken));            // bearer FIRST
app.addHook('onRequest', rateLimitPreHandler);                          // rate-limit
app.addHook('preHandler', opts.scopedIdsPreHandler ?? default...);     // Phase 14 scoped IDs
app.addHook('preHandler', opts.agentIdPreHandler ?? default...);        // Phase 5 agent + pino .child
// Phase 17 INSERT POINT (NEW):
app.addHook('preHandler', opts.sessionIdPreHandler ?? defaultSessionIdPreHandler);
```

Insertion AFTER agentId is non-negotiable (RESEARCH lines 875-887): the session-attach block reads `req.agentId` to scope `SessionStore.loadHistory` (P4-03 BLOCK).

---

### Error envelope routing

**Source:** `router/src/errors/envelope.ts` (entire file is the canonical error registry)
**Apply to:** All four new Phase 17 error classes (`SessionNotFoundError`, `SessionExpiredError`, `SessionAgentMismatchError`, `InvalidSessionIdError`)

**Existing pattern** for adding a new error (verified from `envelope.ts:278-296` + `envelope.ts:395`):
1. Declare class with `readonly code = '...'` + `readonly httpStatus = N as const` + `super(...)` call + `this.name = 'ErrorName'`.
2. Add `mapToHttpStatus` instanceof branch.
3. Add OpenAI envelope branch (`toOpenAIErrorEnvelope`).
4. Add Anthropic envelope branch (`toAnthropicErrorEnvelope`).

**Phase 17 divergence (route policy):** Only `InvalidSessionIdError` raises 4xx. The other three are CAUGHT LOCALLY by the route session-attach try/catch and never reach the centralized handler. Document this in the class JSDoc to prevent future "tidy up" PRs that route them through.

---

### Test fakes (FastifyInstance fixtures)

**Source:** `router/tests/fakes.ts` (referenced by `idempotency-integration.test.ts:25`, `agentIdPreHandler.test.ts:4`, `preflight.test.ts:65-80`)
**Apply to:** All Phase 17 unit + integration tests

**Existing fakes (mirror style for the three new ones):**
- `makeFakeBufferedWriter` → push noop + drain async noop
- `makeFakeMetrics` (or `makeMetricsRegistry`) → lightweight Registry + counters

**Phase 17 additions to `tests/fakes.ts`:**
- `makeFakeSessionStore(opts?: { history?: Turn[]; appendShouldTimeout?: boolean })` — returns an object satisfying the `SessionStore` interface with `createSession` echoing input, `loadHistory` returning `opts.history ?? []`, `appendTurn` returning `{ persisted: !opts.appendShouldTimeout }`, etc.
- `makeFakeContextProvider(opts?: { passthrough?: boolean })` — when passthrough, returns incoming messages verbatim.
- `makeFakeSummaryProvider()` — returns the `NoopSummaryProvider` instance.

These three plus the existing fakes give every Phase 17 test a single-line opts construction.

---

### Indivisible-tuple migration writes

**Source:** Project memory `project_drizzle_migration_journal.md` + `router/tests/migration0005.test.ts`
**Apply to:** Migration 0006 plan task

**Rule:** SQL file + Drizzle schema + `_journal.json` entry are **one git commit**. Phase 14 (Plan 14-01) is the canonical worked example. The planner MUST NOT plan these three writes across separate tasks/plans — the Drizzle migrator silently skips any entry whose journal row is missing, leaving production with a missing table and zero error message.

The accompanying integration test `tests/db/migration-journal.test.ts` is the regression gate.

---

### Three-route mirror pattern

**Source:** `router/src/routes/v1/{chat-completions, responses, messages}.ts` — Phase 15's MCPS-01 `applyPreflight` consolidation across these three routes is the canonical example of a single change shape repeated three times.
**Apply to:** Phase 17 session-attach block + `appendTurn` calls (Insertion Points #1, #2, #3 above)

The three routes share `applyPreflight → resolvedBackend → makeAdapter → canonical-build → controller/heartbeat/semaphore → adapter.X → reply.sse / reply.send` scaffolding. Phase 17's insertion point is **always** between `makeAdapter` and `canonical-build` for the load, and **always** inside the existing non-stream `await adapter.X` result path AND inside the existing `sseCleanup` closure for the append. The three diffs are mechanically transformable from one to another — RESEARCH lines 1046-1051 documents the per-route divergences (Anthropic top-level `system`, Responses `responsesToCanonical(body, entry.backend_model)` shape).

---

## No Analog Found

Files with no close codebase match (planner relies on RESEARCH and the new patterns established here):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `router/src/providers/` (entire directory) | provider seam | n/a | First "providers" namespace in the codebase. Closest existing namespace is `router/src/backends/` (adapter interface), but adapters serve a different role (upstream IO) than providers (router-internal pluggable seams). Use this PATTERNS.md + RESEARCH.md as the convention-establishing reference for v0.12+ provider work (RetrieverProvider in Phase 18). |
| `router/tests/integration/migrations/0006-sessions.test.ts` | real-PG migration integration test | n/a | No prior phase has had a real-PG migration integration test for new tables (Phase 14's `migration0005.test.ts` is filesystem-only). Closest reference is `router/tests/integration/cloud-spend-daily.test.ts` (real-PG fixture for the `cloud_spend_daily` view). Mirror its `beforeEach` pg-Pool setup but assert on `information_schema.columns` / `information_schema.table_constraints` rows to verify `expires_at NOT NULL`, the four indexes, and the ON DELETE CASCADE FK. |
| `router/src/providers/postgres-session-store.ts` `appendTurn` fail-open metric | observability | n/a | Pitfall 17-E mandates a `router_session_append_failed_total{reason="timeout"}` counter. No prior counter is incremented from a Promise.race timeout fallback — planner is establishing the pattern. Use the existing `makeMetricsRegistry()` shape (`router/src/metrics/registry.ts`) and follow the P8-03 cardinality rule (bounded `reason` label only — never `_id` labels). |

---

## Metadata

**Analog search scope:**
- `router/src/middleware/` — preHandler ordering + module-augmentation idiom (HIGH-CONFIDENCE match for `sessionId.ts`)
- `router/src/db/schema/` + `router/db/migrations/` — Drizzle pgTable + migration SQL idiom (HIGH-CONFIDENCE for schema + SQL)
- `router/src/errors/envelope.ts` — error class declaration shape (EXACT match for 4 new errors)
- `router/src/config/registry.ts` — Zod schema widening from Phase 14 POL-02 (EXACT match for CTXP-04)
- `router/models.yaml` — operator-facing commented banner from Phase 14 POLICY PRIMITIVES (EXACT match for CTXP-04 stanza)
- `router/src/app.ts` — `BuildAppOpts` widening + preHandler-registration idiom (EXACT match for both)
- `router/src/routes/v1/{chat-completions,responses,messages}.ts` — three-route mirror; self-analog for insertion (EXACT)
- `router/src/db/bufferedWriter.ts` — header-comment + invariant-tagging idiom; explicit CONTRAST reference for sync-vs-buffered (role-match)
- `router/src/translation/count-tokens.ts:148` — `countTokens()` reuse target (PRIMITIVE — do not reimplement)
- `router/tests/unit/dispatch/preflight.test.ts` — vitest unit-test idiom (EXACT)
- `router/tests/routes/idempotency-integration.test.ts` — three-route integration test idiom (EXACT)
- `router/tests/migration0005.test.ts` — migration atomic-tuple grep gate (EXACT for `tests/db/migration-journal.test.ts`)
- `router/tests/unit/mcp/host/stdio-grep-gate.test.ts` — grep-gate execSync idiom (secondary)
- `router/src/config/__tests__/registry.policies.test.ts` — Zod-parse unit-test idiom (EXACT for `tests/config/registry-ctx.test.ts`)
- `router/src/middleware/__tests__/scopedIds.test.ts` — preHandler unit-test fixture (secondary reference for potential `tests/middleware/sessionId.test.ts`)

**Files scanned:** 18 (live read) + 3 (project memory references)

**Pattern extraction date:** 2026-05-31

**Verification:** All cited line numbers verified at extraction time against current `master` branch (commit 7fe368e). The planner should re-verify line numbers at execution time only if a Phase 17 plan modifies the analog file BEFORE the consumer file (e.g., if the planner widens `errors/envelope.ts` for the new error classes before writing `session-errors.ts`).
