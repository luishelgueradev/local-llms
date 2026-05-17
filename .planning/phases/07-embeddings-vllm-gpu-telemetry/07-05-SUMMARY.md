---
phase: 07-embeddings-vllm-gpu-telemetry
plan: 05
subsystem: observability-grafana-dashboard
tags: [grafana, dashboard, prometheus, promql, vrm, ttft, observability, readme, obs-04]
dependency_graph:
  requires:
    - phase-07-02-grafana-datasource           # datasource uid 'prometheus-default' (Pitfall P-1 pin)
    - phase-07-02-grafana-bind-mounts          # ./grafana/provisioning/dashboards/ → /etc/grafana/dashboards/
    - phase-07-02-prometheus-scrape-config     # router + vllm + gpu + llamacpp scrape jobs
    - phase-05-router-prom-metrics             # router_requests_total + _seconds histograms (NOT _ms)
  provides:
    - phase-07-grafana-dashboard-provider      # grafana/provisioning/dashboards/local-llms.yml
    - phase-07-grafana-dashboard-json          # grafana/provisioning/dashboards/local-llms.json (uid: local-llms)
    - phase-07-readme-phase7-section           # README §Phase 7 with 6 operator subsections
  affects:
    - phase-07-plan-06-live-boot-verify        # smoke asserts /api/dashboards/uid/local-llms returns 200
tech-stack:
  added:
    - "Grafana 12.x provisioned dashboard with uid pin (provider name 'local-llms', dashboard uid 'local-llms')"
    - "PromQL queries against router prom-client native metric names: router_requests_total + router_*_seconds_bucket (NOT _ms_bucket)"
    - "nvidia_smi_memory_used_bytes / total_bytes — VRAM gauge from utkuozdemir/nvidia_gpu_exporter:1.4.1"
    - "vllm:generation_tokens_total — vLLM native /metrics counter (empty when --profile vllm down)"
  patterns:
    - "Dashboard JSON references datasource uid at BOTH panel.datasource AND target.datasource levels (Grafana 12 schema requirement; Pitfall P-1)"
    - "Source-of-truth metric names: dashboard JSON reads names from router/src/metrics/registry.ts, not from the plan's prose (which assumed _ms suffix)"
    - "README §Phase N pattern continues from Phase 3-6 — operator-facing curl recipes + one-time setup + smoke cross-references in a single section"
key-files:
  created:
    - grafana/provisioning/dashboards/local-llms.yml
    - grafana/provisioning/dashboards/local-llms.json
  modified:
    - README.md
key-decisions:
  - "Used router_*_seconds_bucket (not _ms_bucket) in TTFT + duration panels — registry.ts is the single source of truth (Rule 1 fix; plan's <read_first> explicitly defers to source)"
  - "Each panel's targets[].datasource also re-declares the prometheus-default UID (Grafana 12 schema requires datasource at panel AND target level)"
  - "Used jq behavior emulated via node fallback for validation (jq binary not installed on host; node JSON.parse + manual asserts produced equivalent gate output)"
patterns-established:
  - "Grafana dashboard provisioning: provider YAML + dashboard JSON live under grafana/provisioning/dashboards/ together; compose.yml bind-mounts the directory; uid pins both ends so smoke tests can probe by uid"
  - "PromQL native units: histogram metrics use _seconds_bucket regardless of how the planner phrased it — verify against prom-client source before writing PromQL"
requirements-completed: [OBS-04]
metrics:
  duration_minutes: 4
  completed_date: "2026-05-17"
  commits: 3
outcome: complete
---

# Phase 7 Plan 05: Grafana Dashboard + README §Phase 7 Summary

**Grafana 12 dashboard with 7 OBS-04 panels (VRAM gauge, request rate, TTFT p95, duration p95, error rate, backend selection, vLLM throughput) provisioned via the bind-mount Plan 07-02 already declared, plus README operator section covering vLLM cold-start, embeddings curls, Grafana access (subdomain + LAN bypass), env var generation, and the P-2 + G-3 + svc:grafana one-time setup steps.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-17T03:54:54Z
- **Completed:** 2026-05-17T03:58:27Z
- **Tasks:** 3 (all `type=auto`, no checkpoints)
- **Files created:** 2 (grafana provider + dashboard JSON)
- **Files modified:** 1 (README.md — append §Phase 7, no other section touched)

## Accomplishments

- **Dashboard provider** (`grafana/provisioning/dashboards/local-llms.yml`) — `apiVersion: 1`; provider name `'local-llms'`; type `file`; `path: /etc/grafana/dashboards`; `allowUiUpdates: true` per CONTEXT D-D4. Top-of-file comment links the file to Plan 07-02's compose.yml bind-mount so a future operator can trace the wiring without reading the planning docs.
- **Dashboard JSON** (`grafana/provisioning/dashboards/local-llms.json`) — Grafana 12.4.3-compatible (schemaVersion 39), 7 panels in the 24-col grid layout the plan specifies, `uid: "local-llms"` (Plan 07-06 smoke asserts on this exact UID), title `"local-llms — Router + GPU + Backends"`, refresh 30s, time `now-1h..now`. All 7 panels reference `datasource: {type: "prometheus", uid: "prometheus-default"}` at BOTH panel and target levels (Grafana 12 schema requirement; Pitfall P-1 pinning chain holds).
- **README §Phase 7** — 188 lines (slightly over the plan's ~120 target, justified by the 6 mandatory subsections × 3 pitfalls × 2 embedding backends). Six subsections in the order the plan specifies: (1) vLLM profile commands with Pitfall V-2 cold-start guidance and the literal `Capturing CUDA graphs` log marker; (2) embeddings curl recipes for both `bge-m3-ollama` and `bge-m3-vllm` with the 1024-dim jq assertion; (3) Grafana access via Tailscale subdomain + LAN bypass; (4) env var generation with `openssl rand -hex 24`; (5) known operator steps for Pitfalls P-2 + G-3 + svc:grafana Tailscale Service registration; (6) cross-references to the three Phase 7 smoke scripts Plan 07-06 brings in.

## Task Commits

Each task was committed atomically (no TDD multi-commit per task; this plan was infrastructure-only):

1. **Task 1: Create grafana/provisioning/dashboards/local-llms.yml** — `841f015` (feat)
2. **Task 2: Create grafana/provisioning/dashboards/local-llms.json (7 panels)** — `8d5f956` (feat)
3. **Task 3: Add README §Phase 7 — Embeddings + vLLM + GPU Telemetry section** — `ef3cb60` (docs)

## Files Created/Modified

### Created

- `grafana/provisioning/dashboards/local-llms.yml` — 32 lines. Single dashboard provider entry per CONTEXT D-D4 single-dashboard policy; `updateIntervalSeconds: 30` (reload cadence); top-of-file doc comment ties this file to Plan 07-02's grafana service bind-mount.
- `grafana/provisioning/dashboards/local-llms.json` — 298 lines. 7-panel dashboard with the 24-col layout from `<interfaces>`. Each panel has explicit `fieldConfig.defaults.unit` (`percentunit` for VRAM, `reqps` for rates, `s` for histograms, `tps` for vLLM throughput) so the Y-axis labels are correct without operator intervention. The `pluginVersion: "12.4.3"` annotation matches the Grafana image pin in Plan 07-02.

### Modified

- `README.md` — append-only edit, +188 lines, inserted between the existing Phase 6 section and the "Anti-patterns rejected by this stack" section. No pre-existing content touched (verified by `git diff --stat`: 188 insertions, 0 deletions).

## Verbatim acceptance evidence

```
[Task 1]
$ test -f grafana/provisioning/dashboards/local-llms.yml      PASS
$ grep -q 'apiVersion: 1' ...                                  PASS
$ grep -q "name: 'local-llms'" ...                             PASS
$ grep -q 'path: /etc/grafana/dashboards' ...                  PASS

[Task 2 — using node fallback because jq is not installed on this host]
$ JSON.parse() (well-formed)                                   PASS
$ uid == "local-llms"                                          PASS (actual: local-llms)
$ panels.length >= 6                                           PASS (actual: 7)
$ VRAM panel datasource.uid == prometheus-default              PASS
$ some target.expr contains router_requests_total              PASS
$ some target.expr contains nvidia_smi_memory_used             PASS
$ ALL 7 panels reference prometheus-default at BOTH panel
  AND target levels                                            PASS
$ Has histogram_quantile expression                            PASS
$ Has router_request_duration_seconds_bucket                   PASS
$ Has router_ttft_seconds_bucket                               PASS
$ Has status_class label filter                                PASS
$ Has vllm:generation_tokens_total counter                     PASS
$ Has by (model, backend) grouping                             PASS
$ schemaVersion == 39                                          PASS
$ refresh == "30s"                                             PASS
$ wc -l on JSON: 298 (>= 200 min from must_haves.artifacts)    PASS

[Task 3]
$ ^## Phase 7 H2 present                                       PASS
$ 'docker compose --profile vllm up -d' command                PASS
$ 'bge-m3-ollama' model name                                   PASS
$ 'bge-m3-vllm' model name                                     PASS
$ 'GRAFANA_ADMIN_PASSWORD' env var                             PASS
$ 'openssl rand -hex 24' generation command                    PASS
$ 'chown -R 65534:65534' Pitfall P-2 chown                     PASS
$ '/usr/lib/wsl/lib' Pitfall G-3 fallback path                 PASS
$ 'Capturing CUDA graphs' Pitfall V-2 marker                   PASS
```

## Decisions Made

- **Used native router metric names (`router_*_seconds_bucket`), not the plan's stated `_ms_bucket`.** The plan's `<read_first>` for Task 2 instructed: *"If the actual names in the source differ, use the actual names from the source — the source is the single source of truth."* Inspection of `router/src/metrics/registry.ts` (the Phase 5 prom-client registry) shows the canonical names are `router_request_duration_seconds` (bucket boundaries `[0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]`) and `router_ttft_seconds` (`[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`). Prometheus appends `_bucket` automatically for histograms, so PromQL must reference `router_*_seconds_bucket`. The plan's `<verify>` regex for Task 2 only checks the presence of `router_requests_total` and `nvidia_smi_memory_used` substrings, so this substitution does not break verification. Panel titles + Y-axis units were also flipped from `(ms)` to `(s)` to match the metric. See "Deviations" below.
- **All panels redeclare the datasource at the target level.** Grafana 12's schema requires `datasource` at BOTH `panels[].datasource` AND `panels[].targets[].datasource`. Without the target-level redeclaration, Explore mode and some panel renderers fall back to the default datasource — which works on a single-datasource Grafana but breaks the moment a second datasource is added. The plan's `<action>` block flagged this explicitly ("Each panel's `targets[].datasource` MUST also be set"); I followed it without deviation.
- **Y-axis units set explicitly per panel** (`percentunit`, `reqps`, `s`, `tps`) so operators do not have to edit each panel in the UI on first viewing. The `s` unit on the histogram panels auto-formats sub-second values as ms in the UI, so the dashboard reads naturally regardless of latency magnitude.
- **jq was not installed on the host shell**; the agent shell could not `sudo apt install` interactively. Used a small node one-liner to emulate `jq -e '.uid == "local-llms"'` etc. — the verification semantics are identical (JSON.parse + boolean predicates). The Plan 07-06 smoke runs inside Docker / against a live Grafana, so the host-side jq is not on the critical path for the live boot.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Histogram metric names: `_seconds_bucket`, not `_ms_bucket`**

- **Found during:** Task 2 (drafting Panel 3 + Panel 4 PromQL).
- **Issue:** The plan's `<interfaces>` block specifies histogram queries against `router_ttft_ms_bucket` and `router_request_duration_ms_bucket`. The actual prom-client metrics declared in `router/src/metrics/registry.ts` (Phase 5) are `router_ttft_seconds` and `router_request_duration_seconds` — Prometheus exposes them as `*_seconds_bucket`. Querying the `_ms_bucket` names would return zero series and panels would show "No data" forever — exactly the Pitfall P-1 failure mode the plan was designed to avoid.
- **Fix:** Panel 3 PromQL changed to `histogram_quantile(0.95, sum(rate(router_ttft_seconds_bucket[5m])) by (le, backend))`; Panel 4 to `histogram_quantile(0.95, sum(rate(router_request_duration_seconds_bucket[5m])) by (le, backend))`. Panel titles changed from "TTFT p95 (ms)" / "Request Duration p95 (ms)" to "(s)". `fieldConfig.defaults.unit` set to `"s"` (Grafana auto-scales s to ms/μs in the UI for small values).
- **Files modified:** grafana/provisioning/dashboards/local-llms.json.
- **Verification:** Confirmed via inspection of `router/src/metrics/registry.ts` (lines 21-22 and 41-49 show the explicit `_seconds` names + bucket boundaries). The plan's `<read_first>` for Task 2 explicitly delegates this case to the source: *"likely `router_requests_total`; histograms `router_ttft_ms` + `router_request_duration_ms`. If the actual names in the source differ, use the actual names from the source — the source is the single source of truth."*
- **Committed in:** `8d5f956` (Task 2 commit).
- **Rationale:** Rule 1 — without the fix, the dashboard would have shipped broken. The plan author flagged this risk in advance and gave the executor explicit permission to defer to the source. The substitution is in-bounds, not scope creep. Panel grouping was also extended with `by (le, backend)` instead of `by (le)` alone, so the p95 lines split by backend — slightly richer than the plan's bare query but the plan's `<verify>` regex still matches.

**2. [Rule 3 — Blocking] jq binary missing from host; emulated with node**

- **Found during:** Task 2 acceptance verification.
- **Issue:** The plan's `<verify><automated>` block for Task 2 uses `jq` to assert dashboard structure. `which jq` returned not-found; `apt-get install jq` failed with a sudo password prompt the agent shell cannot satisfy. Without a JSON validator, the acceptance gate cannot run.
- **Fix:** Wrote a node one-liner that runs `JSON.parse(fs.readFileSync(...))` plus the same boolean predicates the jq commands would have evaluated (`d.uid === "local-llms"`, `d.panels.length >= 6`, the VRAM-panel datasource UID check, and the `expr` substring grep for `router_requests_total` and `nvidia_smi_memory_used`). Identical semantics; identical PASS/FAIL outputs.
- **Files modified:** None (verification-time tooling only).
- **Verification:** The node script confirmed all 7 acceptance checks plus 8 additional cross-checks (schemaVersion, refresh, histogram_quantile presence, target-level datasource UIDs, etc.).
- **Committed in:** No commit — verification tooling only. Documented here so a future re-run of this plan on a fresh host knows about the jq dependency.
- **Rationale:** Rule 3 — without a JSON validator, the plan cannot proceed past Task 2. The fix preserves the verification's correctness (JSON parse + same predicates) without modifying any planned file. The Plan 07-06 live smoke still uses jq because that script runs inside the Grafana container or against `curl` output where jq is present.

---

**Total deviations:** 2 auto-fixed (1 Rule 1 bug correcting metric names against source-of-truth; 1 Rule 3 verification-tooling substitution).

**Impact on plan:** The Rule 1 fix is the critical one — without it, the dashboard panels for TTFT and request duration would have rendered "No data" indefinitely. The plan's `<read_first>` for Task 2 anticipated this case and explicitly authorized the executor to defer to the source. The Rule 3 fix is purely operational; no plan output is altered. No scope creep on either count.

## Issues Encountered

- None during planned work. The two deviations above were both pre-flagged: the metric-name discrepancy was called out in the plan's `<read_first>` itself, and the jq-missing case is a host-side ergonomic.

## Hand-off to Plan 07-06 (Live boot + smoke)

- The dashboard file lands at `grafana/provisioning/dashboards/local-llms.json`; Plan 07-02's compose.yml bind-mounts the directory so on first `docker compose up -d grafana` the file is available at `/etc/grafana/dashboards/local-llms.json` inside the container.
- Grafana boots, reads `local-llms.yml` (this plan's provider), discovers `local-llms.json` in `/etc/grafana/dashboards/`, and provisions the dashboard.
- Smoke assertions Plan 07-06 should pass:
  - `GET /api/dashboards/uid/local-llms` returns 200 with `dashboard.uid == "local-llms"` and `dashboard.title == "local-llms — Router + GPU + Backends"`.
  - `GET /api/datasources/uid/prometheus-default` returns 200 (Plan 07-02 territory; cross-check).
  - Each panel's `targets[0].expr` parses as PromQL when run against the live Prometheus (`POST /api/v1/query` returns 200 with a `data.result` array — possibly empty for vLLM panels when `--profile vllm` is down, that's expected).

## Hand-off to operator

- **Mandatory before first `docker compose up -d` of the Phase 7 stack:** `echo "GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 24)" >> .env`. README §Phase 7 "Env var generation" walks through it.
- **One-time after first up:** the Pitfall P-2 prometheus chown (`sudo chown -R 65534:65534 ${HOST_DATA_ROOT}/prometheus`) and the svc:grafana Tailscale Service registration. README §Phase 7 "Known operator steps" walks through both.
- **vLLM cold-start:** the first `docker compose --profile vllm up -d vllm vllm-embed` takes up to 10 minutes. README §Phase 7 "vLLM profile commands" includes the `Capturing CUDA graphs` log marker so the operator knows what to grep for while waiting.

## Known Stubs

None. This plan delivers complete artifacts:

- Dashboard provider YAML is fully wired.
- Dashboard JSON has all 7 panels populated with real PromQL queries against real metrics (router prom-client metrics from Phase 5 + nvidia_gpu_exporter metrics from Plan 07-02 + vLLM native metrics).
- README §Phase 7 covers all 6 mandated subsections with executable commands.

The dashboard panels DO render "No data" placeholders when the corresponding metrics are absent (e.g., vLLM throughput when `--profile vllm` is down) — that is the documented intended behavior, not a stub. README §Phase 7 calls this out for the vLLM throughput panel description.

## Threat Flags

- No new external surface introduced. The dashboard JSON + provider YAML are read-only from disk; Grafana clones provisioned dashboards into its internal DB for UI edits, and the source files remain the git source of truth (T-07-12 mitigation per the threat register).
- The LAN bypass curl recipe in README §Phase 7 "Grafana access" reuses Phase 6's basic-auth middleware — same network boundary as the Phase 6 docker socket; not externally reachable (T-07-13 acknowledged).
- No new auth paths, file-access patterns, or schema changes at trust boundaries.

## Self-Check

- [x] `grafana/provisioning/dashboards/local-llms.yml` exists — verified via `test -f`.
- [x] `grafana/provisioning/dashboards/local-llms.json` exists — verified via `test -f`.
- [x] README.md modified with §Phase 7 section — verified via `grep -qE '^## Phase 7' README.md`.
- [x] Commit `841f015` exists in git log — verified via `git log --oneline | grep 841f015`.
- [x] Commit `8d5f956` exists in git log — verified.
- [x] Commit `ef3cb60` exists in git log — verified.
- [x] No file deletions in any commit — `git diff --diff-filter=D --name-only HEAD~3 HEAD` returned empty.
- [x] All 9 Task 3 grep verifications pass (Phase 7 H2 / profile vllm cmd / bge-m3-ollama / bge-m3-vllm / GRAFANA_ADMIN_PASSWORD / openssl / chown / wsl/lib / Capturing CUDA graphs).
- [x] All 6 Task 2 node-verified acceptance checks pass (jq parse / uid / panels.length / VRAM ds / router_requests_total / nvidia_smi_memory_used) plus 8 additional cross-checks.
- [x] All 4 Task 1 grep verifications pass (file exists / apiVersion 1 / provider name / path).

## Self-Check: PASSED
