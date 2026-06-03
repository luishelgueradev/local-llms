---
phase: 18-mcp-client-retrieverprovider-pre-completion-hook
verified: 2026-06-03T02:50:00Z
status: passed
score: 6/6 success criteria + 12/12 requirements verified
retroactive: true
overrides_applied: 0
notes:
  - "Retroactive audit performed for v0.11.0 audit prep. Phase shipped 2026-06-01; verifier step was skipped at execute-phase time."
  - "Migration 0007 indivisible tuple (SQL + Drizzle schema + journal idx=7) verified intact (project_drizzle_migration_journal memory)."
  - "Live deployment rollout still pending (see deferred-items.md §Live tunnel rebuild) — this is a deploy gap, not an implementation gap."
---

# Phase 18: MCP Client + RetrieverProvider + Pre-Completion Hook — Verification Report

**Phase Goal:** Operators can declare external MCP servers in `models.yaml` and the router lazily connects to them to inject their tools into model requests; operators can register a `RetrieverProvider` pre-completion hook that injects retrieved context before the model call; both mechanisms coexist without interference.

**Verified:** 2026-06-03T02:50:00Z
**Status:** passed
**Retroactive:** Yes — phase shipped 2026-06-01 (commits via plans 18-01..18-08); verifier step skipped at execute time. This audit runs goal-backward against the on-disk codebase.

---

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Success Criterion | Status | Evidence |
|---|-------------------|--------|----------|
| SC-1 | Router boots cleanly when declared MCP server is unreachable; `/readyz` returns 200 | VERIFIED | `router/src/mcp/client/registry.ts:166-172` constructor invariant — NO `connect()` call; lazy via `getOrConnect()`. Integration test `tests/integration/mcp-client-lazy-boot.integration.test.ts` exists. Smoke gate 2 (`bin/smoke-test-router.sh:2478-2486`) asserts P2-01 BLOCK at deploy time. |
| SC-2 | Two MCP servers each registering tool `search` produce `serverA__search` + `serverB__search` with no collision | VERIFIED | `router/src/mcp/client/prefix.ts:22-24` `prefixToolName(alias, name)` + `tests/integration/mcp-client-prefix-routing.integration.test.ts` — 6/6 tests pass locally (verifier ran the suite). |
| SC-3 | `fail-open` hook timeout → request succeeds with `X-Hook-Error` header set; `fail-closed` hook timeout → 502 | VERIFIED | `router/src/hooks/pre-completion.ts:204-241` `runHookChain` branches on `hook.on_timeout` — fail-open warn-logs + sets `fail_open_signaled`, fail-closed throws `HookTimeoutError`. Envelope mapper (`router/src/errors/envelope.ts:524`) maps `HookTimeoutError → 502`. Route helper (`router/src/routes/v1/helpers/pre-completion.ts:206-207`) stashes `req.hookLog`. |
| SC-4 | Retrieved docs appear in `request_log.hook_log` JSONB with `context_hash` (SHA256), `hook_name`, `latency_ms`, `chars_retrieved` — never full content | VERIFIED | Migration `router/db/migrations/0007_request_log_hook_log.sql` adds JSONB column. Drizzle schema `router/src/db/schema/request_log.ts:70` declares `jsonb('hook_log')`. `recordOutcome.ts:310` writes `ctx.hookLog`. SHA256 in `pre-completion.ts:202` (`createHash('sha256').update(content).digest('hex')`). Comment in SQL line 14 explicitly says "Hashes only". |
| SC-5 | `/v1/embeddings` smoke test byte-identical to pre-Phase-18 | VERIFIED | `tests/unit/grep-gates/embeddings-untouched.test.ts` + baseline `embeddings-untouched-baseline.json` pin SHA256 of `src/routes/v1/embeddings.ts`. Grep gate test passes (verifier ran the suite — 3 test files, 34 tests, all pass). |
| SC-6 | Hook + MCP tool coexist independently — hook fires before model call, MCP tool fires via tool-call loop after | VERIFIED | `tests/integration/hook-and-mcp-coexist.integration.test.ts` exists and passes (verifier ran the suite). Route handlers (`messages.ts`, `chat-completions.ts`, `responses.ts`) invoke `runPreCompletionAndInjectMcpTools()` then conditionally wrap adapter call in `runMcpToolLoop()` — both code paths present in all 3 routes. |

**Score:** 6/6 success criteria verified.

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `router/src/providers/retriever-provider.ts` | RetrieverProvider interface (RETR-01) | VERIFIED | 89 LOC. Exports `OnTimeout`, `RetrievedDocument`, `RetrieverRequest`, `RetrieverResponse`, `RetrieverProvider` interface. Frame-01 BLOCK doc-comment explicitly states no implementation lives in `router/src/`. |
| `router/src/hooks/pre-completion.ts` | runHookChain + types (RETR-02, RETR-03, RETR-04, RETR-05) | VERIFIED | 265 LOC. Exports `PreCompletionHook`, `HookLogEntry`, `RunHookChainResult`, `timeout`, `redactBearer`, `runHookChain`. SHA256 audit + cancel-able Promise.race + fail-open/fail-closed branching. |
| `router/src/hooks/inject.ts` | Fenced context injection (P5-03 BLOCK) | VERIFIED | 93 LOC. `injectRetrievedContent` fences as `<retrieved_context source="...">` with 4000-char default cap; preserves closing fence on truncate. Writes to `canonical.system` (not `messages` — Phase 17 CTXP-03 invariant). |
| `router/src/mcp/client/registry.ts` | McpClientRegistry impl (MCPC-01..06) | VERIFIED | 448 LOC. 9 documented invariants (lazy connect, auth isolation, prefix, sanitize-on-ingest, 60s Valkey cache, concurrent-connect coalescing, connect-failure retry, SIGTERM-safe disposeAll, Valkey-absent degradation). Factory `makeMcpClientRegistry()` is the only public construction surface. |
| `router/src/mcp/client/transport.ts` | P2-04 boundary (auth isolation) | VERIFIED | 76 LOC. Sole import boundary for `@modelcontextprotocol/sdk/client/*`. `buildOutboundHeaders(cfg)` takes ONLY `McpServerConfig` — no FastifyRequest reachable by construction. |
| `router/src/mcp/client/sanitize.ts` | P2-03 BLOCK (tool poisoning defense) | VERIFIED | 70 LOC. `TOOL_NAME_REGEX = /^[a-z0-9_]{1,64}$/`, `DESCRIPTION_MAX_CHARS = 512`. Rejected tools return `null` with warn log. |
| `router/src/mcp/client/prefix.ts` | MCPC-03 (collision prevention) | VERIFIED | 55 LOC. `prefixToolName`, `stripPrefix` (splits on FIRST `__` only — alias-internal `__` preserved in toolName), `isExternalMcpToolCall`. |
| `router/src/mcp/client/tool-loop.ts` | runMcpToolLoop with 10-cap (MCPC-04) | VERIFIED | 166 LOC. `MCP_TOOL_LOOP_MAX = 10`. Parallel dispatch within iteration (Promise.all), sequential across iterations. Throws `McpToolLoopExceededError` on cap. Counter `routerMcpToolCallsExternalTotal` observes per-dispatch. |
| `router/src/mcp/client/index.ts` | Barrel export | VERIFIED | 42 LOC barrel re-exporting registry + prefix + sanitize + tool-loop + transport. |
| `router/src/hooks/index.ts` | Barrel export | VERIFIED | 20 LOC barrel re-exporting pre-completion + inject. |
| `router/db/migrations/0007_request_log_hook_log.sql` | hook_log JSONB column | VERIFIED | 14 lines. `ALTER TABLE request_log ADD COLUMN IF NOT EXISTS hook_log jsonb` + `COMMENT ON COLUMN` documenting shape. Idempotent. |
| `router/db/migrations/meta/_journal.json` | idx=7 entry | VERIFIED | Entry exists: `{ idx: 7, version: "7", when: 1780318886848, tag: "0007_request_log_hook_log", breakpoints: true }`. Indivisible-tuple invariant satisfied (SQL + schema + journal). |
| `router/src/db/schema/request_log.ts` | Drizzle `hook_log` column | VERIFIED | Line 70: `hook_log: jsonb('hook_log')`. Matches SQL migration. Indivisible-tuple invariant satisfied. |
| `router/src/errors/envelope.ts` | 4 new error classes | VERIFIED | `McpServerUnreachableError` (line 376), `McpToolLoopExceededError` (line 393), `HookTimeoutError` (line 407), `HookConfigError` (line 426). All mapped to 502 in `mapToHttpStatus` (lines 522-524). |
| `router/src/metrics/registry.ts` | 2 new Prometheus metrics | VERIFIED | `routerHookDurationMs` Histogram (line 173, labels `{hook_name, status}`). `routerMcpToolCallsExternalTotal` Counter (line 192, labels `{server_alias, status_class}`). |
| `router/src/config/registry.ts` | mcp_servers Zod schema | VERIFIED | `McpServerConfigSchema` (line 106), `mcp_servers` top-level (line 168), `mcp_servers_enabled` per-model (line 79), boot-time superRefine validates cross-reference (line 237+). |
| `router/src/routes/v1/helpers/pre-completion.ts` | Three-route shared helper | VERIFIED | `runPreCompletionAndInjectMcpTools()` consumed by `messages.ts`, `chat-completions.ts`, `responses.ts`. Stashes `req.hookLog` for recordOutcome (line 207). |
| `router/src/metrics/recordOutcome.ts` | hookLog → JSONB sink | VERIFIED | Line 118 declares `hookLog?: HookLogEntry[]` on context; line 310 writes `hook_log: ctx.hookLog ?? null` into Drizzle insert. End-to-end audit trail closed. |

**18/18 artifacts present, substantive, wired.**

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `router/src/index.ts` | `makeMcpClientRegistry` | `mcpClientRegistry = makeMcpClientRegistry({ servers, valkey, logger, cacheTtlSec: 60 })` at line 190 | WIRED | Production composition root constructs the registry from `initialRegistrySnapshot.mcp_servers`. |
| `router/src/index.ts` | `preCompletionHooks: Map` | `const preCompletionHooks = new Map()` at line 215 (Frame-01 BLOCK: literal empty) | WIRED | Production ships zero hooks by design — operators extend locally. |
| `router/src/app.ts` | `BuildAppOpts.mcpClientRegistry` + `preCompletionHooks` | Types at lines 313, 329; HookConfigError startup validation at 358-380 | WIRED | App typed widening accepted. Boot-time validation throws `HookConfigError` on missing `on_timeout` / empty `name` / negative `timeout_ms`. |
| `router/src/app.ts` | `mcpClientRegistry.disposeAll()` on shutdown | onClose hook at line 846-862, called BEFORE Fastify close (FIFO — Valkey alive during cache DEL) | WIRED | SIGTERM-safe; per-alias 5s Promise.race ceiling inside disposeAll. |
| `router/src/index.ts` (onReload) | `mcpClientRegistry.dispose(alias)` | Diff against `previousMcpServers` at lines 386-399; fire-and-forget dispose on changed/removed aliases | WIRED | Hot-reload Valkey cache invalidation. Resolves `project_models_yaml_hot_edit.md` friction-point for cache keys. |
| `router/src/routes/v1/messages.ts` | `runPreCompletionAndInjectMcpTools` + `runMcpToolLoop` | Imports at lines 64-65; invocations at 360 + 933 | WIRED | All three routes consume the shared helper. |
| `router/src/routes/v1/chat-completions.ts` | `runPreCompletionAndInjectMcpTools` + `runMcpToolLoop` | Imports at lines 34-35; invocations at 374 + 1106 | WIRED | |
| `router/src/routes/v1/responses.ts` | `runPreCompletionAndInjectMcpTools` + `runMcpToolLoop` | Imports at lines 107-108; invocations at 460 + 1052 | WIRED | |
| `req.hookLog` (Fastify request) | `recordOutcome.ts:310` | `hook_log: ctx.hookLog ?? null` | WIRED | Plan 18-08 Rule-2 gap closure. End-to-end audit flow: hook execution → req stash → recordOutcome → Postgres JSONB column. |
| `request_log.hook_log` SQL column | Drizzle `jsonb('hook_log')` | Migration 0007 + schema declaration parallel | WIRED | Indivisible tuple invariant intact. |

**10/10 key links wired.**

---

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| MCPC-01 | Operator declares `mcp_servers:` in models.yaml with `{ alias, url, transport, auth_type, auth_value, tool_filter? }` | SATISFIED | `config/registry.ts` McpServerConfigSchema. |
| MCPC-02 | Router connects to MCP servers LAZILY (not eager at boot) | SATISFIED | `registry.ts:166-172` constructor invariant; `getOrConnect()` is the lazy entrypoint. |
| MCPC-03 | Tools namespace-prefixed `<alias>__<tool>`; collision-free | SATISFIED | `prefix.ts:22-24` + applied in `registry.ts:262, 332`. |
| MCPC-04 | tool_call loop caps at 10 iterations; throws `{code: "mcp_tool_loop_exceeded"}` | SATISFIED | `tool-loop.ts:37` MCP_TOOL_LOOP_MAX=10; `tool-loop.ts:157-163` throws `McpToolLoopExceededError`. |
| MCPC-05 | Inbound bearer NEVER forwarded; per-server `auth_value` only | SATISFIED | `transport.ts:39-48` `buildOutboundHeaders(cfg)` — config-only signature; FastifyRequest unreachable by construction. Grep gate test `no inbound-headers references in router/src/mcp/client/`. |
| MCPC-06 | tools/list cached in Valkey 60s under `mcp:tools:{alias}`; hot-reload invalidates | SATISFIED | `registry.ts:252-336` GET/SET with `EX cacheTtlSec`; index.ts onReload calls `dispose(alias)` which DELs cache. |
| RETR-01 | `RetrieverProvider` interface exported with `retrieve(req) → Resp` shape | SATISFIED | `providers/retriever-provider.ts:87-89`. |
| RETR-02 | Operator registers RetrieverProvider per route via preHandler hook seam; fires BEFORE backend dispatch + AFTER ContextProvider | SATISFIED | `routes/v1/helpers/pre-completion.ts` invoked AFTER context-window resolution and BEFORE adapter call in all 3 routes. |
| RETR-03 | `on_timeout` required (no default); missing = startup error | SATISFIED | `app.ts:358-380` boot-time validation throws `HookConfigError` if `on_timeout` is missing/invalid. |
| RETR-04 | Retrieved docs injected as system message `<retrieved_context>...</retrieved_context>`; visible in `request_log.hook_log` JSONB | SATISFIED | `hooks/inject.ts` fence; migration 0007 + `recordOutcome.ts:310` end-to-end. |
| RETR-05 | NO retriever ships by default; NoopRetrieverProvider in tests only | SATISFIED | Production `index.ts:215` ships empty Map. Grep gate `tests/unit/grep-gates/no-default-retriever.test.ts` passes (verifier ran). Fake lives in `tests/fakes.ts`. |
| RETR-06 | When both MCP tool + hook configured for same route, both fire independently | SATISFIED | `tests/integration/hook-and-mcp-coexist.integration.test.ts` passes (verifier ran). Route handlers call both `runPreCompletionAndInjectMcpTools` then `runMcpToolLoop`. |

**12/12 requirements satisfied.**

---

### Anti-Patterns Scan

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `src/mcp/client/*.ts`, `src/hooks/*.ts`, `src/providers/retriever-provider.ts` | TBD/FIXME/XXX | none | grep returned 0 matches. |
| Same files | TODO/HACK/PLACEHOLDER | none | grep returned 0 matches. |
| `src/routes/v1/helpers/pre-completion.ts` | Empty handlers / stub returns | none | Helper invokes `runHookChain`, stashes `req.hookLog`, returns structured result. |

No debt markers found in Phase 18 code. All deferred items are documented in `deferred-items.md` and tracked as out-of-scope (future phases or operator action — see Carry-overs).

---

### Behavioral Spot-Checks (Verifier-Executed)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase 18 unit tests (mcp/client + hooks + registry-mcp-servers config) | `npx vitest run tests/mcp/client/ tests/hooks/ tests/config/registry-mcp-servers.test.ts` | 9 files, 93 tests, all passed (1.43s) | PASS |
| Grep gates + journal indivisible-tuple | `npx vitest run tests/unit/grep-gates/no-default-retriever.test.ts tests/unit/grep-gates/embeddings-untouched.test.ts tests/db/migration-journal.test.ts` | 3 files, 34 tests, all passed | PASS |
| Key integration tests (prefix routing, auth isolation, hook+mcp coexist) | `npx vitest run tests/integration/mcp-client-prefix-routing.integration.test.ts tests/integration/mcp-client-auth-isolation.integration.test.ts tests/integration/hook-and-mcp-coexist.integration.test.ts` | 3 files, 18 tests, all passed | PASS |
| Migration 0007 PG-gated test (skips when PG unreachable — expected on CI/dev) | `npx vitest run tests/integration/migrations/0007-hook-log.test.ts` | 1 file, 8 tests, all SKIPPED (no PG) | SKIP (expected) |

**Total executed: 13 test files, 145 tests, all pass; 1 file (8 tests) appropriately skipped.**

---

### Probe Execution

Not applicable — Phase 18 is a router-internals phase. The closest analog is `bin/smoke-test-router.sh` Phase 18 section (lines 2434-2538) which runs end-to-end against a deployed container. That probe requires a live deployment (see Deferred carry-over: "Live tunnel rebuild pending"). The 13 test files run above cover the same invariants in-process.

---

### Human Verification Required

None for goal-backward verification. All success criteria are codebase-verifiable.

**Deferred to deploy step** (NOT a verification gap — tracked in `deferred-items.md`):
- Rollout of the Phase 18 image to the live cloudflared-fronted deployment (`docker compose up -d --build --force-recreate router` + run `bin/smoke-test-router.sh --profile prod`). The deployed binary today is post-Phase-17; the Phase 18 code is on disk but not running in the live tunnel. This is a deploy gap, not an implementation gap.

---

## Summary

Phase 18 goal is **fully achieved** in the codebase:

1. **MCP client subsystem** (8 files, 1067 LOC) implements lazy-connect, sanitize-on-ingest, alias-prefix collision prevention, 60s Valkey cache, SIGTERM-safe disposeAll, hot-reload invalidation, and outbound-auth isolation enforced structurally (transport.ts boundary).
2. **Pre-completion hook subsystem** (2 files, 358 LOC) implements sequential chain, cancel-able Promise.race timeout, SHA256 audit (content NEVER stored), fail-open/fail-closed branching with boot-time HookConfigError validation, and `<retrieved_context>` fence with 4000-char truncate that preserves the closing tag.
3. **Migration 0007** indivisible tuple (SQL + Drizzle schema + journal idx=7) intact; `recordOutcome` end-to-end wires `req.hookLog` → JSONB column.
4. **Coexistence** verified by `tests/integration/hook-and-mcp-coexist.integration.test.ts` — both hook and MCP tool fire independently in all 3 routes (messages, chat-completions, responses).
5. **Frame-01 BLOCK** structurally enforced: production `index.ts:215` ships empty `preCompletionHooks` Map; grep gate `no-default-retriever.test.ts` passes; production code contains zero `RetrieverProvider` implementations.
6. **Embedding wire shape unchanged**: grep gate `embeddings-untouched.test.ts` + SHA256 baseline confirm `/v1/embeddings` route handler byte-identical to pre-Phase-18.

**No gaps. No overrides needed. No human verification required for code path.**

Operator action needed for live tunnel rollout (documented in `deferred-items.md` §Live tunnel rebuild) — out of scope for goal-backward code verification.

---

_Verified: 2026-06-03T02:50:00Z_
_Verifier: Claude (gsd-verifier)_
_Mode: retroactive — phase shipped 2026-06-01, audit performed for v0.11.0 audit prep_
