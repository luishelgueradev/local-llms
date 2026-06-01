---
phase: 19
slug: embeddingprovider-formalization-observability-hardening
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-01
---

# Phase 19 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from `19-RESEARCH.md` §"Validation Architecture".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest `^3.x` (already in repo; pinned by `router/package.json`) |
| **Config file** | `router/vitest.config.ts` (glob `tests/**/*.test.ts` already matches new files — verified by research §6) |
| **Quick run command** | `cd router && npx vitest run --reporter=default tests/providers/embedding-provider.test.ts tests/integration/cardinality-live.integration.test.ts tests/unit/grep-gates/embeddings-untouched.test.ts tests/routes/embeddings.test.ts` |
| **Full suite command** | `cd router && npm test` |
| **Smoke command** | `bash bin/smoke-test-router.sh` (set `OLLAMA_API_KEY` to exercise `RESS-WITH-TOOLS`; absent ⇒ soft-skip) |
| **Estimated runtime** | Quick ~1.5s · Full ~25s vitest · Smoke ~30s end-to-end |

---

## Sampling Rate

- **After every task commit:** Run the quick command above (4 files; sub-second turnaround on cold cache).
- **After every plan wave:** Run `cd router && npm test` (full vitest sweep — expect ≥1220 passes including Phase 19 additions).
- **Before `/gsd:verify-work`:** Full vitest GREEN **AND** `bash bin/smoke-test-router.sh` exit 0 with `OLLAMA_API_KEY` set so `RESS-WITH-TOOLS` exercises the real cloud path.
- **Max feedback latency:** ~2s for the quick command; ~30s for the smoke pass.

---

## Per-Requirement Verification Map

| Req ID | Behavior | Test Type | Automated Command | File Exists | Status |
|--------|----------|-----------|-------------------|-------------|--------|
| **EMBP-01** | Interface `EmbeddingProvider` exposed via `fastify.decorate('embeddingProvider', ...)` with the locked `embed(input, opts) → { embeddings, model, usage }` signature | vitest unit (`expectTypeOf` + runtime shape across string/array inputs) | `npx vitest run tests/providers/embedding-provider.test.ts` | ❌ W0 — new `router/tests/providers/embedding-provider.test.ts` | ⬜ pending |
| **EMBP-02** | `/v1/embeddings` route delegates to provider; wire shape, dims enforcement, cache, X-Cost-Cents BYTE-IDENTICAL to Phase 12 baseline | (a) vitest regression `tests/routes/embeddings.test.ts` (30+ existing cases pass)<br>(b) P7-01 SHA-256 baseline updated atomically (`tests/unit/grep-gates/embeddings-untouched.test.ts`)<br>(c) smoke Phase 7 EMBED-01 + Phase 12 EMB-H01..06 still PASS | `npx vitest run tests/routes/embeddings.test.ts tests/unit/grep-gates/embeddings-untouched.test.ts && bash bin/smoke-test-router.sh` | ✅ vitest files + smoke gates exist | ⬜ pending |
| **OBSV-01** | Smoke covers MCP host + `/v1/responses` stream WITH **and** WITHOUT tools + SessionStore round-trip | Cite-only banners (Phase 15 MCP-01..03, Phase 17 SESSION SC-1..SC-4) + NEW `RESS-WITH-TOOLS` smoke gate (function-call delta + `incomplete: tool_calls` final event) | `bash bin/smoke-test-router.sh` (RESS-WITH-TOOLS soft-skips when `OLLAMA_API_KEY` absent or model missing from `models.yaml`) | ✅ MCP + Session gates exist; ❌ W0 — RESS-WITH-TOOLS new gate | ⬜ pending |
| **OBSV-02** | Live `/metrics` cardinality CI gate; FAILS on any label name ending in `_id` | (a) vitest integration `cardinality-live.integration.test.ts` boots `buildApp(...)`, `inject({GET,/metrics})`, asserts `violations.length === 0`<br>(b) NEW smoke gate `OBSV-02-LIVE` (`curl /metrics \| node check-prometheus-cardinality.ts --live -`) | `npx vitest run tests/integration/cardinality-live.integration.test.ts` + smoke gate | ❌ W0 — new vitest file + new smoke gate + new `checkCardinalityLive` export | ⬜ pending |
| **OBSV-03** | README + DEPLOY document MCP host/client + sessions + hooks + policy + scoped IDs + EmbeddingProvider; v0.11.0 SHIPPED banner flipped | Manual review + grep gates for required headings (Phase 14/15/17/18 sections already present; only EmbeddingProvider section + banner flip new) | `grep -E '^## EmbeddingProvider' DEPLOY.md README.md && grep -E '## Estado.*v0\.11\.0.*✅' README.md` | ❌ W0 — new doc sections + banner flip | ⬜ pending |
| **OBSV-04** | Migration 0007 `hook_log` JSONB column verified in live Postgres (re-verification of Plan 18-02 deliverable; **NO** new migration) | vitest PG-gated integration — EXTEND existing file with Phase 19 describe block | `PG_TESTS=1 POSTGRES_URL=... npx vitest run tests/integration/migrations/0007-hook-log.test.ts` | ✅ file exists (7 cases) — extend, do not create | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `router/src/providers/embedding-provider.ts` — interface + factory (NEW source file — landing in Wave 1 or 2)
- [ ] `router/src/types/fastify.d.ts` — `FastifyInstance.embeddingProvider` augmentation (NEW; create `router/src/types/` directory)
- [ ] `router/tests/providers/embedding-provider.test.ts` — conformance test placeholder (Wave 0 stub; Wave 1 flips to real)
- [ ] `router/tests/integration/cardinality-live.integration.test.ts` — live `/metrics` parse + assert placeholder (Wave 0 stub; Wave 1 fills)
- [ ] `router/tests/fakes.ts` — add `makeFakeEmbeddingProvider(opts)` builder (Wave 0 — mirror Phase 17 fakes patterns)
- [ ] Extension to `router/scripts/__tests__/check-prometheus-cardinality.test.ts` — new describe block for `checkCardinalityLive` with hand-rolled exposition fixtures (Wave 0 placeholder)
- [ ] Extension to `router/tests/integration/migrations/0007-hook-log.test.ts` — Phase 19 OBSV-04 re-verify describe block
- [ ] `bin/smoke-test-router.sh` — new Phase 19 section: `RESS-WITH-TOOLS` gate + `OBSV-02-LIVE` gate + 4 cite-only lines, inserted between line ~2538 (Phase 18 section end) and ~2544 (summary banner)
- [ ] `DEPLOY.md` — new §"EmbeddingProvider (Phase 19 — v0.11.0)"
- [ ] `README.md` — new §"EmbeddingProvider (v0.11.0)" + flip "Estado del proyecto" v0.11.0 row to ✅

*Framework install: none needed — vitest already in repo (`router/package.json`).*

---

## Cross-Phase Regression Dependencies (MUST still PASS after Phase 19)

| Prior-phase gate | What it verifies | Phase 19 risk | Mitigation |
|------------------|------------------|---------------|------------|
| `tests/routes/embeddings.test.ts` (30+ cases — Phase 7 + Phase 12) | Wire shape + cache + dims + capability gate | Route refactor must preserve all wire-level behavior | Provider is a thinner layer; route still owns wire shape + base64 + X-Cost-Cents. Re-run the existing suite unchanged. |
| `tests/unit/grep-gates/embeddings-untouched.test.ts` (P7-01 BLOCK) | SHA-256 of route file | MUST update baseline atomically with route diff | D-24 rule: baseline rotation + route refactor land in the **same commit**; never split. |
| `bin/smoke-test-router.sh` Phase 7 EMBED-01 gate (line ~1362) | Live 1024-dim vector return | Same wire shape — provider returns through route unchanged | Smoke re-runs; gate is wire-shape only. |
| `bin/smoke-test-router.sh` Phase 12 EMB-H01..06 gates (line ~1846) | Cache hit/miss/bypass + dims metric | Cache ownership moved to provider; metric names + label sets UNCHANGED | Metric names (`router_embeddings_cache_total{result}`, `router_embeddings_dims_total{model,dims}`) and labels frozen. |
| `tests/db/migration-journal.test.ts` (P9-01 BLOCK) | Migration journal atomic-tuple | Phase 19 ships NO new migration (D-22) | Vacuously satisfied. |
| `tests/integration/migrations/0007-hook-log.test.ts` (existing 7 cases) | Plan 18-02 migration 0007 invariants | Phase 19 EXTENDS this file | Existing describe blocks stay; new describe block added at bottom. |
| `tests/unit/grep-gates/no-default-retriever.test.ts` (Frame-01) | No `class \w+RetrieverProvider` in `router/src/` | EmbeddingProvider is NOT a RetrieverProvider | Provider returned by factory is an **object literal**, not a class — Frame-01 spirit preserved. Gate unaffected. |
| `scripts/__tests__/check-prometheus-cardinality.test.ts` (5 cases) | Static-source cardinality scan | Phase 19 ADDS a new `checkCardinalityLive` export | Existing `checkCardinality` (static) export stays unchanged; existing tests stay green. |
| Phase 17 SESSION SC-1..SC-4 smoke gates | Session round-trip | Phase 19 does not touch session code | Vacuous. |
| Phase 18 P5-01..P5-05 + P2-01..P2-05 BLOCK gates | Hook config + MCP client invariants | Phase 19 does not touch hook or MCP code | Vacuous. |

---

## Security Domain

> `security_enforcement` default = enabled (no override in `.planning/config.json`).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Phase 19 does not touch bearer auth (`makeBearerHook` already gates `/v1/embeddings`). |
| V3 Session Management | no | Phase 17 closed sessions; Phase 19 orthogonal. |
| V4 Access Control | partial | `applyPreflight` (Phase 15) gates policy + breaker UPSTREAM of `provider.embed(...)`. D-04 reaffirms route runs preflight BEFORE the provider call. |
| V5 Input Validation | yes | `EmbeddingsRequestSchema` (zod) stays at the route boundary — provider receives validated inputs. |
| V6 Cryptography | no | SHA-256 in P7-01 is integrity-checking, not security-cryptography. |
| V8 Data Protection | partial | `request_log.cost_cents` + `request_log.error_message` write paths unchanged — no new PII surfaces. |
| V9 Communication | no | No new outbound calls (cloud key threaded by Phase 8). |
| V10 Malicious Code | no | Zero new npm packages — supply chain unchanged (research §1). |

### Threat → Mitigation Map

| Pattern | STRIDE | Mitigation in Phase 19 |
|---------|--------|------------------------|
| **Wrong-dim vector poisoning** (provider returns vectors mismatching `entry.dims`) | Tampering | D-03: `EmbeddingsDimsMismatchError` throw INSIDE the provider — single source of truth. Future `RetrieverProvider` consumers cannot bypass; they cannot reach upstream adapter without going through `provider.embed(...)`. |
| **High-cardinality Prometheus labels** (label values only appear at runtime) | Denial-of-Service via metric blowup | OBSV-02 live-parse gate (D-13/D-14/D-15): CI test scrapes `/metrics` from a real `buildApp(...)` and rejects any `_id` label. Catches drift CI static gate would miss. |
| **Wire-shape regression breaks n8n consumers** | Tampering / Availability | Four-layer defense: P7-01 SHA-256 baseline + Phase 7 EMBED-01 smoke + Phase 12 EMB-H01..06 smoke + `tests/routes/embeddings.test.ts` regression. |
| **Cloud function-call cost runaway in smoke** | Denial-of-Wallet (operator) | RESS-WITH-TOOLS uses `gpt-oss:20b-cloud` (5× cheaper than 120b sibling). Trigger prompt ~50 tokens. Per-smoke-run cost bounded ~$0.001. Skip predicate when `OLLAMA_API_KEY` absent. |

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| OBSV-03 doc prose reads correctly for an operator | OBSV-03 | Doc copy quality is subjective | Operator-read of new DEPLOY EmbeddingProvider section + README EmbeddingProvider section; cross-reference Phase 17/18 section voice for consistency. |
| v0.11.0 SHIPPED banner visual fits existing "Estado del proyecto" table style | OBSV-03 | Markdown table layout cosmetics | Render README locally; confirm v0.11.0 row matches v0.9.0 / v0.10.0 row format. |

*Everything else has automated verification.*

---

## Validation Sign-Off

- [ ] All requirements have ≥1 automated test (vitest, smoke gate, or grep gate)
- [ ] Sampling continuity: no 3 consecutive tasks land without an automated verification step
- [ ] Wave 0 covers all MISSING test files (placeholders) before Wave 1 starts
- [ ] No `vitest --watch` in CI commands
- [ ] Feedback latency < 30s (quick command sub-2s, smoke ~30s)
- [ ] `nyquist_compliant: true` set in frontmatter after plan-checker validates Dimension 8

**Approval:** pending
