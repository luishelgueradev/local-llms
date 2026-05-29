# Phase 14: Policy Primitives + Tenant/Project ID Foundation - Context

**Gathered:** 2026-05-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 14 delivers two interlocking foundations, both **additive and zero-dependency on existing v0.10.0 surfaces**:

1. **A policy gate** that fires AFTER the capability gate and BEFORE the circuit breaker on every model-bound route (`/v1/chat/completions`, `/v1/messages`, `/v1/embeddings`, `/v1/rerank`, `/v1/responses`). The gate returns `403` for two violation classes — model-not-in-allowlist and cloud-not-allowed — **before** any backend request is emitted or any breaker counter is mutated.

2. **Tenant/project/workload-class context extraction** from request headers (`X-Tenant-ID`, `X-Project-ID`, `X-Workload-Class`) into:
   - new `request_log` columns (migration 0005)
   - the pino structured log child context
   - NEVER into Prometheus labels (enforced by CI script)

The strategic frame holds: **the router declares policy and surfaces tenant context for observability. The router does not classify content, does not derive tenant from bearer token, does not run a policy engine, and does not change Prometheus cardinality.** Multi-tenant ID extraction is an observability foundation that every subsequent phase (15–19) inherits — adding it now means no retrofit pass.

**Phase is NOT delivering:** full RBAC, per-tenant model allowlists, per-bearer policy, content classifier, or `X-Workload-Class`-driven routing. Those belong to future phases.

</domain>

<decisions>
## Implementation Decisions

### Policy Configuration Shape (`models.yaml`)

- **D-01:** Policy configuration uses a **hybrid shape**: a new top-level `policies:` section for the **global model allowlist**, plus a per-entry `policy:` block for the per-entry `cloud_allowed` flag.

  ```yaml
  policies:
    default:
      model_allowlist: []          # empty = allow-all (default); list of registry display names
  models:
    - name: chat-local
      backend: ollama
      # …
      policy:
        cloud_allowed: true        # default true; per-entry deny of cloud routing
    - name: big-cloud
      backend: ollama-cloud
      policy:
        cloud_allowed: false       # explicit deny of THIS cloud entry
  ```

- **D-02:** **Rationale for the hybrid shape (resolves REQ wording ambiguity).** POL-01 phrases `model_allowlist` as "per registry entry" but also requires the 403 to fire "BEFORE backend resolution". The per-entry placement of an allowlist is semantically inconsistent with "before resolution" (the entry has to be selected to be consulted). We resolve the contradiction by placing the allowlist at top level (`policies.default.model_allowlist`) — fires **before** `registry.resolve()` — and keeping `cloud_allowed` per-entry where it is well-defined.

- **D-03:** **POL-01 wording will be updated in REQUIREMENTS.md** in this phase's plan to reflect the top-level shape. The original "per registry entry" phrasing was a wording bug.

- **D-04:** Empty list (`model_allowlist: []`) and absent `policies:` section **both** evaluate to allow-all. This is the default and means existing smoke tests pass unchanged (zero-config = unchanged behavior).

- **D-05:** Per-entry `policy.cloud_allowed` defaults to **`true`** when omitted. The gate only fires the 403 when `entry.backend === 'ollama-cloud' && entry.policy?.cloud_allowed === false`. Local-backend entries can legally set `cloud_allowed: false` — it is simply vacuous (never fires) but not an error.

- **D-06:** The new `policies:` top-level section participates in the existing `models.yaml` hot-reload path. No new file watcher; the existing `RegistryStore.reload()` round-trip re-parses + atomically swaps. Cache invalidation (Valkey `model-registry:*`) follows the same path as the v0.9.0 hot-reload memory.

### Policy Gate Code Placement

- **D-07:** Create `src/policy/gate.ts` exporting a single function `applyPolicyGate(policies, entry, requested_model): void`. Each of the 5 routes imports and calls it at the **exact same code position** — right after the existing capability gate, right before `opts.breaker.check(entry.backend)`. Throws on violation; the centralized envelope handler maps the error type to the structured 403 envelope.

  ```ts
  // src/policy/gate.ts
  export function applyPolicyGate(
    policies: PoliciesConfig,
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

- **D-08:** **Rationale.** Inline duplication across 5 routes is the same anti-pattern v0.9.0 rejected for the capability gate (which now uses `CapabilityNotSupportedError` per-route inline but with single error-envelope mapping). A shared helper is one source of truth and aligns with the established envelope mapping discipline. Fastify preHandler at app-level was rejected because the gate requires the **resolved registry entry**, which is route-specific work that already happens inline.

- **D-09:** **Gate position is non-negotiable (P8-01 BLOCK).** Policy violations MUST NOT count as backend failures. Integration test asserts `circuitBreaker.recordFailure()` counter is **unchanged** after a 403 from either policy violation.

- **D-10:** **New error types** added to `src/errors/envelope.ts`:
  - `AllowlistViolationError(model)` → 403 + `{ error: { code: "model_not_in_allowlist", model, type: "policy_violation" } }`
  - `CloudNotAllowedError(model)` → 403 + `{ error: { code: "cloud_not_allowed", model, type: "policy_violation" } }`
  - Both map to the existing Anthropic envelope shape too (the gate runs on `/v1/messages` as well as `/v1/chat/completions`).

### `X-Workload-Class` Validation

- **D-11:** `X-Workload-Class` is **opaque metadata**. Accept any value matching `/^[A-Za-z0-9._-]{1,64}$/`, normalize to lowercase on extraction, and stamp into `request_log.workload_class`. **No content classification, no routing impact, no fixed enum** — the value is documented as "operator's downstream taxonomy".

- **D-12:** **Invalid values silently NULL** (do not 400). Rationale: POL-03 explicitly frames this as opaque metadata. A 400 on header shape would couple caller deployments to the router's regex; a silent NULL is the lower-coupling choice. The integration test asserts a malformed `X-Workload-Class` (e.g., space, length > 64) produces a successful 200 with `workload_class: NULL` in the row.

- **D-13:** Missing header (the common case) is also `workload_class: NULL` — no warning, no error.

- **D-14:** `workload_class` ships as part of **migration 0005** alongside `tenant_id` + `project_id`. Three columns, one migration file.

### Tenant/Project ID Validation

- **D-15:** Reuse `agentId`'s validation regex **exactly**: `/^[A-Za-z0-9._:-]{1,128}$/`. Define `ID_RE` as a shared constant in `src/middleware/scopedIds.ts`; `X-Agent-Id`, `X-Tenant-ID`, and `X-Project-ID` all use the same regex, the same length cap, and the same ReDoS analysis (anchored + bounded + no nested quantifiers — already cleared in v0.9.0 for `agentId`).

- **D-16:** Invalid `X-Tenant-ID` / `X-Project-ID` values throw `InvalidScopedIdError(label, value)` mapped to **400** (consistent with `InvalidAgentIdError`'s existing behavior). Diverges from `X-Workload-Class` (silent NULL) because tenant/project IDs are operationally load-bearing — typos must surface at the caller.

- **D-17:** Missing headers (the common case) silently set the column to NULL. No warning.

### Middleware Layout

- **D-18:** **New sibling preHandler module** `src/middleware/scopedIds.ts` extracts `X-Tenant-ID`, `X-Project-ID`, `X-Workload-Class`. The existing `src/middleware/agentId.ts` is **not** extended — it stays a single-responsibility module for `X-Agent-Id` + `_t0` capture (renaming it would force a churn pass with no net benefit). Both preHandlers register in `app.ts` at the same hook level; ordering does not matter since they read disjoint headers.

- **D-19:** `FastifyRequest` module augmentation adds `tenantId?: string`, `projectId?: string`, `workloadClass?: string` (mirrors the existing `agentId?: string`, `_t0?: number`, `resolvedBackend?: string`, `computedCostCents?: string` pattern in `agentId.ts`).

- **D-20:** Pino child logger creation lives in **one place** (the existing `req.log = req.log.child(...)` call in `agentIdPreHandler` at the cross-file grep gate Pitfall 9). The new middleware **stamps fields onto `req`** only; the agentId preHandler reads them (after running) and includes them in the single `req.log.child({...})` call. This preserves the Pitfall 9 invariant: **exactly one `req.log = ` assignment in production source**.

### Migration 0005

- **D-21:** **First task of the phase plan is reading `router/db/migrations/meta/_journal.json`** to confirm 0005 is the next sequential number. Verified at discuss time: the journal has entries 0..4 (last tag `0004_cost_per_agent_daily`, idx 4). The plan must re-verify at execution time to guard against concurrent migration work elsewhere.

- **D-22:** Migration 0005 file name: `0005_request_log_scoped_ids.sql`. Adds three columns:
  ```sql
  ALTER TABLE request_log ADD COLUMN tenant_id TEXT;
  ALTER TABLE request_log ADD COLUMN project_id TEXT;
  ALTER TABLE request_log ADD COLUMN workload_class TEXT;
  ```
  All three NULLable, no defaults, no backfill. The `agent_id` column already exists from v0.9.0.

- **D-23:** **Drizzle journal tuple discipline (project-level invariant).** New migration requires SQL file + Drizzle schema update (`router/src/db/schema/request_log.ts`) + `_journal.json` entry as an **indivisible tuple**, else the migrator silently skips. The plan flags all three as a single atomic task.

- **D-24:** No new indexes in 0005. Tenant/project queries are low-volume operator tooling, not request-path; the existing `idx_request_log_ts_desc` and `(agent_id, ts DESC)` covering index suffice. Add indexes later if/when a query plan shows them needed.

### Prometheus Cardinality Discipline

- **D-25:** **No new metric label additions** in Phase 14. The existing labelNames arrays in `src/metrics/registry.ts` (`['protocol', 'backend', 'model', 'status_class']`, etc.) are explicitly **not extended** with `tenant_id`, `project_id`, `agent_id`, or `session_id`.

- **D-26:** New CI script `router/scripts/check-prometheus-cardinality.ts` (TypeScript, run by vitest as part of the test suite). The script:
  1. Performs a static grep on `src/metrics/registry.ts` for `labelNames:` arrays
  2. Asserts no array element matches `/_id$/` (catches `tenant_id`, `project_id`, `agent_id`, `session_id`, plus any future `*_id` addition)
  3. Optionally (Phase 19) also live-parses `/metrics` output for the same regex
  4. Fails the test suite with a clear error: `"Forbidden _id label found in router_request_total — see CONTEXT.md D-25"`

- **D-27:** **Static-grep first, live parse deferred to Phase 19.** Static grep catches the static-source case (the only case Phase 14 can introduce). Live `/metrics` parse adds value when downstream phases add metrics that read labels from request-time data (e.g., a hook-emitted metric). Phase 19's "Observability Hardening" REQ already covers the live parse.

- **D-28:** New Prometheus metrics introduced by Phase 14: **none**. Policy violations are surfaced via the existing `router_request_total{status_class="client_error"}` counter (already labels the 403). A future, dedicated `policy_violation_total{code}` counter could be added in Phase 19 if operator dashboards need it; it does NOT carry tenant/project labels.

### Claude's Discretion

- The exact wording of CI test failure messages (D-26).
- Whether the new CI script is added to the `test:` script in `router/package.json` as a pre-existing pattern or as a separate `test:cardinality` script — implementation choice based on existing test-script structure.
- The exact file split between `src/policy/gate.ts` and `src/policy/types.ts` (one file vs two) — implementation detail.
- Specific structured-log field names in pino child: `tenant_id`, `project_id`, `workload_class` (snake_case to match `request_log` column names) — already consistent with existing `agent_id` field, so this is locked.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Roadmap + Requirements
- `.planning/ROADMAP.md` §"Phase 14: Policy Primitives + Tenant/Project ID Foundation" — goal, dependencies, design constraints (P8-01..03, P9-01, Frame-04 BLOCK), success criteria 1–5
- `.planning/REQUIREMENTS.md` POL-01 through POL-06 — full requirement text (POL-01 wording to be patched per D-03)
- `.planning/STATE.md` "Key Design Decisions (v0.11.0)" + "Active Decisions" rows — milestone-level locks

### Milestone Research (read before planning)
- `.planning/research/SUMMARY.md` §"Phase 14: Policy Primitives + Tenant/Project ID Foundation" — research-time rationale (contradicting Features researcher; Architecture wins) + research flag "Standard patterns — no deeper research needed"
- `.planning/research/PITFALLS.md` §"Policy + Observability" P8-01 (gate position), P8-02 (cloud_allowed bypass), P8-03 (Prometheus cardinality), §"Migration journal" P9-01 — BLOCK-severity design pitfalls
- `.planning/research/ARCHITECTURE.md` §"Policy Gate" + §"Tenant/Project Middleware" — pipeline-position diagrams
- `.planning/research/FEATURES.md` §"Policy primitives" + §"Tenant/Project IDs" — feature-level acceptance text (lower-confidence than ARCHITECTURE for this phase per SUMMARY contradiction resolution)
- `.planning/research/STACK.md` — confirms no new dependencies needed for Phase 14

### Codebase — Patterns to Mirror
- `router/src/middleware/agentId.ts` — single-responsibility preHandler pattern, ReDoS-cleared regex, FastifyRequest module augmentation, Pitfall 9 "exactly one req.log assignment" invariant
- `router/src/routes/v1/chat-completions.ts` lines 196–218 (capability gate) + lines 319–334 (breaker.check call site) — **the exact code position where `applyPolicyGate()` calls go**
- `router/src/errors/envelope.ts` (CapabilityNotSupportedError, InvalidAgentIdError) — error class pattern + envelope mapping to mirror for AllowlistViolationError, CloudNotAllowedError, InvalidScopedIdError
- `router/src/config/registry.ts` (ModelEntrySchema, RegistrySchema, BackendsSection) — Zod schema extension target; `superRefine` pattern for cross-field invariants
- `router/src/metrics/registry.ts` — current labelNames discipline (T-5-11 forbidden-label gate); CI script asserts this stays clean
- `router/src/db/schema/request_log.ts` — column-add target; numeric() / text() patterns; `agent_id TEXT` precedent for tenant_id / project_id / workload_class
- `router/db/migrations/meta/_journal.json` — first task of the plan reads this to confirm next sequential idx is 5

### Operational + External
- `router/models.yaml` — current operator-facing shape; new `policies:` top-level + per-entry `policy:` block extend this file
- [Drizzle Kit migrations docs](https://orm.drizzle.team/kit-docs/commands) — migration generation + journal tuple discipline (project memory: `project_drizzle_migration_journal.md`)
- [Prometheus best practices: labels](https://prometheus.io/docs/practices/naming/#labels) — cardinality discipline source (referenced by P8-03)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`agentIdPreHandler` (`router/src/middleware/agentId.ts`):** single-responsibility preHandler that validates a regex, throws a typed error on shape violation, stamps `req.agentId`, and creates the **one and only** `req.log = req.log.child({...})` in production source. The new `scopedIdsPreHandler` will read `X-Tenant-ID`, `X-Project-ID`, `X-Workload-Class`, throw on invalid IDs, and stamp `req.tenantId`/`req.projectId`/`req.workloadClass`. The pino `.child()` call STAYS in `agentIdPreHandler`, reading all four IDs off `req` after both preHandlers have run (preserves Pitfall 9 grep gate).
- **`CapabilityNotSupportedError` + envelope handler (`router/src/errors/envelope.ts`):** the existing error-to-envelope mapping for capability gating is the template for `AllowlistViolationError` and `CloudNotAllowedError`. Reuse the OpenAI/Anthropic dual-envelope dispatch in `toOpenAIErrorEnvelope` / `toAnthropicErrorEnvelope`.
- **`ModelEntrySchema` (`router/src/config/registry.ts`):** Zod schema with `LocalBackendEnum`, capability arrays, optional fields, and a top-level `superRefine` for cross-field invariants. Extending it with `.policy: z.object({ cloud_allowed: z.boolean().default(true) }).optional()` follows the existing optional-field pattern with no `.passthrough()` (which would defeat the strict-schema discipline).
- **`RegistrySchema` (`router/src/config/registry.ts`):** already has a top-level `backends:` section alongside `models:`. Adding a top-level `policies:` section mirrors this pattern exactly — same shape, same `.optional()`, same hot-reload semantics.
- **`request_log` schema (`router/src/db/schema/request_log.ts`):** `agent_id: text('agent_id')` is the exact precedent for `tenant_id: text('tenant_id')`, `project_id: text('project_id')`, `workload_class: text('workload_class')`. All three are nullable, no defaults.
- **`bufferedWriter` (`router/src/db/bufferedWriter.ts`):** writes `request_log` rows. Already accepts a shape that will pick up new columns when the schema type widens. **No bufferedWriter API changes needed.**
- **`onSend` hook in `router/src/app.ts`:** currently reads `req.computedCostCents` to stamp `X-Cost-Cents`. Phase 14 may add `X-Tenant-ID` / `X-Project-ID` response header echo if operator UX wants it (Claude's discretion; not in the REQs).

### Established Patterns
- **Hook ordering:** `onRequest` (bearer auth) → body parsing + Zod validation → `preHandler` (agentId capture) → route body. Phase 14's `scopedIdsPreHandler` runs at the same `preHandler` slot as `agentIdPreHandler`. Order between them does not matter; they read disjoint headers.
- **Single `req.log = ` invariant (Pitfall 9 grep gate):** production source has exactly one `req.log = req.log.child(...)` line, in `agentIdPreHandler`. The new scopedIds preHandler MUST NOT add a second one. The plan must reassert this invariant in the threat register.
- **Capability gate position:** in every route, fires AFTER body validation + entry resolution, BEFORE breaker.check. Policy gate goes **at the same position, immediately after capability gate**.
- **Zod registry hot-reload:** `registry.ts` watches the file and reloads on change; cache (`registryCache.ts` + Valkey `model-registry:*`) is invalidated via the existing `reload()` path. New `policies:` section participates transparently.
- **Migration tuple:** every migration is SQL + schema + `_journal.json` entry — verified by project memory `project_drizzle_migration_journal.md`.
- **Error envelope dual-mapping:** all typed errors map to BOTH OpenAI shape and Anthropic shape via `toOpenAIErrorEnvelope` / `toAnthropicErrorEnvelope`. Phase 14's new error types follow this.

### Integration Points
- **`policies` field added to `RegistryStore` snapshot:** the snapshot returned by `registry.get()` gains a `policies: { default: { model_allowlist: string[] } }` field. The 5 routes call `applyPolicyGate(snapshot.policies, entry, body.model)`.
- **5 route files touched (additive, ~3 lines each):** `chat-completions.ts`, `messages.ts`, `embeddings.ts`, `rerank.ts`, `responses.ts`. Insert `applyPolicyGate(...)` right after the existing capability gate, before `await opts.breaker.check(entry.backend)`. No other route logic changes.
- **`app.ts` decorates the new preHandler:** `scopedIdsPreHandler` is registered via `app.addHook('preHandler', ...)` next to the existing agentId preHandler hook registration.
- **`bufferedWriter` consumer (`recordOutcome.ts`):** wherever it currently reads `req.agentId` to stamp `agent_id`, it adds reads for `req.tenantId`, `req.projectId`, `req.workloadClass` and stamps the new columns.
- **`models.yaml` shipped example:** the actual production file at `router/models.yaml` does NOT need policy fields added — defaults are "allow all" and "cloud_allowed: true". The plan ships an **example** policies block as a YAML comment in `models.yaml` so operators see the affordance.

</code_context>

<specifics>
## Specific Ideas

- **Policy config shape preview (locked from discussion):**
  ```yaml
  policies:
    default:
      model_allowlist: []          # empty = allow-all
  models:
    - name: chat-local
      # …
      policy:
        cloud_allowed: true
    - name: big-cloud
      backend: ollama-cloud
      policy:
        cloud_allowed: false
  ```
- **Gate code preview (locked from discussion):**
  ```ts
  // src/policy/gate.ts
  export function applyPolicyGate(
    policies: PoliciesConfig,
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
- **Shared ID validator preview (locked from discussion):**
  ```ts
  // src/middleware/scopedIds.ts
  const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
  function extractScopedId(req: FastifyRequest, header: string, label: string): string | undefined {
    const raw = req.headers[header];
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    if (!ID_RE.test(raw)) throw new InvalidScopedIdError(label, raw);
    return raw;
  }
  ```
- **Workload class extraction (locked from discussion):**
  ```ts
  const WC_RE = /^[A-Za-z0-9._-]{1,64}$/;
  const raw = req.headers['x-workload-class'];
  req.workloadClass = typeof raw === 'string' && WC_RE.test(raw) ? raw.toLowerCase() : undefined;
  // missing or invalid → undefined → NULL in request_log; never errors
  ```
- **Migration 0005 SQL (locked from discussion):**
  ```sql
  -- router/db/migrations/0005_request_log_scoped_ids.sql
  ALTER TABLE request_log ADD COLUMN tenant_id TEXT;
  ALTER TABLE request_log ADD COLUMN project_id TEXT;
  ALTER TABLE request_log ADD COLUMN workload_class TEXT;
  ```

</specifics>

<deferred>
## Deferred Ideas

- **Per-tenant model allowlists** — requires multi-bearer auth (multiple `X-API-Key`s or JWT-style claims) which Phase 14 does not introduce. Deferred to a future "Multi-Tenant Auth" milestone.
- **`X-Workload-Class`-driven routing** (e.g., `sensitive` → force local-only) — explicit Frame-04 violation if shipped without an explicit per-class policy block. Deferred until per-class policy is desired; for now, the header is logged-only.
- **Dedicated `policy_violation_total{code}` Prometheus counter** — existing `router_request_total{status_class="client_error"}` already labels the 403; a dedicated counter is a Phase 19 / observability-hardening candidate, not a Phase 14 requirement.
- **Per-entry `policy.caller_allowlist: [agent_ids]`** — the "per-entry allowlist with caller-ID semantics" interpretation considered during discussion. Not chosen for Phase 14 (top-level `model_allowlist` was chosen instead). Recorded here so future per-tenant work can revisit.
- **Live `/metrics` cardinality parse** — Phase 19 covers this. Phase 14 ships only the static-grep CI check.
- **`X-Tenant-ID` / `X-Project-ID` response header echo** — would mirror the existing `X-Cost-Cents` onSend pattern; Claude's discretion to include if operator UX wants it during implementation, otherwise defer.
- **Index on `(tenant_id, ts DESC)` covering index in `request_log`** — deferred until operator query patterns demonstrate need. Existing indexes suffice for early v0.11.0.

</deferred>

---

*Phase: 14-policy-primitives-tenant-project-id-foundation*
*Context gathered: 2026-05-29*
