---
phase: 14
slug: policy-primitives-tenant-project-id-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-30
---

# Phase 14 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.x (existing in `router/package.json`) |
| **Config file** | `router/vitest.config.ts` |
| **Quick run command** | `cd router && pnpm vitest run --reporter=dot` |
| **Full suite command** | `cd router && pnpm vitest run` |
| **Estimated runtime** | ~25 seconds (per existing v0.10.0 suite baseline) |

---

## Sampling Rate

- **After every task commit:** Run `cd router && pnpm vitest run --reporter=dot`
- **After every plan wave:** Run `cd router && pnpm vitest run` (full suite — guards Pitfall-9 grep gate + cardinality CI check)
- **Before `/gsd:verify-work`:** Full suite must be green AND `pnpm typecheck` must pass
- **Max feedback latency:** ~30 seconds per task; ~60 seconds per wave

---

## Per-Task Verification Map

> Final map is filled in during planning. The planner will populate one row per task across all PLAN.md files for Phase 14, mapping `(task_id → req_id → automated command)`.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 14-01-01 | 01 | 1 | POL-04 (request_log columns) | — | Migration tuple atomic: `_journal.json` + SQL + Drizzle schema land together; migrator does NOT silently skip 0005 | unit | `cd router && pnpm vitest run src/db/__tests__/migration0005.test.ts` | ❌ W0 | ⬜ pending |
| 14-02-01 | 02 | 1 | POL-01 (allowlist), POL-02 (cloud_allowed) | — | Zod schema accepts the new `policies.default.model_allowlist` and per-entry `policy.cloud_allowed` with proper defaults | unit | `cd router && pnpm vitest run src/config/__tests__/registry.policies.test.ts` | ❌ W0 | ⬜ pending |
| 14-03-01 | 03 | 1 | POL-01, POL-02 | T-14-01 (allowlist bypass), T-14-02 (cloud bypass) | New error classes throw with correct envelope shape (OpenAI + Anthropic) | unit | `cd router && pnpm vitest run src/errors/__tests__/policy-envelopes.test.ts` | ❌ W0 | ⬜ pending |
| 14-04-01 | 04 | 2 | POL-01, POL-02 | T-14-01, T-14-02 | `applyPolicyGate()` throws AllowlistViolationError / CloudNotAllowedError at correct preconditions; allow-all default holds | unit | `cd router && pnpm vitest run src/policy/__tests__/gate.test.ts` | ❌ W0 | ⬜ pending |
| 14-05-01 | 05 | 2 | POL-01, POL-02 | T-14-01, T-14-02, T-14-03 (gate-position) | All 5 routes wire `applyPolicyGate()` at the canonical position (after capability gate, before `breaker.check`); 403 fires before breaker counter mutation | integration | `cd router && pnpm vitest run src/routes/__tests__/policy-gate-integration.test.ts` | ❌ W0 | ⬜ pending |
| 14-06-01 | 06 | 2 | POL-03 (workload class), POL-05 (tenant/project IDs) | T-14-04 (ID validation) | `scopedIdsPreHandler` stamps `req.tenantId`/`req.projectId`/`req.workloadClass`; invalid tenant/project → 400; invalid workload class → silent NULL | unit | `cd router && pnpm vitest run src/middleware/__tests__/scopedIds.test.ts` | ❌ W0 | ⬜ pending |
| 14-06-02 | 06 | 2 | POL-03, POL-05 | T-14-05 (Pitfall-9 invariant) | Pitfall-9 grep gate: exactly one `req.log = req.log.child(...)` assignment in `router/src/` | unit | `cd router && pnpm vitest run src/middleware/__tests__/single-req-log.test.ts` | ❌ W0 | ⬜ pending |
| 14-07-01 | 07 | 3 | POL-04 (DB columns populated) | — | Integration: caller sending `X-Tenant-ID: acme` + `X-Project-ID: agents` sees both values land in the Postgres `request_log` row | integration | `cd router && pnpm vitest run src/routes/__tests__/scopedIds-request-log.test.ts` | ❌ W0 | ⬜ pending |
| 14-08-01 | 08 | 3 | POL-06 (Prometheus cardinality) | T-14-06 (cardinality regression) | New CI script greps `src/metrics/registry.ts` for `labelNames:` arrays and asserts no element matches `/_id$/` | unit | `cd router && pnpm vitest run scripts/__tests__/check-prometheus-cardinality.test.ts` | ❌ W0 | ⬜ pending |
| 14-09-01 | 09 | 3 | All POL-01..POL-06 | — | Existing smoke suite passes unchanged with policy defaults (allow-all + cloud_allowed=true) | smoke | `cd router && pnpm vitest run` | ✅ | ⬜ pending |

> Plan IDs (01..09) reflect the recommended ordering in RESEARCH.md §9. The planner may rename/renumber; the gate is that every Phase 14 task slots into this table with an automated command and ✅ / ❌ W0 status.

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Wave 0 = test stubs created before any production-source task starts execution. For Phase 14, Wave 0 is contained in **the same plan that creates each piece of test infrastructure** (each plan's first task is the `describe.skip` stub; subsequent tasks `.skip`-flip as they land).

- [ ] `router/src/db/__tests__/migration0005.test.ts` — stub for POL-04 (migration tuple integrity)
- [ ] `router/src/config/__tests__/registry.policies.test.ts` — stub for POL-01/POL-02 (Zod schema for `policies` + per-entry `policy`)
- [ ] `router/src/errors/__tests__/policy-envelopes.test.ts` — stub for POL-01/POL-02 (envelope dual-mapping)
- [ ] `router/src/policy/__tests__/gate.test.ts` — stub for POL-01/POL-02 (`applyPolicyGate()` unit)
- [ ] `router/src/routes/__tests__/policy-gate-integration.test.ts` — stub for POL-01/POL-02 (route-level gate position)
- [ ] `router/src/middleware/__tests__/scopedIds.test.ts` — stub for POL-03/POL-05 (preHandler unit)
- [ ] `router/src/middleware/__tests__/single-req-log.test.ts` — stub for POL-05 (Pitfall-9 grep gate)
- [ ] `router/src/routes/__tests__/scopedIds-request-log.test.ts` — stub for POL-04 (DB column population)
- [ ] `router/scripts/__tests__/check-prometheus-cardinality.test.ts` — stub for POL-06 (cardinality CI)

vitest is already installed (`router/package.json` v0.10.0 baseline). No framework install required.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Hot-reload of `policies:` block in `models.yaml` re-evaluates the gate on the very next request | POL-01 implicit | Requires editing the live `models.yaml` + Valkey cache DEL + `docker compose up -d --force-recreate router` (see project memory `project_models_yaml_hot_edit.md`); cannot run inside vitest harness | 1) Add `policies.default.model_allowlist: ["chat-local"]` to `router/models.yaml` 2) `docker compose exec valkey valkey-cli DEL 'model-registry:*'` 3) `docker compose up -d --force-recreate router` 4) Request a non-allowlisted model → 403 5) Revert YAML, repeat steps 2–3 → 200 |
| Operator-facing `models.yaml` example block is human-readable | POL-01 / POL-02 ergonomics | Reads as YAML comments; the value is operator UX, not behavior | Open `router/models.yaml`; confirm a commented `# policies:` example block exists near the top with at least one entry showing `policy.cloud_allowed: false` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags (vitest commands all use `vitest run`, never `vitest` alone)
- [ ] Feedback latency < 30s per task / 60s per wave
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
