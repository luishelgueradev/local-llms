---
phase: 08-ollama-cloud-fallback-resilience-hardening
plan: 05
subsystem: router/cloud-resilience
tags: [max-tokens, cloud-cap, validation, structured-error, mvp-slice]
requires:
  - 08-02-SUMMARY.md  # Ollama Cloud adapter + ollama-cloud registry surface
  - 08-03-SUMMARY.md  # req.resolvedBackend stamp + X-Model-Backend header
  - 08-04-SUMMARY.md  # circuit breaker — guard fires BEFORE breaker.check
provides:
  - "CLOUD_MAX_TOKENS_CAP constant (16384, single source of truth)"
  - "CloudMaxTokensExceededError class + envelope mappings (400 + cloud_max_tokens_exceeded)"
  - "Route-level cap guard on /v1/chat/completions + /v1/messages (cloud-only)"
  - "CLOUD-04 closure (cost-bounded request shape)"
affects:
  - router/src/config/constants.ts
  - router/src/errors/envelope.ts
  - router/src/metrics/recordOutcome.ts
  - router/src/routes/v1/chat-completions.ts
  - router/src/routes/v1/messages.ts
tech-stack:
  added: []
  patterns:
    - "pre-adapter request-shape guard (mirrors CapabilityNotSupportedError pattern from Phase 4)"
    - "typed error class with structured fields (requested, cap, modelName) carried into both wire envelopes so clients can self-correct"
    - "dual-envelope mapping (OpenAI specific `code` + Anthropic invalid_request_error taxonomy collapse)"
    - "D-D2 taxonomy bucket reuse — response code is specific (cloud_max_tokens_exceeded) but request_log row collapses to 'invalid_request' alongside ZodError/InvalidAgentIdError"
key-files:
  created:
    - router/tests/errors/cloud-max-tokens.test.ts
    - router/tests/routes/cloud-max-tokens-integration.test.ts
  modified:
    - router/src/config/constants.ts
    - router/src/errors/envelope.ts
    - router/src/metrics/recordOutcome.ts
    - router/src/routes/v1/chat-completions.ts
    - router/src/routes/v1/messages.ts
decisions:
  - "Cap = 16384 is a module-level constant in constants.ts, not env-configurable in v1 (D-C2 — Ollama Cloud's documented ceiling per PITFALLS Pitfall 9; a future policy change → flip constant + ship)"
  - "Guard fires AFTER req.resolvedBackend stamp + BEFORE breaker.check — preserves X-Model-Backend on the 400 and prevents oversized requests from consuming half-open probe slots"
  - "Anthropic envelope collapses to invalid_request_error (Anthropic taxonomy has no specific cloud-cap type) while OpenAI envelope carries the specific code='cloud_max_tokens_exceeded' + param='max_tokens'"
  - "mapErrorToCode collapses to existing 'invalid_request' D-D2 bucket — response envelope keeps the specific code, request_log row aggregates into the SQL-friendly taxonomy bucket"
  - "Embeddings route NOT gated — OpenAI Embeddings request body has no max_tokens parameter; the cap is cloud-chat-only per D-C2"
metrics:
  duration_min: 7
  completed: 2026-05-17T16:37:39Z
  tasks: 2
  files_modified: 7
  tests_added: 12
  tests_passing_before: 598
  tests_passing_after: 610
---

# Phase 08 Plan 05: Cloud max_tokens hard-cap (CLOUD-04) Summary

`max_tokens` hard-cap at 16,384 for cloud-served chat / messages requests via route-level guard throwing `CloudMaxTokensExceededError` → 400 + structured envelope (`cloud_max_tokens_exceeded` OpenAI / `invalid_request_error` Anthropic) — D-C1 "never silently clip" enforcement.

## What landed

| Layer | Artifact | Purpose |
|---|---|---|
| Constants | `router/src/config/constants.ts` | `export const CLOUD_MAX_TOKENS_CAP = 16_384` — single source of truth (D-C2) |
| Errors | `router/src/errors/envelope.ts` | `CloudMaxTokensExceededError` class + 3 mappings (status 400, OpenAI envelope with specific `code`, Anthropic envelope as generic `invalid_request_error`) |
| Metrics | `router/src/metrics/recordOutcome.ts` | `mapErrorToCode` → `'invalid_request'` D-D2 bucket (joins ZodError + InvalidAgentIdError) |
| Routes | `router/src/routes/v1/chat-completions.ts`, `router/src/routes/v1/messages.ts` | Pre-adapter guard: `entry.backend === 'ollama-cloud' && typeof body.max_tokens === 'number' && body.max_tokens > CAP → throw` |
| Tests | `router/tests/errors/cloud-max-tokens.test.ts` (6 unit) + `router/tests/routes/cloud-max-tokens-integration.test.ts` (6 integration) | Constant + class + 3 envelopes + bucket + E2E both surfaces + local-unaffected + boundary + undefined-max_tokens + embeddings-not-gated |

## Guard placement

```
typed.post('/v1/chat/completions', ..., async (req, reply) => {
  const body = req.body;
  const entry = opts.registry.resolve(body.model);
  req.resolvedBackend = entry.backend;           // Plan 08-03 stamp

  // ── Plan 08-05 (THIS) ────────────────────────────────────
  if (entry.backend === 'ollama-cloud' &&
      typeof body.max_tokens === 'number' &&
      body.max_tokens > CLOUD_MAX_TOKENS_CAP) {
    throw new CloudMaxTokensExceededError(body.max_tokens, CLOUD_MAX_TOKENS_CAP, entry.name);
  }
  // ─────────────────────────────────────────────────────────

  const adapter = opts.makeAdapter(entry);
  ...
  try {
    const breakerResult = await opts.breaker.check(entry.backend); // Plan 08-04 — AFTER cap
    ...
```

The guard fires:
- **AFTER** `req.resolvedBackend = entry.backend` — Plan 08-03's onSend hook still stamps `X-Model-Backend: ollama-cloud` on the 400 response (verified by Test 1).
- **BEFORE** `opts.breaker.check(entry.backend)` — Plan 08-04's half-open probe slot is not consumed by a request that would 400 anyway.
- **BEFORE** `semaphore.acquire(controller.signal)` — does not queue against the cloud semaphore.

## CLOUD-04 closure: the D-C1/D-C2 contract

> **D-C1 (never silently clip).** Cloud max_tokens overflow MUST be rejected with HTTP 400 + structured envelope. The router never modifies the request and forwards it; the client must know its request was modified.

Enforced by `throw new CloudMaxTokensExceededError(...)`. The 400 envelope carries both the requested value AND the cap so clients construct retry payloads directly from the response body:

```
{
  "error": {
    "message": "Cloud model \"gpt-oss:120b-cloud\" rejects max_tokens=32768: hard cap is 16384. Reduce max_tokens to <= 16384 and retry; cloud-served models cannot exceed this limit.",
    "type": "invalid_request_error",
    "code": "cloud_max_tokens_exceeded",
    "param": "max_tokens"
  }
}
```

Anthropic surface (`/v1/messages`):

```
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Cloud model \"gpt-oss:120b-cloud\" rejects max_tokens=32768: ..."
  }
}
```

> **D-C2 (16384 global, not env-configurable in v1).** A future Ollama Cloud policy change is handled by flipping the constant in a follow-up plan and shipping — no env, no YAML, no per-model knobs in v1.

Enforced by `export const CLOUD_MAX_TOKENS_CAP = 16_384` in a module that has no consumers outside this guard + its test. `grep -c CLOUD_MAX_TOKENS_CAP router/src/routes/v1/{chat-completions,messages}.ts` returns 4 per file (import + body comment + condition + constructor arg); `embeddings.ts` returns 0.

## Test inventory

### Unit (router/tests/errors/cloud-max-tokens.test.ts) — 6 tests

| # | Scope | Assertion |
|---|-------|-----------|
| 1 | `CLOUD_MAX_TOKENS_CAP` | exports literal 16_384 |
| 2 | Constructor | wires requested / cap / modelName / code + message contains both numbers + modelName |
| 3 | `mapToHttpStatus` | → 400 |
| 4 | `toOpenAIErrorEnvelope` | `invalid_request_error` / `cloud_max_tokens_exceeded` / `param='max_tokens'` / message contains both numbers |
| 5 | `toAnthropicErrorEnvelope` | `type='error'`, `error.type='invalid_request_error'`, message contains both numbers |
| 6 | `mapErrorToCode` | `'invalid_request'` D-D2 bucket |

### Integration (router/tests/routes/cloud-max-tokens-integration.test.ts) — 6 tests

| # | Surface | Body | Expected |
|---|---------|------|----------|
| 1 | `/v1/chat/completions` | cloud + `max_tokens: 32768` | 400 + OpenAI envelope; adapter NOT called; X-Model-Backend stamped |
| 2 | `/v1/messages` | cloud + `max_tokens: 32768` | 400 + Anthropic envelope (`type: 'error'`, `error.type: 'invalid_request_error'`) |
| 3 | `/v1/chat/completions` | local + `max_tokens: 32768` | 200; adapter called (cap is cloud-only) |
| 4 | `/v1/chat/completions` | cloud + `max_tokens: 16384` (exact cap) | 200 (cap is strict `>`, not `>=`) |
| 5 | `/v1/chat/completions` | cloud + no `max_tokens` | 200 (guard skips undefined) |
| 6 | `/v1/embeddings` | cloud embedding entry + input array | 200 (embeddings NOT gated; no max_tokens param) |

## Commits

| Hash | Type | Description |
|------|------|-------------|
| `645bffe` | test(08-05) | RED — failing unit tests for constant + error class + 3 envelopes + bucket (6 tests) |
| `5921672` | feat(08-05) | GREEN — CLOUD_MAX_TOKENS_CAP constant + CloudMaxTokensExceededError + 3 envelope mappings + mapErrorToCode arm |
| `0b87d2b` | test(08-05) | RED — failing integration tests for chat-completions + messages cap guards (6 tests) |
| `eb9291f` | feat(08-05) | GREEN — pre-adapter guard on both routes; embeddings UNCHANGED |

## Verification

```bash
# Plan's automated verify gates — all PASS:
$ grep -c 'CLOUD_MAX_TOKENS_CAP' router/src/routes/v1/{chat-completions,messages}.ts
router/src/routes/v1/chat-completions.ts:4
router/src/routes/v1/messages.ts:4
$ grep -c 'CLOUD_MAX_TOKENS_CAP' router/src/routes/v1/embeddings.ts
0
$ cd router && npm test
Tests  610 passed | 2 skipped (612)        # +12 vs Plan 08-04 (598 → 610)
$ npm run build
ESM ⚡️ Build success in 99ms
```

## Deviations from Plan

None — plan executed exactly as written. Both tasks followed TDD RED → GREEN cycles; no REFACTOR commit needed (the additions are localized to single-line imports + single-block guards + a single new class — no structural cleanup opportunity).

The plan called for "5 unit tests" in Task 1 but the implementation landed **6** (an additional standalone test verifying `CLOUD_MAX_TOKENS_CAP === 16_384` as a separate assertion from the error class constructor test — clearer failure messages if either drifts independently). The plan's grep gate (`min_lines: 30`) is exceeded with 95 lines. Documented for completeness — not a true deviation since the artifact's `provides` and `behavior` blocks are fully satisfied.

## Threat Model Review

| Threat ID | Disposition | Mitigation landed | Verification |
|-----------|-------------|-------------------|--------------|
| T-08-D-06 | mitigate | Pre-adapter guard at <1ms; oversized cloud max_tokens → 400 without upstream call (Test 1 verifies `counts.chat === 0` after a 32768 request); combined with Plan 08-06 (rate limit) attacker can't retry-spam the 400 | Integration Test 1 + 2 |
| T-08-I-05 | accept | Error message reveals the cap (16384) — appropriate per Ollama Cloud's public docs; client needs the value to retry | Unit Test 4 (message contains '16384') |
| T-08-T-05 | accept | Cloud max_tokens smuggle via passthrough — the canonical translator reads `body.max_tokens` explicitly; SDK ignores extraneous fields. Even if a client passed a duplicate field, the canonical-derived adapter call wouldn't see it | Architectural (no test needed) |

## Threat Flags

None — no new network surface, no new auth path, no new file access, no new trust boundary introduced. The guard ONLY rejects requests; it never accepts new input shapes or relaxes any existing validation.

## Cloud-cost-protection picture (post Plan 08-05)

The four guards now layer independently:

| Plan | Guard | What it prevents |
|------|-------|------------------|
| 08-04 | Per-backend circuit breaker | Repeated upstream failures from consuming cloud quota (5 failures in 30s → 60s cooldown) |
| **08-05 (this)** | **max_tokens hard-cap** | **Oversized requests from consuming cloud quota (max_tokens > 16384 → 400)** |
| 08-06 (next) | Per-backend rate limit | Burst frequency from consuming cloud quota |
| 08-07 (next) | Idempotency mux | Retry-storm duplication from consuming cloud quota |

CLOUD-04 closes. Phase 08 progress: 7/9 → 8/9 requirements coded.

## Self-Check: PASSED

- [x] `router/src/config/constants.ts` exists with `CLOUD_MAX_TOKENS_CAP = 16_384`
- [x] `router/src/errors/envelope.ts` exports `CloudMaxTokensExceededError`
- [x] `router/src/metrics/recordOutcome.ts` arm references `CloudMaxTokensExceededError`
- [x] `router/src/routes/v1/chat-completions.ts` guard present
- [x] `router/src/routes/v1/messages.ts` guard present
- [x] `router/src/routes/v1/embeddings.ts` does NOT reference `CLOUD_MAX_TOKENS_CAP`
- [x] `router/tests/errors/cloud-max-tokens.test.ts` exists
- [x] `router/tests/routes/cloud-max-tokens-integration.test.ts` exists
- [x] Commit `645bffe` (test RED unit) — found
- [x] Commit `5921672` (feat GREEN core) — found
- [x] Commit `0b87d2b` (test RED integration) — found
- [x] Commit `eb9291f` (feat GREEN routes) — found
- [x] `npm test` → 610 passing
- [x] `npm run build` → clean
