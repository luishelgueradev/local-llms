---
phase: 15
slug: mcp-host-router-as-mcp-server
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-31
---

# Phase 15 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `vitest@^4.1.6` (already installed in `router/package.json`) |
| **Config file** | `router/vitest.config.ts` (existing — separate `tests/unit/` and `tests/integration/` projects) |
| **Quick run command** | `cd router && pnpm vitest run tests/unit/mcp/host tests/unit/dispatch/preflight.test.ts` |
| **Full suite command** | `cd router && pnpm vitest run && pnpm typecheck` |
| **Estimated runtime** | ~10 seconds (unit) + ~20 seconds (integration + typecheck) |

---

## Sampling Rate

- **After every task commit:** Run `cd router && pnpm vitest run tests/unit/mcp/host tests/unit/dispatch/preflight.test.ts` (fast, ~2s)
- **After every plan wave:** Run `cd router && pnpm vitest run tests/integration/mcp-*.integration.test.ts` + replay Phase 14 integration suite
- **Before `/gsd:verify-work`:** Full `pnpm vitest run` + `pnpm typecheck` green + `bin/smoke-test-router.sh` MCP section PASS
- **Max feedback latency:** 30 seconds (unit) / 90 seconds (full)

---

## Per-Task Verification Map

| Req ID | Behavior | Test Type | Automated Command | File Exists | Status |
|--------|----------|-----------|-------------------|-------------|--------|
| MCPS-01 | MCP `@modelcontextprotocol/sdk` Client connects to `POST /mcp`, receives `tools/list` with ≥5 tools | integration | `pnpm vitest run tests/integration/mcp-host.integration.test.ts -t "tools/list"` | ❌ W0 | ⬜ pending |
| MCPS-02 | `POST /mcp` without `Authorization` header → 401 BEFORE MCP-level handling | integration | `pnpm vitest run tests/integration/mcp-host.integration.test.ts -t "bearer 401"` | ❌ W0 | ⬜ pending |
| MCPS-03 | 5 tools registered with correct names + JSON Schema 2020-12 `inputSchema` | unit + golden | `pnpm vitest run tests/unit/mcp/host/tools -t "registers all 5"` + snapshot at `tests/golden/mcp-tools-manifest.json` | ❌ W0 | ⬜ pending |
| MCPS-04 | Tool handler error → `isError: true` with structured `{ error, code, message }` content block (not thrown) | unit | `pnpm vitest run tests/unit/mcp/host/tools/chat-completion.test.ts -t "policy violation returns isError"` | ❌ W0 | ⬜ pending |
| MCPS-05 | SIGTERM closes all sessions within 5s; no leaked `sessionMap` entries | integration | `pnpm vitest run tests/integration/mcp-shutdown.integration.test.ts -t "SIGTERM closes sessions"` | ❌ W0 | ⬜ pending |
| MCPS-06 | `StdioServerTransport` NOT imported anywhere in `router/src/` | grep gate | `grep -rn 'StdioServerTransport' router/src/ \| wc -l` must equal `0` | ❌ W0 | ⬜ pending |
| D-01 | Tool `inputSchema` deep-equals `z.toJSONSchema(<route Zod schema>)` | unit + golden | `pnpm vitest run tests/unit/mcp/host/tools/chat-completion.test.ts -t "inputSchema mirrors ChatCompletionRequestSchema"` | ❌ W0 | ⬜ pending |
| D-05 | One `request_log` row per MCP tool call with `protocol='mcp'` | integration | `pnpm vitest run tests/integration/mcp-request-log.integration.test.ts` | ❌ W0 | ⬜ pending |
| D-06 | `tenant_id`/`project_id`/`agent_id` from outer `/mcp` request appear on each MCP `request_log` row | integration | covered in `mcp-request-log.integration.test.ts` | ❌ W0 | ⬜ pending |
| D-07 | `router_mcp_active_sessions` gauge + `router_mcp_tool_calls_total{tool,status_class}` counter present in `/metrics` | integration | `pnpm vitest run tests/integration/mcp-metrics.integration.test.ts` | ❌ W0 | ⬜ pending |
| D-09 | `applyPreflight` helper called from all 5 HTTP routes; breaker not mutated by 403 | unit + Phase 14 replay | `pnpm vitest run tests/unit/dispatch/preflight.test.ts` + `tests/integration/policy-gate-integration.test.ts` | unit ❌ W0; integration ✅ exists | ⬜ pending |
| D-10/D-11 | `list_models` tool + `GET /v1/models` both filter by allowlist + carry `policy.cloud_allowed` | integration | `pnpm vitest run tests/integration/list-models-policy-filter.integration.test.ts` | ❌ W0 | ⬜ pending |
| D-12 | `chat_completion` MCP tool with `stream:true` returns non-stream `structuredContent` | unit | `pnpm vitest run tests/unit/mcp/host/tools/chat-completion.test.ts -t "coerces stream:true to false"` | ❌ W0 | ⬜ pending |
| D-14 | Tool handler aborts upstream adapter when `extra.signal` aborts | unit | `pnpm vitest run tests/unit/mcp/host/tools/chat-completion.test.ts -t "extra.signal triggers adapter abort"` | ❌ W0 | ⬜ pending |
| D-15 | `MCP_ENABLED=false` → no `/mcp` route registered (returns 404) | integration | `pnpm vitest run tests/integration/mcp-disabled.integration.test.ts -t "MCP_ENABLED=false"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `router/tests/unit/dispatch/preflight.test.ts` — covers D-09 helper behavior (resolve + gate + breaker matrix)
- [ ] `router/tests/unit/mcp/host/plugin.test.ts` — session map, initialize handling, GC sweep, onClose race
- [ ] `router/tests/unit/mcp/host/tools/chat-completion.test.ts` — D-01, D-02, D-04, D-12, D-14
- [ ] `router/tests/unit/mcp/host/tools/create-response.test.ts` — `/v1/responses` surface dual-shape
- [ ] `router/tests/unit/mcp/host/tools/create-embedding.test.ts` — D-02/D-03 stamp + vector ride-along
- [ ] `router/tests/unit/mcp/host/tools/rerank.test.ts` — D-02/D-03 stamp + rerank scoring shape
- [ ] `router/tests/unit/mcp/host/tools/list-models.test.ts` — D-10 filter + `policy.cloud_allowed` annotation
- [ ] `router/tests/integration/mcp-host.integration.test.ts` — `@modelcontextprotocol/sdk` `Client` round-trip
- [ ] `router/tests/integration/mcp-shutdown.integration.test.ts` — MCPS-05 SIGTERM cleanup
- [ ] `router/tests/integration/mcp-request-log.integration.test.ts` — D-05/D-06 row population
- [ ] `router/tests/integration/mcp-metrics.integration.test.ts` — D-07 gauge + counter
- [ ] `router/tests/integration/mcp-disabled.integration.test.ts` — D-15 `MCP_ENABLED=false`
- [ ] `router/tests/integration/list-models-policy-filter.integration.test.ts` — D-10/D-11 dual-surface filter
- [ ] `router/tests/golden/mcp-tools-manifest.json` — snapshot of `tools/list` output (P1-03 drift gate)
- [ ] Smoke script extension: `bin/smoke-test-router.sh` adds MCP section (initialize → tools/list → `list_models` tools/call)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| n8n MCP Trigger node connects end-to-end against deployed router | MCPS-01 (interop) | Requires running n8n; out of CI scope | After Phase 15 merge: in n8n, add an MCP Server Trigger pointing at `https://local-llms.luishelguera.dev/mcp` with bearer token; confirm `tools/list` returns the 5 tools and `chat_completion` invocation returns a non-error result. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter after Wave 0 ships

**Approval:** pending
