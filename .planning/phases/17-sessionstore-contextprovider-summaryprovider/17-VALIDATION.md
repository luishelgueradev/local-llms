---
phase: 17
slug: sessionstore-contextprovider-summaryprovider
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-31
---

# Phase 17 — Validation Strategy

> Per-phase validation contract for SessionStore + ContextProvider + SummaryProvider.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `vitest@^4.1.6` (already installed) |
| **Config file** | `router/vitest.config.ts` |
| **Quick run command** | `cd router && npm test -- tests/providers/` |
| **Full suite command** | `cd router && npm test && npm run typecheck` |
| **Estimated runtime** | ~5 s (unit providers) / ~20 s (full suite + integration) |

---

## Sampling Rate

- **Per task commit:** `cd router && npm test -- tests/providers/ tests/db/migration-journal.test.ts`
- **Per wave merge:** `cd router && npm test -- tests/providers/ tests/routes/session-* tests/integration/migrations/0006-*` + Phase 14/15/16 integration suites
- **Phase gate:** Full `npm test` + `npm run typecheck` green + `bin/smoke-test-router.sh` new SESSION section PASS

---

## Per-Requirement Verification Map

| Req ID | Behavior | Test Type | Status |
|--------|----------|-----------|--------|
| **SESS-01** | Interface exports + shape | unit | ⬜ pending |
| **SESS-02** | Migration 0006 creates `sessions` + `conversation_turns`; `expires_at` NOT NULL | integration | ⬜ pending |
| **SESS-03** | `loadHistory(session_id, agent_id)` mismatched agent → `[]` | integration | ⬜ pending |
| **SESS-04** | `appendTurn` 1s timeout fail-open → `persisted: false` | integration | ⬜ pending |
| **SESS-05** | `X-Session-ID` response header on stream + non-stream | integration | ⬜ pending |
| **SESS-06** | No header → no DB rows → byte-identical to Phase 16 | integration + golden | ⬜ pending |
| **CTXP-01** | `provideContext` interface shape | unit | ⬜ pending |
| **CTXP-02** | `sliding-window` strategy default + `truncate` opt-in | unit | ⬜ pending |
| **CTXP-03** | System pinning (preserved through trimming) | unit | ⬜ pending |
| **CTXP-04** | Zod widening accepts `ctx_size` + `context_strategy` | unit | ⬜ pending |
| **SUMP-01** | Interface exports | unit | ⬜ pending |
| **SUMP-02** | `NoopSummaryProvider` returns `{ summary: '', replaced_turn_ids: [] }` | unit | ⬜ pending |
| **SUMP-03** | `has_pending_tool_call: true` → `summarize()` returns null | integration | ⬜ pending |
| **P4-02 BLOCK** | 10 parallel `appendTurn` → turn_index 1..10 no gaps | integration | ⬜ pending |
| **P6-01 BLOCK** | Tool-call turn sets `has_pending_tool_call=true` + skips summary | integration | ⬜ pending |
| **P9-01 BLOCK** | Migration 0006 SQL + Drizzle schema + journal entry indivisible | unit | ⬜ pending |
| **SC-1** | Two requests same X-Session-ID → second response shows awareness | integration | ⬜ pending |
| **SC-2** | Different agent_id → empty history | integration | ⬜ pending |
| **SC-3** | Long session + small ctx_size → no backend 400 | integration | ⬜ pending |
| **SC-4** | Stateless mode preserved | integration + golden | ⬜ pending |
| **SC-5** | Header set + Noop never calls model | integration | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `router/tests/providers/session-store.interface.test.ts`
- [ ] `router/tests/providers/postgres-session-store.test.ts` (SESS-02..04 + P4-02)
- [ ] `router/tests/providers/context-provider.test.ts` (CTXP-01..04 + P4-04)
- [ ] `router/tests/providers/summary-provider.test.ts` (SUMP-01..03 + P6-01)
- [ ] `router/tests/routes/session-attach.integration.test.ts` (SESS-05/06 + SC-1..5 across all 3 routes)
- [ ] `router/tests/integration/migrations/0006-sessions.test.ts`
- [ ] `router/tests/db/migration-journal.test.ts` (P9-01 indivisible-tuple grep gate)
- [ ] `router/tests/config/registry-ctx.test.ts` (CTXP-04 Zod widening)
- [ ] `bin/smoke-test-router.sh` new SESSION section

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| n8n maintains multi-turn conversation via `X-Session-ID` | SC-1 | Requires live n8n workflow | After Phase 17 merge: in n8n, set up a Chat Trigger → OpenAI node with `X-Session-ID` set to a stable per-conversation id; verify the second message shows context awareness. |

---

## Validation Sign-Off

- [ ] All 13 REQs + 3 BLOCK pitfalls covered by automated tests
- [ ] No watch-mode flags in CI
- [ ] Feedback latency < 30 s
- [ ] `nyquist_compliant: true` after Wave 0 ships

**Approval:** pending
