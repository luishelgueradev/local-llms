# Phase 14: Policy Primitives + Tenant/Project ID Foundation — Pattern Map

**Mapped:** 2026-05-30
**Files analyzed:** 26 (new + modified source/tests/migrations)
**Analogs found:** 26 / 26 (every file has a direct in-repo precedent)

This phase is a "mirror the v0.9.0 / v0.10.0 patterns exactly" exercise — every new file has a concrete, line-cited analog in `router/`. No novel patterns are introduced.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `router/src/policy/gate.ts` (NEW) | utility (pure helper) | transform (sync, throws-on-violation) | `router/src/cost/computeCostCents.ts` (single pure exported fn) AND `router/src/errors/envelope.ts` CapabilityNotSupportedError throw-site pattern | role-match (no `src/policy/` exists yet) |
| `router/src/policy/types.ts` (NEW, optional) | model (type-only) | n/a | Inline `z.infer<>` exports in `registry.ts:145-146` | role-match |
| `router/src/middleware/scopedIds.ts` (NEW) | middleware (preHandler) | request-response (header → req decoration) | `router/src/middleware/agentId.ts` | **exact** |
| `router/scripts/check-prometheus-cardinality.ts` (NEW) | utility (CI script + vitest module) | batch (read file → assert) | `router/scripts/gc-classify.ts` (per RESEARCH.md §"Don't Hand-Roll") | role-match |
| `router/src/db/__tests__/migration0005.test.ts` (NEW) | test | request-response | Existing migration smoke (see `recordOutcome.test.ts:149` bufferedWriter spy pattern) | role-match |
| `router/src/config/__tests__/registry.policies.test.ts` (NEW) | test | transform | `tests/integration/hotreload.test.ts` (registry schema unit tests) | role-match |
| `router/src/errors/__tests__/policy-envelopes.test.ts` (NEW) | test | transform | Existing envelope tests (see envelope.ts:395-403 verbatim shape) | role-match |
| `router/src/policy/__tests__/gate.test.ts` (NEW) | test (unit) | transform | Pure-function unit test pattern (any `*.test.ts` covering a single helper) | role-match |
| `router/src/routes/__tests__/policy-gate-integration.test.ts` (NEW) | test (integration) | request-response | `router/tests/integration/chat-completions.nonstream.test.ts` (MSW + breaker spy) | exact |
| `router/src/middleware/__tests__/scopedIds.test.ts` (NEW) | test (integration) | request-response | `router/tests/integration/agentIdPreHandler.test.ts` | **exact** |
| `router/src/middleware/__tests__/single-req-log.test.ts` (NEW) | test (unit) | transform | RESEARCH.md §"Pitfall-9 Grep Gate" (verbatim) | exact |
| `router/src/routes/__tests__/scopedIds-request-log.test.ts` (NEW) | test (integration) | request-response | `router/tests/integration/recordOutcome.test.ts:149-151` (bufferedWriter spy) | exact |
| `router/scripts/__tests__/check-prometheus-cardinality.test.ts` (NEW) | test (unit) | batch | RESEARCH.md §"CI Cardinality Check" (verbatim) | exact |
| `router/db/migrations/0005_request_log_scoped_ids.sql` (NEW) | migration | batch (DDL) | `router/db/migrations/0004_cost_per_agent_daily.sql` AND `0002_request_log_idempotency_key.sql` (ALTER TABLE ADD COLUMN precedent) | exact |
| `router/db/migrations/meta/_journal.json` (EDIT) | config | batch | Existing entry idx=4 (`0004_cost_per_agent_daily`) | exact |
| `router/src/db/schema/request_log.ts` (MOD) | model (schema) | n/a | Existing `agent_id: text('agent_id')` declaration on line 36 | exact |
| `router/src/config/registry.ts` (MOD) | config (Zod schema) | n/a | Existing optional `pricing` block (lines 47-52) + `BackendsSection` (60-72) | exact |
| `router/src/errors/envelope.ts` (MOD) | error model + envelope mapper | transform | `CapabilityNotSupportedError` (57-69) + its 3 mapping sites (327, 395-403, 628-630) | exact |
| `router/src/app.ts` (MOD) | controller (server bootstrap) | request-response | Existing `agentIdPreHandler` registration on line 282 | exact |
| `router/src/middleware/agentId.ts` (MOD, 1-line `.child(...)` extension) | middleware | request-response | Existing `req.log = req.log.child({ agent_id })` on line 104 | exact |
| `router/src/metrics/recordOutcome.ts` (MOD) | service (lifecycle helper) | request-response | Existing `OutcomeContext.agentId` (line 73) + `row.agent_id` builder (line 255) | exact |
| `router/src/routes/v1/chat-completions.ts` (MOD) | controller (route handler) | request-response/streaming | Existing capability gate at lines 203-205 + breaker.check at 324 | exact |
| `router/src/routes/v1/messages.ts` (MOD) | controller | request-response/streaming | Same as chat-completions.ts above | exact |
| `router/src/routes/v1/embeddings.ts` (MOD) | controller | request-response | Same shape | exact |
| `router/src/routes/v1/rerank.ts` (MOD) | controller | request-response | Same shape | exact |
| `router/src/routes/v1/responses.ts` (MOD) | controller | request-response | Same shape | exact |
| `router/models.yaml` (MOD) | config (operator-facing) | n/a | Existing `backends:` block with inline comments (lines 1-30) | role-match |

---

## Pattern Assignments

### `router/src/middleware/scopedIds.ts` (NEW — middleware, request-response)

**Analog:** `router/src/middleware/agentId.ts` — the WHOLE preHandler is the template. Copy the file shape verbatim, swap header names and error-throw policy.

**Imports + module augmentation pattern (agentId.ts:24-68 — verbatim shape to mirror):**
```typescript
import type { FastifyReply, FastifyRequest } from 'fastify';
import { InvalidAgentIdError } from '../errors/envelope.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** X-Agent-Id validated by agentIdPreHandler; undefined when header absent. */
    agentId?: string;
    /** performance.now() captured at preHandler entry — latency_ms source (D-D6). */
    _t0?: number;
    // ... other fields (__recorded, resolvedBackend, computedCostCents) elided ...
  }
}
```
**For scopedIds.ts:** mirror the `declare module 'fastify'` block but add three new optional fields: `tenantId?: string`, `projectId?: string`, `workloadClass?: string` (locked from CONTEXT.md D-19). Import `InvalidScopedIdError` from `../errors/envelope.js`.

**ReDoS-cleared regex constant pattern (agentId.ts:70-74):**
```typescript
/**
 * D-D5 regex: alphanumerics, dot, underscore, colon, hyphen; 1–128 chars.
 * Anchored + bounded + no nested quantifiers — ReDoS-safe (T-5-10).
 */
const AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
```
**For scopedIds.ts:** declare `ID_RE = /^[A-Za-z0-9._:-]{1,128}$/` (D-15 mandates EXACT reuse) and `WC_RE = /^[A-Za-z0-9._-]{1,64}$/`.

**Core preHandler body pattern (agentId.ts:76-105 — verbatim):**
```typescript
export async function agentIdPreHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  // Earliest post-auth capture — bearer onRequest has already run, so this
  // measures only the request-processing portion (not the auth gate).
  req._t0 = performance.now();

  const raw = req.headers['x-agent-id'];
  if (raw === undefined) {
    // D-D5: absent → agentId stays undefined → request_log.agent_id NULL.
    return;
  }

  // RFC 9110 §5.3 — duplicates may join with commas OR appear as an array
  // (Fastify normalizes duplicates to an array). First value wins.
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (typeof value !== 'string' || !AGENT_ID_RE.test(value)) {
    // D-D5: regex violation → 400 + invalid_agent_id. The centralized
    // app.setErrorHandler routes to the matching wire envelope...
    throw new InvalidAgentIdError(typeof value === 'string' ? value : '');
  }

  req.agentId = value;
  // Decorate req.log so every subsequent pino line carries agent_id.
  // THIS IS THE ONLY req.log reassignment in router/src/ (Pitfall 9 gate).
  req.log = req.log.child({ agent_id: value });
}
```

**Phase 14 application (scopedIds.ts skeleton — locked in CONTEXT.md "Specific Ideas" + RESEARCH.md §"`scopedIds.ts` Module Shape"):**
1. **Do NOT capture `req._t0`** — that stays the agentIdPreHandler's job (single responsibility).
2. **Do NOT touch `req.log`** — Pitfall 9 invariant. Stamp `req.tenantId / req.projectId / req.workloadClass` only.
3. Tenant/project: throw `InvalidScopedIdError(label, value)` on regex fail (D-16).
4. Workload-class: silent-NULL on missing OR invalid (D-12). Lowercase normalize.
5. Use the SAME `Array.isArray(raw) ? raw[0] : raw` first-value-wins pattern as agentId.ts:92.

**Single-responsibility seam to preserve:** the existing `req.log = req.log.child({ agent_id: value })` line at agentId.ts:104 is the ONE production source `req.log = ` (Pitfall-9 invariant). `scopedIdsPreHandler` MUST NOT add a second one. The agentId.ts patch in Wave 2 extends the existing `.child({...})` argument to include the three new IDs read defensively off `req`.

---

### `router/src/middleware/agentId.ts` (MOD — 1-line `.child(...)` extension only)

**Analog:** the file itself. Single targeted edit.

**Current line (agentId.ts:104):**
```typescript
  req.log = req.log.child({ agent_id: value });
```

**Phase 14 replacement (locked in RESEARCH.md §"`agentId.ts` Minimal Patch"):**
```typescript
  // Phase 14 (v0.11.0 — POL-03/04): include scoped IDs in the pino child if
  // scopedIdsPreHandler ran first and stamped them on req. Reading defensively
  // with ?? undefined — Pitfall 9 invariant: this is STILL the ONLY req.log =
  // assignment in production source (grep gate verifies count === 1).
  req.log = req.log.child({
    agent_id: value,
    tenant_id: req.tenantId,
    project_id: req.projectId,
    workload_class: req.workloadClass,
  });
```

**Hook-ordering dependency (RESEARCH.md A1 + Pitfall 3):** for this `.child()` to read populated IDs, `scopedIdsPreHandler` MUST be registered BEFORE `agentIdPreHandler` in `app.ts`. Fastify v5 preserves `addHook('preHandler', ...)` registration order — first-registered runs first.

---

### `router/src/errors/envelope.ts` (MOD — add 3 error classes + 4 mapping sites)

**Analog:** `CapabilityNotSupportedError` (lines 57-69) for the 403-style policy errors; `InvalidAgentIdError` (lines 278-290) for the 400-style scoped-ID error.

**Error class pattern (envelope.ts:57-69 — verbatim shape):**
```typescript
export class CapabilityNotSupportedError extends Error {
  readonly code = 'model_capability_mismatch';
  constructor(
    public readonly modelName: string,
    public readonly missingCapability: 'vision' | 'tools' | 'embeddings' | 'json_mode' | 'rerank',
  ) {
    super(
      `Model "${modelName}" does not support capability "${missingCapability}". ` +
        `Pick a model with "${missingCapability}" in its capabilities list.`,
    );
    this.name = 'CapabilityNotSupportedError';
  }
}
```

**Truncation-defense pattern for attacker-controlled values (envelope.ts:278-290 — InvalidAgentIdError):**
```typescript
export class InvalidAgentIdError extends Error {
  readonly code = 'invalid_agent_id';
  constructor(public readonly suppliedValue: string) {
    const display =
      typeof suppliedValue === 'string' && suppliedValue.length > 32
        ? `${suppliedValue.slice(0, 32)}...`
        : String(suppliedValue ?? '');
    super(
      `X-Agent-Id "${display}" violates regex /^[A-Za-z0-9._:-]{1,128}$/`,
    );
    this.name = 'InvalidAgentIdError';
  }
}
```
**For Phase 14 `InvalidScopedIdError`:** mirror this exactly with `headerLabel + suppliedValue` constructor args (RESEARCH.md Open Question #4 — recommendation: mirror the 32-char truncation).

**mapToHttpStatus dispatch pattern (envelope.ts:327, 333):**
```typescript
  // Plan 04-02 D-C2: missing capability for the requested model — pre-adapter 400.
  if (err instanceof CapabilityNotSupportedError) return 400;
  // Plan 05-02 D-D5 / ROUTE-09: X-Agent-Id regex violation — pre-route 400.
  if (err instanceof InvalidAgentIdError) return 400;
```
**Phase 14 additions:** `if (err instanceof AllowlistViolationError) return 403;`, `if (err instanceof CloudNotAllowedError) return 403;`, `if (err instanceof InvalidScopedIdError) return 400;`.

**OpenAI envelope mapping pattern (envelope.ts:395-403 — verbatim template for the 403 policy errors):**
```typescript
  // Plan 04-02 D-C2: CapabilityNotSupportedError on /v1/chat/completions surface.
  if (err instanceof CapabilityNotSupportedError) {
    return {
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: 'model_capability_mismatch',
        param: 'model',
      },
    };
  }
```
**Phase 14 additions** (locked in CONTEXT.md D-10 and RESEARCH.md §"Error Envelope Dual-Mapping"): substitute `type: 'policy_violation'` and `code: 'model_not_in_allowlist'` / `code: 'cloud_not_allowed'` with `param: 'model'`. For `InvalidScopedIdError`, mirror `InvalidAgentIdError`'s OpenAI mapping (envelope.ts:430-440) with `code: 'invalid_scoped_id'`, `param: err.headerLabel`.

**Anthropic envelope mapping pattern (envelope.ts:628-630 — verbatim):**
```typescript
  if (err instanceof CapabilityNotSupportedError) {
    return { type: 'error', error: { type: 'invalid_request_error', message: err.message } };
  }
```
**Phase 14 additions:** `permission_error` for the two policy errors (Anthropic's taxonomy reserves this for "the request was well-formed but policy refused it" — locked in RESEARCH.md). `invalid_request_error` for the scoped-ID error (mirrors `InvalidAgentIdError` at envelope.ts:643-645).

---

### `router/src/config/registry.ts` (MOD — Zod schema extensions)

**Analog:** the existing optional `pricing` block (lines 47-52) and `BackendsSection` (60-72).

**Per-entry optional block precedent (registry.ts:47-52 — verbatim):**
```typescript
  pricing: z
    .object({
      input_per_1m: z.number().nonnegative(),
      output_per_1m: z.number().nonnegative(),
    })
    .optional(),
```
**Phase 14 insertion point:** immediately after `pricing` (before the closing `});` at line 53). Add the `policy:` block per CONTEXT.md D-05 / RESEARCH.md §"Zod Schema Extension":
```typescript
  policy: z
    .object({
      cloud_allowed: z.boolean().default(true),
    })
    .optional(),
```

**Top-level optional section precedent (registry.ts:60-72 — `BackendsSection` is the model):**
```typescript
const BackendsSection = z.record(
  z.string(),
  z.object({
    base_url: z.string().url().optional(),
    concurrency: z.number().int().positive().default(2),
    queue_max_wait_ms: z.number().int().positive().default(30_000),
  }),
).optional();
```
**Phase 14 application:** add a top-level `policies` field to `RegistrySchema` (verbatim shape from RESEARCH.md):
```typescript
  policies: z
    .object({
      default: z
        .object({
          model_allowlist: z.array(z.string()).default([]),
        })
        .optional(),
    })
    .optional(),
```
**Insertion site:** inside the `z.object({...})` at registry.ts:74, BEFORE `.superRefine(...)` at line 77. The new fields are independent of existing refinements (VRAM sum, URL collision, dims), so no new refinement is added.

**Type derivation precedent (registry.ts:145-146):**
```typescript
export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type Registry = z.infer<typeof RegistrySchema>;
```
`Registry['policies']` becomes the type passed to `applyPolicyGate()` — no separate type declaration needed.

---

### `router/src/policy/gate.ts` (NEW — pure helper, transform)

**Analog:** no direct analog in `src/policy/` (this directory is new). The closest precedent is `router/src/cost/computeCostCents.ts` — a single pure exported function consumed by all 5 routes. The throw-site shape mirrors the route-side capability-gate throws (chat-completions.ts:203-205, 216-218).

**Locked implementation (verbatim from CONTEXT.md D-07 + RESEARCH.md §"Policy gate helper"):**
```typescript
import {
  AllowlistViolationError,
  CloudNotAllowedError,
} from '../errors/envelope.js';
import type { Registry, ModelEntry } from '../config/registry.js';

export function applyPolicyGate(
  policies: Registry['policies'],
  entry: ModelEntry,
  requested_model: string,
): void {
  const allow = policies?.default?.model_allowlist ?? [];
  if (allow.length > 0 && !allow.includes(requested_model)) {
    throw new AllowlistViolationError(requested_model);
  }
  if (entry.backend === 'ollama-cloud' && entry.policy?.cloud_allowed === false) {
    throw new CloudNotAllowedError(requested_model);
  }
}
```

**Note on D-07 logic:** the check is `=== false` (not `!entry.policy?.cloud_allowed`) — Pitfall 4 in RESEARCH.md. The strict-equality form correctly handles all four cases: (no `policy:` block, no cloud → pass), (no block, cloud → pass), (block with `cloud_allowed: false`, cloud → throw), (block with `cloud_allowed: true`, cloud → pass).

---

### `router/src/db/schema/request_log.ts` (MOD — add 3 nullable TEXT columns)

**Analog:** the existing `agent_id: text('agent_id')` declaration on line 36 (verbatim precedent for all three new columns).

**Existing column declaration (request_log.ts:36 — verbatim):**
```typescript
    agent_id: text('agent_id'), // nullable — from X-Agent-Id header, validated regex (D-D5)
```

**Phase 14 additions** (insert after `cost_cents:` at line 55, per RESEARCH.md §"Drizzle Migration Tuple" patch (b)):
```typescript
    // Phase 14 (v0.11.0 — POL-04): scoped-ID columns from X-Tenant-ID / X-Project-ID
    // headers. Validated regex (shared with X-Agent-Id) /^[A-Za-z0-9._:-]{1,128}$/.
    tenant_id: text('tenant_id'),
    project_id: text('project_id'),
    // Phase 14 (v0.11.0 — POL-03): X-Workload-Class — opaque metadata (Frame-04).
    workload_class: text('workload_class'),
```

**Index discipline (D-24):** NO new indexes. The existing `idxAgentTs: index('idx_request_log_agent_ts').on(t.agent_id, t.ts.desc())` (lines 60-61) is the precedent shape if a future phase decides to add `(tenant_id, ts DESC)`.

---

### `router/db/migrations/0005_request_log_scoped_ids.sql` (NEW — migration SQL)

**Analog:** `router/db/migrations/0004_cost_per_agent_daily.sql` for the structural shape (header comment + idempotent DDL) AND `0002_request_log_idempotency_key.sql` for the `ALTER TABLE ADD COLUMN IF NOT EXISTS` pattern.

**Migration 0004 header comment style (verbatim — mirror this discipline):**
```sql
-- Migration 0004: cost_per_agent_daily view (Phase 13 / v0.10.0 — COST-03).
--
-- [multi-line description]
--
-- Idempotent: CREATE OR REPLACE VIEW. Re-running this migration is a no-op.
```

**Phase 14 SQL (verbatim from RESEARCH.md §"Drizzle Migration Tuple" patch (a)):**
```sql
ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "tenant_id" text;
ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "project_id" text;
ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "workload_class" text;

COMMENT ON COLUMN "request_log"."tenant_id" IS '...';
COMMENT ON COLUMN "request_log"."project_id" IS '...';
COMMENT ON COLUMN "request_log"."workload_class" IS '...';
```

---

### `router/db/migrations/meta/_journal.json` (MOD — append idx=5 entry)

**Analog:** the existing entry idx=4 (verbatim shape to mirror):
```json
{
  "idx": 4,
  "version": "7",
  "when": 1779696000000,
  "tag": "0004_cost_per_agent_daily",
  "breakpoints": true
}
```

**Phase 14 append (per RESEARCH.md §"Drizzle Migration Tuple" patch (c)):**
```json
{
  "idx": 5,
  "version": "7",
  "when": 1748563200000,
  "tag": "0005_request_log_scoped_ids",
  "breakpoints": true
}
```
`when` is Unix milliseconds at task-start time (`Date.now()` value).

**CRITICAL — Drizzle journal tuple atomicity (D-23 + project memory `project_drizzle_migration_journal.md`):** SQL file + schema update + journal entry are an **indivisible tuple**. Migrator silently skips otherwise. All three changes MUST land in a single commit. Grep-gate verification:
```bash
test -f router/db/migrations/0005_request_log_scoped_ids.sql
test "$(grep -c '0005_request_log_scoped_ids' router/db/migrations/meta/_journal.json)" -eq 1
test "$(grep -c 'tenant_id: text' router/src/db/schema/request_log.ts)" -ge 1
```

---

### `router/src/app.ts` (MOD — register scopedIdsPreHandler BEFORE agentIdPreHandler)

**Analog:** the existing `app.addHook('preHandler', opts.agentIdPreHandler ?? defaultAgentIdPreHandler)` call on line 282.

**Existing registration site (app.ts:276-282 — verbatim context):**
```typescript
  // Plan 05-02 (D-D5 / ROUTE-09) — X-Agent-Id preHandler runs AFTER bearer
  // auth (onRequest) and BEFORE the route handler. Hook ordering verified
  // against fastify.dev/docs/v5.8.x/Reference/Hooks/: onRequest → ... →
  // preHandler. Bearer must pass first; agent-id is post-auth metadata
  // enrichment. The handler also stamps req._t0 = performance.now() — the
  // latency_ms source for the request_log row (D-D6 + Plan 05-02 Task 3).
  app.addHook('preHandler', opts.agentIdPreHandler ?? defaultAgentIdPreHandler);
```

**Phase 14 patch (verbatim from RESEARCH.md §"preHandler Hook Registration"):**
```typescript
  // Phase 14 (v0.11.0 — POL-03/04): scoped-ID extraction runs BEFORE the
  // agentId preHandler. Both register at the preHandler hook; Fastify
  // preserves registration order. Ordering matters here because
  // agentIdPreHandler's req.log = req.log.child({...}) call reads
  // req.tenantId / req.projectId / req.workloadClass — which scopedIds must
  // have stamped first.
  app.addHook('preHandler', opts.scopedIdsPreHandler ?? defaultScopedIdsPreHandler);

  // Plan 05-02 (D-D5 / ROUTE-09) — X-Agent-Id preHandler ...
  app.addHook('preHandler', opts.agentIdPreHandler ?? defaultAgentIdPreHandler);
```

**BuildAppOpts seam precedent (app.ts:117-121 — verbatim):**
```typescript
  /**
   * Plan 05-02 (D-D5 / ROUTE-09) — preHandler that validates X-Agent-Id and
   * ...
   * production agentIdPreHandler; tests override for hook-isolation cases.
   */
  agentIdPreHandler?: preHandlerAsyncHookHandler;
```
**Phase 14 addition** (next to the existing `agentIdPreHandler?` field):
```typescript
  scopedIdsPreHandler?: preHandlerAsyncHookHandler;
```

**setErrorHandler `recordOutcome` call site (app.ts:340-355 — verbatim insertion target):**
```typescript
    if (isRecordedRoute && req.__recorded !== true) {
      req.__recorded = true;
      recordOutcome({
        protocol: isAnthropicRoute ? 'anthropic' : 'openai',
        route,
        backend: 'unknown',
        model: 'unknown',
        statusClass: deriveStatusClass(status, false),
        httpStatus: status,
        durationMs: performance.now() - (req._t0 ?? performance.now()),
        errorCode: mapErrorToCode(err),
        errorMessage: truncateAndRedact(err instanceof Error ? err.message : String(err)),
        agentId: req.agentId,
        requestId: req.id,
        timestamp: new Date(),
      });
    }
```
**Phase 14 addition:** insert `tenantId: req.tenantId`, `projectId: req.projectId`, `workloadClass: req.workloadClass` next to `agentId: req.agentId,`.

---

### `router/src/metrics/recordOutcome.ts` (MOD — widen OutcomeContext + row builder)

**Analog:** the existing `agentId?: string` field in `OutcomeContext` (line 73) and the `agent_id: ctx.agentId ?? null` row builder line (255).

**OutcomeContext field pattern (recordOutcome.ts:60-75 — verbatim):**
```typescript
export interface OutcomeContext {
  // ...existing fields...
  agentId?: string;
  requestId: string;
  // ...
}
```
**Phase 14 additions** (RESEARCH.md §"recordOutcome Plumbing" patch 1, insert next to `agentId`):
```typescript
  agentId?: string;
  tenantId?: string;
  projectId?: string;
  workloadClass?: string;
  requestId: string;
```

**Row builder pattern (recordOutcome.ts:240-269 — verbatim insertion target):**
```typescript
    const row: RequestLogInsert = {
      // ...
      error_message:
        ctx.errorMessage !== undefined ? truncateAndRedact(ctx.errorMessage) : null,
      agent_id: ctx.agentId ?? null,
      request_id: ctx.requestId,
      // ...
    };
```
**Phase 14 additions** (insert immediately after `agent_id`):
```typescript
      agent_id: ctx.agentId ?? null,
      tenant_id: ctx.tenantId ?? null,
      project_id: ctx.projectId ?? null,
      workload_class: ctx.workloadClass ?? null,
```

---

### `router/src/routes/v1/{chat-completions,messages,embeddings,rerank,responses}.ts` (MOD — insert applyPolicyGate + extend safeRecord)

**Analog:** the existing capability-gate block in `chat-completions.ts:196-218` (verbatim insertion ANCHOR) plus the `breaker.check` call at line 324 (insertion delimiter).

**Insertion anchor (chat-completions.ts:196-218 — verbatim — read this to find the position):**
```typescript
      // Plan 04-05 D-C2 / VISION-02: capability gating on the OpenAI surface too.
      // Fire BEFORE semaphore acquire / adapter call so non-vision-model image
      // requests get a clean 400 without consuming a slot. CapabilityNotSupportedError
      // → 400 + OpenAI envelope (model_capability_mismatch) per envelope.ts.
      const hasImage = canonical.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'),
      );
      if (hasImage && !entry.capabilities.includes('vision')) {
        throw new CapabilityNotSupportedError(entry.name, 'vision');
      }

      // Phase 10 (v0.10.0 — JSON-05): json_mode capability gate.
      // ...
      const wantsJson =
        body.response_format !== undefined &&
        (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema');
      if (wantsJson && !entry.capabilities.includes('json_mode')) {
        throw new CapabilityNotSupportedError(entry.name, 'json_mode');
      }
```

**Insertion delimiter (chat-completions.ts:318-331 — verbatim — the breaker.check line is the lower bound):**
```typescript
      try {
        // Plan 08-04 (CLOUD-03) — per-backend circuit breaker gate. Fires AFTER
        // capability gating (above) and BEFORE semaphore acquire so a backend
        // outage fails fast in <1ms without consuming a slot. On state='open',
        // throw BreakerOpenError (503 + structured envelope); on 'half-open',
        // this caller IS the probe — fall through to the adapter call.
        const breakerResult = await opts.breaker.check(entry.backend);
        if (breakerResult.state === 'open') {
          void reply.header('Retry-After', String(opts.breakerCooldownSec));
          throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
        }
```

**Phase 14 insertion (verbatim from RESEARCH.md §"Route-side insertion"):**
```typescript
      // Phase 14 (v0.11.0 — POL-01 / POL-02 / P8-01 BLOCK): policy gate fires
      // AFTER capability gate, BEFORE the breaker check, so a policy 403 never
      // mutates the breaker counter (P8-01). Snapshot fetched here — registry.get()
      // is the existing seam; hot-reload swaps the snapshot atomically.
      const snapshot = opts.registry.get();
      applyPolicyGate(snapshot.policies, entry, body.model);
```

**Position non-negotiable (D-09 + P8-01 BLOCK):** between the last capability check (`throw new CapabilityNotSupportedError(entry.name, 'json_mode');`) and the `try {` that contains `opts.breaker.check(entry.backend)`. Same position in all 5 routes.

**`safeRecord` extension pattern (chat-completions.ts:461 — verbatim — multiplied across 13 sites in 5 files):**
```typescript
                agentId: req.agentId,
```
**Phase 14 application:** wherever a `safeRecord` closure or recordOutcome call passes `agentId: req.agentId,`, add three sibling lines:
```typescript
                agentId: req.agentId,
                tenantId: req.tenantId,
                projectId: req.projectId,
                workloadClass: req.workloadClass,
```
Grep target sites (all confirmed via `grep -n 'agentId: req.agentId' router/src/routes/v1/*.ts`):
- `chat-completions.ts:461, 542, 561, 701, 933` (5 sites)
- `messages.ts:364, 452, 471, 601, 754` (5 sites)
- `embeddings.ts:526` (1 site)
- `rerank.ts:246` (1 site)
- `responses.ts:498` (1 site)
**Total: 13 grep-driven sites.** Each is a 3-line additive insertion immediately after the existing `agentId: req.agentId,` line.

---

### `router/scripts/check-prometheus-cardinality.ts` (NEW — CI script + vitest module)

**Analog:** the existing `router/src/metrics/registry.ts` (the file to be scanned — analog for the labelNames discipline) plus the static-grep + vitest-import pattern shown in RESEARCH.md §"CI Cardinality Check" (verbatim).

**Existing labelNames discipline (registry.ts:33-38 — verbatim — the assertion target):**
```typescript
  const requestsTotal = new Counter({
    name: 'router_requests_total',
    help: 'Total number of model requests by protocol/backend/model/status_class',
    labelNames: ['protocol', 'backend', 'model', 'status_class'] as const,
    registers: [register],
  });
```
**Discipline:** all 9 labelNames arrays in `registry.ts` are clean of `/_id$/` matches. The CI script must keep this true.

**Implementation locked in RESEARCH.md** (lines 803-871 of 14-RESEARCH.md) — verbatim TypeScript exporting `checkCardinality(source: string): CardinalityViolation[]` plus a CLI entry point. Consumed by the vitest test in `router/scripts/__tests__/check-prometheus-cardinality.test.ts`.

---

### `router/models.yaml` (MOD — add commented policy example block)

**Analog:** the existing `backends:` block (lines 1-30) with inline operator-facing comments — precedent for "commented affordance that defaults to noop".

**Existing comment style (models.yaml:1-7 — verbatim):**
```yaml
backends:
  ollama:
    # base_url: documentation only — NOT used at runtime (see registry.ts BackendsSection comment).
    # Effective backend URL per model is each entry's backend_url field below.
    base_url: http://ollama:11434/v1
    concurrency: 2
    queue_max_wait_ms: 30000
```

**Phase 14 addition** (locked in RESEARCH.md §"Operator-Visible Affordances" — entirely commented out so default behavior is unchanged):
- Add a `# policies:` block at the very top of the file (before `backends:`) with `# default: # model_allowlist: ...` lines and a `# policy: cloud_allowed: false` example inside a model block.
- Cross-link the hot-reload caveat (project memory `project_models_yaml_hot_edit.md`): editing requires `valkey-cli DEL model-registry:snapshot` + `docker compose up -d --force-recreate router`.

---

### Test Files (NEW)

| Test File | Analog | What to Mirror |
|-----------|--------|----------------|
| `router/src/middleware/__tests__/scopedIds.test.ts` | `router/tests/integration/agentIdPreHandler.test.ts` | preHandler test scaffolding — bootstrap a minimal Fastify app, inject headers, assert `req.tenantId` / response status. 6 scenarios per RESEARCH.md §"Component Responsibilities": missing → NULLs; valid → populated; invalid tenant → 400; invalid project → 400; invalid workload-class → 200 + NULL; hook-ordering insensitivity. |
| `router/src/routes/__tests__/policy-gate-integration.test.ts` | `router/tests/integration/chat-completions.nonstream.test.ts` (MSW handler pattern) + RESEARCH.md POL-05 test pattern (breaker spy) | 4 scenarios (CONTEXT.md §"Component Responsibilities"): allowlist 403 + breaker counter unchanged; cloud-not-allowed 403 + no MSW call to `https://ollama.com/v1/...`; valid 200; absent `policies:` → allow-all. Breaker spy: `recordFailure = vi.fn()`; assert `recordFailure` called 0 times after 403. |
| `router/src/routes/__tests__/scopedIds-request-log.test.ts` | `router/tests/integration/recordOutcome.test.ts:149-151` (bufferedWriter spy) | Verbatim pattern: `const pushed: RequestLogInsert[] = []; const bufferedWriter = { push: (row) => pushed.push(row), drain: async () => {}, get size() { return 0; } };` Then assert `pushed[0]?.tenant_id === 'acme:prod'`, `pushed[0]?.workload_class === null`, etc. |
| `router/src/middleware/__tests__/single-req-log.test.ts` | RESEARCH.md §"Pitfall-9 Grep Gate" (verbatim vitest module) | Use `execSync("grep -rn 'req\\.log = ' router/src/ ...")`; assert exactly 1 line in `middleware/agentId.ts`. |
| `router/scripts/__tests__/check-prometheus-cardinality.test.ts` | RESEARCH.md §"CI Cardinality Check" (verbatim) | 3 cases: production `registry.ts` clean; synthetic `tenant_id` label detected; legitimate `[model, dims]` labels NOT flagged. |
| `router/src/policy/__tests__/gate.test.ts` | Pure-function unit test patterns throughout `router/tests/` | 4 cases per Pitfall 4: no policy block + no cloud (pass); no block + cloud (pass); block with `cloud_allowed: false` + cloud entry (throw); block with `cloud_allowed: true` + cloud entry (pass). Plus 2 allowlist cases: empty list (pass), out-of-list model (throw). |
| `router/src/errors/__tests__/policy-envelopes.test.ts` | Existing envelope unit-test discipline (the codebase tests envelope mapping inline in route tests; this is the first dedicated envelope-only test for Phase 14) | For each new error: assert mapToHttpStatus, toOpenAIErrorEnvelope, toAnthropicErrorEnvelope return the spec'd shapes (CONTEXT.md D-10, RESEARCH.md §"Error Envelope Dual-Mapping"). |
| `router/src/config/__tests__/registry.policies.test.ts` | `router/tests/integration/hotreload.test.ts` for hot-reload + schema tests | Parse YAML with absent `policies:` → `policies` field is `undefined`. Parse YAML with empty `model_allowlist: []` → allow-all semantics intact. Parse YAML with per-entry `policy: { cloud_allowed: false }` → typed as expected. |
| `router/src/db/__tests__/migration0005.test.ts` | Migration tuple atomicity grep gate (RESEARCH.md §"Drizzle Migration Tuple" atomicity check) | Assert the three tuple pieces all exist (SQL file present, journal idx=5 entry present, schema `tenant_id: text` line present). |

---

## Shared Patterns

### Hook Registration Order (Fastify v5)

**Source:** `router/src/app.ts:249-282`
**Apply to:** `app.ts` Phase 14 patch
**Pattern:** `onRequest` (bearer auth, rate limit) → preValidation/Zod → `preHandler` (registration-order preserved, first-registered runs first) → route. **Phase 14 must register `scopedIdsPreHandler` BEFORE `agentIdPreHandler`** because agentId's `.child()` call reads scopedIds-stamped fields.

### Single `req.log = ` Invariant (Pitfall 9 Grep Gate)

**Source:** `router/src/middleware/agentId.ts:104` (the ONE assignment site)
**Apply to:** `scopedIds.ts` MUST NOT add a second assignment. `agentId.ts` patch extends the existing argument.
**Verification:**
```bash
COUNT=$(grep -rn 'req\.log = ' router/src/ | wc -l)
test "$COUNT" -eq 1
```
The vitest test in `router/src/middleware/__tests__/single-req-log.test.ts` makes this a CI-blocking assertion.

### Error → Wire Envelope Dual Mapping

**Source:** `router/src/errors/envelope.ts` — every typed error class has a triple:
1. `mapToHttpStatus(err)` — HTTP status (envelope.ts:318-358)
2. `toOpenAIErrorEnvelope(err)` — `{ error: { message, type, code, param } }` (envelope.ts:361-548)
3. `toAnthropicErrorEnvelope(err)` — `{ type: 'error', error: { type, message } }` (envelope.ts:609-692)

**Apply to:** all 3 new error classes (`AllowlistViolationError`, `CloudNotAllowedError`, `InvalidScopedIdError`). The centralized `app.setErrorHandler` in `app.ts:311` routes by URL prefix (`isAnthropicRoute = route.startsWith('/v1/messages')`) — no per-route handling needed.

### Migration Tuple Atomicity (Drizzle)

**Source:** `router/db/migrations/{0002,0003,0004}_*.sql` + `_journal.json` + corresponding `src/db/schema/*.ts` changes — every migration is a 3-file indivisible commit.
**Apply to:** Phase 14 migration 0005 — SQL + schema + journal entry land together. Drizzle's migrator silently skips otherwise (project memory `project_drizzle_migration_journal.md`).

### Prometheus Cardinality Discipline

**Source:** `router/src/metrics/registry.ts:36, 43, 51, 59, 78, 94, 119` — every `labelNames:` array contains only bounded-cardinality fields (`protocol`, `backend`, `model`, `status_class`, `direction`, `result`, `dims`). No `/_id$/` ever.
**Apply to:** Phase 14 ships ZERO new metric labels. The CI script enforces this going forward (D-25, D-26).

### Bearer-Redacted Header Truncation (Log-Injection Defense)

**Source:** `router/src/errors/envelope.ts:278-290` (InvalidAgentIdError) AND `:243-266` (InvalidIdempotencyKeyError, with the stricter sanitize-then-truncate pattern).
**Apply to:** `InvalidScopedIdError` mirrors `InvalidAgentIdError`'s 32-char truncation (RESEARCH.md Open Question #4 recommends YES — one-line defense, no downside).

### `safeRecord` Idempotency Closure (Pitfall 8)

**Source:** `router/src/routes/v1/chat-completions.ts:288-298` — the `recorded` flag + `safeRecord = (ctx) => { ... opts.recordOutcome(ctx); }` closure pattern (5-route precedent).
**Apply to:** Phase 14 does NOT change the closure shape — only widens the `ctx` object passed into it (add `tenantId`, `projectId`, `workloadClass`). The 13 grep sites are mechanical 3-line additions next to existing `agentId: req.agentId,` lines.

---

## No Analog Found

None. Every Phase 14 file has a direct in-repo analog. The `router/src/policy/` directory is new but `applyPolicyGate` is a pure helper whose shape mirrors `router/src/cost/computeCostCents.ts` (single exported function consumed by the same 5 routes).

---

## Metadata

**Analog search scope:**
- `router/src/middleware/` (agentId.ts)
- `router/src/errors/` (envelope.ts — all error classes + envelope mappers)
- `router/src/config/` (registry.ts — Zod schema)
- `router/src/db/schema/` (request_log.ts)
- `router/db/migrations/` + `meta/_journal.json`
- `router/src/routes/v1/` (chat-completions.ts as the canonical 5-route precedent)
- `router/src/app.ts` (hook registration + setErrorHandler)
- `router/src/metrics/` (registry.ts cardinality discipline + recordOutcome.ts row builder)
- `router/models.yaml` (operator-facing comment style)
- `router/tests/integration/` (agentIdPreHandler.test.ts, recordOutcome.test.ts, chat-completions.nonstream.test.ts)

**Files scanned:** 14 source files read in full or in targeted ranges.

**Pattern extraction date:** 2026-05-30

---

## PATTERN MAPPING COMPLETE
