# Phase 9: Operations Hardening - Context

**Gathered:** 2026-05-17
**Status:** Ready for planning
**Mode:** Auto-generated (smart-discuss detected infrastructure-only phase — no grey areas)

<domain>
## Phase Boundary

Once everything works, prevent it from rotting — disk hygiene, off-host backups, alerting on the constrained resource (disk), and a documented secret rotation path.

**In scope (requirement IDs):** OPS-01, OPS-02, OPS-03, OPS-04.

**Out of scope:**
- USD cost estimation (COST-01) → v2 backlog.
- OpenTelemetry / Loki / Alertmanager (TRACE-01, LOG-01, ALERT-01) → v2 backlog.
- Multi-host / HA failover → v2.

</domain>

<decisions>
## Implementation Decisions

### Claude's Discretion

All implementation choices are at Claude's discretion — pure infrastructure phase. The planner should still respect these locked principles from prior phases:

- **Single-host single-user single-NVIDIA-GPU stack** — no orchestrator, no multi-host failover (PROJECT.md non-negotiable).
- **WSL2 + Docker Desktop** is the documented host config; ops tooling must not assume bare-Linux paths exclusively (e.g. `/srv/models` is the convention but the operator may have it elsewhere — read `HOST_DATA_ROOT` from `.env` if introduced earlier).
- **Postgres dump pipeline already exists** (Phase 5 DATA-05 ships `bin/pg-dump-cron.sh` + restore drill). OPS-02 off-host destination layers ON TOP of the existing dump cron — no rewrite, just a publish step.
- **Bearer rotation** is documented manual procedure — single-user project, the operator is the only consumer of the token.
- **Grafana already runs** (Phase 7 OBS-04) — disk-usage alert can route through Grafana's built-in alerting OR a simpler `cron + ntfy.sh` hook if Grafana alerting setup is heavyweight for this scope. Planner picks the simpler path that meets SC3 ("fires visibly").
- **All four OPS items can ship as autonomous plans** — none require human-verify gates (unlike Phases 7 + 8 where live-stack UAT was load-bearing).

### Recommended Plan Decomposition (planner is free to deviate)

- **09-01** — OPS-01: `bin/gc-models.sh` scanning `models-gguf/` + `models-hf/` against `router/models.yaml` entries (dry-run by default; `--apply` removes). README §Operations subsection with sample dry-run output.
- **09-02** — OPS-02: off-host backup destination — recommend `restic` to a local-LAN target or external HDD (simpler than rclone-to-cloud for v1). Wrap as `bin/backup-postgres.sh` that runs after the existing `pg-dump-cron.sh`. End-to-end restore drill documented.
- **09-03** — OPS-03: disk-usage alert. Threshold from env (`DISK_ALERT_THRESHOLD_PCT`, default 80). Cron job emitting structured log line on threshold breach + optional ntfy.sh hook (env-gated). Documented in README.
- **09-04** — OPS-04: bearer-token rotation README — include Open WebUI stored-token update procedure (without recreating admin user) + grep recipe to confirm zero log lines mention the old token.

That's 4 plans, all Wave 1 (independent file ownership). No human-verify needed.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`bin/pg-dump-cron.sh`** (Phase 5 DATA-05) — existing daily dump cron. OPS-02 wraps its output with a publish-to-off-host step.
- **`router/models.yaml`** — single source of truth for model→file mapping. OPS-01 reads this to determine "referenced" files.
- **`compose.yml` `models-gguf` + `models-hf` volumes** — Phase 1 D-D1/D-D2 separation. GC script must respect both volume roots.
- **`HOST_DATA_ROOT` env** — referenced in Phase 7 P-2 (prometheus chown). OPS scripts should reuse it for disk paths.
- **`.env.example`** — extend with `DISK_ALERT_THRESHOLD_PCT`, `BACKUP_RESTIC_REPO`, `BACKUP_RESTIC_PASSWORD`, `NTFY_URL` (optional).
- **README §Operations** (likely created fresh in this phase) — central reference for the four OPS items.

### Established Patterns

- **bash scripts in `bin/`** all use `set -euo pipefail` + section headers `=== <name> ===` (per Phase 7 smoke pattern).
- **Cron-style scripts** invoked from host crontab, NOT inside containers (Phase 5 pg-dump uses this pattern).
- **README subsections** use `## Phase N — <name>` (Phase 7 OBS) or `## Operations` for cross-cutting topics.
- **TDD applies where there's parsable logic** (OPS-01 has parser logic for matching files-on-disk vs models.yaml entries → unit-testable via Vitest; OPS-02/03/04 are mostly shell + docs → smoke-testable not unit-testable).

### Integration Points

- **No router code changes expected** (all OPS items are external scripts + docs). If discovered otherwise during planning, that's a sign of scope creep — push back.

</code_context>

<specifics>
## Specific Ideas

- Prefer `restic` over `rclone` for OPS-02 — encryption built in; simpler retention policy semantics.
- The Phase 5 DATA-05 SUMMARY mentions an existing restore drill — OPS-02 should EXTEND that drill (not replace) by adding the "fetch from off-host first" step.
- The bearer rotation README (OPS-04) should reference the Phase 6 SUMMARY's Open WebUI auth config (where the bearer is stored).

</specifics>

<deferred>
## Deferred Ideas

- **Multi-destination backup** (e.g. local NAS + cloud S3) — v2 if needed.
- **Alertmanager integration** — explicitly v2 (ALERT-01 in REQUIREMENTS.md).
- **Encrypted .env at rest** (sops, age, vault) — v2.
- **Automated bearer rotation** via secret-rotation tooling — v2; v1 is manual + documented.

</deferred>
