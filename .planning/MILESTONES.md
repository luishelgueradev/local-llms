# Milestones

## v0.9.0 MVP — Router multi-backend con cloud fallback + observability + ops (Shipped: 2026-05-28)

**Phases completed:** 9 phases · 55 plans · 112 tasks
**Timeline:** 2026-05-09 → 2026-05-28 (~20 days)
**Repo stats:** 498 commits · 404 files changed · +116,415 / -19 LOC · 105 `feat` + 109 `fix` commits

### What shipped

- **OpenAI- and Anthropic-compatible router** (Fastify v5 + TypeScript + pino + zod) — `POST /v1/chat/completions`, `POST /v1/messages` + `/count_tokens`, `POST /v1/embeddings`, `GET /v1/models` (+ retrieve), `/healthz` + `/readyz` + `/metrics`. Canonical Anthropic-shape translation layer with golden round-trip fixtures; bidirectional tool-calling; vision (both protocols); typed SSE streaming with heartbeats, abort propagation, and 15s heartbeats.
- **Multi-backend dispatch** — Ollama, llama.cpp-server, vLLM (chat + embeddings), and **Ollama Cloud** as a declared `backend: ollama-cloud` entry. Per-backend liveness/readiness probes, concurrency caps, VRAM budgets validated at boot via `superRefine`, Compose profiles per backend.
- **Resilience layer** — Valkey-backed per-backend circuit breaker (5/30s → 60s cooldown + Retry-After), server-side per-bearer-token rate limit (default 600 RPM, fail-open on Valkey down), `Idempotency-Key` multiplexer (N concurrent retries → 1 upstream generation, byte-identical SSE replay), hard `max_tokens=16384` cap on cloud-served models, `X-Model-Backend` response header on every successful response.
- **Postgres observability** — `request_log` buffered async writes (re-entrancy locked, drop-oldest at 10_000), `usage_daily` aggregation, `cloud_spend_daily` read-only view, pg_dump cron + tested restore drill + off-host backup via restic. Prometheus `/metrics` on the router + vLLM + nvidia_gpu_exporter; Grafana dashboard with 7 OBS-04 panels (VRAM gauge, request rate, TTFT p95, duration p95, error rate, backend selection, vLLM throughput).
- **Edge + UI** — Traefik v3.7 with SSE-friendly forwarding timeouts and metrics-blackhole middleware; Open WebUI v0.9 with basic-auth at the edge and an isolated `webui-app` network closing the OWUI→ollama bypass; Tailscale-hostname routing.
- **Ops runbooks** — `bin/gc-models.sh` (allowlisted move-to-trash by `models.yaml`), `bin/backup-postgres.sh` (restic with retention), `bin/disk-alert.sh` (host-cron threshold check), `bin/restore-drill.sh`, README §Operations covering 10-step bearer-token rotation with OWUI PersistentConfig pivot.

### Re-audit (2026-05-28)

The original 2026-05-17 audit flagged 7 tech-debt items (TD-01..TD-07). The re-audit verified that **TD-01 (bearer case-sensitive), TD-04 (TS2367/TS2741 fixtures), and TD-07 (hotreload.vram.test.ts flake) closed of facto** in commits after the original audit — the code already complies. Live-stack smokes (Phase 8 Plan 10 Task 2) ran clean 2026-05-27. The remaining items (TD-02, TD-03, TD-05, TD-06) are by-design / v2-multi-instance / WSL2-environmental and have no operational impact.

### Known deferred items at close

- **Phase 7 Plan 07-06 Task 3** — vLLM cold-start UAT on RTX 5060 Ti host. Deferred by user decision: the project runs an Ollama-only profile because vLLM redundant for the chosen workhorse model (qwen2.5:7b q4) under the 16 GB VRAM budget shared with a Whisper sidecar.

### Final verification

- `tsc --noEmit` — 0 errors
- ESM build (`tsup`) — clean
- Vitest full suite — 708 pass · 7 skipped (opt-in: 2× LIVE Ollama, 5× `PG_TESTS=1` real-DB)
- Live tunnel smoke — `chat-local` 200/0.7s, `big-cloud` 200/3.5s, `/v1/models/chat-local` 200

### Archived artifacts

- [`milestones/v0.9.0-ROADMAP.md`](./milestones/v0.9.0-ROADMAP.md)
- [`milestones/v0.9.0-REQUIREMENTS.md`](./milestones/v0.9.0-REQUIREMENTS.md)
- [`milestones/v0.9.0-MILESTONE-AUDIT.md`](./milestones/v0.9.0-MILESTONE-AUDIT.md)

### Git tag

`v0.9.0`
