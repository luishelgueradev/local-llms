---
phase: 14-policy-primitives-tenant-project-id-foundation
reviewed: 2026-05-30T00:00:00Z
depth: standard
files_reviewed: 27
files_reviewed_list:
  - router/db/migrations/0005_request_log_scoped_ids.sql
  - router/db/migrations/meta/_journal.json
  - router/models.yaml
  - router/scripts/__tests__/check-prometheus-cardinality.test.ts
  - router/scripts/check-prometheus-cardinality.ts
  - router/src/app.ts
  - router/src/config/registry.ts
  - router/src/db/schema/request_log.ts
  - router/src/errors/__tests__/policy-envelopes.test.ts
  - router/src/errors/envelope.ts
  - router/src/metrics/recordOutcome.ts
  - router/src/metrics/registry.ts
  - router/src/middleware/__tests__/scopedIds.test.ts
  - router/src/middleware/__tests__/single-req-log.test.ts
  - router/src/middleware/agentId.ts
  - router/src/middleware/scopedIds.ts
  - router/src/policy/__tests__/gate.test.ts
  - router/src/policy/gate.ts
  - router/src/routes/__tests__/policy-gate-integration.test.ts
  - router/src/routes/__tests__/scopedIds-request-log.test.ts
  - router/src/routes/v1/chat-completions.ts
  - router/src/routes/v1/embeddings.ts
  - router/src/routes/v1/messages.ts
  - router/src/routes/v1/rerank.ts
  - router/src/routes/v1/responses.ts
  - router/tests/migration0005.test.ts
  - router/vitest.config.ts
findings:
  critical: 1
  warning: 5
  info: 3
  total: 9
status: issues_found
---

# Phase 14: Code Review Report

**Reviewed:** 2026-05-30T00:00:00Z
**Depth:** standard
**Files Reviewed:** 27
**Status:** issues_found

## Summary

Phase 14 introduces two policy primitives (model allowlist, cloud-not-allowed) and three scoped-ID headers (X-Tenant-ID, X-Project-ID, X-Workload-Class) that flow into `request_log` and pino log context. The structural work — `policy/gate.ts`, `middleware/scopedIds.ts`, migration 0005 atomic-tuple, the Pitfall-9 grep gate, and the Prometheus cardinality static-grep — is competent and well-tested. The dual-surface envelope mapping (OpenAI `policy_violation` and Anthropic `permission_error`) is correctly wired across all five routes, and the per-route `applyPolicyGate` placement (post-capability, pre-breaker) matches the P8-01 BLOCK contract verified by integration test 2.

That said, this PR has one **BLOCKER** and several **WARNINGS** that should not ship:

- The combined hook ordering creates a real observability regression: when `X-Agent-Id` is absent (the common case in v0.11.0 — most agents have not been retrofitted), `agentIdPreHandler` returns BEFORE the `req.log = req.log.child({ tenant_id, project_id, workload_class })` enrichment runs. Result: pino lines for the vast majority of requests carry NONE of the scoped-ID fields the D-20 contract promises. The Pitfall-9 invariant and Test 6 mask this because they exercise the all-headers-present path.
- The scoped-ID preHandler runs on `PUBLIC_PATHS` (`/healthz`, `/readyz`, `/metrics`); a malformed `X-Tenant-ID` header on `/metrics` would 400 the scrape rather than fall through.
- `InvalidScopedIdError` does not scrub control characters from the supplied value before stamping it into the error `.message`, even though `InvalidIdempotencyKeyError` (a sibling class in the same file) does scrub.
- The `responses.ts` 'chat' capability-gate uses an `as never` cast that bypasses the union type on `CapabilityNotSupportedError.missingCapability` (pre-existing, but now actively exercised after the Phase 14 policy gate wiring runs through the same throw site).

Phase-14-specific test coverage is good for the happy paths but does NOT exercise the no-X-Agent-Id observability path (the silent regression) nor the public-path scoped-ID interaction.

## Structural Findings (fallow)

No structural findings block was provided. This section is intentionally empty.

## Critical Issues

### CR-01: Scoped-ID pino enrichment never fires when X-Agent-Id is absent

**File:** `router/src/middleware/agentId.ts:84-87, 112-117`
**Issue:**
`scopedIdsPreHandler` stamps `req.tenantId / req.projectId / req.workloadClass` correctly, then `agentIdPreHandler` is supposed to enrich the pino child with all four IDs in a single assignment (D-20 / Pitfall-9). But `agentIdPreHandler` short-circuits at line 86–87 when `req.headers['x-agent-id']` is undefined:

```ts
const raw = req.headers['x-agent-id'];
if (raw === undefined) {
  // D-D5: absent → agentId stays undefined → request_log.agent_id NULL.
  return;       // <-- returns BEFORE the req.log = req.log.child({...}) call
}
...
req.log = req.log.child({
  agent_id: value,
  tenant_id: req.tenantId,
  project_id: req.projectId,
  workload_class: req.workloadClass,
});
```

Consequence: for any request that sets `X-Tenant-ID`/`X-Project-ID`/`X-Workload-Class` but NOT `X-Agent-Id`, the subsequent `req.log.*` lines (route handler logs, error handler logs, etc.) carry NONE of the scoped-ID bindings. The `request_log` row is correctly populated by the route's `safeRecord` (which reads `req.tenantId` directly, not via pino bindings) — so the DB side is fine — but the pino-side observability invariant D-20 promises is silently violated for the common case.

The integration test `scopedIds.test.ts` Test 6 happens to inject `x-agent-id: 'test-agent'` alongside the other headers, so the pino-enrichment path runs only in that scenario. Drop the `x-agent-id` header from that test and the assertion `combined.toContain('"tenant_id":"acme"')` would fail.

**Fix:** Always run the `req.log = req.log.child({...})` enrichment when ANY of the four IDs is non-undefined; only `agent_id` should be gated on the X-Agent-Id presence. Two equivalent shapes:

```ts
// Option A — keep agentId short-circuit, but unconditionally enrich for scoped IDs.
const value = raw === undefined ? undefined : (Array.isArray(raw) ? raw[0] : raw);
if (value !== undefined) {
  if (typeof value !== 'string' || !AGENT_ID_RE.test(value)) {
    throw new InvalidAgentIdError(typeof value === 'string' ? value : '');
  }
  req.agentId = value;
}
// Enrich the child with every defined ID — undefined-valued keys are silently
// dropped by pino's .child() (Assumption A2 stays intact).
if (req.agentId !== undefined ||
    req.tenantId !== undefined ||
    req.projectId !== undefined ||
    req.workloadClass !== undefined) {
  req.log = req.log.child({
    agent_id: req.agentId,
    tenant_id: req.tenantId,
    project_id: req.projectId,
    workload_class: req.workloadClass,
  });
}
```

Add a regression test in `scopedIds.test.ts`: re-run Test 6 with `x-agent-id` removed and assert `tenant_id` / `project_id` / `workload_class` still appear in the captured log line.

## Warnings

### WR-01: `scopedIdsPreHandler` runs on `/healthz`, `/readyz`, `/metrics` — bad headers can 400 these paths

**File:** `router/src/app.ts:303` and `router/src/middleware/scopedIds.ts:84-88`
**Issue:**
`scopedIdsPreHandler` is registered as a global `preHandler` hook. Bearer auth (`makeBearerHook`) explicitly skips `PUBLIC_PATHS = {'/healthz', '/readyz', '/metrics'}` (`auth/bearer.ts:25,36`) but the scoped-ID hook has no equivalent skip. Result:

1. Wasted CPU parsing absent headers on every healthz/readyz scrape (3+/sec under typical Prometheus scrape).
2. A misbehaving scraper or external probe that sets `X-Tenant-ID: bad/value` will receive **HTTP 400 `invalid_scoped_id`** from `/healthz`, breaking the readiness contract.
3. Same exposure on `/metrics` — a scraper that injects (or proxy adds) a malformed scoped-ID header silently fails the Prometheus scrape with a 400 instead of returning metrics.

Practically Prometheus and Docker healthchecks don't set these headers today, but the asymmetry (`makeBearerHook` skips, `scopedIdsPreHandler` does not) is a real future-foot-gun, and the integration test surface does not cover it.

**Fix:** Mirror the bearer-hook skip pattern. Either import `PUBLIC_PATHS` and short-circuit, or move both `agentIdPreHandler` and `scopedIdsPreHandler` to route-scoped hooks on the recorded route allowlist. The smaller change:

```ts
// router/src/middleware/scopedIds.ts
import { PUBLIC_PATHS } from '../auth/bearer.js';

export async function scopedIdsPreHandler(req, _reply): Promise<void> {
  const path = req.url.split('?')[0] ?? '';
  if (PUBLIC_PATHS.has(path)) return;
  // ...existing body...
}
```

Same fix in `agentId.ts` (the existing implementation has the same gap — it just happens to be silent there because agents don't typically set `X-Agent-Id` against `/metrics`).

### WR-02: `InvalidScopedIdError` message does not scrub control characters — log/audit poisoning vector

**File:** `router/src/errors/envelope.ts:337-352`
**Issue:**
`InvalidScopedIdError` truncates `suppliedValue` to 32 chars but interpolates it raw into the error message:

```ts
const display =
  typeof suppliedValue === 'string' && suppliedValue.length > 32
    ? `${suppliedValue.slice(0, 32)}...`
    : String(suppliedValue ?? '');
super(`${headerLabel} "${display}" violates regex /^[A-Za-z0-9._:-]{1,128}$/`);
```

A sibling class in the same file, `InvalidIdempotencyKeyError` (line 243-266), was hardened in 08-REVIEW WR-01 with a scrub:

```ts
const sanitized = raw.replace(/[^A-Za-z0-9._:,\-]/g, '?');
const display = sanitized.length > 32 ? `${sanitized.slice(0, 32)}...` : sanitized;
```

The Phase 14 file-header docstring on `InvalidScopedIdError` claims it "mirrors InvalidAgentIdError pattern" — which is true, but that means `InvalidScopedIdError` inherits the same un-scrubbed weakness `InvalidIdempotencyKeyError` was explicitly hardened against.

The error message lands in:
- The HTTP response body (JSON-encoded → newlines escape OK at wire level).
- `req.log.warn({ err, url, status }, ...)` in `app.setErrorHandler` — pino JSON-serializes so structured-log injection is OK there.
- The `request_log.error_message` column via `truncateAndRedact` (`recordOutcome.ts:269-270`) — and `truncateAndRedact` only filters `Bearer/Authorization/api_key` patterns, **NOT** control characters. So an attacker-supplied `X-Tenant-ID: \r\n[FAKE LOG ENTRY]` puts CR/LF/ESC bytes into a Postgres `text` column read by `psql`, `tail -f` of an export, ops dashboards, etc.

The `policy-envelopes.test.ts` Test 4 only tests truncation of repeated `'a'` characters — never asserts control-byte removal.

The vitest test at `policy-envelopes.test.ts:54-60` (truncation) should be widened to assert control-byte scrubbing in the same shape `InvalidIdempotencyKeyError` does it.

**Fix:** Apply the same scrub as `InvalidIdempotencyKeyError`:

```ts
constructor(
  public readonly headerLabel: string,
  public readonly suppliedValue: string,
) {
  const raw = String(suppliedValue ?? '');
  const sanitized = raw.replace(/[^A-Za-z0-9._:\-]/g, '?');
  const display = sanitized.length > 32 ? `${sanitized.slice(0, 32)}...` : sanitized;
  super(`${headerLabel} "${display}" violates regex /^[A-Za-z0-9._:-]{1,128}$/`);
  this.name = 'InvalidScopedIdError';
}
```

Add an assertion to `policy-envelopes.test.ts` Test 4: `expect(err.message).not.toMatch(/[\r\n\t\x00-\x1f]/)`. Apply the same hardening to `InvalidAgentIdError` (envelope.ts:278-290) while you're here — that class has the same gap and `InvalidIdempotencyKeyError` was explicitly fixed against it in 08-REVIEW.

### WR-03: `responses.ts` capability gate throws `'chat' as never` — type-unsafe and out-of-taxonomy

**File:** `router/src/routes/v1/responses.ts:361-363`
**Issue:**
```ts
if (!entry.capabilities.includes('chat')) {
  throw new CapabilityNotSupportedError(entry.name, 'chat' as never);
}
```

`CapabilityNotSupportedError.missingCapability` is typed as `'vision' | 'tools' | 'embeddings' | 'json_mode' | 'rerank'` (`envelope.ts:61`). `'chat'` is NOT in that union. The `as never` cast silences the type checker, but at runtime the thrown error carries an out-of-taxonomy capability name, and `mapErrorToCode(err)` will collapse it to `'model_capability_mismatch'` correctly only because the type discriminator isn't read in `mapErrorToCode` (line 168). The user-facing error message generated by the constructor will read `Model "X" does not support capability "chat". Pick a model with "chat" in its capabilities list.` — which is technically correct but only because the constructor concatenates the string raw.

The `as never` cast is the bigger smell: a future refactor that switches the constructor to enum-validation would let this throw site silently break. The CapabilityNotSupportedError class is also re-throwable on /v1/responses for non-chat models because Phase 14 newly wired policy-gate just upstream — meaning this throw site is now actively exercised by integration tests in this phase.

This pre-dates Phase 14 (Phase 13 introduced it) but it's in the review scope and the cast hides a real type-safety regression vector.

**Fix:** Widen `CapabilityNotSupportedError.missingCapability` to include `'chat'`, OR (cleaner) define a `'chat'` literal as the missing capability and drop the cast:

```ts
// envelope.ts:61 — widen the union
missingCapability: 'vision' | 'tools' | 'embeddings' | 'json_mode' | 'rerank' | 'chat',
```

Then in responses.ts drop the cast:

```ts
throw new CapabilityNotSupportedError(entry.name, 'chat');
```

### WR-04: Empty header array yields generic "" in `InvalidScopedIdError` — surfaces as confusing 400

**File:** `router/src/middleware/scopedIds.ts:82-88`
**Issue:**
```ts
const value = Array.isArray(raw) ? raw[0] : raw;
if (typeof value !== 'string' || !ID_RE.test(value)) {
  throw new InvalidScopedIdError(headerLabel, typeof value === 'string' ? value : '');
}
```

When Fastify normalizes a duplicated header to `[]` (extreme edge case but possible with custom proxies), `raw[0]` is `undefined`, the typeof check fails, and the thrown error reports `X-Tenant-ID "" violates regex /^[A-Za-z0-9._:-]{1,128}$/`. The empty-quotes display is confusing to the operator chasing the issue — they will assume the client sent an empty string. The same idiom in `agentId.ts:92-98` has the identical weakness (and was not fixed in Phase 5).

Same minor concern: if `raw` is the literal empty string `''` (RFC-permitted), `value` is `''`, the regex fails, and the operator sees the same empty-quotes message — at least there the operator's hypothesis (empty header value) is correct.

This is not a security issue — it's a debug-experience tax that surfaces during operator support escalations.

**Fix:** Distinguish "no value" from "regex-fail" in the error message:

```ts
if (typeof value !== 'string') {
  throw new InvalidScopedIdError(headerLabel, '<missing or non-string header value>');
}
if (!ID_RE.test(value)) {
  throw new InvalidScopedIdError(headerLabel, value);
}
```

### WR-05: `models.yaml` claims hot-reload of `policies:` works, but Valkey snapshot invalidation is the only documented path

**File:** `router/models.yaml:46-58`
**Issue:**
The header comment block instructs operators to invalidate the Valkey snapshot AND force-recreate the router for ANY change. This is consistent with `project_models_yaml_hot_edit.md` memory. But four route files (`chat-completions.ts:225`, `messages.ts:228`, `embeddings.ts:236`, `rerank.ts:140`, `responses.ts:369`) all read `opts.registry.get().policies` inside the request handler — which means **on a successful `watchRegistry` swap, policy changes DO take effect without a restart** (the in-memory snapshot is replaced and the next request sees it).

The hot-edit memory says the Valkey path serves a cached snapshot; if that path is now bypassed for policies (which it appears to be in this code), the hot-reload story in the YAML header is more pessimistic than what the code actually does. Operators reading the YAML will believe they need the heavy `up -d --force-recreate` cycle even for a simple `model_allowlist` change.

This is also a regression test gap: there is no test that exercises the hot-reload path with a policies section toggled mid-run. `watchRegistry` is exercised in earlier phases, but Phase 14 should add a smoke test that:
1. Boots with empty allowlist.
2. Issues a request → 200.
3. Swaps in a non-empty allowlist via `store._swap`.
4. Issues a request for an unlisted model → 403.

Without this, a future refactor that moves `policies` parsing under a Valkey cache (e.g. for Phase 19 multi-instance) silently regresses hot-reload semantics for policy changes.

**Fix:** Either (a) update the `models.yaml` header to clarify "policies + per-entry policy blocks hot-reload via the file watcher; Valkey invalidation is only required when …(specific case)…", or (b) add an integration test in `tests/integration/policy-hot-reload.test.ts` that asserts `store._swap` with a new `policies` block takes effect on the next request.

## Info

### IN-01: Cardinality grep regex misses `labelNames: [ \n 'a', \n 'b' \n ]` multi-line form

**File:** `router/scripts/check-prometheus-cardinality.ts:34`
**Issue:**
`LABEL_NAMES_RE = /labelNames\s*:\s*\[([^\]]*)\]/g` — the `[^\]]*` body allows newlines (the `.` would not, but `[^\]]` does), so multi-line declarations are captured. Good. But a contrived author who writes `labelNames: [\n  'protocol',\n  'tenant_id' /* a comment with ] in it */,\n]` would break the capture because `]` inside a comment terminates the match early. Low likelihood in practice. The Phase 19 live-parse path (D-27) is the proper backstop.

Worth noting that `METRIC_NAME_RE` similarly captures the nearest `name:` — if a future helper function uses the `name:` token in a non-metric context (e.g. JSDoc, an object spec), the grep might attribute the violation to the wrong metric.

**Fix:** Document the limitation as a brief comment near the regex; defer the full AST parse to Phase 19 as already planned.

### IN-02: Duplicate import — `BackendSaturatedError` imported twice in `envelope.ts`

**File:** `router/src/errors/envelope.ts:5-6`
**Issue:**
```ts
export { BackendSaturatedError } from '../concurrency/semaphore.js';
import { BackendSaturatedError } from '../concurrency/semaphore.js';
```

Same module imported once for re-export, once for local use. ES modules handle this fine (single module record), so no runtime cost — but it's a small noise smell that suggests the file structure is overdue for tidying. Same pattern repeats for `InvalidImageUrlError` and `ImageFetchError` (line 10-11). Pre-Phase-14; flagged because this file gained ~80 LOC for the new policy/scoped-ID classes and is approaching the size where readability matters.

**Fix:** Replace with one of:
- `import { BackendSaturatedError } from '../concurrency/semaphore.js'; export { BackendSaturatedError };`
- Or a single `export { BackendSaturatedError } from ...` and reference the import via the re-export path.

### IN-03: Test fixture `makeEntry` casts via `as unknown as ModelEntry` — masks future schema additions

**File:** `router/src/policy/__tests__/gate.test.ts:38`
**Issue:**
The test factory:
```ts
function makeEntry(backend: string, policy?: { cloud_allowed: boolean }, name = 'test-model'): ModelEntry {
  return { name, backend, policy } as unknown as ModelEntry;
}
```

bypasses the full `ModelEntry` shape (capabilities, vram_budget_gb, backend_url, backend_model). Stated rationale in the comment block: `applyPolicyGate` only reads `backend` and `policy.cloud_allowed`. True today. If a future contributor extends `applyPolicyGate` to read e.g. `entry.capabilities` (a plausible extension for capability-aware policies), the unit test will pass on stale fixtures while production code blows up at runtime.

**Fix:** Tighten the fixture so each test entry has the minimal valid `ModelEntry` shape. Either parse a small YAML string via `loadRegistryFromString` and pluck the entry, or define a `BASE_ENTRY` constant with all required fields and spread it:

```ts
const BASE_ENTRY: ModelEntry = {
  name: 'placeholder',
  backend: 'ollama',
  backend_url: 'http://x:1/v1',
  backend_model: 'm',
  capabilities: ['chat'],
  vram_budget_gb: 1,
};
function makeEntry(backend, policy, name = 'test-model'): ModelEntry {
  return { ...BASE_ENTRY, backend, policy, name } as ModelEntry;
}
```

---

_Reviewed: 2026-05-30T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
