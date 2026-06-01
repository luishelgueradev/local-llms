---
phase: 18
slug: mcp-client-retrieverprovider-pre-completion-hook
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-01
---

# Phase 18 — Validation Strategy

> Per-phase validation contract for MCP Client + RetrieverProvider + Pre-Completion Hook.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `vitest@^4.1.6` (already installed) |
| **Config file** | `router/vitest.config.ts` |
| **Quick run command** | `cd router && npx vitest run tests/mcp/client tests/hooks` |
| **Full suite command** | `cd router && npm test && npm run typecheck` |
| **Estimated runtime** | ~10s unit / ~30s with PG-gated integration |
| **MSW fixture** | `router/tests/fixtures/mcp-server.ts` (NEW) — serves JSON-RPC over Streamable HTTP per MCP spec |

---

## Sampling Rate

- **Per task commit:** `cd router && npx vitest run tests/mcp/client tests/hooks tests/config/registry-mcp-servers.test.ts`
- **Per wave merge:** `cd router && npx vitest run` (full suite; Phase 14/15/16/17 baseline preserved)
- **Phase gate:** Full `npm test` + `npm run typecheck` green + cardinality CI guard + new MCP-client + HOOK smoke sections green
- **Max feedback latency:** 30 s

---

## Per-Requirement Verification Map

| Req ID | Behavior | Test Type | Status |
|--------|----------|-----------|--------|
| **MCPC-01** | `mcp_servers:` block parses; validation errors on missing fields | unit | ⬜ pending |
| **MCPC-02** | Boot succeeds when external MCP unreachable; `/readyz` returns 200 | integration | ⬜ pending |
| **MCPC-03** | Two servers register `search` → injected as `serverA__search` + `serverB__search`; dispatch routes correctly | integration | ⬜ pending |
| **MCPC-04** | Tool-call loop max 10 iter; `mcp_tool_loop_exceeded` error on cap | integration | ⬜ pending |
| **MCPC-05** | Inbound bearer NEVER forwarded; outbound uses per-server `auth_value` | integration (MSW assertion) | ⬜ pending |
| **MCPC-06** | `tools/list` cached 60s in Valkey; hot-reload `DEL`s cache | integration | ⬜ pending |
| **RETR-01** | `RetrieverProvider` interface shape (expectTypeOf) | unit | ⬜ pending |
| **RETR-02** | Hook fires AFTER ContextProvider, BEFORE backend dispatch | integration | ⬜ pending |
| **RETR-03** | Missing `on_timeout` → buildApp throws `HookConfigError` | unit | ⬜ pending |
| **RETR-04** | `request_log.hook_log` JSONB populated with SHA256 + name + latency + chars; NO full content | integration (PG) | ⬜ pending |
| **RETR-05** | No `RetrieverProvider` impl in `router/src/` outside interface file (Frame-01 grep gate) | grep gate | ⬜ pending |
| **RETR-06** | Hook + MCP tool same request: hook fires once + MCP tool routes correctly | integration | ⬜ pending |
| **P2-03 BLOCK** | Tool with bad name rejected; description >512 truncated + warn | unit | ⬜ pending |
| **P5-02 BLOCK** | `router_hook_duration_ms{hook_name, status}` series after hook fires; no timer leak | unit + integration | ⬜ pending |
| **P5-03 BLOCK** | Retrieved content >4000 chars truncated; fence-close tag preserved | unit | ⬜ pending |
| **P7-01 BLOCK** | `/v1/embeddings` byte-identical; `git diff --stat` does NOT touch embeddings.ts | grep gate | ⬜ pending |
| **P9-01 BLOCK** | Migration 0007 SQL + Drizzle schema + journal entry indivisible | unit | ⬜ pending |
| **SC-1** | Unreachable MCP server during boot → `/readyz` still 200 | integration | ⬜ pending |
| **SC-2** | Two servers same tool name → namespace prefix routes correctly | integration | ⬜ pending |
| **SC-3** | `on_timeout: fail-open` → request succeeds + `X-Hook-Error` header; `fail-closed` → 502 | integration | ⬜ pending |
| **SC-4** | `hook_log` JSONB has content_hash + hook_name + latency_ms + chars_retrieved; NO full content | integration | ⬜ pending |
| **SC-5** | `/v1/embeddings` smoke passes byte-identical | smoke | ⬜ pending |
| **SC-6** | Hook + MCP coexist on same request without overlap | integration | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `router/tests/config/registry-mcp-servers.test.ts` (MCPC-01)
- [ ] `router/tests/integration/mcp-client-lazy-boot.integration.test.ts` (MCPC-02 / P2-01)
- [ ] `router/tests/integration/mcp-client-prefix-routing.integration.test.ts` (MCPC-03)
- [ ] `router/tests/integration/mcp-tool-loop.integration.test.ts` (MCPC-04)
- [ ] `router/tests/integration/mcp-client-auth-isolation.integration.test.ts` (MCPC-05)
- [ ] `router/tests/integration/mcp-tools-list-cache.integration.test.ts` (MCPC-06)
- [ ] `router/tests/mcp/client/sanitize.test.ts` (P2-03 name + description gates)
- [ ] `router/tests/mcp/client/registry.test.ts` (`McpClientRegistry` shape)
- [ ] `router/tests/mcp/client/tool-loop.test.ts` (`runMcpToolLoop` unit)
- [ ] `router/tests/hooks/retriever-provider.interface.test.ts` (RETR-01)
- [ ] `router/tests/hooks/pre-completion.test.ts` (`runHookChain`)
- [ ] `router/tests/hooks/inject.test.ts` (P5-03 fence + 4000 char cap)
- [ ] `router/tests/hooks/hook-config-validation.test.ts` (RETR-03 / P5-01)
- [ ] `router/tests/hooks/promise-race-timeout.test.ts` (P5-02 no leak)
- [ ] `router/tests/integration/hook-position.integration.test.ts` (RETR-02)
- [ ] `router/tests/integration/hook-log-audit.integration.test.ts` (RETR-04 PG)
- [ ] `router/tests/integration/hook-and-mcp-coexist.integration.test.ts` (RETR-06)
- [ ] `router/tests/integration/hook-metrics.integration.test.ts` (P5-02)
- [ ] `router/tests/integration/migrations/0007-hook-log.test.ts` (P9-01)
- [ ] `router/tests/db/migration-journal.test.ts` (extend with idx=7)
- [ ] `router/tests/unit/grep-gates/no-default-retriever.test.ts` (Frame-01)
- [ ] `router/tests/unit/grep-gates/embeddings-untouched.test.ts` (P7-01)
- [ ] `router/tests/fixtures/mcp-server.ts` (MSW MCP Streamable HTTP fixture)
- [ ] `router/tests/fakes.ts` (extend with `makeFakeRetrieverProvider` + `makeFakeMcpClientRegistry`)
- [ ] `bin/smoke-test-router.sh` — new MCP-CLIENT + HOOK sections

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| n8n calls router with external MCP server bound + hook configured | SC-6 | Requires real n8n workflow + an external MCP server | After Phase 18 merge: configure n8n HTTP Request against router with model that has `mcp_servers_enabled: [searcher]` and a `pre_completion_hooks: [rag-stub]`; verify both fire. |

---

## Validation Sign-Off

- [ ] All 12 REQs + 12 BLOCK pitfalls covered by automated tests
- [ ] No watch-mode flags in CI
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` after Wave 0 ships

**Approval:** pending
