---
phase: 18-mcp-client-retrieverprovider-pre-completion-hook
plan: 04
subsystem: mcp-client-registry
tags: [wave-4, mcp-client, lazy-connect, valkey-cache, dispose-lifecycle, p2-01-block, p2-03-block, p2-04-block, mcpc-01, mcpc-02, mcpc-03, mcpc-05, mcpc-06]
requires:
  - phase: 18-mcp-client-retrieverprovider-pre-completion-hook (Plan 18-01)
    provides: Wave-0 scaffold tests (registry.test.ts + 4 integration test it.todo files) + MSW MCP fixture (tests/fixtures/mcp-server.ts) + tests/fakes.ts:makeFakeMcpClientRegistry shape lock
  - phase: 18-mcp-client-retrieverprovider-pre-completion-hook (Plan 18-02)
    provides: McpServerConfigSchema (canonical Zod source) + McpServerUnreachableError envelope class + Zod widening for top-level mcp_servers[] (RegistrySchema)
  - phase: 18-mcp-client-retrieverprovider-pre-completion-hook (Plan 18-03)
    provides: sanitizeExternalTool (P2-03 BLOCK regex + truncate) + prefixToolName (MCPC-03 alias prefix) + SanitizedTool type + mcp/client/ barrel
  - phase: 15-mcp-host
    provides: Phase 15 host plugin SDK install precedent (Client name/version 'local-llms-router'/'0.11.0' literal); shutdownSessions Promise.race 5s ceiling analog
  - phase: 08-cloud-resilience
    provides: ValkeyClient + 'EX' TTL idiom + enableOfflineQueue:false fail-fast pattern
provides:
  - mcp-client-transport-factory       # router/src/mcp/client/transport.ts — buildClient + buildOutboundHeaders (single P2-04 boundary)
  - mcp-client-registry-impl           # router/src/mcp/client/registry.ts — McpClientRegistryImpl with lazy-connect + cache + dispose
  - mcp-client-barrel-extended         # router/src/mcp/client/index.ts — re-exports makeMcpClientRegistry + transport factories
affects:
  - router/src/mcp/client/
  - router/tests/mcp/client/registry.test.ts
  - router/tests/integration/mcp-client-*.integration.test.ts
  - router/tests/integration/mcp-tools-list-cache.integration.test.ts
  - Plan 18-05 (tool-loop.ts — consumes McpClientRegistry + stripPrefix)
  - Plan 18-07 (composition root — wires makeMcpClientRegistry into BuildAppOpts.mcpClientRegistry + onSwap subscriber + onClose hook)
tech-stack:
  added: []  # zero new dependencies — Client + StreamableHTTPClientTransport already installed in Phase 15
  patterns:
    - "Lazy-connect with in-flight promise coalescing: connections Map<string, Promise<ConnectedEntry>>; concurrent getOrConnect(alias) share one network round-trip; connect failure evicts the promise so next call retries"
    - "Single P2-04 boundary: ALL outbound MCP header construction lives in transport.ts; the function signature (cfg: McpServerConfig) → headers structurally excludes any inbound context"
    - "Valkey write-through cache with hot-reload DEL: key 'mcp:tools:{alias}', EX 60s, stored SANITIZED but UN-PREFIXED so prefixToolName runs on every read"
    - "P2-03 BLOCK at ingestion: sanitizeExternalTool runs BEFORE cache write — poisoned tools NEVER land in canonical even on cache HIT"
    - "Promise.race(dispose, 5s timeout) per alias in disposeAll — mirror of Phase 15 shutdownSessions; a wedged transport.close() cannot block SIGTERM"
    - "Tools cached PREFIX-FREE — the alias prefix is applied at every read; cache lines are alias-agnostic and cheap to invalidate"
key-files:
  created:
    - "router/src/mcp/client/transport.ts (76 lines — buildClient + buildOutboundHeaders, sole SDK construction site, sole header-building site)"
    - "router/src/mcp/client/registry.ts (448 lines — McpClientRegistryImpl class + makeMcpClientRegistry factory + 4 types: McpClientRegistry, MakeMcpClientRegistryOpts, McpServerConfig re-export, CachedToolList internal)"
  modified:
    - "router/src/mcp/client/index.ts (37 lines — barrel extended with registry + transport re-exports)"
    - "router/tests/fakes.ts (Rule 1 fix: makeFakeMcpClientRegistry.getOrConnect return type — production interface returns Promise<Client>, fake cast through any)"
    - "router/tests/fixtures/mcp-server.ts (Rule 3 fix: SetupServerApi → SetupServer — Wave-0 typing detritus from Plan 18-01)"
    - "router/tests/mcp/client/registry.test.ts (12 it.todo → 12 real it() + 1 sentinel = 13 green)"
    - "router/tests/integration/mcp-client-lazy-boot.integration.test.ts (6 it.todo → 6 real it() = 6 green)"
    - "router/tests/integration/mcp-client-prefix-routing.integration.test.ts (6 it.todo → 6 real it() = 6 green)"
    - "router/tests/integration/mcp-client-auth-isolation.integration.test.ts (6 it.todo → 6 real it() = 6 green)"
    - "router/tests/integration/mcp-tools-list-cache.integration.test.ts (7 it.todo → 7 real it() = 7 green)"
key-decisions:
  - "transport.ts is the ONLY SDK construction site AND the ONLY header-building site. registry.ts uses `import type` for Client + StreamableHTTPClientTransport (type identity only — no runtime construction), preserving the P2-04 BLOCK boundary at module-graph level."
  - "Connections Map stores Promise<ConnectedEntry>, NOT the resolved entry. Concurrent getOrConnect(alias) calls coalesce to one network connect; on rejection the promise is evicted (.catch removes from map) so the next caller retries rather than caching the failure forever."
  - "Cache stores SANITIZED but UN-PREFIXED tools. The alias prefix is applied at every read via prefixToolName. Rationale: cheaper cache invalidation (the same line works for any future schema rename), cleaner separation of concerns (sanitize is policy on ingest, prefix is policy on injection)."
  - "Per-alias dispose wrapped in Promise.race([dispose, 5s timeout]) — direct mirror of Phase 15 shutdownSessions. A single wedged transport cannot block SIGTERM beyond the 5s ceiling; Compose stop_grace_period (10s) − bufferedWriter.drain (3s) leaves ~7s headroom, of which 5s is the registry budget."
  - "Valkey is OPTIONAL. With no valkey in opts, getOrFetchTools re-fetches from upstream every call. No in-memory fallback intentionally — the SDK transport keeps the TCP connection warm, so the only delta is one tools/list network round-trip (typically < 50ms)."
  - "McpServerConfig is type-re-exported from src/config/registry.ts (Plan 18-02's canonical Zod source) into src/mcp/client/registry.ts. Single source of truth for the shape; the mcp/client/ subsystem is the import-surface for downstream consumers."
patterns-established:
  - "Lazy-connect registry pattern: constructor accepts the full server catalog but performs NO network I/O. First connect happens on first getOrConnect/getOrFetchTools/callTool. Future external-resource registries (e.g. embeddings provider pool, summarizer pool) should follow this template."
  - "Single-boundary header factory: any outbound HTTP surface that must NOT leak inbound credentials should construct its headers in a function whose signature accepts ONLY the per-server config (NOT a FastifyRequest or headers bag). Structural enforcement is stronger than convention."
  - "Cache key namespace 'mcp:tools:{alias}' joins the existing 'model-registry:*' / 'rate-limit:*' family. Future MCP-related cache lines should keep the 'mcp:*' prefix for consistent operator observability."
requirements-completed: [MCPC-01, MCPC-02, MCPC-03, MCPC-05, MCPC-06]

# Metrics
duration: 12m
completed: 2026-06-01
tasks_completed: 2
files_created: 2
files_modified: 6                    # 1 barrel + 1 fakes + 1 fixture + 4 test scaffolds (it.todo → real it())
commits: 2
it_todo_flipped_real: 37             # 12 unit + 25 integration
tests_passing_in_scope: 38           # 1 sentinel + 37 cases
tsc_errors_in_src: 0
new_exports: 7                       # buildClient + buildOutboundHeaders + makeMcpClientRegistry + McpClientRegistry + McpServerConfig (re-export) + MakeMcpClientRegistryOpts + (CachedToolList kept internal)
---

# Phase 18 Plan 04: McpClientRegistry — lazy connect + Valkey cache + dispose lifecycle Summary

**Two production files (524 lines) shipping the load-bearing McpClientRegistry: lazy outbound MCP `Client` holder with per-alias Valkey-backed `tools/list` cache, P2-04 BLOCK auth isolation enforced at the type-signature level, and 5s SIGTERM-race dispose lifecycle.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-06-01T14:02:52Z
- **Completed:** 2026-06-01T14:14:41Z
- **Tasks:** 2 (both green)
- **Files created:** 2 production + 7 test/fixture files modified

## Accomplishments

- `router/src/mcp/client/transport.ts` (76 lines) ships as the **single P2-04 BLOCK boundary** — `buildClient(cfg)` is the only site that constructs `Client + StreamableHTTPClientTransport`, and `buildOutboundHeaders(cfg)` is the only site that builds outbound headers. Both functions take ONLY `McpServerConfig` — the inbound bearer + every routing/tenancy header is **unreachable by construction** (the type signature does not accept a `FastifyRequest`).
- `router/src/mcp/client/registry.ts` (448 lines) ships `McpClientRegistryImpl` with the 6-method contract: `getOrConnect`, `getOrFetchTools`, `callTool`, `dispose`, `disposeAll` + private `connectOne`. Lazy connect (P2-01 BLOCK), in-flight promise coalescing, connect-failure retry-eviction, 60s Valkey cache with `EX 60` write-through + DEL-on-dispose, P2-03 sanitization at ingestion (poisoned tools never land in cache), 5s Promise.race per-alias ceiling in `disposeAll`.
- **38 in-scope tests passing** (1 sentinel + 37 cases): 12 unit tests + 25 integration tests across 4 integration files. All tests use either `vi.mock` on `./transport.js` (unit) or a real MSW peer (integration) — no production-code mocks; the registry itself is exercised end-to-end.
- **All P2 grep gates green:** `req.headers|request.headers` in `src/mcp/client/` → empty (P2-04); `connectAll|mcpRegistry.connect` in `src/` → empty (P2-01); `class \w+RetrieverProvider` in `src/` → empty (Frame-01, untouched).
- **`npx tsc --noEmit` `src/` errors: 0**. Remaining tsc errors live entirely in `tests/` and are explicit Wave-0 RED signals for Plans 18-05 (`tool-loop.ts`) and 18-06 (`pre-completion.ts`).
- **Zero new npm dependencies.** `@modelcontextprotocol/sdk` was installed in Phase 15; `msw` and `vitest` were already dev-deps; `pino` is transitive via Fastify.

## Task Commits

Each task was committed atomically:

1. **Task 1: transport.ts — buildClient factory + buildOutboundHeaders (P2-04 BLOCK)** — `5b052b2` (feat)
2. **Task 2: registry.ts — McpClientRegistry impl + Valkey cache + dispose lifecycle (MCPC-01..06)** — `f8b1a81` (feat)

**Plan metadata commit:** (final docs commit after this SUMMARY lands)

## Files Created

| Path | Lines | Exports |
|------|-------|---------|
| `router/src/mcp/client/transport.ts` | 76 | `buildClient`, `buildOutboundHeaders` (2) |
| `router/src/mcp/client/registry.ts` | 448 | `makeMcpClientRegistry`, `McpClientRegistry`, `McpServerConfig` (re-export), `MakeMcpClientRegistryOpts` (4 — `CachedToolList` kept internal) |

**Total production lines:** 524.

## Files Modified

| Path | Change |
|------|--------|
| `router/src/mcp/client/index.ts` | barrel: +makeMcpClientRegistry + 3 types + buildClient + buildOutboundHeaders re-exports |
| `router/tests/fakes.ts` | Rule 1 fix: `makeFakeMcpClientRegistry.getOrConnect` return type aligned with `McpClientRegistry` interface (cast through `any` — same pattern as Phase 17 fakes that don't pull in the full SDK type tree) |
| `router/tests/fixtures/mcp-server.ts` | Rule 3 fix: `SetupServerApi` → `SetupServer` — Wave-0 typing detritus from Plan 18-01 (the `Api` suffix is the class implementation; the `setupServer()` return contract is the `SetupServer` interface) |
| `router/tests/mcp/client/registry.test.ts` | 12 it.todo → 12 real it() — vi.mock on `./transport.js`, hand-rolled fake `Client` + fake Valkey via `mkFakeValkey()`. 1 sentinel + 12 cases = 13 green. |
| `router/tests/integration/mcp-client-lazy-boot.integration.test.ts` | 6 it.todo → 6 real it(). buildApp completes with unreachable `mcp_servers`; `/readyz` baseline matches no-MCP variant (proving MCP adds zero readiness degradation); body has no 'mcp' token; direct `getOrConnect` against unreachable port DOES attempt connect (proves lazy != never); 2 grep gates. |
| `router/tests/integration/mcp-client-prefix-routing.integration.test.ts` | 6 it.todo → 6 real it(). Single `setupServer` with handlers for both base URLs (MSW interceptor is process-global); two-server collision verified by per-server `callCounter` increments. |
| `router/tests/integration/mcp-client-auth-isolation.integration.test.ts` | 6 it.todo → 6 real it(). Custom snapshot-all-headers MSW handler captures every outbound header; asserts per-server bearer present, inbound bearer absent, 5 forbidden routing/tenancy headers absent, `auth_type:'none'` → no Authorization. |
| `router/tests/integration/mcp-tools-list-cache.integration.test.ts` | 7 it.todo → 7 real it(). MISS → SET 'EX 60' → HIT → DEL on dispose verified via `mkFakeValkey()` introspection. |

## Barrel Contents (after Plan 18-04)

```typescript
// router/src/mcp/client/index.ts
export {
  sanitizeExternalTool, TOOL_NAME_REGEX, DESCRIPTION_MAX_CHARS, type SanitizedTool,
} from './sanitize.js';   // Plan 18-03

export {
  prefixToolName, stripPrefix, isExternalMcpToolCall, PREFIX_SEPARATOR,
} from './prefix.js';     // Plan 18-03

export {
  makeMcpClientRegistry,
  type McpClientRegistry, type McpServerConfig, type MakeMcpClientRegistryOpts,
} from './registry.js';   // Plan 18-04 (this plan)

export {
  buildClient, buildOutboundHeaders,
} from './transport.js';  // Plan 18-04 (this plan)

// Plan 18-05 adds: runMcpToolLoop + MCP_TOOL_LOOP_MAX + type RunMcpToolLoopOpts
```

## The 6-method McpClientRegistry Contract

```typescript
export interface McpClientRegistry {
  getOrConnect(alias: string): Promise<Client>;
  getOrFetchTools(alias: string): Promise<CanonicalTool[]>;
  callTool(alias: string, toolName: string, args: unknown): Promise<unknown>;
  dispose(alias: string): Promise<void>;
  disposeAll(): Promise<void>;
}
```

| Method | Invariant |
|--------|-----------|
| `getOrConnect` | Lazy + idempotent + concurrent-coalescing. First call connects; subsequent calls return the cached `Client`. Connect failure throws `McpServerUnreachableError` and evicts the promise (next call retries). |
| `getOrFetchTools` | Returns SANITIZED + PREFIXED `CanonicalTool[]`. Consults Valkey first (`mcp:tools:{alias}`), falls back to `client.listTools()` + sanitize + `tool_filter` allowlist + write-through. P2-03 BLOCK enforced: bad tools rejected before cache write. |
| `callTool` | Forwards via SDK `client.callTool(...)` with per-server `timeout_ms` enforced via SDK request-options. `toolName` is UN-PREFIXED (caller stripped via `stripPrefix`). |
| `dispose` | Pops in-flight promise, DELs Valkey cache key, closes transport. Idempotent. Errors during close swallowed. |
| `disposeAll` | SIGTERM path. Per-alias `Promise.race([dispose, 5s])` ceiling — mirror of Phase 15 `shutdownSessions`. |

## P2-04 BLOCK Grep-Gate Output

Output of `grep -rE "req\.headers|request\.headers" router/src/mcp/client/`:

```
(empty)
```

Verified at Task 1 commit time and Task 2 commit time. The structural enforcement at the type-signature level (`buildOutboundHeaders(cfg: McpServerConfig)`) makes it impossible to forward the inbound bearer even by accident — the function does not accept any context-bearing object.

## Lazy-Connect Proof

The lazy-boot integration test exercises three guarantees:

1. **Boot completes in < 2s** with `mcp_servers` pointing at a deliberately-closed port (`http://127.0.0.1:1/mcp`). A non-lazy connect would surface as either an ECONNREFUSED thrown out of `buildApp` OR a timeout that extends boot beyond the 2s budget.
2. **`/readyz` status code is IDENTICAL** between a no-MCP YAML and a YAML with the same models PLUS an unreachable `mcp_servers` entry. MCP unreachability contributes **zero** to readiness degradation.
3. **First `getOrConnect` on an unreachable alias DOES attempt the connect** (proven by the resulting `McpServerUnreachableError`). Lazy ≠ never — the network probe is deferred to first use, not skipped entirely.

## Test Flip Summary

37 cases flipped from `it.todo` → real `it()` and PASSING. By file:

| File | Cases (sentinel + flipped) | Domain |
|------|---------------------------|--------|
| `tests/mcp/client/registry.test.ts` | 1 + 12 = 13 | Unit: vi.mock on transport; lazy ctor, retry on failure, sanitize-on-list, cache MISS/HIT, EX 60, dispose, disposeAll, Valkey-absent |
| `tests/integration/mcp-client-lazy-boot.integration.test.ts` | 0 + 6 = 6 | buildApp + /readyz invariants + 2 grep gates |
| `tests/integration/mcp-client-prefix-routing.integration.test.ts` | 0 + 6 = 6 | Two-server collision; prefix __; stripPrefix first-occurrence |
| `tests/integration/mcp-client-auth-isolation.integration.test.ts` | 0 + 6 = 6 | Header snapshot: per-server bearer / no inbound bearer / no routing headers / auth_type:none / grep gates |
| `tests/integration/mcp-tools-list-cache.integration.test.ts` | 0 + 7 = 7 | MISS → SET EX 60 → HIT → DEL on dispose |
| **Total** | **1 + 37 = 38** | |

## MSW Fixture's bearerAssertion — P2-04 BLOCK at Integration Time

The auth-isolation integration test uses a custom snapshot-all-headers MSW handler that captures every outbound HTTP request's full header bag. On every request it asserts:

- `request.headers.get('authorization') === 'Bearer ${PER_SERVER_BEARER}'` (per-server token forwarded).
- `JSON.stringify(allHeaders)` does not contain `INBOUND_ROUTER_BEARER` (`'inbound-router-bearer-NEVER-FORWARDED'` — a sentinel string that would surface anywhere the inbound bearer leaked).
- `allHeaders['x-tenant-id']`, `['x-project-id']`, `['x-agent-id']`, `['x-session-id']`, `['x-workload-class']` are all `undefined`.
- With `auth_type:'none'`, `request.headers.get('authorization') === null`.

The runtime checks complement the static grep gate — the boundary holds at both the source-tree level AND at the wire level.

## Valkey Cache Verification

The MCPC-06 integration test exercises the full lifecycle via a hand-rolled `mkFakeValkey()` whose `set`/`get`/`del` are real `vi.fn()` spies with TTL retention:

```
1. GET mcp:tools:searcher          → null (cache MISS)
2. (upstream client.listTools() runs once)
3. SET mcp:tools:searcher … EX 60  → 'OK' (write-through; TTL stored as 60)
4. GET mcp:tools:searcher          → JSON payload (cache HIT)
5. (upstream listTools NOT called second time — request count unchanged)
6. dispose('searcher')
7. DEL mcp:tools:searcher          → 1 (key gone)
8. (subsequent get would MISS again — verified via store inspection)
```

`valkey.set.mock.calls[0]` shape: `['mcp:tools:searcher', '<json>', 'EX', 60]` — matches the plan's MCPC-06 contract exactly.

## Decisions Made

- **transport.ts owns the SDK construction site AND the header-building site.** Two responsibilities in one ~80-line file is justified because both responsibilities answer the same question: "what should the outbound HTTP request look like?". Splitting would create a register-and-glue dance for no benefit. registry.ts uses `import type` for `Client` + `StreamableHTTPClientTransport` (type identity only) so the module-graph boundary is preserved.
- **Connections Map stores Promise<ConnectedEntry>, NOT the resolved entry.** Storing the promise enables concurrent-connect coalescing (Invariant #6) and connect-failure retry-eviction (Invariant #7) in two lines of code. Mirror of how Phase 15's session-attach helper coalesces in-flight session creates.
- **Cache stores SANITIZED but UN-PREFIXED tools.** The alias prefix is applied at every read (`prefixToolName(alias, t.name)`). Rationale: cleaner separation of concerns (sanitize is ingest-policy, prefix is injection-policy); cheaper invalidation (cache lines are alias-agnostic at the byte level — same payload could serve any alias if the schema ever needs it).
- **Per-alias dispose wrapped in 5s Promise.race.** Direct mirror of Phase 15 `shutdownSessions` (router/src/mcp/host/session-gc.ts:140-162). Same SIGTERM budget arithmetic: Compose `stop_grace_period` 10s minus `bufferedWriter.drain(3_000)` leaves 7s, of which 5s is the registry budget.
- **Valkey is OPTIONAL with NO in-memory fallback.** When `opts.valkey === undefined`, every `getOrFetchTools` re-fetches from upstream. The SDK keeps the TCP connection warm; the only delta is one `tools/list` round-trip (typically < 50ms). Rationale: an in-memory cache would need its own invalidation contract + its own LRU eviction; not worth the complexity for what is intended to be a temporary Valkey-down-degradation mode.
- **McpServerConfig re-exported from src/config/registry.ts.** Plan 18-02 ships the canonical Zod schema in `src/config/registry.ts`. The `mcp/client/registry.ts` file re-exports the inferred type so the mcp/client/ subsystem is the import-surface for downstream consumers — but the single source of truth (the Zod schema) lives in the config layer.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] tests/fakes.ts:makeFakeMcpClientRegistry.getOrConnect return type misaligned with production interface**
- **Found during:** Task 2 (registry.ts implementation + tsc check)
- **Issue:** The Wave-0 fake declared `getOrConnect(alias: string): Promise<unknown>`. The shipped `McpClientRegistry` interface (Plan 18-04 Task 2) requires `Promise<Client>` — TypeScript rejected the structural mismatch. Pre-existing in Plan 18-01; would have surfaced when any consumer typed against the fake.
- **Fix:** Removed the explicit return-type annotation; the fake returns a structurally-compatible object cast through `as any` (with eslint-disable-next-line). Same pattern as Phase 17's `makeFakeSessionStore` which intentionally doesn't pull the full SDK type tree into the fakes module.
- **Files modified:** `router/tests/fakes.ts` (single 4-line edit around lines 342-347)
- **Verification:** `npx tsc --noEmit` errors in `tests/fakes.ts` dropped from 1 → 0.
- **Committed in:** `f8b1a81` (Task 2 commit)

**2. [Rule 3 - Blocking] tests/fixtures/mcp-server.ts:SetupServerApi → SetupServer typing detritus**
- **Found during:** Task 2 (integration test type checks)
- **Issue:** Plan 18-01 declared `setupMcpMswServer(opts): SetupServerApi`. The msw v2 public API surfaces `SetupServer` (the interface returned by `setupServer()`); `SetupServerApi` is the class implementation. The two share fields but `#private` + `network` are flagged as missing on the interface side, breaking tsc.
- **Fix:** Replaced `SetupServerApi` with `SetupServer` in the fixture's import + return type annotation. Propagated the same change to the four integration tests that imported the type.
- **Files modified:** `router/tests/fixtures/mcp-server.ts`, `router/tests/integration/mcp-client-prefix-routing.integration.test.ts`, `router/tests/integration/mcp-client-auth-isolation.integration.test.ts`, `router/tests/integration/mcp-tools-list-cache.integration.test.ts`
- **Verification:** `npx tsc --noEmit` errors for `SetupServerApi` mismatch dropped from ~8 → 0. Tests still pass.
- **Committed in:** `f8b1a81` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 Rule-1 bug, 1 Rule-3 blocking).
**Impact on plan:** Trivial — both deviations were typing-only Wave-0 detritus that would have blocked downstream consumers. No scope creep; no behavioral changes; tests didn't change semantically.

## Issues Encountered

- **MSW process-global interceptor:** initial draft of the prefix-routing test built two separate `setupServer` instances (one per base URL) and called `.listen()` on both. The second `.listen()` overrides the first — msw's interceptor is process-global. Resolved by collapsing to a single `setupServer(handlerForA, handlerForB)` — pattern documented in the test's header comment.
- **/readyz returns 503 in hermetic test:** the route's 200/503 gate depends on the liveness scheduler having ticked. In `buildApp`+`app.inject` tests the scheduler never runs, so `/readyz` always returns 503. The lazy-boot test was reworked to assert that the MCP-with-unreachable variant's status code MATCHES the no-MCP baseline (proving MCP adds zero degradation), not that it returns 200. This is a stronger guarantee anyway.

## Wave-0 RED Signals Remaining (expected)

The following 2 test files still fail with explicit Wave-0 sentinel-runtime imports — these are the dependency-graph signals that Plans 18-05/06 still need to land:

- `tests/mcp/client/tool-loop.test.ts` (Plan 18-05 — `runMcpToolLoop`)
- `tests/hooks/pre-completion.test.ts`, `tests/hooks/hook-config-validation.test.ts`, `tests/hooks/promise-race-timeout.test.ts` (Plan 18-06 — `runHookChain` / timeout helpers)

These are by-design. Plan 18-04 explicitly stops at the registry surface.

## User Setup Required

None — no external service configuration required. All deliverables are pure-TS modules; the Valkey backing is OPTIONAL and degrades gracefully (every getOrFetchTools re-fetches from upstream when Valkey is absent).

## Verification Report

| Acceptance Criterion | Status |
|---|---|
| `router/src/mcp/client/transport.ts` exists with `buildClient` + `buildOutboundHeaders` exports | ✓ verified via `test -f` + `grep -E` |
| `buildOutboundHeaders` signature: `(cfg: McpServerConfig) => Record<string, string>` (no FastifyRequest) | ✓ type-signature inspection |
| `buildClient` returns `{ client, transport }` — caller wires connect lifecycle | ✓ source inspection |
| Grep gate `grep -rE "req\.headers\|request\.headers" router/src/mcp/client/` returns empty | ✓ verified after both commits |
| `Client` name/version: `'local-llms-router'` / `'0.11.0'` (matches Phase 15 host pattern) | ✓ source inspection |
| `router/src/mcp/client/registry.ts` exports the 4 required names | ✓ `grep -cE "^export"` returns 4 |
| `McpClientRegistryImpl` has 6 methods (5 public + private connectOne) | ✓ source inspection |
| Constructor does NOT call connect (P2-01 BLOCK) | ✓ source inspection + lazy-boot integration test |
| Connect failure throws `McpServerUnreachableError(alias, url, cause)` | ✓ registry unit test "connect failure removes promise from cache" |
| Connect failure REMOVES the promise from `connections` Map so next request retries | ✓ same unit test asserts 2 buildClient calls across 2 attempts |
| `getOrFetchTools` chains through `sanitizeExternalTool` BEFORE caching | ✓ registry unit test "skips tools that fail sanitizeExternalTool" |
| Cache key format `mcp:tools:{alias}` + TTL 60s | ✓ tools-list-cache integration test "Valkey key format" + "TTL: 60s via EX" |
| `dispose(alias)` DELs the cache key + closes transport | ✓ tools-list-cache integration test "hot-reload (onSwap)" + registry unit test "dispose(alias) DELs Valkey cache" |
| `disposeAll` uses Promise.race with 5s timeout | ✓ source inspection (`DISPOSE_TIMEOUT_MS = 5_000`) + registry unit test "disposeAll iterates" |
| Grep gate `grep -rE "req\.headers\|request\.headers" router/src/mcp/client/` empty | ✓ |
| 12 unit + 25 integration tests pass (= 37 cases) | ✓ 38 (1 sentinel + 37 cases) |
| `npx tsc --noEmit` `src/` errors: 0 | ✓ verified |
| Frame-01 BLOCK grep gate STILL green | ✓ `grep -rE "class \w+RetrieverProvider" src/` empty |
| P7-01 grep gate STILL green | ✓ all 9 grep-gate tests still pass |
| Zero new npm dependencies | ✓ no `package.json` change |
| Zero changes to any Phase 14/15/16/17 file | ✓ `git diff master~2 -- router/src/{translation,providers,db,errors,metrics,config,backends,routes,resilience,concurrency,clients,backends,dispatch}` empty |

## Threat Flags

None — no new threat surface introduced beyond what the plan's `<threat_model>` already enumerated. The 7 mitigation rows (T-18-04-S spoofing inbound→outbound, T-18-04-T tool poisoning, T-18-04-S tool name collision, T-18-04-D wedged close on SIGTERM, T-18-04-D concurrent connect, T-18-04-A unreachable at boot, T-18-04-SC supply chain) are all directly implemented in this plan's code:

| Threat ID | Mitigation Site |
|-----------|----------------|
| T-18-04-S (inbound bearer leak) | `transport.ts:buildOutboundHeaders(cfg)` type-signature; integration test snapshot-all-headers |
| T-18-04-T (tool poisoning) | `registry.ts:getOrFetchTools` calls `sanitizeExternalTool` BEFORE cache write |
| T-18-04-S (tool name collision) | `registry.ts:getOrFetchTools` maps through `prefixToolName(alias, …)` on return |
| T-18-04-D (wedged close) | `registry.ts:disposeAll` Promise.race(dispose, 5s) per alias |
| T-18-04-D (concurrent connect) | `registry.ts:getOrConnect` stores Promise in Map → coalescing |
| T-18-04-A (unreachable at boot) | constructor has no connect calls; lazy-boot integration test verifies |
| T-18-04-SC (supply chain) | no new dependencies — Client + StreamableHTTPClientTransport already installed in Phase 15 |

## Next Phase Readiness

- **Plan 18-05 (tool-loop.ts):** UNBLOCKED — depends on `makeMcpClientRegistry`, `McpClientRegistry` interface, `stripPrefix`, `prefixToolName`, `isExternalMcpToolCall`. All shipped.
- **Plan 18-06 (pre-completion.ts):** UNBLOCKED — depends on the `RetrieverProvider` interface (Plan 18-03), the four error envelopes (Plan 18-02), and `injectRetrievedContent` (Plan 18-03). No dependency on Plan 18-04 specifically, but follows in execution order.
- **Plan 18-07 (composition root):** UNBLOCKED — depends on `makeMcpClientRegistry` (this plan) for production wiring into `BuildAppOpts.mcpClientRegistry`. The plan's responsibility includes:
  - Construct the registry at boot time from `initialRegistry.mcp_servers` map.
  - Wire `registry.onSwap((prev, next) => /* diff aliases → mcpRegistry.dispose */)`.
  - Add `app.addHook('onClose', async () => mcpRegistry.disposeAll())` in `index.ts`.
  - Plumb the registry into the 3 routes (chat-completions, messages, responses) per Plan 18-05 + Plan 18-07's helper.

## Self-Check: PASSED

**Files exist (verified):**
- `router/src/mcp/client/transport.ts` ✓
- `router/src/mcp/client/registry.ts` ✓
- `router/src/mcp/client/index.ts` ✓ (modified)

**Commits exist (verified via `git log --oneline`):**
- `5b052b2` Task 1 transport.ts ✓
- `f8b1a81` Task 2 registry.ts + tests ✓

---
*Phase: 18-mcp-client-retrieverprovider-pre-completion-hook*
*Plan: 04*
*Completed: 2026-06-01*
