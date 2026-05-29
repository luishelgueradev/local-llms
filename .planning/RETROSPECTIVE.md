# Project Retrospective: local-llms

## Milestone: v0.10.0 — Cognitive Primitives — Structured outputs · Reranker · Embeddings hardening · Cost obs + Responses API

**Shipped:** 2026-05-29
**Phases:** 4 (10–13) | **Plans:** n/a (freeform single-shot commit per phase) | **Requirements:** 26/26
**Timeline:** 2026-05-29 (single-day milestone; bootstrap commit + 4 phase commits)
**Repo stats:** 4 commits · 48 files changed · +4,187 / -65 LOC · 4 `feat` + 0 `fix` commits

### What Was Built

Capacidades cognitivas reusables sobre el router v0.9.0 — *primitives, not solutions*. Cuatro piezas que cierran gaps recurrentes en clientes modernos: (a) JSON mode con AJV + repair retry (Phase 10), (b) reranker `/v1/rerank` Cohere-compat sobre cross-encoders vía Ollama (Phase 11), (c) embeddings cache + dims contract + métricas (Phase 12), (d) cost telemetry `cost_cents` + `X-Cost-Cents` header + `cost_per_agent_daily` view + minimal `/v1/responses` no-stream surface (Phase 13 — cierra el n8n "Message a Model" 404 permanentemente).

### What Worked

- **Freeform single-shot pattern.** Each phase shipped as ONE atomic `feat(NN):` commit with implementation + tests + smoke section + docs. 4 commits total, no per-phase planning artifacts. The pattern fits when phases are small-scope (5-10 requirements each) and independently shippable — the GSD discipline of v0.9.0 (76 reqs / 55 plans / 112 tasks across 9 phases) would be overkill here. Pragmatic choice for the milestone's scale.
- **Canonical seam paid off again.** `/v1/responses` (Phase 13) reused `adapter.chatCompletionsCanonical` via a Responses↔canonical translator pair — no duplication of the 800-LOC chat-completions pipeline. Same plumbing (auth, breaker, semaphore, idempotency, request_log, X-Cost-Cents) shared end-to-end. The fact that adding a third wire surface needed ~370 LOC (responses.ts) + ~50 LOC translator is the dividend on the v0.9.0 canonical investment.
- **Registry capability gates kept new endpoints honest.** `json_mode` (Phase 10), `rerank` (Phase 11), `dims` (Phase 12), `chat` (RESP-04 in Phase 13) — every new behavior gets a registry capability + a route-side gate + an integration test asserting the 400 envelope. Adding the rerank-only model `bge-reranker-local` immediately broke the chat tests (caught at type-check time via the discriminated enum) — that's the test we want.
- **Cost helper as pure function.** `computeCostCents(entry, tokensIn, tokensOut)` lives in its own module with 8 unit tests covering null contract + formula derivation. Wiring it into 5 routes (chat-completions stream/non-stream/follower, messages stream/non-stream/follower, embeddings, rerank, responses) was a one-line call each — the helper's purity made the cost-of-coverage trivial.
- **Smoke section template.** The Phase 12 + 13 smoke sections in `bin/smoke-test-router.sh` follow the exact same pattern as Phase 7/8 — scrape /metrics → make a call → scrape /metrics → assert delta. Reusable mental model, easy to extend for v0.11.

### What Was Inefficient

- **Discovered Fastify v5 onSend timing the hard way.** First Phase 13 implementation stamped `req.computedCostCents` in the route's `finally` block — but Fastify v5 fires `onSend` SYNCHRONOUSLY inside `reply.send()`, BEFORE the try/finally's return-trigger. Required restructuring all 5 routes to stamp the value BEFORE `reply.send()`. Cost: ~30 min of debug + 5 mechanical refactors. Lesson: when wiring response headers from a hook, verify hook timing against `reply.send()` semantics with a sentinel BEFORE committing.
- **Fake adapters returning 1 vector for batch input.** Three test fixtures (`x-model-backend.test.ts`, `cloud-max-tokens-integration.test.ts`, `idempotency-integration.test.ts`) had `async embeddings() { return data: [{ ... }] }` — single result regardless of input shape. Worked pre-Phase-12 because the route was a passthrough; broke immediately when the new route added a count-mismatch defense. Lesson: when widening a route's defenses, audit fake adapters in the same change.
- **Embeddings models missing `dims` in test fixtures.** Making `dims` required on the registry (the right call — that's the EMB-H02 contract) immediately broke 6 test YAMLs that had `capabilities: [embeddings]` without `dims:`. Mechanical fix but caught only by running the full suite — a stricter unit test on the registry schema would have surfaced this sooner. Lesson: when adding a `superRefine` rule, prebake a unit test against a deliberate violating fixture before touching the consuming routes.
- **Two cloud model pricing values are placeholders.** `models.yaml` declares $0.50 / $1.50 per 1M tokens for `gpt-oss:120b-cloud` and $0.10 / $0.30 for `gpt-oss:20b-cloud` — conservative guesses, not Ollama's published rates (Ollama Cloud doesn't publish per-model pricing as of 2026-05). The router computes cost faithfully but the absolute numbers are operator-set. Acknowledged in `models.yaml` comment + STATE.md deferred section — not a defect, just incomplete data.

### Patterns Established

- **Single-shot freeform commit per phase** (this milestone): full implementation + tests + smoke + docs in one `feat(NN):` commit. Best for small-scope phases. Documented in the close-time audit so future milestones can pick the right pattern by scope.
- **Compute-cost-before-send + record-cost-in-finally**: the route stamps `req.computedCostCents` BEFORE `reply.send()` (header path) AND passes the same value to `safeRecord(...)` in finally (request_log row path). Same value, two emissions; cost helper is called twice but it's pure + cheap.
- **`X-Cost-Cents` survives the edge**: response header pattern that survives Cloudflare Tunnel + Traefik forward-headers — verified live for `big-cloud` through `https://local-llms.luishelguera.dev`. Trust the existing `X-Model-Backend` precedent: if Traefik passes one, it passes others.
- **Drizzle migration journal as authoritative**: `db/migrations/meta/_journal.json` had to be updated alongside the new SQL files. Without that, drizzle's migrator ignores files not in the journal. Captured this as a pre-commit reminder in the migration template comments.

### Key Lessons

1. **Hook timing > intuition.** Fastify v5's `onSend` fires inside `reply.send()`, not after the route's promise resolves. When stamping per-request data for hooks, set it BEFORE `.send()`, not in `finally`. This is a Fastify-v5-specific behavior worth documenting at the project level.
2. **Small phases want small ceremony.** v0.9.0's GSD discipline (4 docs per phase × 9 phases = 36 planning artifacts) was load-bearing for that scope. v0.10.0's 4 phases × 5-10 reqs each shipped cleanly as 4 commits with zero planning docs. The framework should accommodate both — and the choice is the operator's based on scope, not a default.
3. **`/metrics` scraping IS the smoke oracle for counters.** The Phase 12 smoke section reads `router_embeddings_cache_total{result="hit"}` before AND after two identical calls, asserts the delta. This pattern is more reliable than parsing log lines and works for any prom-counter you add — make it the default smoke template for any new metric.
4. **Cost numbers are operator data, not router data.** The router computes correctly from declared pricing. The pricing values themselves come from the operator's view of upstream rates (Ollama Cloud doesn't publish a stable table). Document this distinction in `models.yaml` + retrospective; don't pretend the placeholder numbers are real.
5. **Migration files + schema columns + journal entry are an indivisible unit.** All three got added in this milestone (cost_cents column + cost_per_agent_daily view); forgetting any one would have meant a silent skip at boot. Future migrations should be code-reviewed as a tuple, not file-by-file.

### Cost Observations

- **Model mix:** primarily Claude Opus 4.7 for end-to-end milestone autonomy (planning, code-archeology, integration-test design, doc drafting). No sub-agent delegation needed at this scale — the milestone fit in a single conversation context.
- **Sessions:** 1 session (this one). The user delegated full autonomy and the work completed end-to-end including milestone closure.
- **Notable efficiency:** the canonical seam from v0.9.0 dropped Phase 13's `/v1/responses` cost from "another 800 LOC of route logic" to "370 LOC of route + 50 LOC of translator" — a real concrete dividend on the architectural choice made 20 days earlier.

---

## Milestone: v0.9.0 — MVP — Router multi-backend con cloud fallback + observability + ops

**Shipped:** 2026-05-28
**Phases:** 9 | **Plans:** 55 | **Tasks:** 112 | **Requirements:** 76/76
**Timeline:** 2026-05-09 → 2026-05-28 (~20 days)
**Repo stats:** 498 commits · 404 files changed · +116,415 / -19 LOC · 105 `feat` + 109 `fix` commits

### What Was Built

Self-hosted OpenAI- and Anthropic-compatible HTTP router that unifies local GPU backends (Ollama / llama.cpp / vLLM) with Ollama Cloud as a declared `backend: ollama-cloud` entry. Production-grade resilience layer (circuit breaker, rate limit, `Idempotency-Key` multiplexer, `max_tokens` cap), full observability stack (Postgres `request_log` + `usage_daily` + `cloud_spend_daily` + Prometheus + Grafana), Traefik + Open WebUI edge, and ops runbooks (gc-models, restic backups, disk-alert, bearer-token rotation). Consumed in production by the user's n8n agents over Cloudflare Tunnel and by a local Whisper sidecar.

### What Worked

- **GSD framework discipline:** every phase had its own SPEC → discuss → plan → execute → verify cycle, with cross-phase integration audited at the end. Made it trivial to pick up after `/clear` or after multi-day pauses.
- **Phase-research artifacts (`*-RESEARCH.md`) catching pitfalls early:** Pitfall V-1 (vLLM sm_120 on RTX 5060 Ti), Pitfall 7 (WSL2 fs.watch debounce), Pitfall G-3 (libnvidia-ml in WSL2), Pitfall 14 (agent retry storms). Each pitfall surfaced **before** the corresponding plan tried to implement around it.
- **Canonical Anthropic-shape translation layer:** writing 9 golden round-trip fixtures *before* the bidirectional translators paid off massively — tool calling + vision + stream events in two protocols would be a debugging nightmare otherwise.
- **Smoke scripts as live oracle:** `bin/smoke-test-router.sh` + `bin/smoke-test-cloud.sh` caught the TTL/SSE/cloud spend defects long before they'd have hit production. Section 9 (DATA-06 registry cache) caught the boot-race that became 08-11.
- **`autonomous: false` plans as explicit human-verify checkpoints:** Phase 6/7/8 each had an `autonomous: false` final plan that required operator UAT (browser, vLLM cold-start, live smokes). This kept human-only work boxed and visible, instead of pretending the whole thing could be automated.
- **Atomic commits per task** with conventional commit prefixes (`feat(NN-NN)`, `fix(NN-NN)`, `test(NN-NN)`, `docs(NN-NN)`) made the 498-commit history navigable end-to-end.

### What Was Inefficient

- **Milestone audit staleness:** the 2026-05-17 audit listed 7 tech-debt items, of which 3 (TD-01, TD-04, TD-07) were closed in subsequent commits but never reflected back in the audit. The 2026-05-28 re-audit found this by checking the live code against each item; the lesson is that **a single mid-milestone audit is not authoritative at close time** — re-verify against `tsc --noEmit` and the actual test suite right before archiving.
- **VRAM accounting realism:** the original ROADMAP positioned a 14B local model as viable, but the actual 16 GB budget shared with a Whisper sidecar made it impossible (qwen2.5:14b q4 = 10.4 GB needed vs ~9.9 GB free → CPU offload → timeout). Required a mid-stream redesign to settle on qwen2.5:7b q4 as the workhorse + Ollama Cloud for heavy lifting. **Lesson:** measure VRAM with the actual cohabitants, not in isolation.
- **`models.yaml` hot-edit gotcha:** editing the file requires `valkey-cli DEL registry:models-yaml:cache:v1 && docker compose up -d --force-recreate router` — not `restart`. The combination of WSL2 single-file bind-mount inode-change + the 300s boot-warm cache (08-09 / 08-11) made simple edits silently no-op. Captured in memory but should be a runbook entry.
- **`/v1/responses` blind spot:** n8n's OpenAI "Message a Model" node uses the newer Responses API (`/v1/responses`) which the router doesn't implement. The fix path was to set `responsesApiEnabled: false` on the LangChain "OpenAI Chat Model" node — but that's a workaround, not a real fix. If clients adopt Responses API more broadly, the router needs that surface (out of scope for v0.9.0).
- **Cloudflare AI-bot block surprise:** Cloudflare's "Block AI bots" default rule 403s the `User-Agent: OpenAI/NodeJS` UA string. Not the router's fault but caused real n8n integration time. Captured in tunnel memory.

### Patterns Established

- **Canonical-shape internal protocol** (Anthropic-superset), with strict separate translators per inbound + outbound protocol. Avoids the "two-protocol bidirectional translation" hell pattern.
- **Per-route `req.resolvedBackend` stamp + single `onSend` hook** for `X-Model-Backend` header. One source of truth for "which backend served this".
- **Boot-warm Valkey cache + file-source-of-truth fallback** pattern (DATA-06). Schema-validated on every cache read (`safeParse` → null on tamper → file fallback).
- **`response_log.backend` set from RESOLVED entry, not from client claim.** Honest audit even if the client lies on the wire (T-08-E-02).
- **`bin/smoke-*.sh` as live integration oracle** — each script exercises an entire phase's requirements end-to-end against the running stack, with `pre-seed Valkey state` instead of burst loops to keep them deterministic.
- **`autonomous: false` plan frontmatter as explicit human-verify gate** — distinguishes "tests pass" from "operator confirmed on real hardware/browser".

### Key Lessons

1. **Re-audit at close time.** Mid-milestone audits go stale fast on a 20-day milestone with 498 commits. Treat the close-time re-audit as the authoritative one and use it to mark TD items resolved-after-the-fact.
2. **Measure VRAM with cohabitants.** A 7B q4 local + bge-m3 + Whisper sidecar fits in 16 GB; a 14B q4 does not. Spec the local-model envelope after accounting for what else lives on the GPU.
3. **Hot-reload + bind-mount + boot-warm cache** = subtle gotcha. When in doubt, force-recreate the container and invalidate the cache key, not `restart`.
4. **Clients evolve faster than this router.** The OpenAI Responses API arrived during this milestone and broke an integration that should have "just worked." A v2 milestone should consider how to track upstream API drift.
5. **Cloudflare/edge defaults bite specific UAs.** When adding an HTTPS tunnel, sanity-check what the edge does to bot-fingerprinted User-Agents — even when the origin is your own service.

### Cost Observations

- **Model mix:** primarily Claude Opus (planning, deep code-archeology); Sonnet for executor sub-agents (autonomous task execution); minimal Haiku usage.
- **Sessions:** ~30+ sessions across 20 days; heavy use of `/clear` between phase boundaries kept context lean.
- **Notable efficiency:** delegating phase execution to `gsd-executor` sub-agents (fresh 200K context per plan) instead of running everything in the orchestrator. Plans of 3-4 atomic tasks fit cleanly inside a sub-agent without context exhaustion.

---

## Cross-Milestone Trends

*(Will populate as more milestones ship. v0.9.0 is the baseline.)*

| Milestone | Phases | Plans | Days | Commits | LOC delta | Notes |
|-----------|--------|-------|------|---------|-----------|-------|
| v0.9.0 | 9 | 55 | 20 | 498 | +116,415 | MVP — first ship; established the GSD discipline + smoke-as-oracle pattern |
| v0.10.0 | 4 | n/a (freeform) | 1 | 4 | +4,187 | Cognitive Primitives — freeform single-shot pattern paid the dividends of v0.9.0's canonical seam (370 LOC of new route reuses 800 LOC of shared plumbing). Caught a Fastify v5 onSend timing quirk that v0.9.0 hadn't surfaced |
