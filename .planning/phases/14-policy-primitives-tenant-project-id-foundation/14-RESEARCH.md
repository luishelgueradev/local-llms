# Phase 14: Policy Primitives + Tenant/Project ID Foundation - Research

**Researched:** 2026-05-29
**Domain:** Fastify v5 router middleware, Drizzle Postgres migration, zod schema extension, prom-client cardinality discipline
**Confidence:** HIGH (every claim verified against codebase or CONTEXT.md locks)

## Summary

Phase 14 is a **two-pillar additive foundation** with zero new external dependencies. Every architectural lock — policy gate position, error-envelope dual-mapping, ID validation regex, migration tuple shape, Prometheus cardinality discipline — has a direct existing precedent in the repository. The plan is mostly **mirror-this-exact-pattern** work, not new design.

The two non-obvious risks are: (1) the Drizzle migration tuple (sql + schema + journal entry) is silently skipped if any of the three pieces is missing — verified via `project_drizzle_migration_journal.md` memory and the existing 0002/0003/0004 precedents; and (2) the Pitfall-9 single-`req.log` invariant must survive — the new `scopedIdsPreHandler` MUST stamp fields onto `req` without calling `req.log.child(...)`, leaving `agentIdPreHandler` as the sole assignment site (verified: grep returns exactly one match today at `agentId.ts:104`).

**Primary recommendation:** Three waves — (1) data-layer foundation (migration tuple + Zod schema + error envelope + middleware module), (2) gate wiring (policy gate helper + 5 inline call-sites + `app.ts` preHandler registration + `recordOutcome` plumbing), (3) operator affordances + CI guards (CI cardinality script + models.yaml commented example + integration tests + docs).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Policy Configuration Shape (`models.yaml`)**
- **D-01:** Hybrid YAML shape — top-level `policies.default.model_allowlist` for the global allowlist; per-entry `policy.cloud_allowed` for the cloud-routing flag.
- **D-02:** Hybrid shape resolves POL-01 wording contradiction ("per registry entry" vs "BEFORE backend resolution"). Top-level allowlist fires before `registry.resolve()`; per-entry `cloud_allowed` is consulted after.
- **D-03:** POL-01 wording will be patched in REQUIREMENTS.md in this phase's plan to reflect the top-level shape.
- **D-04:** Empty list (`model_allowlist: []`) AND absent `policies:` section both evaluate to allow-all (default → existing smoke tests pass unchanged).
- **D-05:** Per-entry `policy.cloud_allowed` defaults to `true` when omitted. Gate fires the 403 ONLY when `entry.backend === 'ollama-cloud' && entry.policy?.cloud_allowed === false`. Local-backend entries setting `cloud_allowed: false` is vacuous, not an error.
- **D-06:** `policies:` section participates in the existing `models.yaml` hot-reload path — no new watcher, no new cache invalidation logic. Existing `RegistryStore._swap` + Valkey `model-registry:*` invalidation covers it.

**Policy Gate Code Placement**
- **D-07:** `src/policy/gate.ts` exports a single `applyPolicyGate(policies, entry, requested_model): void`. Called inline in all 5 routes at the **exact same code position**: right after the existing capability gate, right before `opts.breaker.check(entry.backend)`. Throws on violation; centralized envelope handler maps to 403.
- **D-08:** Inline duplication across 5 routes is the rejected anti-pattern. Shared helper with single-source-of-truth envelope mapping. Fastify preHandler at app-level was rejected because the gate requires the resolved registry entry (route-specific work).
- **D-09:** Gate position is non-negotiable (P8-01 BLOCK). Policy violations MUST NOT count as backend failures — integration test asserts `circuitBreaker.recordFailure()` counter unchanged after a 403.
- **D-10:** New error types added to `src/errors/envelope.ts`:
  - `AllowlistViolationError(model)` → 403 + `{ error: { code: "model_not_in_allowlist", model, type: "policy_violation" } }`
  - `CloudNotAllowedError(model)` → 403 + `{ error: { code: "cloud_not_allowed", model, type: "policy_violation" } }`
  - Both map to the existing Anthropic envelope shape too (the gate runs on `/v1/messages` as well).

**`X-Workload-Class` Validation**
- **D-11:** `X-Workload-Class` is opaque metadata. Accept any value matching `/^[A-Za-z0-9._-]{1,64}$/`, normalize to lowercase on extraction, stamp into `request_log.workload_class`. No content classification, no routing impact, no fixed enum.
- **D-12:** Invalid values silently NULL (do NOT 400). Integration test asserts malformed header → 200 + `workload_class: NULL`.
- **D-13:** Missing header → `workload_class: NULL` — no warning, no error.
- **D-14:** `workload_class` ships in migration 0005 alongside `tenant_id` + `project_id`. Three columns, one migration file.

**Tenant/Project ID Validation**
- **D-15:** Reuse `agentId`'s regex EXACTLY: `/^[A-Za-z0-9._:-]{1,128}$/`. Shared `ID_RE` constant in `src/middleware/scopedIds.ts`; same ReDoS analysis already cleared in v0.9.0.
- **D-16:** Invalid `X-Tenant-ID` / `X-Project-ID` → `InvalidScopedIdError(label, value)` → 400 (consistent with `InvalidAgentIdError`). Diverges from `X-Workload-Class` because tenant/project IDs are operationally load-bearing.
- **D-17:** Missing headers (common case) silently NULL. No warning.

**Middleware Layout**
- **D-18:** NEW sibling preHandler `src/middleware/scopedIds.ts`. Existing `agentId.ts` is NOT extended (single-responsibility preserved). Both register in `app.ts` at the same hook level; ordering doesn't matter (disjoint headers).
- **D-19:** `FastifyRequest` augmentation adds `tenantId?: string`, `projectId?: string`, `workloadClass?: string` (mirrors `agentId?`, `_t0?`, `resolvedBackend?`, `computedCostCents?` pattern).
- **D-20:** Pino child logger creation stays in ONE place — the existing `req.log = req.log.child(...)` call in `agentIdPreHandler`. New middleware ONLY stamps fields on `req`; `agentIdPreHandler` reads them and includes them in its single `.child({...})` call. Preserves Pitfall-9 invariant: **exactly one `req.log = ` assignment in production source**.

**Migration 0005**
- **D-21:** First task: read `router/db/migrations/meta/_journal.json` to confirm 0005 is the next idx. Verified at discuss time (idx 0..4 present). Re-verify at execution time.
- **D-22:** File name: `0005_request_log_scoped_ids.sql`. Adds three nullable TEXT columns: `tenant_id`, `project_id`, `workload_class`. No backfill.
- **D-23:** Drizzle migration tuple = SQL file + schema update (`router/src/db/schema/request_log.ts`) + `_journal.json` entry — INDIVISIBLE. Migrator silently skips otherwise.
- **D-24:** No new indexes in 0005. Existing `idx_request_log_ts_desc` and `(agent_id, ts DESC)` suffice. Add later if query plans demand.

**Prometheus Cardinality Discipline**
- **D-25:** No new metric label additions. Existing `labelNames` arrays in `src/metrics/registry.ts` (`['protocol', 'backend', 'model', 'status_class']`) are NOT extended with any `*_id`.
- **D-26:** New CI script `router/scripts/check-prometheus-cardinality.ts`. Static-greps `src/metrics/registry.ts` for `labelNames:` arrays; asserts no element matches `/_id$/`; runs as part of vitest.
- **D-27:** Static-grep first; live `/metrics` parse deferred to Phase 19.
- **D-28:** New Prometheus metrics in Phase 14: NONE. Policy violations surface via existing `router_requests_total{status_class="client_error"}` counter.

### Claude's Discretion

- Exact wording of CI test failure messages (D-26).
- Whether the cardinality script is wired into existing `test:` or a separate `test:cardinality` script.
- File split between `src/policy/gate.ts` and `src/policy/types.ts` (one file vs two).
- Whether to echo `X-Tenant-ID` / `X-Project-ID` in response headers via the existing onSend pattern (mirrors `X-Cost-Cents`).

### Deferred Ideas (OUT OF SCOPE)

- Per-tenant model allowlists (requires multi-bearer auth).
- `X-Workload-Class`-driven routing (Frame-04 violation if shipped without explicit per-class policy block).
- Dedicated `policy_violation_total{code}` Prometheus counter (Phase 19 candidate).
- Per-entry `policy.caller_allowlist: [agent_ids]` (future per-tenant work).
- Live `/metrics` cardinality parse (Phase 19).
- `X-Tenant-ID` / `X-Project-ID` response header echo (Claude's discretion).
- Index on `(tenant_id, ts DESC)` (deferred until query patterns demand).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| POL-01 | `model_allowlist` per registry entry; empty=allow-all; out-of-list returns 403 `{ code: "model_not_in_allowlist", model }` BEFORE backend resolution. | Resolved via D-02/D-03 hybrid shape: top-level `policies.default.model_allowlist` fires before `registry.resolve()`. New `AllowlistViolationError` mapping shape documented in §"Error Envelope Dual-Mapping". |
| POL-02 | `policy.cloud_allowed: false` per registry entry; 403 `{ code: "cloud_not_allowed", model }` when refused. | Per-entry Zod schema extension shown in §"Zod Schema Extension". Gate uses `entry.backend === 'ollama-cloud' && entry.policy?.cloud_allowed === false` (P8-02 strict-schema mitigation already in place — `ChatCompletionRequestSchema.passthrough()` is bypassed because the flag lives in `models.yaml`, not in request body). |
| POL-03 | `X-Workload-Class: sensitive` extracted into `request_log.workload_class` + logs. Opaque metadata. | Frame-04 enforced (no content classification). Regex `/^[A-Za-z0-9._-]{1,64}$/`, lowercased, silent-NULL on invalid (D-11..D-13). Code skeleton in §"`scopedIds.ts` Module Shape". |
| POL-04 | `X-Tenant-ID`, `X-Project-ID`, `X-Agent-ID` extracted into new `request_log` columns; migration 0005 adds NULLable columns. | Reuses `agentId.ts` regex (D-15). Migration tuple recipe in §"Drizzle Migration Tuple". `recordOutcome.ts` plumbing patch shown in §"recordOutcome Plumbing". |
| POL-05 | Policy gate fires BEFORE circuit breaker; violations don't count as backend failures. Integration test asserts breaker counter unchanged. | Gate insertion point identified at `chat-completions.ts:319-334` (immediately before `await opts.breaker.check(entry.backend)`). Test pattern in §"Validation Architecture". |
| POL-06 | Prometheus metric labels NEVER include `tenant_id`, `project_id`, `agent_id`, `session_id`. CI assertion. | Existing labelNames arrays verified clean. CI script outline in §"CI Cardinality Check — Implementation Outline". |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Node 22 + Fastify v5 + Drizzle + Postgres 17 + Valkey 8 — locked stack; no upgrades in Phase 14.
- `tsx` for dev, `tsup` for build, `vitest` for tests, biome for lint+format.
- Zod schemas: use `.strict()` for request bodies (P8-02 mitigation). `policies` config Zod object should use the existing `.optional()` pattern with no `.passthrough()`.
- All filesystem/data work goes through GSD workflow entry points. Phase 14 plan tasks must call out the migration-tuple atomicity (project memory `project_drizzle_migration_journal.md`).
- Editing `models.yaml` operationally requires a Valkey cache DEL + `up -d --force-recreate` of the router (project memory `project_models_yaml_hot_edit.md`) — surface this in DEPLOY.md updates.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Header extraction + ID validation | Fastify preHandler middleware (`src/middleware/`) | Centralized error handler in `app.ts` | preHandler is the canonical earliest-point seam for cross-cutting request augmentation; agentId.ts is the proven precedent. |
| Policy gate (allowlist, cloud refusal) | Route handler inline (`src/routes/v1/*.ts`) | Shared helper in `src/policy/gate.ts` | Gate requires resolved registry entry → must run after `registry.resolve(body.model)`. Inline call to shared helper is the same pattern v0.9.0 uses for capability gating. |
| Error → wire envelope mapping | `src/errors/envelope.ts` (single dispatch) | — | Dual OpenAI/Anthropic envelope is centralized; new error types extend the existing `toOpenAIErrorEnvelope` + `toAnthropicErrorEnvelope` switch chains. |
| `request_log` column persistence | Drizzle schema + migration tuple (`src/db/schema/`, `db/migrations/`) | `recordOutcome.ts` row-builder | Schema declaration is the type seam; migration SQL is the on-disk DDL; `_journal.json` registers the migration with Drizzle's runner. All three are required for the migrator to apply the change. |
| pino structured-log enrichment | `agentIdPreHandler` `.child({...})` call (single site) | `scopedIdsPreHandler` field-stamping only | Pitfall-9 invariant: exactly one `req.log = req.log.child(...)` in production source. New middleware MUST NOT add a second assignment. |
| Prometheus cardinality discipline | `src/metrics/registry.ts` labelNames arrays | New CI script `scripts/check-prometheus-cardinality.ts` | labelNames arrays are the schema-of-record for metric cardinality. CI script statically asserts the discipline at build time. |
| Operator-facing config affordance | `router/models.yaml` (commented example block) | `DEPLOY.md` + `README.md` text | Operators discover policy shape from the production YAML's comments first; docs second. |

## Standard Stack

### Core (already in repo — no installs)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `fastify` | `^5.8.5` | preHandler hook for `scopedIds.ts`; centralized `setErrorHandler` for policy error envelopes | [VERIFIED: package.json] — v5 hook ordering: `onRequest` → preValidation → `preHandler` → route. The new middleware slots in at preHandler alongside `agentIdPreHandler`. |
| `zod` (v4) | `^4.4.3` | Extend `ModelEntrySchema` with `policy: z.object({ cloud_allowed: z.boolean().default(true) }).optional()`; extend `RegistrySchema` with `policies: z.object({ default: z.object({ model_allowlist: z.array(z.string()).default([]) }).optional() }).optional()` | [VERIFIED: package.json] — already powers all registry validation; the new fields use `.optional()` + `.default(...)` patterns matching existing `BackendsSection` shape. |
| `drizzle-orm` | `^0.36.0` | `request_log` schema additions: `tenant_id`, `project_id`, `workload_class` as `text('...')` nullable. | [VERIFIED: package.json] — direct precedent: `agent_id: text('agent_id')` (line 36 of `request_log.ts`). |
| `prom-client` | `^15.1.3` | NO changes. Phase 14 ships zero new metrics and zero new labels. CI script will lint existing labelNames arrays. | [VERIFIED: package.json + D-25, D-28] |
| `pino` | `^10.3.1` | Child-logger augmentation in `agentIdPreHandler` extended to include `tenant_id`, `project_id`, `workload_class` fields. | [VERIFIED: package.json] — `req.log = req.log.child({ agent_id, tenant_id, project_id, workload_class })` is the only assignment. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `js-yaml` | `^4.1.1` | Already parses `models.yaml`. The new `policies:` block parses transparently — no library change. | No use beyond existing `loadRegistryFromFile`. |
| `vitest` | `^4.1.6` | Run the new CI cardinality script as a test; run the policy-gate integration tests; assert breaker counter unchanged on 403. | All new tests go through `vitest run`. |

### Alternatives Considered (and rejected per CONTEXT.md locks)

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Inline `applyPolicyGate()` calls in 5 routes | Single app-level preHandler doing the gate | Rejected (D-08): the gate needs the resolved registry entry, which is route-specific work. The preHandler runs before `registry.resolve()`. |
| Top-level `policies.default.model_allowlist` | Per-entry `allowlist_agents: []` | Considered then rejected during discuss (recorded under Deferred Ideas). Top-level shape resolves the POL-01 "before backend resolution" wording cleanly. |
| Adding `tenant_id` / `project_id` to Prometheus labels | Keep labels bounded; query the DB view | P8-03 quantified cardinality blowup. 10 tenants × 5 projects = 400× series. Rejected by D-25 (BLOCK). |
| Extending `agentId.ts` to also extract scoped IDs | New sibling `scopedIds.ts` preHandler | D-18: single-responsibility preserved. Renaming `agentId.ts` would force a churn pass with no net benefit. |
| Running migration 0005 across 3 files in 3 commits | Single atomic task in plan | `project_drizzle_migration_journal.md` memory: migrator silently skips. D-23 mandates indivisible tuple. |

**Installation:** None. Zero new dependencies.

## Package Legitimacy Audit

Not applicable. Phase 14 introduces **no new package dependencies**. The plan adds only project-local TypeScript files. No `npm install` command runs in any Phase 14 task.

## Architecture Patterns

### System Architecture Diagram (Phase 14 deltas inside the existing request pipeline)

```
HTTP request
   │
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ onRequest hooks (unchanged)                                       │
│   stamp req._t0  →  bearer auth  →  (optional rate-limit)         │
└──────────────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ Zod body validation (preValidation, unchanged)                    │
└──────────────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ preHandler hooks                                                  │
│                                                                   │
│   [NEW] scopedIdsPreHandler                                       │
│     • read X-Tenant-ID / X-Project-ID  →  validate regex          │
│       (throws InvalidScopedIdError → 400)                         │
│     • read X-Workload-Class → silent-NULL on invalid              │
│     • stamp req.tenantId / req.projectId / req.workloadClass      │
│     • does NOT touch req.log                                      │
│                                                                   │
│   agentIdPreHandler (unchanged shape, child() call extended)      │
│     • read X-Agent-Id, validate, stamp req.agentId                │
│     • req.log = req.log.child({                                   │
│         agent_id, tenant_id, project_id, workload_class           │
│       })  ← still the ONLY req.log = assignment in src/           │
└──────────────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ Route handler (one of 5: chat-completions, messages, embeddings, │
│                 rerank, responses)                                │
│                                                                   │
│   entry = registry.resolve(body.model)        ← reused            │
│   req.resolvedBackend = entry.backend                             │
│                                                                   │
│   • capability gate (existing)                                    │
│                                                                   │
│   [NEW] applyPolicyGate(snapshot.policies, entry, body.model)     │
│     • allowlist check  →  AllowlistViolationError(model)  → 403   │
│     • cloud-deny check →  CloudNotAllowedError(model)     → 403   │
│                                                                   │
│   • opts.breaker.check(entry.backend)         ← unchanged         │
│   • semaphore acquire → adapter call → response                   │
└──────────────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────────────┐
│ recordOutcome → bufferedWriter.push                              │
│   • row now includes tenant_id / project_id / workload_class      │
│     (read off ctx, which routes populate from req.*)              │
└──────────────────────────────────────────────────────────────────┘
   │
   ▼
HTTP response (onSend stamps X-Model-Backend + X-Cost-Cents — unchanged)
```

### Component Responsibilities

| File | Responsibility |
|------|---------------|
| `src/policy/gate.ts` (NEW) | Single function `applyPolicyGate(policies, entry, requested_model): void`. Throws `AllowlistViolationError` or `CloudNotAllowedError`. |
| `src/policy/types.ts` (NEW, optional split) | `PoliciesConfig` type derived from registry Zod schema. (May inline into `gate.ts`.) |
| `src/middleware/scopedIds.ts` (NEW) | preHandler. Extracts/validates `X-Tenant-ID`/`X-Project-ID` (throws `InvalidScopedIdError` on bad shape); extracts `X-Workload-Class` (silent-NULL on bad shape). Stamps fields on req. Does NOT touch `req.log`. |
| `src/middleware/agentId.ts` (MODIFIED) | Single edit: extend the existing `req.log = req.log.child({ agent_id })` call to include `tenant_id`, `project_id`, `workload_class` from `req.*`. Read defensively (`req.tenantId ?? undefined`) — scopedIds runs ordering-independent. |
| `src/config/registry.ts` (MODIFIED) | Add `policy?: z.object({ cloud_allowed: z.boolean().default(true) }).optional()` to `ModelEntrySchema`. Add `policies?: z.object({ default: z.object({ model_allowlist: z.array(z.string()).default([]) }).optional() }).optional()` to `RegistrySchema`. Hot-reload path unchanged. |
| `src/errors/envelope.ts` (MODIFIED) | Add `AllowlistViolationError`, `CloudNotAllowedError`, `InvalidScopedIdError`. Extend `mapToHttpStatus` (403 for both policy errors; 400 for InvalidScopedIdError). Extend `toOpenAIErrorEnvelope` + `toAnthropicErrorEnvelope`. |
| `src/db/schema/request_log.ts` (MODIFIED) | Add `tenant_id: text('tenant_id')`, `project_id: text('project_id')`, `workload_class: text('workload_class')`. All nullable. No new indexes (D-24). |
| `db/migrations/0005_request_log_scoped_ids.sql` (NEW) | `ALTER TABLE request_log ADD COLUMN ...` × 3. Idempotent. |
| `db/migrations/meta/_journal.json` (MODIFIED) | Add entry idx=5, tag=`0005_request_log_scoped_ids`. |
| `src/metrics/recordOutcome.ts` (MODIFIED) | Extend `OutcomeContext` with `tenantId?`, `projectId?`, `workloadClass?`. Add three corresponding fields to the `row: RequestLogInsert = { ... }` builder. |
| `src/app.ts` (MODIFIED) | Register `scopedIdsPreHandler` next to `agentIdPreHandler`. Extend the `setErrorHandler` `recordOutcome` call to include `tenantId`/`projectId`/`workloadClass` from `req.*`. Extend per-route registration to optionally pass `policies` snapshot (or routes read it from `opts.registry.get()` directly — see "Order-of-Operations" recommendation below). |
| `src/routes/v1/*.ts` (×5, MODIFIED) | Insert `applyPolicyGate(snapshot.policies, entry, body.model)` immediately after the capability gate, before `await opts.breaker.check(entry.backend)`. Per-route `safeRecord` closures already include `agentId` from `req.agentId` — extend the closure to also pull `req.tenantId`/`req.projectId`/`req.workloadClass` and pass to `OutcomeContext`. |
| `scripts/check-prometheus-cardinality.ts` (NEW) | TypeScript script — see implementation outline below. |
| `tests/integration/policy.test.ts` (NEW) | 4 scenarios: allowlist 403 + breaker unchanged; cloud-not-allowed 403 + no cloud request; valid request 200; missing policies section → allow-all. |
| `tests/integration/scopedIds.test.ts` (NEW) | 6 scenarios: missing headers → NULLs; valid IDs → row populated + child log; invalid tenant_id → 400; invalid project_id → 400; invalid workload_class → 200 + NULL; hook ordering insensitive (parallel send + reverse-order registration in fixture). |
| `tests/unit/cardinality.test.ts` (NEW) | Runs `scripts/check-prometheus-cardinality.ts` as an importable module; asserts no `/_id$/` label found. Add a regression case: inject a synthetic `tenant_id` label into a fixture string and assert the script throws. |

### Pattern 1: Single-Source Error Envelope Mapping (mirror `CapabilityNotSupportedError`)

**What:** Each new error class declares a `readonly code` string and is mapped to (a) HTTP status in `mapToHttpStatus`, (b) OpenAI envelope in `toOpenAIErrorEnvelope`, (c) Anthropic envelope in `toAnthropicErrorEnvelope`. The pattern is verbatim across `BearerAuthError`, `CapabilityNotSupportedError`, `CloudMaxTokensExceededError`, `InvalidAgentIdError`, etc.

**When to use:** Any new typed error that crosses the route → centralized error handler boundary.

**Example (CapabilityNotSupportedError is the closest template — same 400 vs 403 difference):**
```ts
// Source: router/src/errors/envelope.ts:57-69 (CapabilityNotSupportedError)
export class CapabilityNotSupportedError extends Error {
  readonly code = 'model_capability_mismatch';
  constructor(
    public readonly modelName: string,
    public readonly missingCapability: '...',
  ) {
    super(`Model "${modelName}" does not support capability "${missingCapability}"...`);
    this.name = 'CapabilityNotSupportedError';
  }
}
```
**Phase 14 application:** New classes follow the same shape (see §"Error Envelope Dual-Mapping" below).

### Pattern 2: preHandler Header Augmentation (mirror `agentIdPreHandler`)

**What:** Read header, validate regex, throw typed 400 error on shape violation, stamp validated value on `req.*`. `agentId.ts:76-105` is the canonical precedent.

**When to use:** Any new optional header that needs to flow into the request_log row and/or structured logs.

**Phase 14 application:** `scopedIds.ts` follows this shape with two tweaks: (a) tenant/project IDs throw on invalid; workload class silently NULLs; (b) no `req.log = ...` assignment (Pitfall-9 invariant).

### Pattern 3: Migration Tuple Atomicity (mirror 0002/0003/0004)

**What:** Every Drizzle migration is a 3-file tuple — SQL in `db/migrations/`, schema update in `src/db/schema/`, journal entry in `db/migrations/meta/_journal.json`. All three land in the same commit. Migrator silently skips if any piece is missing.

**Phase 14 application:** Migration 0005 follows this discipline. See §"Drizzle Migration Tuple — Concrete Recipe" below.

### Anti-Patterns to Avoid

- **Extending `models.yaml` ChatCompletionRequestSchema with policy fields.** P8-02 strict-schema mitigation: policy lives in `models.yaml`, never in request bodies. Per-request `prefer_cloud: true` is exactly the bypass P8-02 forbids.
- **Adding a second `req.log = req.log.child(...)` in `scopedIds.ts`.** Pitfall-9 invariant violation. The grep gate `grep -rn 'req\.log = ' router/src/ | wc -l` MUST stay at `1`.
- **Adding `tenant_id` to any Prometheus `labelNames` array.** P8-03 BLOCK. The CI script catches this; the design discipline must be the primary defense.
- **Throwing on invalid `X-Workload-Class`.** D-12 explicitly requires silent-NULL. A 400 would couple caller deployments to the router's regex.
- **Renaming `agentId.ts` to `requestIds.ts` or similar.** D-18 explicitly rejects this — single-responsibility preserved.
- **Adding `policy_violation_total` Prometheus counter in Phase 14.** Deferred (D-28 + Deferred Ideas).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Header validation | A new regex parser | Reuse `agentId.ts` `AGENT_ID_RE` constant (export it from `agentId.ts` OR redeclare identically in `scopedIds.ts`) | Same regex already cleared for ReDoS in v0.9.0 (anchored, bounded, no nested quantifiers). D-15 mandates exact reuse. |
| YAML parsing | Custom YAML walker | Existing `loadRegistryFromFile` via `js-yaml` + Zod refinement | New `policies:` section parses transparently; no new code path. |
| Migration journal entry generation | Hand-edit `_journal.json` only | Use `drizzle-kit generate` OR carefully hand-craft the entry matching the 0004 precedent | Migrator silently skips on shape drift — see §"Drizzle Migration Tuple — Concrete Recipe" for the verbatim 0004 entry shape to mirror. |
| Error envelope mapping | A second `switch` in route files | Extend existing `toOpenAIErrorEnvelope` + `toAnthropicErrorEnvelope` | Single source of truth — every existing typed error is mapped there. |
| Policy decision logic | Generic "policy engine" abstraction | Hard-coded two-rule helper in `gate.ts` | Phase 14 has exactly two rules. A "policy engine" is the wrong abstraction at this scale; defer until 5+ rules exist (Frame-04 + Deferred Ideas). |
| Prometheus cardinality runtime check | Live `/metrics` regex parse | Static-grep script on `src/metrics/registry.ts` source | D-27: static grep catches all Phase 14 introductions; live parse is Phase 19. |

**Key insight:** Phase 14 is a "wire it up the way v0.9.0 already does" exercise. Every novel architectural decision is already locked in CONTEXT.md. The dominant risk is **forgetting the migration journal entry** (silent skip) or **adding a second `req.log =` assignment** (Pitfall 9). Both are catchable by grep — make them grep gates in the plan.

## Drizzle Migration Tuple — Concrete Recipe

**Verified precedent — `_journal.json` shape** (from `router/db/migrations/meta/_journal.json`):
```json
{
  "idx": 4,
  "version": "7",
  "when": 1779696000000,
  "tag": "0004_cost_per_agent_daily",
  "breakpoints": true
}
```

### Phase 14 migration tuple — three files, indivisible

**(a) New file: `router/db/migrations/0005_request_log_scoped_ids.sql`**
```sql
-- Migration 0005: add request_log scoped-ID columns (Phase 14 / v0.11.0 — POL-04).
--
-- Three new TEXT columns, all NULLable, no defaults, no backfill:
--   tenant_id      from X-Tenant-ID header (validated regex /^[A-Za-z0-9._:-]{1,128}$/)
--   project_id     from X-Project-ID header (same regex)
--   workload_class from X-Workload-Class header (regex /^[A-Za-z0-9._-]{1,64}$/, lowercased,
--                  silent-NULL on invalid — D-11..D-13)
--
-- No new indexes (D-24). Existing idx_request_log_ts_desc and (agent_id, ts DESC)
-- covering index suffice for Phase 14 query patterns (low-volume operator tooling).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS — re-runs are no-ops (parity with 0002/0003).

ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "tenant_id" text;
ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "project_id" text;
ALTER TABLE "request_log"
  ADD COLUMN IF NOT EXISTS "workload_class" text;

COMMENT ON COLUMN "request_log"."tenant_id" IS
  'POL-04 (Phase 14): X-Tenant-ID header value, validated regex /^[A-Za-z0-9._:-]{1,128}$/. NULL when header absent.';
COMMENT ON COLUMN "request_log"."project_id" IS
  'POL-04 (Phase 14): X-Project-ID header value, validated regex /^[A-Za-z0-9._:-]{1,128}$/. NULL when header absent.';
COMMENT ON COLUMN "request_log"."workload_class" IS
  'POL-03 (Phase 14): X-Workload-Class header value (lowercased) — opaque metadata. Regex /^[A-Za-z0-9._-]{1,64}$/. NULL when header absent OR invalid (silent-NULL per D-12).';
```

**(b) Schema patch — `router/src/db/schema/request_log.ts`**

Add three lines after the existing `cost_cents: numeric(...)` (line 55):
```ts
    cost_cents: numeric('cost_cents', { precision: 10, scale: 4 }),
    // Phase 14 (v0.11.0 — POL-04): scoped-ID columns from X-Tenant-ID / X-Project-ID
    // headers. Validated regex (shared with X-Agent-Id) /^[A-Za-z0-9._:-]{1,128}$/.
    // NULL when header absent OR invalid (invalid throws 400 InvalidScopedIdError;
    // the row is only written on responses that pass the preHandler regex).
    tenant_id: text('tenant_id'),
    project_id: text('project_id'),
    // Phase 14 (v0.11.0 — POL-03): X-Workload-Class — opaque metadata (Frame-04).
    // Regex /^[A-Za-z0-9._-]{1,64}$/, lowercased on extraction. Silent-NULL on
    // invalid value (D-12). No content classification, no routing impact.
    workload_class: text('workload_class'),
```
No changes to the index block (D-24). `RequestLogInsert` type widens automatically via `$inferInsert`.

**(c) Journal entry — append to `router/db/migrations/meta/_journal.json` `entries` array:**
```json
{
  "idx": 5,
  "version": "7",
  "when": 1748563200000,
  "tag": "0005_request_log_scoped_ids",
  "breakpoints": true
}
```
*(`when` is Unix milliseconds at execution time — use `Date.now()` value from the moment the migration is generated. Plan should specify "use the timestamp captured at task-start time".)*

**Atomicity check (plan-side):**
- Single commit containing all three files.
- Grep gate (run during verification): `wc -l router/db/migrations/0005_*.sql` AND `grep -c '0005_request_log_scoped_ids' router/db/migrations/meta/_journal.json` AND `grep -c 'tenant_id: text' router/src/db/schema/request_log.ts` — all three must be ≥ 1.
- Post-migration smoke: `docker compose exec postgres psql -U app -d router -c "\d request_log"` MUST list the three new columns.

## Zod Schema Extension — Concrete Patch

**Target file:** `router/src/config/registry.ts`

**Patch 1 — extend `ModelEntrySchema`** (insert after the `pricing` block, before the schema's closing brace at line 53):
```ts
  pricing: z
    .object({
      input_per_1m: z.number().nonnegative(),
      output_per_1m: z.number().nonnegative(),
    })
    .optional(),
  // Phase 14 (v0.11.0 — POL-02): per-entry policy block. Currently only
  // `cloud_allowed` is defined; future per-entry policy flags extend this
  // object. Defaults to `cloud_allowed: true` when the block is omitted —
  // local-backend entries are unaffected; cloud entries (`backend: ollama-cloud`)
  // can be explicitly denied via `policy: { cloud_allowed: false }`.
  policy: z
    .object({
      cloud_allowed: z.boolean().default(true),
    })
    .optional(),
});
```

**Patch 2 — extend `RegistrySchema`** (modify the `z.object({...})` shape before `.superRefine(...)` at line 74):
```ts
export const RegistrySchema = z.object({
  models: z.array(ModelEntrySchema).min(1, 'models.yaml must declare at least one model'),
  backends: BackendsSection,
  // Phase 14 (v0.11.0 — POL-01): top-level policies block. Currently only
  // `default.model_allowlist` is defined. Empty list AND absent block both
  // evaluate to allow-all (D-04). Top-level (not per-entry) placement resolves
  // POL-01's "BEFORE backend resolution" requirement — the gate fires before
  // `registry.resolve()`.
  policies: z
    .object({
      default: z
        .object({
          model_allowlist: z.array(z.string()).default([]),
        })
        .optional(),
    })
    .optional(),
}).superRefine((reg, ctx) => {
  // ... existing VRAM envelope + URL collision + embeddings dims refinements unchanged ...
});
```

**superRefine interaction:** None. The new fields are independent of the existing three refinements (VRAM envelope sum, backend_url uniqueness, embeddings dims). Phase 14 does NOT add a new refinement — the gate fires at request time, not at registry-validation time. Adding a refinement that checks "every model in `model_allowlist` exists in `models[]`" was considered but rejected here as scope creep (the plan can add it under Claude's discretion if it costs <3 lines).

**Type derivation:** `Registry`'s `.policies` field becomes `{ default?: { model_allowlist: string[] } } | undefined` via Zod inference. The `applyPolicyGate` helper accepts this exact shape — no separate type declaration needed beyond the file split decision.

## Error Envelope Dual-Mapping — New Error Classes

**Target file:** `router/src/errors/envelope.ts`

### Patch 1 — Add three error classes (after `InvalidIdempotencyKeyError` at line 266)

```ts
/**
 * Phase 14 (v0.11.0 — POL-01): thrown by applyPolicyGate() when the requested
 * model is not in `policies.default.model_allowlist`. Fires BEFORE the
 * circuit-breaker check so policy violations never count as backend failures
 * (P8-01 BLOCK). Maps to 403 + policy_violation on both wire surfaces.
 */
export class AllowlistViolationError extends Error {
  readonly code = 'model_not_in_allowlist';
  constructor(public readonly modelName: string) {
    super(
      `Model "${modelName}" is not in policies.default.model_allowlist. ` +
        `Either add it to the allowlist in models.yaml or use a model from the allowed set.`,
    );
    this.name = 'AllowlistViolationError';
  }
}

/**
 * Phase 14 (v0.11.0 — POL-02): thrown by applyPolicyGate() when the resolved
 * registry entry has `backend: ollama-cloud` AND `policy.cloud_allowed: false`.
 * Fires BEFORE the circuit-breaker check (P8-01). Maps to 403 + policy_violation.
 */
export class CloudNotAllowedError extends Error {
  readonly code = 'cloud_not_allowed';
  constructor(public readonly modelName: string) {
    super(
      `Model "${modelName}" resolves to an ollama-cloud entry whose policy.cloud_allowed=false. ` +
        `Cloud routing is denied for this entry; pick a local-backend model.`,
    );
    this.name = 'CloudNotAllowedError';
  }
}

/**
 * Phase 14 (v0.11.0 — POL-04): thrown by scopedIdsPreHandler when an inbound
 * X-Tenant-ID or X-Project-ID header violates regex /^[A-Za-z0-9._:-]{1,128}$/.
 * Mirrors InvalidAgentIdError (same regex, same 400 mapping). Diverges from
 * X-Workload-Class (silent-NULL) because tenant/project IDs are operationally
 * load-bearing.
 *
 * `label` is the header name for the error message (e.g. 'X-Tenant-ID').
 */
export class InvalidScopedIdError extends Error {
  readonly code: 'invalid_scoped_id' = 'invalid_scoped_id';
  constructor(
    public readonly headerLabel: string,
    public readonly suppliedValue: string,
  ) {
    const display =
      typeof suppliedValue === 'string' && suppliedValue.length > 32
        ? `${suppliedValue.slice(0, 32)}...`
        : String(suppliedValue ?? '');
    super(
      `${headerLabel} "${display}" violates regex /^[A-Za-z0-9._:-]{1,128}$/`,
    );
    this.name = 'InvalidScopedIdError';
  }
}
```

### Patch 2 — Extend `mapToHttpStatus` (inside the function body, after the `InvalidAgentIdError` line ~333):

```ts
  // Phase 14 (v0.11.0 — POL-01 / POL-02): policy violations → 403.
  if (err instanceof AllowlistViolationError) return 403;
  if (err instanceof CloudNotAllowedError) return 403;
  // Phase 14 (v0.11.0 — POL-04): tenant/project header regex violation → 400
  // (mirrors InvalidAgentIdError pattern).
  if (err instanceof InvalidScopedIdError) return 400;
```

### Patch 3 — Extend `toOpenAIErrorEnvelope` (after `InvalidAgentIdError` block ~line 440)

```ts
  // Phase 14 (v0.11.0 — POL-01 / POL-02): policy violation envelopes.
  // type='policy_violation' is a new wire-level type — distinct from
  // invalid_request_error (the request was well-formed; the policy refused it).
  if (err instanceof AllowlistViolationError) {
    return {
      error: {
        message: err.message,
        type: 'policy_violation',
        code: 'model_not_in_allowlist',
        param: 'model',
      },
    };
  }
  if (err instanceof CloudNotAllowedError) {
    return {
      error: {
        message: err.message,
        type: 'policy_violation',
        code: 'cloud_not_allowed',
        param: 'model',
      },
    };
  }
  // Phase 14 (v0.11.0 — POL-04): scoped-ID regex violation — OpenAI envelope.
  if (err instanceof InvalidScopedIdError) {
    return {
      error: {
        message: err.message,
        type: 'invalid_request_error',
        code: 'invalid_scoped_id',
        param: err.headerLabel,
      },
    };
  }
```

### Patch 4 — Extend `toAnthropicErrorEnvelope` (after `InvalidAgentIdError` block ~line 645)

```ts
  // Phase 14 (v0.11.0 — POL-01 / POL-02): policy violation envelopes.
  // Anthropic's wire taxonomy reserves permission_error for policy-style
  // refusals — matches the semantics of "the request was well-formed but
  // policy refused it" better than the closer 'invalid_request_error'.
  if (err instanceof AllowlistViolationError) {
    return { type: 'error', error: { type: 'permission_error', message: err.message } };
  }
  if (err instanceof CloudNotAllowedError) {
    return { type: 'error', error: { type: 'permission_error', message: err.message } };
  }
  // Phase 14 (v0.11.0 — POL-04): scoped-ID regex violation — Anthropic envelope.
  if (err instanceof InvalidScopedIdError) {
    return { type: 'error', error: { type: 'invalid_request_error', message: err.message } };
  }
```

**Verbatim template citation — `CapabilityNotSupportedError` mapping (envelope.ts:395-403):**
```ts
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
The Phase 14 `AllowlistViolationError` mapping mirrors this exact shape with `type: 'policy_violation'` and `code: 'model_not_in_allowlist'` substituted.

## `scopedIds.ts` Module Shape

**Target file:** `router/src/middleware/scopedIds.ts` (NEW)

```ts
// router/src/middleware/scopedIds.ts — Fastify preHandler for X-Tenant-ID /
// X-Project-ID / X-Workload-Class (Phase 14 / v0.11.0 — POL-03, POL-04).
//
// Hook ordering (identical to agentIdPreHandler — both register at
// app.addHook('preHandler', ...)): runs AFTER body parsing + zod validation,
// BEFORE the route handler. Order between scopedIds and agentId does NOT
// matter — they read disjoint headers and stamp disjoint req.* fields. The
// pino .child(...) call lives ONLY in agentIdPreHandler (Pitfall 9 grep gate
// invariant: exactly one req.log = assignment in production source).
//
// Module augmentation extends FastifyRequest with tenantId, projectId,
// workloadClass — mirrors the agentId / _t0 / resolvedBackend / computedCostCents
// pattern in agentId.ts.
//
// ReDoS analysis:
//   ID_RE = /^[A-Za-z0-9._:-]{1,128}$/   — anchored, bounded, no nested
//                                          quantifiers, no overlapping
//                                          alternation. SAME regex as
//                                          AGENT_ID_RE; SAME safety profile.
//   WC_RE = /^[A-Za-z0-9._-]{1,64}$/     — same shape, shorter bound. Safe.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { InvalidScopedIdError } from '../errors/envelope.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** POL-04: X-Tenant-ID validated by scopedIdsPreHandler; undefined when absent. */
    tenantId?: string;
    /** POL-04: X-Project-ID validated by scopedIdsPreHandler; undefined when absent. */
    projectId?: string;
    /**
     * POL-03: X-Workload-Class normalized to lowercase. undefined when absent OR
     * when the supplied value violated WC_RE (silent-NULL per D-12).
     */
    workloadClass?: string;
  }
}

/** D-15: SAME regex as agentId — anchored, bounded, ReDoS-cleared in v0.9.0. */
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** D-11: opaque metadata regex — shorter bound, no colon (workload classes are flat tokens). */
const WC_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Extract + validate a scoped ID header (X-Tenant-ID or X-Project-ID).
 * Throws InvalidScopedIdError → 400 on regex violation (D-16); returns
 * undefined when the header is absent (D-17).
 */
function extractScopedId(
  req: FastifyRequest,
  headerName: 'x-tenant-id' | 'x-project-id',
  label: 'X-Tenant-ID' | 'X-Project-ID',
): string | undefined {
  const raw = req.headers[headerName];
  if (raw === undefined) return undefined;
  // RFC 9110 §5.3 — duplicates may join with commas OR appear as an array.
  // First value wins (mirrors agentId.ts:92).
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new InvalidScopedIdError(label, typeof value === 'string' ? value : '');
  }
  return value;
}

export async function scopedIdsPreHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  // POL-04: tenant / project IDs — throw 400 on regex violation.
  req.tenantId = extractScopedId(req, 'x-tenant-id', 'X-Tenant-ID');
  req.projectId = extractScopedId(req, 'x-project-id', 'X-Project-ID');

  // POL-03: workload class — opaque metadata. Silent-NULL on missing OR invalid
  // (D-12). NEVER throws. Lowercased for normalization.
  const rawWc = req.headers['x-workload-class'];
  const wc = Array.isArray(rawWc) ? rawWc[0] : rawWc;
  req.workloadClass =
    typeof wc === 'string' && WC_RE.test(wc) ? wc.toLowerCase() : undefined;

  // IMPORTANT (Pitfall 9): DO NOT touch req.log here. The pino child-logger
  // augmentation is the agentIdPreHandler's exclusive responsibility; it reads
  // req.tenantId / req.projectId / req.workloadClass off req when it runs (hook
  // ordering: scopedIds and agentId both register at preHandler; order between
  // them is not asserted in app.ts because they read disjoint headers — but
  // agentId MUST run AFTER scopedIds for the child() call to pick up the IDs).
}
```

**Hook-order consideration (D-18 + this module's last comment):** CONTEXT.md D-18 states "ordering does not matter" because they read disjoint headers. That is true for FIELD POPULATION on `req`. But agentIdPreHandler's `req.log = req.log.child({ agent_id, tenant_id, project_id, workload_class })` call requires `req.tenantId` / `req.projectId` / `req.workloadClass` to already be stamped. Therefore the plan MUST register `scopedIdsPreHandler` BEFORE `agentIdPreHandler` in `app.ts`. Fastify preserves `addHook('preHandler', ...)` registration order — first-registered runs first. The plan should add a comment in `app.ts` at both registration sites explaining the dependency.

## `agentId.ts` Minimal Patch (preserve Pitfall-9 invariant)

**Target:** `router/src/middleware/agentId.ts:104` — replace the single `req.log = ...` line.

**Before:**
```ts
  req.log = req.log.child({ agent_id: value });
```

**After:**
```ts
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

**Grep-gate verification command (planner adds to verify-work step):**
```bash
test "$(grep -rn 'req\.log = ' router/src/ | wc -l)" -eq 1
```

Note: pino's `.child()` will include `undefined` fields as JSON `undefined` (which serializes as missing-key, not `null`) — confirmed safe for the existing `chat-completions.nonstream.test.ts` log-line assertions which check for `"agent_id":"…"` substring matching.

## preHandler Hook Registration in `app.ts`

**Today** (`router/src/app.ts:282`):
```ts
  app.addHook('preHandler', opts.agentIdPreHandler ?? defaultAgentIdPreHandler);
```

**Phase 14 patch** — insert `scopedIdsPreHandler` BEFORE the existing line:
```ts
  // Phase 14 (v0.11.0 — POL-03/04): scoped-ID extraction runs BEFORE the
  // agentId preHandler. Both register at the preHandler hook; Fastify
  // preserves registration order. Ordering matters here because
  // agentIdPreHandler's req.log = req.log.child({...}) call reads
  // req.tenantId / req.projectId / req.workloadClass — which scopedIds must
  // have stamped first. The two handlers read disjoint HEADERS, but the
  // pino-child augmentation in agentId reads scopedIds' OUTPUT.
  app.addHook('preHandler', opts.scopedIdsPreHandler ?? defaultScopedIdsPreHandler);

  // Plan 05-02 (D-D5 / ROUTE-09) — X-Agent-Id preHandler ...
  app.addHook('preHandler', opts.agentIdPreHandler ?? defaultAgentIdPreHandler);
```

**BuildAppOpts gains a new optional field:**
```ts
  scopedIdsPreHandler?: preHandlerAsyncHookHandler;
```
Mirrors the existing `agentIdPreHandler?` field shape (line 121 of app.ts). Tests pass a vi.fn fake when hook-isolation is needed.

**Confirmation that hook ordering doesn't matter when both read disjoint HEADERS:** Yes — both handlers only `req.headers[...]` reads, and stamp disjoint `req.*` fields. The ordering requirement is purely about the pino-child call in agentId reading scopedIds-populated fields. If the plan rejects the dependency by inlining tenant/project field stamping into agentId.ts (which D-18 forbids), the ordering constraint disappears. Per D-18, the constraint stays; document it inline.

## The Pitfall-9 Grep Gate

**Current state** (verified in this research session):
```bash
$ grep -rn 'req\.log = ' /home/luis/proyectos/local-llms/router/src/
router/src/middleware/agentId.ts:104:  req.log = req.log.child({ agent_id: value });
```
Count: **1**. Invariant holds.

**Phase 14 plan must add this exact check to verify-work and/or CI:**
```bash
# Pitfall-9 grep gate — exactly one req.log assignment in production source.
COUNT=$(grep -rn 'req\.log = ' router/src/ | wc -l)
if [ "$COUNT" -ne 1 ]; then
  echo "FAIL: Pitfall 9 invariant violated — $COUNT req.log assignments in router/src/ (expected 1, in agentId.ts only)"
  grep -rn 'req\.log = ' router/src/
  exit 1
fi
```

The plan should also add this as a `tests/unit/pitfall9.test.ts` so it runs in CI without needing a shell wrapper:
```ts
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Pitfall 9 invariant — single req.log assignment', () => {
  it('production source contains exactly one req.log = assignment', () => {
    const out = execSync(
      "grep -rn 'req\\.log = ' router/src/ || true",
      { encoding: 'utf8' },
    ).trim();
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/middleware\/agentId\.ts/);
  });
});
```
*(Plan determines whether `vitest`'s CWD is the repo root or `router/` — adjust path accordingly. Existing tests are run from `router/` per package.json `"test": "vitest run"`.)*

## CI Cardinality Check — Implementation Outline

**Target file:** `router/scripts/check-prometheus-cardinality.ts` (NEW)

**Implementation recommendation:** Implement as a **module that exports a checker function** AND register it as a **vitest test** (`tests/unit/cardinality.test.ts`). This is cleaner than a standalone `node scripts/...` invocation:
- Runs as part of the existing `npm test` command — no separate script wiring.
- Failures appear in vitest output with a stack trace.
- Easier to mock the source file for the regression test ("inject a synthetic `tenant_id` label and assert the script throws").

This matches the existing pattern in `router/scripts/gc-classify.ts` (a TypeScript module invoked from a bash entry point), with the new wrinkle being that the cardinality script is consumed by vitest rather than by bash.

**Script pseudo-code:**
```ts
// router/scripts/check-prometheus-cardinality.ts
//
// Phase 14 (v0.11.0 — POL-06 / D-25, D-26): static-grep guard against
// high-cardinality Prometheus labels. Scans src/metrics/registry.ts for
// labelNames arrays and asserts no array element ends in '_id'.
//
// Catches: tenant_id, project_id, agent_id, session_id, request_id, and any
// future *_id label addition. This is the static-source case (the only case
// Phase 14 can introduce); live /metrics parse is deferred to Phase 19 (D-27).
//
// Exported as a function so vitest can call it directly. The CLI entry point
// (if invoked via `node scripts/...`) prints the failure to stderr and exits
// non-zero — but the primary integration is via tests/unit/cardinality.test.ts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CardinalityViolation {
  /** Pretty source location, e.g. "registry.ts:36" */
  location: string;
  /** The full labelNames array literal text, e.g. "['protocol', 'tenant_id']" */
  arrayText: string;
  /** The offending label, e.g. "tenant_id" */
  forbiddenLabel: string;
  /** The metric name nearest the violation, for the failure message */
  metricNameHint: string;
}

/** Regex matches `labelNames: ['a', 'b', 'c'] as const` style declarations. */
const LABEL_NAMES_RE = /labelNames\s*:\s*\[([^\]]*)\]/g;
/** Regex matches `name: 'router_xxx_total'` so we can hint the metric in the error. */
const METRIC_NAME_RE = /name\s*:\s*['"]([a-z0-9_]+)['"]/g;

/** Returns an array of violations. Empty array means clean. */
export function checkCardinality(source: string): CardinalityViolation[] {
  const violations: CardinalityViolation[] = [];

  // Build a sorted list of (offset, metricName) so we can look up the
  // nearest preceding metric name for each labelNames hit.
  const metricNames: Array<{ offset: number; name: string }> = [];
  for (const m of source.matchAll(METRIC_NAME_RE)) {
    if (m[1]?.startsWith('router_')) {
      metricNames.push({ offset: m.index ?? 0, name: m[1] });
    }
  }

  for (const m of source.matchAll(LABEL_NAMES_RE)) {
    const arrayText = m[1] ?? '';
    const labels = [...arrayText.matchAll(/['"]([a-z0-9_]+)['"]/g)].map((x) => x[1] ?? '');
    const offset = m.index ?? 0;
    const lineNo = source.slice(0, offset).split('\n').length;
    const nearest = [...metricNames]
      .reverse()
      .find((mn) => mn.offset < offset);
    for (const label of labels) {
      if (/_id$/.test(label)) {
        violations.push({
          location: `registry.ts:${lineNo}`,
          arrayText: `[${arrayText.trim()}]`,
          forbiddenLabel: label,
          metricNameHint: nearest?.name ?? 'unknown',
        });
      }
    }
  }
  return violations;
}

/** CLI entry — primary integration is via tests/unit/cardinality.test.ts. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = resolve(process.cwd(), 'src/metrics/registry.ts');
  const source = readFileSync(path, 'utf8');
  const violations = checkCardinality(source);
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(
        `cardinality-check: FORBIDDEN _id label "${v.forbiddenLabel}" found in ` +
          `${v.metricNameHint} (${v.location}). ` +
          `Labels matching /_id$/ are forbidden — see CONTEXT.md D-25 / Pitfall P8-03. ` +
          `Move per-request identifiers to request_log columns, not Prometheus labels.\n`,
      );
    }
    process.exit(1);
  }
}
```

**Failure message format (locked):** `"Forbidden _id label found in router_request_total — see CONTEXT.md D-25"` — Claude's discretion allows variation. The above message follows the spirit of D-26.

**Vitest test file — `router/tests/unit/cardinality.test.ts`:**
```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCardinality } from '../../scripts/check-prometheus-cardinality.js';

describe('Prometheus cardinality static-grep guard (POL-06 / D-25)', () => {
  it('production src/metrics/registry.ts has no /_id$/ labels', () => {
    const path = resolve(import.meta.dirname, '../../src/metrics/registry.ts');
    const source = readFileSync(path, 'utf8');
    expect(checkCardinality(source)).toEqual([]);
  });

  it('regression: synthetic tenant_id label is detected', () => {
    const fake = `
      new Counter({
        name: 'router_fake_total',
        labelNames: ['protocol', 'tenant_id'] as const,
      });
    `;
    const violations = checkCardinality(fake);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.forbiddenLabel).toBe('tenant_id');
    expect(violations[0]?.metricNameHint).toBe('router_fake_total');
  });

  it('regression: legitimate model+dims labels are not flagged', () => {
    // router_embeddings_dims_total uses ['model', 'dims'] — both bounded, neither ends in _id.
    const fake = `
      new Counter({
        name: 'router_embeddings_dims_total',
        labelNames: ['model', 'dims'] as const,
      });
    `;
    expect(checkCardinality(fake)).toEqual([]);
  });
});
```

**Wire it into `package.json scripts`:** No change. The existing `"test": "vitest run"` discovers `tests/unit/cardinality.test.ts` automatically. No separate `test:cardinality` script needed unless the plan wants a fast-path during development — Claude's discretion (D-26).

## recordOutcome Plumbing

**Target file:** `router/src/metrics/recordOutcome.ts`

**Patch 1 — extend `OutcomeContext`** (line 60+):
```ts
  agentId?: string;
  // Phase 14 (v0.11.0 — POL-03/04): scoped-ID + workload-class context. The
  // route's safeRecord closure reads req.tenantId / req.projectId /
  // req.workloadClass and passes them here; undefined → NULL column.
  tenantId?: string;
  projectId?: string;
  workloadClass?: string;
  requestId: string;
```

**Patch 2 — extend `row: RequestLogInsert = { ... }`** (around line 255):
```ts
      agent_id: ctx.agentId ?? null,
      // Phase 14 (v0.11.0 — POL-03/04): scoped-ID + workload-class columns.
      tenant_id: ctx.tenantId ?? null,
      project_id: ctx.projectId ?? null,
      workload_class: ctx.workloadClass ?? null,
      request_id: ctx.requestId,
```

**Patch 3 — extend `app.ts` setErrorHandler recordOutcome call** (around line 342):
```ts
      recordOutcome({
        protocol: isAnthropicRoute ? 'anthropic' : 'openai',
        // ... existing fields ...
        agentId: req.agentId,
        // Phase 14: pre-resolve errors still get scoped-ID context if
        // scopedIdsPreHandler ran before the error was thrown.
        tenantId: req.tenantId,
        projectId: req.projectId,
        workloadClass: req.workloadClass,
        requestId: req.id,
        timestamp: new Date(),
      });
```

**Patch 4 — extend per-route `safeRecord` closures** (5 routes — `chat-completions.ts`, `messages.ts`, `embeddings.ts`, `rerank.ts`, `responses.ts`). Each route already reads `req.agentId` and passes it to `OutcomeContext.agentId`. The patch is one repeated `req.tenantId` / `req.projectId` / `req.workloadClass` triple at each call site. Grep for `agentId: req.agentId,` in those 5 files to find every site.

## Operator-Visible Affordances

### `router/models.yaml` — commented example block

Add at the very top of the file, before `backends:`:
```yaml
# Phase 14 (v0.11.0 — POL-01, POL-02): operator policy stanza (additive,
# defaults to allow-all). The router enforces policy AFTER capability gating
# and BEFORE the circuit-breaker check — policy violations never count as
# backend failures.
#
# Example: lock the router to a curated set of models AND deny a specific
# cloud entry. Uncomment and edit to enable. With both blocks absent (the
# default), allow-all is in effect and existing behavior is unchanged.
#
# IMPORTANT — hot-reload caveat (see DEPLOY.md):
#   Editing this file requires `docker compose exec valkey valkey-cli DEL
#   model-registry:snapshot` followed by `docker compose up -d --force-recreate
#   router`. A bare `docker compose restart router` will NOT pick up the new
#   policies (verified via project memory `project_models_yaml_hot_edit.md`).
#
# policies:
#   default:
#     model_allowlist:
#       - chat-local
#       - vision-local
#       - embed-local
#       # cloud entries opted in explicitly:
#       - gpt-oss:20b-cloud
#
# Per-entry cloud_allowed example (add inside any model's block):
#   - name: big-cloud
#     backend: ollama-cloud
#     # ... existing fields ...
#     policy:
#       cloud_allowed: false   # deny THIS cloud entry while still listing it

backends:
  ollama:
    # ...
```

### `DEPLOY.md` / `README.md` updates

The plan should add a "Policy primitives (Phase 14)" subsection under operator configuration. Key points to cover:
1. Top-level `policies.default.model_allowlist` — what it does, default behavior, how to opt models in.
2. Per-entry `policy.cloud_allowed: false` — when to use, what it returns (403 + envelope shape).
3. `X-Tenant-ID` / `X-Project-ID` / `X-Workload-Class` request headers — regex shape, what columns they populate, where they appear in logs.
4. **Hot-reload caveat (cross-link to project memory `project_models_yaml_hot_edit.md`):** editing `models.yaml` requires Valkey `DEL model-registry:*` + `docker compose up -d --force-recreate router`. A bare `restart` will NOT pick up policy changes — the cached snapshot lives in Valkey.
5. CI cardinality check — operators editing `src/metrics/registry.ts` must avoid `*_id` labels; the test will fail otherwise.
6. Migration 0005 — auto-applies on next `docker compose up`; rollback by `ALTER TABLE request_log DROP COLUMN tenant_id, DROP COLUMN project_id, DROP COLUMN workload_class` (with corresponding journal+schema reversion).

## Order-of-Operations Recommendation

The phase has a clear three-wave shape. Within a wave tasks can parallelize; across waves they cannot (dependencies are real).

### Wave 1 — Data + Type Foundation (parallel-safe within)

These tasks have **no inter-dependency** beyond reading the same files for context:

| Task | Files | Depends on |
|------|-------|------------|
| W1-T1: Read `_journal.json`, confirm next idx is 5 | `db/migrations/meta/_journal.json` | — |
| W1-T2: Write migration 0005 SQL + schema patch + journal entry (ATOMIC, one commit) | 3 files | W1-T1 |
| W1-T3: Extend Zod schema (`registry.ts`) with `policy` + `policies` | `src/config/registry.ts` | — |
| W1-T4: Add three new error classes + envelope mappings | `src/errors/envelope.ts` | — |
| W1-T5: Write `src/middleware/scopedIds.ts` | `src/middleware/scopedIds.ts` | W1-T4 (imports `InvalidScopedIdError`) |
| W1-T6: Write `src/policy/gate.ts` | `src/policy/gate.ts` | W1-T3 (uses `Registry['policies']` type), W1-T4 |

### Wave 2 — Pipeline Wiring (depends on Wave 1 fully complete)

| Task | Files | Depends on |
|------|-------|------------|
| W2-T1: Patch `agentId.ts` — extend `.child()` call (Pitfall-9 preserving) | `src/middleware/agentId.ts` | W1-T5 |
| W2-T2: Patch `app.ts` — register `scopedIdsPreHandler`; thread `tenantId/projectId/workloadClass` through setErrorHandler `recordOutcome` call | `src/app.ts` | W1-T5, W1-T6 |
| W2-T3: Patch `recordOutcome.ts` — widen `OutcomeContext` + row builder | `src/metrics/recordOutcome.ts` | W1-T2 (schema widened first) |
| W2-T4: Insert `applyPolicyGate()` in all 5 routes + extend each `safeRecord` closure | 5 route files | W1-T6, W2-T3 |

### Wave 3 — Operator Affordances + CI (depends on Waves 1+2 complete)

| Task | Files | Depends on |
|------|-------|------------|
| W3-T1: Write CI cardinality script + unit test | `scripts/check-prometheus-cardinality.ts`, `tests/unit/cardinality.test.ts` | — |
| W3-T2: Add Pitfall-9 grep-gate vitest test | `tests/unit/pitfall9.test.ts` | W2-T1 |
| W3-T3: Integration test — policy gate (4 scenarios) | `tests/integration/policy.test.ts` | W2-T4 |
| W3-T4: Integration test — scoped IDs preHandler (6 scenarios) | `tests/integration/scopedIds.test.ts` | W2-T1, W2-T2 |
| W3-T5: Update `models.yaml` with commented policy example | `router/models.yaml` | — |
| W3-T6: Update `DEPLOY.md` + `README.md` | docs | All previous |
| W3-T7: Update `.planning/REQUIREMENTS.md` POL-01 wording (D-03) | `.planning/REQUIREMENTS.md` | — |
| W3-T8: Run existing smoke test suite + assert all-green | `bin/smoke-test-router.sh` | All previous |

**Actual dependencies (not based on file modification order):**
- Wave 1 is fully parallel (each task touches a disjoint file). The only ordering constraint is W1-T5 and W1-T6 import from W1-T4 — so the merged Wave 1 commit must land before Wave 2.
- Wave 2 depends on the **complete** Wave 1 output because every Wave 2 file imports from a Wave 1 file (gate.ts, scopedIds.ts, envelope.ts new exports, schema widening).
- Wave 3 mostly depends on Wave 2 being done so the assertions are meaningful; W3-T1 (cardinality script) and W3-T5 (yaml comment) can land in parallel with Wave 2.

## Validation Architecture

> Including this section per `workflow.nyquist_validation: true` (config.json) — required for plan-checker handoff.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest `^4.1.6` |
| Config file | `router/vitest.config.ts` |
| Quick run command | `cd router && npm test` |
| Full suite command | `cd router && npm test && bash bin/smoke-test-router.sh` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| POL-01 | Request for unlisted model → 403 + `model_not_in_allowlist` envelope | integration | `cd router && vitest run tests/integration/policy.test.ts -t "allowlist"` | ❌ Wave 3 |
| POL-02 | Cloud-denied entry → 403 + `cloud_not_allowed` envelope; no outbound cloud request | integration | `cd router && vitest run tests/integration/policy.test.ts -t "cloud-not-allowed"` | ❌ Wave 3 |
| POL-03 | Valid `X-Workload-Class: sensitive` → 200 + row `workload_class='sensitive'`; invalid value → 200 + row `workload_class=NULL` | integration | `cd router && vitest run tests/integration/scopedIds.test.ts -t "workload class"` | ❌ Wave 3 |
| POL-04 | Valid `X-Tenant-ID`/`X-Project-ID` → 200 + row populated; invalid → 400 + `invalid_scoped_id` envelope | integration | `cd router && vitest run tests/integration/scopedIds.test.ts -t "scoped IDs"` | ❌ Wave 3 |
| POL-05 | After 403 from policy gate, breaker counter unchanged | integration | `cd router && vitest run tests/integration/policy.test.ts -t "breaker counter unchanged"` | ❌ Wave 3 |
| POL-06 | `src/metrics/registry.ts` contains no labelName matching `/_id$/` | unit | `cd router && vitest run tests/unit/cardinality.test.ts` | ❌ Wave 3 |
| Pitfall-9 | Exactly one `req.log = ` in `router/src/` | unit | `cd router && vitest run tests/unit/pitfall9.test.ts` | ❌ Wave 3 |
| Regression | Existing smoke suite still all-green | smoke | `bash bin/smoke-test-router.sh` | ✅ existing |

### Concrete Test Patterns

**POL-05 — Breaker counter unchanged.** Pattern: construct a fake `CircuitBreaker` implementation with a spied `recordFailure`, inject via `opts.breaker` (the existing `app.ts:542` shape uses a literal `{ check, recordFailure, recordSuccess, reset }` object — easy to wrap with `vi.fn`). After triggering a policy 403, assert `breaker.recordFailure` was called zero times.

```ts
// tests/integration/policy.test.ts — breaker-counter pattern
const recordFailure = vi.fn();
const fakeBreaker = {
  check: async () => ({ state: 'closed' as const }),
  recordFailure,
  recordSuccess: vi.fn(),
  reset: vi.fn(),
};
// NB: app.ts uses opts.valkey + opts.env to gate breaker construction.
// Inject opts.breaker is not yet a field — the plan either (a) adds a
// new optional `breaker?: CircuitBreaker` field to BuildAppOpts (cleanest),
// or (b) uses opts.valkey + opts.env + custom semantics to drive a real
// breaker and asserts the counter via Valkey direct read. (a) is preferred
// — add the field exclusively for test injection, with the production path
// untouched (opts.breaker ?? existing-if-block).
```
**Action for planner:** the simplest test seam is to add `breaker?: CircuitBreaker` to `BuildAppOpts` and gate the existing constructor as `opts.breaker ?? (opts.valkey && opts.env ? makeCircuitBreaker(...) : noopBreaker)`. Existing tests untouched (the new field is optional); the policy test uses the seam.

**POL-02 — No cloud request emitted.** Pattern: use the existing MSW setup (`tests/msw/handlers.ts`). Register a handler at `https://ollama.com/v1/chat/completions` that **fails the test if invoked**. Then trigger the policy violation and assert no outbound request hit MSW. The existing chat-completions tests (`chat-completions.nonstream.test.ts`) already use MSW handlers — same pattern.

```ts
// pseudo-code — POL-02
const cloudCalls: Request[] = [];
mswServer.use(
  http.post('https://ollama.com/v1/chat/completions', (info) => {
    cloudCalls.push(info.request);
    return HttpResponse.json({}, { status: 500 });
  }),
);
// ... send request to a cloud entry with policy.cloud_allowed: false ...
expect(cloudCalls).toHaveLength(0);
```

**POL-03/POL-04 — `request_log` row population.** Pattern: use a vi.fn-spied bufferedWriter (existing precedent in `recordOutcome.test.ts:149` and `chat-completions.stream.test.ts:351`). After the request, assert the captured row has the expected `tenant_id` / `project_id` / `workload_class`.

```ts
// Existing precedent — recordOutcome.test.ts:149-151
const pushed: RequestLogInsert[] = [];
const bufferedWriter = {
  push: (row: RequestLogInsert) => pushed.push(row),
  drain: async () => {},
  get size() { return 0; },
};
// ... after request ...
expect(pushed[0]?.tenant_id).toBe('acme:prod');
expect(pushed[0]?.workload_class).toBeNull();
```

**POL-06 — Cardinality CI.** Pattern: as shown in §"CI Cardinality Check" above — `tests/unit/cardinality.test.ts` reads the actual `src/metrics/registry.ts` source and runs `checkCardinality()`.

**Regression — Smoke test suite.** `bin/smoke-test-router.sh` is the existing harness. The plan should NOT extend it for Phase 14 (Phase 19 explicitly owns smoke-test extension per the milestone roadmap). Phase 14's contract is "existing smoke passes unchanged" — with allow-all defaults, the new gate is a no-op and no existing assertion changes.

### Sampling Rate
- **Per task commit:** `cd router && npm test` (full vitest run; ~10s for unit, ~30s for integration in this codebase).
- **Per wave merge:** `cd router && npm test && cd .. && bash bin/smoke-test-router.sh` (smoke needs a running compose stack).
- **Phase gate:** Full suite green + smoke green before `/gsd:verify-work`.

### Wave 0 Gaps
- [ ] `router/tests/integration/policy.test.ts` — covers POL-01, POL-02, POL-05
- [ ] `router/tests/integration/scopedIds.test.ts` — covers POL-03, POL-04
- [ ] `router/tests/unit/cardinality.test.ts` — covers POL-06
- [ ] `router/tests/unit/pitfall9.test.ts` — covers Pitfall-9 invariant (D-20)
- [ ] No new test framework install needed — vitest already covers everything.

## Common Pitfalls

### Pitfall 1: Drizzle Migration Silently Skipped

**What goes wrong:** The 0005 SQL file is committed and the schema is updated, but `_journal.json` is left at the 0004 idx. The migrator on next `docker compose up` runs nothing — `request_log` never gets the new columns. The schema type widens (TypeScript happy), but the runtime INSERT fails with `column "tenant_id" does not exist`.

**Why it happens:** The 3-file tuple is easy to split across commits; the journal entry feels like Drizzle-internal bookkeeping (it isn't).

**How to avoid:** Mandate atomic commit in plan (W1-T2). Verification command in verify-work step:
```bash
test "$(grep -c '0005_request_log_scoped_ids' router/db/migrations/meta/_journal.json)" -eq 1
test -f router/db/migrations/0005_request_log_scoped_ids.sql
grep -c 'tenant_id: text' router/src/db/schema/request_log.ts
```
All three must return ≥ 1.

**Warning signs:** Schema TypeScript builds clean but runtime INSERTs throw "column does not exist" on a fresh `docker compose up`.

### Pitfall 2: `req.log =` Duplicate

**What goes wrong:** Phase 14 author adds `req.log = req.log.child({ tenant_id })` inside `scopedIdsPreHandler` because it feels like the right place. Now there are two assignments — the agentId child overwrites the scopedIds child, losing tenant_id from logs in the common case where agentId is present.

**Why it happens:** Symmetric ergonomics — agentId.ts does it, why not scopedIds?

**How to avoid:** D-20 + Pattern §"`scopedIds.ts` Module Shape" inline comment + Pitfall-9 grep-gate vitest test (W3-T2). The plan must add the test.

**Warning signs:** `grep -rn 'req\.log = ' router/src/ | wc -l` returns `2`.

### Pitfall 3: Hook Ordering Surprise

**What goes wrong:** Plan registers `scopedIdsPreHandler` AFTER `agentIdPreHandler`. agentId's `.child()` call runs first; tenant_id / project_id / workload_class are still undefined; logs lose them.

**Why it happens:** D-18 says "ordering does not matter" — true for field stamping, FALSE for agentId reading scopedIds' output.

**How to avoid:** Register scopedIds BEFORE agentId in `app.ts`. Add an integration test asserting log lines contain `tenant_id` when the header is supplied (mirror of `agentIdPreHandler.test.ts` case 2).

**Warning signs:** Test asserts `lines.includes('"tenant_id":"acme"')` fails despite header being sent.

### Pitfall 4: Zod schema strict-mode interaction with new optional `policy` field

**What goes wrong:** Author adds `policy:` to per-entry shape but forgets the existing `superRefine` runs against entries; refinement passes but downstream code treats `entry.policy?.cloud_allowed` as `boolean | undefined` instead of `boolean | undefined`. The gate check `entry.policy?.cloud_allowed === false` correctly handles all three cases (true / false / undefined → default true).

**Why it happens:** Zod's `.default(true)` only applies when the property is present-but-undefined; when the whole `policy:` block is omitted, the entry's `policy` field is `undefined`. The `?.` chain correctly returns `undefined` in that case; `=== false` is the right test (not `!entry.policy?.cloud_allowed`, which would also fire on `undefined`).

**How to avoid:** Use `=== false` (D-07 code preview). Add an explicit unit test for the four cases: (no policy block, no cloud), (no policy block, cloud), (policy block with cloud_allowed: false, cloud), (policy block with cloud_allowed: true, cloud).

**Warning signs:** Cloud requests against entries without a `policy:` block return 403 (the `!` operator misuse).

### Pitfall 5: hot-reload of `models.yaml` doesn't pick up new `policies:` block

**What goes wrong:** Operator edits `models.yaml` to add a policy block; `docker compose restart router` is run; the new policy doesn't take effect. The fs.watch path SHOULD pick it up, but `project_models_yaml_hot_edit.md` documents that the Valkey-cached snapshot is the actual hot path.

**Why it happens:** Phase 8+ introduced Valkey caching of the registry snapshot (`model-registry:*` keys). The fs.watch reload updates the in-memory `RegistryStore` but the cache layer reads from Valkey first.

**How to avoid:** Document in DEPLOY.md (Wave 3 task W3-T6) the exact procedure: `docker compose exec valkey valkey-cli DEL model-registry:snapshot` (or equivalent — verify exact key name with `KEYS model-registry:*`) followed by `docker compose up -d --force-recreate router`. Cross-link to the project memory.

**Warning signs:** Operator reports "I added the policy block, restarted, still no 403" — Valkey cache is stale.

### Pitfall 6: Prometheus label regression in a future PR

**What goes wrong:** A future phase adds `tenant_id` to a Prometheus label, intending "just for this one metric, it's only for the operator dashboard." Cardinality blows up in production (P8-03).

**Why it happens:** Plain code review misses it; reviewers see the labelNames array as boilerplate.

**How to avoid:** The CI script is the durable defense. W3-T1 lands the script. Plan should also call out the script's existence in a comment at the top of `src/metrics/registry.ts` (one-line pointer).

**Warning signs:** `npm test` failure with the cardinality message — the test catches it pre-merge.

## Code Examples

Verified patterns from the local codebase (zero external citations needed — all in-repo).

### Policy gate helper

```ts
// Source: CONTEXT.md D-07 (locked code preview)
// Target file: router/src/policy/gate.ts
import {
  AllowlistViolationError,
  CloudNotAllowedError,
} from '../errors/envelope.js';
import type { Registry, ModelEntry } from '../config/registry.js';

type PoliciesConfig = NonNullable<Registry['policies']>;

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

### Route-side insertion (chat-completions example — repeat across 5 routes)

```ts
// Source: chat-completions.ts:196-205 (existing capability gate)
// + chat-completions.ts:319-324 (existing breaker check)
// — applyPolicyGate inserts BETWEEN them.

      if (hasImage && !entry.capabilities.includes('vision')) {
        throw new CapabilityNotSupportedError(entry.name, 'vision');
      }
      if (wantsJson && !entry.capabilities.includes('json_mode')) {
        throw new CapabilityNotSupportedError(entry.name, 'json_mode');
      }

      // Phase 14 (v0.11.0 — POL-01 / POL-02 / P8-01 BLOCK): policy gate fires
      // AFTER capability gate, BEFORE the breaker check, so a policy 403 never
      // mutates the breaker counter (P8-01). Snapshot is fetched at this code
      // position — registry.get() is the existing seam; the registry's hot-reload
      // path swaps the snapshot atomically.
      const snapshot = opts.registry.get();
      applyPolicyGate(snapshot.policies, entry, body.model);

      // ... existing code (controller, semaphore, idempotency, etc.) ...

      try {
        const breakerResult = await opts.breaker.check(entry.backend);
        // ... existing code unchanged ...
```

### scopedIds preHandler — see §"`scopedIds.ts` Module Shape" above for the full file.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-route inline capability checks with no shared helper | Per-route inline call to centralized error class (`CapabilityNotSupportedError`) with single envelope mapping | v0.9.0 | Phase 14 follows the same pattern — single helper `applyPolicyGate()`, centralized envelope. |
| Per-request `prefer_cloud: true`-style overrides | Policy in `models.yaml` + `.strict()` Zod request schemas (P8-02 mitigation) | v0.8.0 | Phase 14's per-entry `policy.cloud_allowed` lives ONLY in YAML; request bodies stay `.strict()`-validated. |
| `tenant_id` as Prometheus label "for dashboards" | `tenant_id` as `request_log` column + pino field; Postgres views for per-tenant breakdowns (`cost_per_agent_daily` precedent) | v0.10.0 | Phase 14 inherits this — no cardinality regression. |

**Deprecated/outdated approaches (do not consider):**
- LangChain.js / Vercel AI SDK / Mastra-style "policy engine" — SUMMARY.md §"State of the Art" explicitly rejects them for this server-side middleware router. Phase 14's "two hard-coded rules in `gate.ts`" is the correct scale.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Hook ordering in `app.ts` `addHook('preHandler', ...)` is preserved (first-registered runs first) | `scopedIds.ts` Module Shape, preHandler Registration | If false, agentId.ts `.child()` call may run before scopedIds.ts stamps fields → tenant_id/project_id/workload_class absent from logs in the happy path. Verified pattern in Fastify v5 docs (CITED via CLAUDE.md research notes), but Phase 14 should add an integration test that asserts log-line ordering. |
| A2 | `pino.child({ undefined-field: undefined })` serializes the undefined field as missing-key, not as `null` | `agentId.ts` Minimal Patch | If false (renders as `null`), existing log-line assertions like `expect(lines).toContain('"agent_id":"…"')` may break in a subtle way. Mitigated by adding undefined-handling tests in the W3-T4 integration suite. |
| A3 | The existing `app.ts:542` literal-shape `breaker` (no-op) is type-compatible with a `vi.fn`-spied wrapper for test injection | Validation Architecture POL-05 pattern | If false, the test-seam approach (a) requires the plan to use approach (b) — Valkey direct read. Both are viable; (a) is cleaner. |
| A4 | The Drizzle migrator runs on `docker compose up` automatically (no separate `drizzle-kit migrate` invocation needed) | Drizzle Migration Tuple recipe | If false, the rollback procedure in DEPLOY.md needs to spell out the explicit migration command. Verified via 0004's existence as a SQL file with no operator-run step documented; assumed true. |
| A5 | Valkey cache key for the registry snapshot is `model-registry:*` (verified via project memory `project_models_yaml_hot_edit.md`) | Operator Affordances, Pitfall 5 | If the exact key name differs (e.g. `registry:snapshot:*`), DEPLOY.md instructions are wrong. Plan should confirm by running `valkey-cli KEYS 'model-registry:*'` in a smoke step. |
| A6 | The CI cardinality script does not need to scan files beyond `src/metrics/registry.ts` | CI Cardinality Check | If a future phase declares Prometheus metrics outside that file, the script silently passes them. Phase 14 only commits to scanning the existing file; Phase 19's live-parse covers the broader case. |

## Open Questions

1. **Should the CI cardinality script also scan `src/metrics/recordOutcome.ts`?**
   - What we know: today, ALL prom-client metric declarations live in `src/metrics/registry.ts`. `recordOutcome.ts` only consumes them (`.inc()`, `.observe()`).
   - What's unclear: whether a future refactor might inline a metric declaration elsewhere.
   - Recommendation: scope Phase 14's script to `src/metrics/registry.ts`; Phase 19's live-parse handles the open case. Document this scope decision in the script header.

2. **Should the policy gate emit a structured warn-log on 403?**
   - What we know: existing centralized error handler emits `req.log.warn({ err, url, status }, 'route error -> envelope')` for every error → 403 will be logged.
   - What's unclear: whether a dedicated `event: "policy_violation"` log field (per P8-04 FLAG) is in scope for Phase 14 or deferred.
   - Recommendation: rely on the default `route error -> envelope` warn log for Phase 14. P8-04 (audit-log for policy CHANGES) is a separate concern, not in scope.

3. **Does `applyPolicyGate()` receive `Registry['policies']` or the full Registry snapshot?**
   - What we know: D-07 code preview passes `policies` directly.
   - What's unclear: future per-entry-conditional logic might want the full registry. Premature.
   - Recommendation: stick with D-07 — pass `policies` only. Refactor later if needed.

4. **Should `InvalidScopedIdError` carry the supplied value in its message (truncated) like `InvalidAgentIdError` does?**
   - What we know: `InvalidAgentIdError` truncates to 32 chars for log/envelope safety.
   - What's unclear: whether Phase 14 should mirror this defense-in-depth.
   - Recommendation: YES — mirror exactly (already encoded in §"Error Envelope Dual-Mapping" patch). One-line defense; no downside.

5. **Migration timestamp value for `_journal.json` `when` field — exact format?**
   - What we know: existing entries use Unix milliseconds (e.g., `1779696000000` for 0004).
   - What's unclear: whether Drizzle uses this strictly or whether the relative ordering is what matters.
   - Recommendation: use `Date.now()` captured at task-start. Drizzle's migrator orders by `idx`, not by `when` — the field is for human-readable audit.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All Phase 14 code | ✓ | 22+ (per CLAUDE.md lock) | — |
| npm | Vitest + tsx invocation | ✓ | bundled with Node | — |
| Docker Compose | Smoke + migration run | ✓ (per project setup) | v2 | — |
| PostgreSQL | Migration 0005 application | ✓ (compose service) | 17 | — |
| Valkey | Hot-reload cache invalidation (Pitfall 5) | ✓ (compose service) | 8 | — |
| Drizzle kit | Migration generation (W1-T2) | ✓ (devDep `drizzle-kit ^0.27.0`) | 0.27.0 | hand-author the SQL + journal entry (already documented as the recipe) |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None.

## Security Domain

> Security enforcement is the project default (no `security_enforcement: false` in config.json).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (Phase 14 adds no auth surface) | existing bearer + onRequest hook unchanged |
| V3 Session Management | no (no session creation) | — |
| V4 Access Control | **yes** (policy gate IS access control) | `applyPolicyGate()` — single helper, single source of truth, runs pre-breaker (P8-01). 403 mapping with stable error codes (`model_not_in_allowlist`, `cloud_not_allowed`). |
| V5 Input Validation | **yes** (3 new headers) | Zod (registry schema) + hand-rolled regex (header preHandlers). Regex shape pre-cleared for ReDoS (anchored + bounded + no nested quantifiers). Error message truncation to 32 chars in `InvalidScopedIdError` (defense in depth — sanitize attacker-controlled header values before log emission). |
| V6 Cryptography | no | — |
| V8 Data Protection | partial | `request_log` columns are server-controlled; no sensitive data flows through tenant/project ID columns. workload_class is opaque (Frame-04: no content analysis). |
| V10 Configuration | **yes** | `models.yaml` is the policy source of truth; existing `.strict()` Zod gates prevent `prefer_cloud`-style request-body bypass (P8-02). Hot-reload path keeps the previous registry on validation failure (existing behavior — no regression). |
| V11 Logging | **yes** | Pino redact config covers request body; new `tenant_id` / `project_id` / `workload_class` fields are non-secret IDs (no redaction needed). `InvalidScopedIdError` message uses 32-char truncation pattern (mirrors `InvalidAgentIdError`). |
| V12 Files & Resources | no | — |
| V13 API & Web Service | **yes** | Dual-envelope (OpenAI + Anthropic) for both 403s preserves wire-protocol parity. Stable error codes (`model_not_in_allowlist`, `cloud_not_allowed`, `invalid_scoped_id`) so clients can pattern-match without parsing prose messages. |

### Known Threat Patterns for Phase 14

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| ReDoS via crafted `X-Tenant-ID` / `X-Project-ID` / `X-Workload-Class` | Denial of Service | Anchored + bounded regex (`^...$`, `{1,128}` / `{1,64}`). No nested quantifiers, no overlapping alternation. SAME profile as `agentId` v0.9.0 (cleared). |
| Log injection via header value (newlines, ANSI escapes) | Tampering | `InvalidScopedIdError` truncates to 32 chars before message embedding. Pino's default JSON serializer escapes control characters. Valid IDs pass the regex first — the regex character class excludes control chars by construction. |
| High-cardinality Prometheus DoS | Denial of Service | D-25 + CI script. Static labelNames stay bounded. |
| Cloud-restriction bypass via per-request param | Tampering | P8-02 — `.strict()` route schemas reject unknown body fields. Policy flag lives ONLY in `models.yaml`. |
| Policy gate skipped due to ordering bug | Tampering | P8-01 — integration test asserts breaker counter unchanged after 403; verifies gate ran in the right position. |
| Migration silently skipped | Information Disclosure (row-write failure leaks via 500 logs) | P9-01 — atomic-tuple discipline + post-migration `\d request_log` smoke check. |
| Pitfall-9 log-context regression | Information Disclosure (tenant_id missing from audit logs) | Grep gate vitest test (W3-T2) — count must equal 1. |

## Sources

### Primary (HIGH confidence — verified in this session against the codebase)

- `router/src/middleware/agentId.ts` (entire file) — preHandler pattern, ReDoS-cleared regex, single-`req.log=` invariant.
- `router/src/errors/envelope.ts` (entire file, 693 lines) — error class pattern, dual envelope mapping, mapToHttpStatus shape.
- `router/src/config/registry.ts` (entire file, 283 lines) — Zod schema extension target, superRefine pattern, hot-reload semantics.
- `router/src/db/schema/request_log.ts` (entire file) — column-add target precedent (`agent_id: text('agent_id')`).
- `router/db/migrations/meta/_journal.json` — verified next idx is 5.
- `router/db/migrations/0002_request_log_idempotency_key.sql` and `0003_request_log_cost_cents.sql` and `0004_cost_per_agent_daily.sql` — migration SQL precedents.
- `router/src/app.ts` (entire file, 791 lines) — preHandler hook registration order, setErrorHandler shape, breaker injection seam.
- `router/src/routes/v1/chat-completions.ts` lines 180-340 — exact insertion point for `applyPolicyGate()` (between capability gate at lines 196-218 and breaker.check at line 324).
- `router/src/metrics/registry.ts` (entire file, 138 lines) — labelNames arrays verified clean of `*_id` labels.
- `router/src/metrics/recordOutcome.ts` lines 40-272 — OutcomeContext shape, row builder, RequestLogInsert consumer.
- `router/tests/integration/agentIdPreHandler.test.ts` lines 1-100 — preHandler test pattern (log-line capture via stream).
- `router/tests/integration/recordOutcome.test.ts` lines 149-151 — bufferedWriter spy pattern.
- `router/tests/integration/chat-completions.nonstream.test.ts` — MSW handler pattern for upstream mocking.
- `router/tests/resilience/circuitBreaker.test.ts` lines 211-264 — breaker `.check()` / `.recordFailure()` interaction pattern.
- `router/models.yaml` — current operator-facing shape; precedent for the commented example block.
- `router/package.json` — verified versions: Fastify 5.8.5, zod 4.4.3, drizzle-orm 0.36.0, prom-client 15.1.3, pino 10.3.1, vitest 4.1.6.

### Secondary (MEDIUM confidence — referenced from `.planning/` corpus)

- `.planning/research/PITFALLS.md` P8-01 lines 574-588 — gate position rationale.
- `.planning/research/PITFALLS.md` P8-02 lines 592-606 — strict-schema mitigation.
- `.planning/research/PITFALLS.md` P8-03 lines 610-629 — cardinality quantified sketch.
- `.planning/research/PITFALLS.md` P9-01 lines 650-663 — migration ordering / atomic tuple.
- `.planning/research/PITFALLS.md` Frame-04 lines 745-753 — no content classification.
- `.planning/research/SUMMARY.md` lines 128-134 — Phase 14 contradiction resolution (Architecture researcher correct).
- `.planning/research/ARCHITECTURE.md` lines 458-490 — policy-store sketch (note: Architecture sketch differs slightly from CONTEXT.md locked shape — CONTEXT.md is authoritative).
- `.planning/REQUIREMENTS.md` lines 21-26 — POL-01..06 full text.
- `.planning/phases/14-policy-primitives-tenant-project-id-foundation/14-CONTEXT.md` — D-01..D-28 locks.

### Project memory (HIGH confidence — verified in working session via session memory)

- `project_drizzle_migration_journal.md` — SQL + schema + journal entry is indivisible.
- `project_models_yaml_hot_edit.md` — Valkey DEL + force-recreate is required for live policy edits.
- `project_fastify_onsend_timing.md` — onSend timing reference (not directly invoked in Phase 14, but relevant if response-header echo is added under Claude's discretion).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every version verified against `router/package.json`; every code pattern mirrored from existing file with line-citations.
- Architecture: HIGH — all 28 decisions are locked in CONTEXT.md and corroborated by existing precedents (capability gate, agentId preHandler, error envelope dual-mapping, migration tuple shape, breaker injection seam).
- Pitfalls: HIGH — Pitfall 1, 2, 3 verified via existing code state (grep returned exactly 1 today); Pitfall 5 verified via project memory; Pitfall 6 mitigation is implemented in W3-T1.
- Validation architecture: HIGH — every test pattern has an existing in-repo precedent (`agentIdPreHandler.test.ts`, `recordOutcome.test.ts`, `chat-completions.nonstream.test.ts`, `circuitBreaker.test.ts`).
- Open questions: MEDIUM — 5 open items, all with explicit recommendations and none blocking.

**Research date:** 2026-05-29
**Valid until:** 2026-06-28 (30 days — stable codebase, no fast-moving external dependencies)

## RESEARCH COMPLETE
