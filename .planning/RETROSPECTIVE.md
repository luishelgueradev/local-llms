# Project Retrospective: local-llms

## Milestone: v0.12.0 — External Consumer DX + Catalog Hygiene — Dead-catalog cleanup · Health-aware `/v1/models` · Naming taxonomy decision · Backward-compat alias layer · Deploy hygiene · Post-ship hygiene closure

**Shipped:** 2026-06-03
**Phases:** 2 (20-21) | **Plans:** 9 | **Requirements:** 13/13 (CAT × 4 + CDX × 3 + OPS × 2 + HYG × 4)
**Timeline:** 2026-06-03 (single-day milestone — opened 03:24 UTC, audit passed 20:12 UTC)
**Repo stats:** 42 commits · 76 files changed · +11,180 / -128 LOC · 8 `feat` + 5 `fix` + 29 `docs` commits

### What Was Built

A consumer-facing surface that lets external projects (artiscrapper, n8n in `objetiva.com.ar`, Unsloth Studio, Hermes Agent) discover and pick aliases programmatically without trial-and-error: additive `health` + `recommended_for` + `recommendations` map on `/v1/models`; backward-compat alias infrastructure ready but disarmed per D-02 LOCKED (deprecated_aliases empty in v0.12.0, ready for v0.13.0+ renames with ≥30-day grace); formalized deploy hygiene (`bin/deploy-router.sh` + Dockerfile BUILD_SHA bake + new `/version` endpoint) that eliminates the 19-09-class skew-bug failure mode; and a post-ship hygiene closure (Phase 21) that closed 4 audit findings (cold-load timeout 45s→180s, curl in runtime image, smoke Phase 3/7 soft-skips, vitest testTimeout 10s) plus a companion SSE retry-preamble fix (commit `e113192`) that unblocked every strict-JSON streaming SDK consumer on day-one.

### What Worked

- **SEED-001 as the milestone's bootstrapping artifact.** The seed was planted 2026-06-03 during a `/gsd:progress` session right after `artiscrapper` exposed three failure categories on the live router. It captured the diagnosis BEFORE any planning happened, so when the milestone opened the scope was already locked: three categories of consumer friction + deploy hygiene → 9 requirements. The seed → milestone → roadmap chain shipped in <2 hours of human time across discuss/plan/execute.
- **D-02 LOCKED ("two taxonomies coexisting on purpose").** The decision to NOT rename anything in v0.12.0 — and instead ship the backward-compat infrastructure disarmed — saved this milestone from being a breaking-change cycle for live consumers (n8n on Cloudflare Tunnel, Unsloth Studio, artiscrapper). The deprecation infrastructure is ready; the renames will come in v0.13.0+ when the operator decides which renames are worth the grace period. Decision-by-not-deciding turned out to be the right move because consumer cost was higher than maintenance cost.
- **Gap-closure phase as a known pattern.** Phase 21 mirrors Phases 19-08/19-09 — open a small post-ship phase inside an already-shipped milestone to close audit findings BEFORE archiving. Worked again here: CONTEXT.md authored with all decisions LOCKED (no discuss-phase needed), 2 plans executed inline, 1 VERIFICATION doc, milestone close happened with all reqs CLOSED instead of with deferred-items carrying forward.
- **Audit-driven Phase 21 + companion SSE hot-fix mid-session.** Phase 21 was triggered by an unattended audit that flagged 4 specific findings. The audit findings became HYG-01..04 verbatim — no scope creep. Mid-session, a Claude Code installing the Hermes Agent surfaced a separate critical SSE bug (`retry: 3000\n\n` preamble breaking openai-python + Hermes + n8n LangChain streaming). The fix was tiny (single Fastify plugin option) but high-leverage; landed on the same chain as Phase 21 commits without retro-classifying as a REQ (HYG-05 candidate documented in the audit).
- **Retroactive SUMMARYs for milestone audit cleanliness.** Phase 21 executed inline (no per-plan PLAN.md/SUMMARY.md) because CONTEXT.md was the source of truth and all decisions were LOCKED. When `/gsd:audit-milestone v0.12.0` ran its 3-source cross-reference, the missing SUMMARY frontmatter would have flagged HYG-01..04 as "partial". Solution: write retroactive `21-01-SUMMARY.md` + `21-02-SUMMARY.md` faithful to actual commits + VERIFICATION evidence + patterns established. Audit then passed clean. The retroactive SUMMARYs are a legitimate audit-trail artifact, not a fiction.
- **Live router as the verification oracle.** Every Phase 21 fix was verified end-to-end against the live router (build SHA `a72d86c`): cold-load probe HTTP 200/84s; `docker exec router curl --version` curl 7.88.1; smoke Phase 3 SKIP-OK + Phase 7 all-PASS; vitest 1355/0; SSE stream starts at `data:` not `retry:`. The 4 v0.11.0-era invariants (P7-01 SHA, POL-06 zero `_id$`, MCPS-06, RESS-WITH-TOOLS) were re-verified live in the milestone audit, not just trusted from prior phase docs.

### What Was Inefficient

- **`/gsd:complete-milestone` CLI auto-generated a corrupted MILESTONES.md entry.** The `gsd-sdk milestone.complete` query pulled `requirements-completed` strings from ALL phase SUMMARYs (including v0.11.0 phases 14-19) into the v0.12.0 entry. Worse, several entries appeared as literal `"One-liner:"` placeholders because the `summary-extract --pick one_liner` fell through on phases without a clean one-liner. Required a manual full rewrite of the MILESTONES.md v0.12.0 section to match the v0.9.0/v0.10.0 format. **Lesson:** the auto-aggregator works for milestones where every phase has well-formed SUMMARY one-liners; treat its output as a draft, not authoritative.
- **`/gsd:complete-milestone` archived files but didn't reorganize ROADMAP.md.** The `gsd-sdk milestone.complete` query correctly moved ROADMAP.md → `milestones/v0.12.0-ROADMAP.md` BUT left the active ROADMAP.md untouched (still showed v0.12.0 as in-progress with full phase details). The workflow's `reorganize_roadmap_and_delete_originals` step still requires AI to rewrite the active file with collapsed `<details>` blocks. **Lesson:** the workflow split between CLI-delegated (archive files) and AI-handled (reorganize active files + commit) is documented but easy to miss — check the active file after the CLI runs.
- **No `*-VALIDATION.md` (Nyquist) artifacts.** Neither Phase 20 nor Phase 21 produced a VALIDATION.md. v0.11.0 and prior also shipped without these — the Nyquist gate is a recent GSD convention. Documented in the audit doc as discovery-only; not blocking. **Lesson:** if formal Nyquist discipline becomes the standard, add a `gsd-validate-phase` invocation to the phase wrap-up checklist BEFORE the milestone close, not retroactively.
- **Phase 21 had no per-plan PLAN.md files.** CONTEXT.md was the explicit source-of-truth for execution (decisions LOCKED, no discuss-phase needed). Worked fine in practice — the executor used CONTEXT, the work shipped — but the milestone audit had to be helped by retroactive SUMMARYs because the 3-source cross-reference relied on SUMMARY frontmatter. **Lesson:** for gap-closure phases with LOCKED CONTEXTs, either (a) generate cheap PLAN.md stubs upfront OR (b) make the audit's SUMMARY cross-reference fall back to commit messages with REQ-ID tags as a third path.
- **Smoke driver wall-clock flakes were not Phase 21's problem to solve.** Live smoke surfaces ~14 transient FAILs on fresh-rebuild runs (Phase 4/5/8/15/16/17/21 sections) because probes hit the router before Ollama finishes warming. Each contract holds when probed individually post-warmup — pre-existing, not v0.12.0 regression. Documented in the audit as tech debt. **Lesson:** scope-clarity at audit time matters — the audit doc has to be explicit about what's a v0.12.0-introduced flake vs a pre-existing one the milestone exposed; downstream readers will assume otherwise.

### Patterns Established

- **Additive-only `/v1/models` field surface.** `health`, `recommended_for`, `recommendations` are all OPTIONAL fields old consumers ignore. Pattern: extend the schema with `.optional()`, add the field after computation, never strip existing fields. v0.13.0+ renames will follow the same pattern via `deprecated_aliases:` block.
- **Operator-declared wins over auto-derived.** For both `recommended_for` per-entry and the top-level `recommendations` map, the model is: if the operator declared it, use it; if not, derive from capabilities. Single source of truth, explicit override path, no surprise.
- **Anti-leak via shared error envelopes.** T-20-01: when an alias is `disabled`, `/v1/models` filters it out AND `resolve()` returns the EXACT same 404 envelope as a fully-unknown alias. Consumers cannot enumerate disabled aliases via error-message inspection. Pattern reusable for any future "hidden but present" entry.
- **Audit findings → REQ IDs verbatim.** Phase 21's HYG-01..04 are 1:1 with the post-Phase-20 audit's 4 findings. No reinterpretation, no scope creep. The audit IS the requirements doc for the gap-closure phase.
- **Companion fix on the same commit chain, not a REQ.** Commit `e113192` (SSE fix) lands between Phase 20 ship and Phase 21 Plan 21-01 commit. Documented in 21-VERIFICATION.md as "outside the audit findings but materially closes a launch blocker" with explicit HYG-05-candidate language. Trade-off accepted: zero audit-trail muddying vs zero pretending it's part of the findings.
- **Retroactive SUMMARY.md as legitimate audit-trail artifact.** When a phase executes inline against a LOCKED CONTEXT, writing the SUMMARYs after-the-fact (faithful to actual commits + VERIFICATION evidence + patterns established during execution) is OK. The SUMMARYs aren't fiction; they're documentation of decisions and outcomes that already happened. Distinguished from "fake SUMMARY to game audit" by being authored from real artifacts.

### Key Lessons

1. **Decision-by-not-deciding is sometimes the right call.** D-02 LOCKED ("two taxonomies coexisting on purpose, no renames in v0.12.0") was the highest-leverage decision in the milestone. The infrastructure to deprecate aliases shipped fully wired but with an empty `deprecated_aliases:` block. v0.12.0 was the consumer-DX milestone WITHOUT being the breaking-change milestone — both at once. Future milestones should ask: "is this the right milestone to use this infrastructure, or does it ship better disarmed?"
2. **Audit-driven gap-closure phases are cheap and correct.** Phase 21 took ~2 hours of human time (1 inline execution + verification + audit). The alternative — accepting the 4 findings as deferred-items at v0.12.0 close — would have left the cold-load 504 bug live in production while the milestone was archived "complete". The HYG- prefix + LOCKED CONTEXT pattern makes these phases mechanical to execute.
3. **The companion-fix problem is real and needs a name.** A critical bug surfaces mid-session (Hermes Agent SSE break). It's not in the audit findings. It's not in the milestone's REQ set. But it's a launch blocker for a real consumer. The choice is: (a) shoehorn it into the milestone as a retro-REQ, (b) ship it as a hot-fix outside the milestone narrative, (c) defer it. The pattern that worked: (b) with explicit documentation in audit + migration guide + retro that it's an HYG-X candidate without claiming the REQ-ID. Future operators can decide later if the audit-trail-completeness premium is worth retro-classifying.
4. **The smoke driver under wall-clock contention is a class of flake, not a bug.** The same fs.watchFile-under-load root cause that HYG-04 addressed for vitest also affects `bin/smoke-test-router.sh`. ~14 transient FAILs on fresh-rebuild runs span Phase 4/5/8/15/16/17/21 sections. Each contract holds individually. The fix isn't another fix — it's hardening the test driver itself (raise per-probe `--max-time`, add explicit warmup gate). Candidate for a future hygiene milestone.
5. **Live router is the verification oracle.** Every Phase 21 gate was verified against the live `http://127.0.0.1:3210` router with deliberate probes (cold-load eviction + curl, `docker exec router`, vitest sweep, smoke Phase 3 SKIP message, SSE stream head). The 4 v0.11.0-era invariants were re-verified live in the milestone audit. Phase verification docs that don't include a live-router proof point are weaker; this should become a default expectation for gates that touch the dispatch path.
6. **CLI-delegated archive + AI-reorganized active files is a brittle split.** `gsd-sdk milestone.complete` archives files but leaves the active ROADMAP.md unchanged. The workflow's `reorganize_roadmap_and_delete_originals` step still requires AI work after the CLI runs. Easy to miss; easy to leave the active file out-of-sync. Future iteration: either CLI does both, or workflow makes the split impossible to miss with explicit gates.

### Cost Observations

- **Model mix:** Claude Opus 4.7 throughout — single-conversation milestone covering all of Phase 20 + Phase 21 + audit + close. No sub-agent delegation except for the milestone audit's `gsd-integration-checker` (returned `pass` on 13 wiring contracts).
- **Sessions:** 1 session (this conversation). Opened with the SSE Hermes prompt + Phase 21 execution; closed with the milestone archive + tag. Total wall-clock: ~17 hours (03:24 UTC milestone open → 20:48 UTC tag created), but actual human-time interaction much less (mostly autonomous execution).
- **Notable efficiency:** the LOCKED CONTEXT pattern (Phase 21's `21-CONTEXT.md` with all 4 findings + decisions pre-resolved) eliminated discuss/plan ceremony for the gap-closure phase. Phase 21 went CONTEXT → execute → verify → audit in one session.

---

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

*(Updated 2026-06-03 after v0.12.0 close.)*

| Milestone | Phases | Plans | Days | Commits | LOC delta | Notes |
|-----------|--------|-------|------|---------|-----------|-------|
| v0.9.0 | 9 | 55 | 20 | 498 | +116,415 | MVP — first ship; established the GSD discipline + smoke-as-oracle pattern |
| v0.10.0 | 4 | n/a (freeform) | 1 | 4 | +4,187 | Cognitive Primitives — freeform single-shot pattern paid the dividends of v0.9.0's canonical seam (370 LOC of new route reuses 800 LOC of shared plumbing). Caught a Fastify v5 onSend timing quirk that v0.9.0 hadn't surfaced |
| v0.11.0 | 6 | 49 | 4 | ~120 | +13,800 | Retrieval-Ready Infrastructure — MCP host + MCP client + sessions/context/summary + retriever hook + EmbeddingProvider + policy primitives. Established the "interfaces, not logic" frame: 5 provider seams shipped without any retrieval/memory implementation. Post-ship gap closure (19-08/19-09) for RESS-WITH-TOOLS prefigured the gap-closure-phase pattern v0.12.0 used in Phase 21 |
| v0.12.0 | 2 | 9 | 1 | 42 | +11,180 | External Consumer DX + Catalog Hygiene — D-02 LOCKED ("two taxonomies coexisting on purpose") was the highest-leverage decision; Phase 21 gap-closure pattern reused from v0.11.0; audit-findings-as-REQs (HYG-01..04 verbatim from audit); companion SSE fix landed mid-session for Hermes Agent unblock without retro-REQ-classification. First milestone where deferred-items entries were ALL pre-existing carry-overs at close (zero new debt introduced) |
