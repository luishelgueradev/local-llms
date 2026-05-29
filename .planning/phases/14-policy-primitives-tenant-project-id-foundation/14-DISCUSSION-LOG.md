# Phase 14: Policy Primitives + Tenant/Project ID Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-29
**Phase:** 14-policy-primitives-tenant-project-id-foundation
**Areas discussed:** Policy config shape in models.yaml, X-Workload-Class accepted values, X-Tenant-ID/X-Project-ID validation regex, Policy gate code placement

---

## Policy Config Shape (`models.yaml`)

| Option | Description | Selected |
|--------|-------------|----------|
| Per-entry nested `policy:` block | Matches SUMMARY phrasing ('policy.cloud_allowed'); groups all policy fields under one key per model; cleanest for future per-model policy growth. | ✓ (initial pick) |
| Per-entry flat fields | Matches POL-01/POL-02 literal wording ('model_allowlist: []' directly on entry); minimal schema delta; risks namespace clutter as policy grows. | |
| Top-level `policies.default` | Matches SUMMARY's later phrasing; ONE global allowlist applied to all requests; simplest semantics; no per-model granularity. | |
| Per-entry nested + top-level fallback | Hybrid: top-level policies.default sets baseline; per-entry policy block overrides. More flexible but two-layer precedence is more to document and test. | |

**User's choice:** Per-entry nested `policy:` block.

**Follow-up question — what does `model_allowlist` actually mean?**

POL-01 says "per registry entry" but also says the 403 fires "BEFORE backend resolution". These are mutually inconsistent: per-entry checks require the entry to be resolved.

| Option | Description | Selected |
|--------|-------------|----------|
| Top-level `policies.default.model_allowlist` | Single global list of model display names callers may request. Fires BEFORE backend resolution (literal POL-01 semantics). `policy:` block per-entry holds only `cloud_allowed`. RECOMMENDED — honors 'BEFORE resolution' constraint. | ✓ |
| Per-entry `caller_allowlist` (rename the field) | Keep allowlist per-entry but rename it to `caller_allowlist` / `tenant_allowlist`. Different semantics; fires AFTER resolution so the 'BEFORE resolution' constraint must be relaxed. | |
| Ship `cloud_allowed` only; defer `model_allowlist` | Phase 14 ships only per-entry `cloud_allowed` (well-defined). Drop POL-01 to a later phase when multi-tenant ID semantics + per-bearer policy land. REQ count shrinks 6→5 for Phase 14; v0.11.0 milestone still ships. | |

**User's choice:** Top-level `policies.default.model_allowlist` + per-entry `policy.cloud_allowed`.

**Notes:** Locked the hybrid shape: top-level `policies:` section for the global allowlist (matches "BEFORE resolution"), per-entry `policy:` block for `cloud_allowed` (per-entry semantics are well-defined). POL-01 wording in REQUIREMENTS.md will be patched by the phase plan to reflect this (D-03).

---

## X-Workload-Class Accepted Values

| Option | Description | Selected |
|--------|-------------|----------|
| Open string, length-capped opaque | Accept any non-empty string up to 64 chars matching `/^[a-z0-9_-]{1,64}$/i`. Logged + persisted as-is. Maximally honors POL-03 'opaque metadata' — zero coupling to a future taxonomy. RECOMMENDED. | ✓ |
| Fixed enum: only 'sensitive' accepted | Reject any other value with 400 (`invalid_workload_class`). Locks the taxonomy now. Risk: any future class ships as a breaking change to operator clients. | |
| Fixed enum, silent NULL on unknown | Accept only 'sensitive' (lowercased). Anything else — including typos like 'Sensitive' — is silently dropped to NULL. Hides bugs in caller code; debugging-hostile. | |

**User's choice:** Open string, length-capped opaque, lowercase-normalized.

**Notes:** Invalid values (failing regex) silently NULL — they do NOT 400. Rationale: POL-03 explicitly says opaque metadata; coupling caller deployments to the router's regex is the wrong place to draw the strictness line. Diverges from tenant/project ID validation (which DOES 400) because workload class is a tag, not a load-bearing identifier.

---

## X-Tenant-ID / X-Project-ID Validation Regex

| Option | Description | Selected |
|--------|-------------|----------|
| Mirror X-Agent-Id exactly | Reuse `/^[A-Za-z0-9._:-]{1,128}$/` for tenant + project (and add it to agent's existing rule). Three IDs share one validator, one error type, one regex — minimum code surface, ReDoS-analyzed already. RECOMMENDED. | ✓ |
| Stricter: lowercase + 64 chars | `/^[a-z0-9._-]{1,64}$/` (no colons, no uppercase). Locks naming discipline for tenants that will live in Cloudflare hostnames / Postgres role names. Diverges from X-Agent-Id; future case-mismatch traps. | |
| Mirror X-Agent-Id but case-normalize on read | Same regex, but normalize tenant/project to lowercase before stamping (X-Agent-Id stays case-preserving for back-compat). Best of both: lenient input, normalized storage. | |

**User's choice:** Mirror X-Agent-Id exactly. Shared `ID_RE` constant, shared `InvalidScopedIdError`, shared regex.

---

## Policy Gate Code Placement

| Option | Description | Selected |
|--------|-------------|----------|
| Shared `applyPolicyGate(entry, body)` helper | One function in `src/policy/gate.ts`; each route imports + calls it at the exact same code position (right after capability gate, before `breaker.check`). Throws `AllowlistViolationError` / `CloudNotAllowedError` mapped via envelope.ts. RECOMMENDED — single source of truth, no drift risk. | ✓ |
| Inline gate in each of 5 routes | Copy the same ~8 lines of allowlist + cloud_allowed check into each route. No new module. Risk: 5 places to keep in sync; drift goes uncaught until production. Rejected pattern in v0.9.0 for capability gate — same reason here. | |
| Fastify preHandler at app level | Register one preHandler hook that runs after Zod validation + entry resolution. Cleaner separation but needs entry to be stored on `req` (similar to `req.resolvedBackend`). More plumbing for ambiguous gain. | |

**User's choice:** Shared `applyPolicyGate()` helper.

**Notes:** Mirrors existing capability-gate envelope-mapping discipline. The helper throws typed errors; the centralized envelope handler maps to the structured 403 + OpenAI/Anthropic dual envelope.

---

## Claude's Discretion

- **CI test failure messages** (D-26): exact wording is implementation choice.
- **Test script split**: whether the new cardinality CI script lives in the existing `test:` npm script or a separate `test:cardinality` script — implementation choice based on existing `router/package.json` structure.
- **File split between `gate.ts` and `types.ts`**: one file vs two — implementation detail.
- **Pino structured-log field names**: locked to `tenant_id` / `project_id` / `workload_class` (snake_case to match column names + existing `agent_id` field) — not discretionary.
- **`onSend` response header echo of `X-Tenant-ID` / `X-Project-ID`**: not required by POL-04; Claude may include for operator UX consistency with `X-Cost-Cents`.

---

## Deferred Ideas

- Per-tenant model allowlists (multi-bearer auth not yet introduced).
- `X-Workload-Class`-driven routing (would violate Frame-04 without an explicit per-class policy block).
- Dedicated `policy_violation_total{code}` Prometheus counter (Phase 19 candidate).
- Per-entry `policy.caller_allowlist: [agent_ids]` (alternative semantics considered but not chosen).
- Live `/metrics` cardinality parse (Phase 19 covers this; Phase 14 ships static-grep only).
- `X-Tenant-ID` / `X-Project-ID` response header echo (Claude's discretion at implementation time).
- Index on `(tenant_id, ts DESC)` for `request_log` (defer until query patterns demand it).
