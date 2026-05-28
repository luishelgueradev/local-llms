---
gsd_state_version: 1.0
milestone: v0.9.0
milestone_name: milestone
status: completed
stopped_at: "Phase 9 Plan 03 (OPS-03 — disk-usage alert) COMPLETE. New bin/disk-alert.sh (307 LOC, executable, bash -n clean) — host-cron-driven df -P threshold check emitting one structured single-line log per invocation: `[disk-alert] LEVEL={INFO|WARN} target=... used_pct=... threshold_pct=... fs=... ts=... hostname=...` (key=value, grep/journalctl/Loki-friendly). Default threshold 80, range 1..99 asserted. Optional HTTP push hook on WARN (curl --fail -sS --max-time 10 POST to NTFY_URL); best-effort — curl failure does NOT fail the script + emits SECONDARY log line with url_host=<sed-extracted host only>. FULL NTFY_URL NEVER LOGGED (T-09-I-05). HARD-FAILS exit 1 when HOST_DATA_ROOT missing — NEVER falls back to / (T-09-D). NO auto-remediation (operator decides via OPS-01 GC / OPS-02 retention / ollama rm). CLI: --threshold N override + --help. .env.example gains Phase 9 section: DISK_ALERT_THRESHOLD_PCT=80 + optional NTFY_URL= with URL-IS-credential security note. README §Operations §### Disk-usage alert (OPS-03) — crontab recipe (15-min cadence), three alert sinks (stdout / NTFY / MAILTO-on-breach), sample INFO + WARN log lines, remediation pointers, v2 non-goals. 3 atomic commits: 9ba36b2 (feat) + 8a6f5e2 (docs env) + 9840daf (docs README). 0 deviations. OPS-03 closes. Phase 9 progress: 3/4."
last_updated: "2026-05-28T14:25:48.260Z"
last_activity: 2026-05-28 — Milestone v0.9.0 completed and archived
progress:
  total_phases: 9
  completed_phases: 9
  total_plans: 55
  completed_plans: 55
  percent: 100
---

# Project State: local-llms

**Last Updated:** 2026-05-28 — Pending-debt sweep: re-auditados TD-01/04/07 → todos resueltos de facto (commits post-audit 2026-05-17). Phase 08 Plan 10 Task 2 cerrado 2026-05-27 con smokes live PASS. Pending real único: Phase 07 Plan 07-06 Task 3 (vLLM cold-start, deferred por decisión Ollama-only).
**Status:** v0.9.0 milestone complete

## Project Reference

**Core Value:** Un endpoint único, estable y multi-protocolo para que los agentes del usuario consuman cualquier modelo disponible — local cuando cabe, Ollama Cloud cuando no — sin que el cliente se entere de quién está respondiendo detrás.

**Current Focus:** v0.9.0 shipped 2026-05-28 — awaiting next milestone (start with `/gsd:new-milestone`).

## Current Position

Phase: Milestone v0.9.0 complete
Plan: —
Status: Awaiting next milestone
Last activity: 2026-05-28 — Milestone v0.9.0 completed and archived

### Progress

```
Milestone v0.9.0: ██████████ 100% — SHIPPED 2026-05-28
  Phase 1: ██████████ 6/6 INFRA — 2026-05-10
  Phase 2: ██████████ 9/9 MVP slice — 2026-05-12
  Phase 3: ██████████ 6/6 multi-backend — 2026-05-13
  Phase 4: ██████████ 16/16 Anthropic + tools + vision — 2026-05-14
  Phase 5: ██████████ 8/8 Postgres + observability — 2026-05-15
  Phase 6: ██████████ 11/11 Open WebUI + Traefik — 2026-05-15
  Phase 7: ██████████ 7/7 embeddings + vLLM + GPU telemetry — 2026-05-17
  Phase 8: ██████████ 10/10 Ollama Cloud + resilience — 2026-05-27
  Phase 9: ██████████ 4/4 ops hardening — 2026-05-17

Overall: ██████████ 76/76 v1 requirements
```

## Performance Metrics

- **Phases planned:** 9
- **Phases completed:** 9
- **Requirements mapped:** 76/76 (100% coverage)
- **Requirements shipped:** 76/76 (v0.9.0)
- **Research artifacts:** PROJECT.md, REQUIREMENTS.md, research/SUMMARY.md, research/STACK.md, research/FEATURES.md, research/ARCHITECTURE.md, research/PITFALLS.md
- **Research-flagged phases:** 4 (Anthropic translation), 6 (Traefik + Open WebUI), 7 (vLLM + embeddings), 8 (Ollama Cloud + resilience)

## Accumulated Context

### Key Decisions (carried from PROJECT.md)

- **Router stack:** Node 22 LTS + Fastify v5 + TypeScript + pino + zod + `fastify-sse-v2` + `@bram-dc/fastify-type-provider-zod`. `node:22-bookworm-slim` (not alpine).
- **Backends:** `ollama/ollama:0.5.7` (catalog), `ghcr.io/ggml-org/llama.cpp:server-cuda` pinned to a build tag (GGUF), `vllm/vllm-openai:v0.20.2-cu129-ubuntu2404` (HF AWQ); Ollama Cloud as a declared `backend: ollama-cloud` entry, not a magic spillover.
- **GPU reservation:** `deploy.resources.reservations.devices` (modern form), via `x-gpu` YAML anchor reused by every backend service. Never `runtime: nvidia`.
- **Storage:** two volumes — `models-gguf/` (Ollama + llama.cpp can read the same `.gguf` via symlink for dedup) and `models-hf/` (HuggingFace snapshot dir for vLLM). Never one shared `/models` tree.
- **Networks:** four — `edge`, `app`, `backend: internal: true`, `data: internal: true`. Router is the only service on all four.
- **Auth:** single bearer token from `.env`, constant-time compare. No multi-key, no OAuth, no spend caps.
- **Streaming:** SSE obligatorio; pino redaction, abort propagation, and 15s heartbeat baked in from Phase 2.
- **Anthropic translation:** normalize internally to canonical Anthropic-shape (strict superset of OpenAI). Translate inbound + outbound separately. Round-trip golden tests.
- **VRAM partitioning:** static, encoded in `models.yaml`. Default policy: one backend hot at a time via Compose `profiles:`. vLLM always with explicit `--max-model-len` and `--gpu-memory-utilization 0.45`.

### Standing Anti-Patterns to Reject (carried from research)

- `:latest` Docker tags on any inference runtime.
- `node:22-alpine` for the router.
- `runtime: nvidia` (legacy form) anywhere in Compose.
- Linux NVIDIA driver installed inside the WSL distro.
- `compress` middleware on `/v1/chat/completions` or `/v1/messages`.
- `redis:latest`; use `valkey/valkey:8-alpine` instead.
- `traefik:v2.x`.
- Single shared `/models` volume across all three runtimes.
- Open WebUI bypass connections (OWUI → backend directly).
- `WEBUI_AUTH=True` "just for testing first" — first boot is permanent.
- Public-internet exposure of the router (Tailscale recommended for remote).

### Active Todos

(empty — milestone v0.9.0 shipped; next milestone not started)

### Blockers

()

### Deferred at milestone close

- **Phase 7 Plan 07-06 Task 3** — vLLM cold-start UAT on RTX 5060 Ti host. Deferred by user decision (Ollama-only profile is the chosen workhorse setup; vLLM image works empirically — Wave 0 PASS — but the live-stack human-verify was not exercised because vLLM is redundant for the 16 GB VRAM budget shared with the Whisper sidecar).

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260510-v8z | Phase 01 script cleanup — non-blocking warnings + info items from 01-REVIEW.md | 2026-05-10 | 20d57d2 | [260510-v8z-phase-01-script-cleanup-non-blocking-war](./quick/260510-v8z-phase-01-script-cleanup-non-blocking-war/) |
| 260525-0hr | Perfil Ollama-only optimizado (MAX_LOADED=2, KEEP_ALIVE=-1) + alias de modelo por rol (chat/vision/embed-local, big-cloud) | 2026-05-25 | c7b0e82 | [260525-0hr-perfil-solo-ollama-optimizado-nombres-de](./quick/260525-0hr-perfil-solo-ollama-optimizado-nombres-de/) |
| Phase 08 P08 | 15min | 1 tasks | 3 files |
| Phase 08 P09 | 4min | 1 tasks | 3 files |
| Phase 08 P10 | 30min | 1 tasks | 4 files |
| Phase 09 P03 | 22min | 3 tasks | 3 files |
| Phase 09 P04 | 12min | 1 tasks | 1 files |

## Session Continuity

Last session: 2026-05-27T13:00:21.349Z
Stopped at: Phase 9 Plan 03 (OPS-03 — disk-usage alert) COMPLETE. New bin/disk-alert.sh (307 LOC, executable, bash -n clean) — host-cron-driven df -P threshold check emitting one structured single-line log per invocation: `[disk-alert] LEVEL={INFO|WARN} target=... used_pct=... threshold_pct=... fs=... ts=... hostname=...` (key=value, grep/journalctl/Loki-friendly). Default threshold 80, range 1..99 asserted. Optional HTTP push hook on WARN (curl --fail -sS --max-time 10 POST to NTFY_URL); best-effort — curl failure does NOT fail the script + emits SECONDARY log line with url_host=<sed-extracted host only>. FULL NTFY_URL NEVER LOGGED (T-09-I-05). HARD-FAILS exit 1 when HOST_DATA_ROOT missing — NEVER falls back to / (T-09-D). NO auto-remediation (operator decides via OPS-01 GC / OPS-02 retention / ollama rm). CLI: --threshold N override + --help. .env.example gains Phase 9 section: DISK_ALERT_THRESHOLD_PCT=80 + optional NTFY_URL= with URL-IS-credential security note. README §Operations §### Disk-usage alert (OPS-03) — crontab recipe (15-min cadence), three alert sinks (stdout / NTFY / MAILTO-on-breach), sample INFO + WARN log lines, remediation pointers, v2 non-goals. 3 atomic commits: 9ba36b2 (feat) + 8a6f5e2 (docs env) + 9840daf (docs README). 0 deviations. OPS-03 closes. Phase 9 progress: 3/4.

**Next action:** Plan 09-04 (Wave 1, OPS-04 — bearer-token rotation runbook). Last plan of Phase 9. Anchor preserved in README + .env.example. After 09-04 closes: Phase 9 100%, milestone v0.9.0 closes. Phase 8 carry-over: Plan 08-10 Task 2 still PENDING-HUMAN. Phase 7 carry-over: Plan 07-06 task 3 still PENDING-HUMAN.

**Open questions for the user (none blocking):**

- Phase 4 is research-flagged: Anthropic translation is the hardest piece. Decide between `/gsd-discuss-phase 4` (human-in-loop) vs `/gsd-plan-phase --research-phase 4` (autonomous research).
- Phase 6 will need to choose Let's Encrypt (public DNS) vs mkcert (LAN-only). Decide before Phase 6 planning.
- Phase 7 needs the host NVIDIA driver version recorded by the Phase 1 preflight to pick the right vLLM image tag (`cu129` ≥ 555.x, otherwise `cu126`/`cu124`).
- Phase 8 needs current Ollama Cloud quotas/naming validated empirically (research flag).

---
*State initialized: 2026-05-10 after roadmap creation*
*Last activity: 2026-05-17 — Phase 7 Plan 06 tasks 1-2 auto-complete (smoke scripts in tree); task 3 awaits operator human-verify*
| 2026-05-23 | fast | publish router loopback host port 3210 | ✅ |

## Operator Next Steps

- Start the next milestone with /gsd-new-milestone
