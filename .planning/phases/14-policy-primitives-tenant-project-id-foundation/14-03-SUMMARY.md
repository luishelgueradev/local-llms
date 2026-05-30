---
phase: 14-policy-primitives-tenant-project-id-foundation
plan: "03"
subsystem: errors
tags:
  - errors
  - envelope
  - openai
  - anthropic
  - policy
dependency_graph:
  requires:
    - router/src/errors/envelope.ts (existing)
  provides:
    - AllowlistViolationError (403 + policy_violation on both surfaces)
    - CloudNotAllowedError (403 + policy_violation on both surfaces)
    - InvalidScopedIdError (400 + invalid_request_error on both surfaces)
  affects:
    - Plan 14-04 (applyPolicyGate — throws AllowlistViolationError/CloudNotAllowedError)
    - Plan 14-06 (scopedIdsPreHandler — throws InvalidScopedIdError)
tech_stack:
  added: []
  patterns:
    - error-class-triple (class + mapToHttpStatus + OpenAI envelope + Anthropic envelope)
    - truncation-defense (32-char display cap for attacker-controlled header values)
key_files:
  created:
    - router/src/errors/__tests__/policy-envelopes.test.ts
  modified:
    - router/src/errors/envelope.ts
decisions:
  - "D-10 — AllowlistViolationError/CloudNotAllowedError: OpenAI type=policy_violation (new wire-level type); Anthropic type=permission_error"
  - "D-16 — InvalidScopedIdError: mirrors InvalidAgentIdError 32-char truncation defense; OpenAI param=err.headerLabel"
  - "T-14-04 mitigation — suppliedValue truncated to 32 chars before embedding in message"
metrics:
  duration: "8m"
  completed: "2026-05-30T12:03:08Z"
  tasks: 1
  files: 2
---

# Phase 14 Plan 03: Policy Error Envelope Dual-Mapping Summary

Three new typed error classes (`AllowlistViolationError`, `CloudNotAllowedError`, `InvalidScopedIdError`) wired into the centralized `mapToHttpStatus` + `toOpenAIErrorEnvelope` + `toAnthropicErrorEnvelope` dispatch in `envelope.ts`, with 13 unit tests covering every mapping path.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Failing tests for policy error envelope mappings | ea2e3b2 | router/src/errors/__tests__/policy-envelopes.test.ts |
| 1 (GREEN) | 3 error classes + 9 mapping branches + 13 tests green | 188830e | router/src/errors/envelope.ts |

## Implementation Details

### Error Classes Added (router/src/errors/envelope.ts)

**`AllowlistViolationError`** — line 298 (after `InvalidAgentIdError` at line 278):
- `readonly code = 'model_not_in_allowlist'`
- Constructor: `(modelName: string)` — message names the model and the config location (`policies.default.model_allowlist` in `models.yaml`)
- Maps to: 403 + `{ type: 'policy_violation', code: 'model_not_in_allowlist', param: 'model' }` (OpenAI) + `{ type: 'permission_error' }` (Anthropic)

**`CloudNotAllowedError`** — line 314:
- `readonly code = 'cloud_not_allowed'`
- Constructor: `(modelName: string)` — message names the model and explains `policy.cloud_allowed=false`
- Maps to: 403 + `{ type: 'policy_violation', code: 'cloud_not_allowed', param: 'model' }` (OpenAI) + `{ type: 'permission_error' }` (Anthropic)

**`InvalidScopedIdError`** — line 336:
- `readonly code: 'invalid_scoped_id' = 'invalid_scoped_id'`
- Constructor: `(headerLabel: string, suppliedValue: string)` — truncates `suppliedValue` to 32 chars + `"..."` before embedding in message (T-14-04 log-injection defense mirrors `InvalidAgentIdError`)
- Maps to: 400 + `{ type: 'invalid_request_error', code: 'invalid_scoped_id', param: err.headerLabel }` (OpenAI) + `{ type: 'invalid_request_error' }` (Anthropic)

### 9 Mapping Insertions

**`mapToHttpStatus`** (after `InvalidAgentIdError` branch at line 391):
```
if (err instanceof AllowlistViolationError) return 403;
if (err instanceof CloudNotAllowedError) return 403;
if (err instanceof InvalidScopedIdError) return 400;
```

**`toOpenAIErrorEnvelope`** (after `InvalidAgentIdError` block):
- `AllowlistViolationError` → `{ error: { type: 'policy_violation', code: 'model_not_in_allowlist', param: 'model' } }`
- `CloudNotAllowedError` → `{ error: { type: 'policy_violation', code: 'cloud_not_allowed', param: 'model' } }`
- `InvalidScopedIdError` → `{ error: { type: 'invalid_request_error', code: 'invalid_scoped_id', param: err.headerLabel } }`

**`toAnthropicErrorEnvelope`** (after `InvalidAgentIdError` block):
- `AllowlistViolationError` → `{ type: 'error', error: { type: 'permission_error' } }`
- `CloudNotAllowedError` → `{ type: 'error', error: { type: 'permission_error' } }`
- `InvalidScopedIdError` → `{ type: 'error', error: { type: 'invalid_request_error' } }`

### Test Results

vitest: 13 passed / 13 total in `router/src/errors/__tests__/policy-envelopes.test.ts`

### Grep Gate Results

All 11 acceptance criteria gates pass:
- `grep -c "export class AllowlistViolationError" envelope.ts` → 1
- `grep -c "export class CloudNotAllowedError" envelope.ts` → 1
- `grep -c "export class InvalidScopedIdError" envelope.ts` → 1
- `grep -c "readonly code = 'model_not_in_allowlist'" envelope.ts` → 1
- `grep -c "readonly code = 'cloud_not_allowed'" envelope.ts` → 1
- `grep -c "invalid_scoped_id" envelope.ts` → 2
- `grep -c "instanceof AllowlistViolationError" envelope.ts` → 3
- `grep -c "instanceof CloudNotAllowedError" envelope.ts` → 3
- `grep -c "instanceof InvalidScopedIdError" envelope.ts` → 3
- `grep -c "type: 'policy_violation'" envelope.ts` → 2
- `grep -c "type: 'permission_error'" envelope.ts` → 2

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written. TDD RED/GREEN cycle followed.

### Out-of-Scope TypeScript Errors (Not Fixed)

`router/src/config/__tests__/registry.policies.test.ts` has 9 TS2339 errors (`'policies' does not exist on type...`, `'policy' does not exist on type...`). These are from plan 14-02's RED phase (failing tests added by the parallel wave agent before the Zod schema extension is implemented in the GREEN phase). These errors are NOT caused by this plan's changes — `envelope.ts` and `policy-envelopes.test.ts` have zero TypeScript errors.

## Known Stubs

None. This plan adds pure error-class and mapper logic with no data flows that could produce empty UI or placeholder output.

## Threat Flags

No new network endpoints, auth paths, file access patterns, or schema changes beyond what is modeled in the plan's `<threat_model>`.

## Self-Check: PASSED

- `router/src/errors/envelope.ts` exists with 808 lines (original 692 + 116 additions)
- `router/src/errors/__tests__/policy-envelopes.test.ts` exists (148 lines)
- RED commit ea2e3b2 exists in git log
- GREEN commit 188830e exists in git log
- 13 tests pass
- All 11 grep gates pass
