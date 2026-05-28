# Project Retrospective: local-llms

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
