---
phase: 07-embeddings-vllm-gpu-telemetry
plan: 06
subsystem: testing
tags: [smoke-test, bash, prometheus, grafana, embeddings, vllm, request_log, observability]

# Dependency graph
requires:
  - phase: 07-embeddings-vllm-gpu-telemetry
    provides: vLLM + vLLM-embed compose services (07-00, 07-01); GPU exporter + Prometheus (07-02); models.yaml registry rows (07-03); /v1/embeddings route + recordRequestOutcome (07-04); Grafana dashboard + README §Phase 7 (07-05)
provides:
  - bin/smoke-test-observability.sh covering OBS-02 (Prometheus targets), OBS-03 (nvidia_gpu_exporter sample), OBS-04 (Grafana datasource + dashboard provisioning)
  - bin/smoke-test-router.sh extended with `=== Phase 7 — /v1/embeddings + request_log ===` section asserting OAI-02 + EMBED-01 + BCKND-03 + Phase SC5 (distinct request_log rows per backend)
  - Human-verify checkpoint recipe for the operator to bring up `--profile vllm`, run both smoke scripts, and visually confirm Grafana dashboard renders live data
affects: [08-ollama-cloud-spillover-resilience, 06-traefik-tls-openwebui]

# Tech tracking
tech-stack:
  added: []  # no new deps — bash, jq, docker compose, curl, psql (all already on host)
  patterns:
    - "Profile-gated smoke assertions — `docker compose ps <svc> --format '{{.State}}' | grep -q '^running$'` to skip rather than fail when a profile-specific service is not active"
    - "Env-var loading via single-line grep from .env (no `set -a`) — preserves WR-05 pattern from smoke-test-router.sh"
    - "Phase 7 smoke uses wget inside Prometheus/Grafana containers (always present in the images) instead of host-side curl — avoids depending on host network access to internal-only networks"

key-files:
  created:
    - bin/smoke-test-observability.sh
  modified:
    - bin/smoke-test-router.sh

key-decisions:
  - "Use `set -uo pipefail` (not `set -euo pipefail`) in bin/smoke-test-observability.sh — matches smoke-test-router.sh convention. Lets the FAILURES counter accumulate across sections so the operator sees ALL failures in one run instead of stopping at the first."
  - "Gate vLLM assertions on `docker compose ps vllm-embed` showing State=running (not on a CLI flag). Operator just runs the script; the script auto-detects whether --profile vllm was used."
  - "request_log assertion uses 3s sleep before psql to give Plan 07-04's buffered writer (D-B4, ~1–2s batch flush interval) time to flush — empirically observed in Phase 5 SC5."
  - "Capability gate test sends `qwen2.5-7b-instruct-awq` on /v1/embeddings expecting 400 — proves the registry's chat/embeddings split is enforced server-side (Plan 07-03 + 07-04 contract)."

patterns-established:
  - "Phase 7 smoke recipe: `bash bin/smoke-test-observability.sh && bash bin/smoke-test-router.sh` — two scripts, both exit 0/1 with FAILURES counter; covers all six phase requirements automatically; the only manual step is the visual Grafana dashboard check (human-verify)."
  - "Profile-aware smoke skipping: services gated on optional compose profiles emit `SKIP: ... (run with --profile X to include it)` rather than failing — keeps the script usable on minimal stacks while still flagging gaps when profile is active."

requirements-completed: [BCKND-03, OAI-02, EMBED-01, OBS-02, OBS-03, OBS-04]

# Metrics
duration: 14min
completed: 2026-05-17
---

# Phase 7 Plan 06: Live smoke scripts + human-verify checkpoint Summary

**Two smoke scripts assert all six Phase 7 requirements end-to-end against the live stack, plus a human-verify checklist for the operator to run on the RTX 5060 Ti host with `--profile vllm` active.**

## Performance

- **Duration:** ~14 min (Tasks 1-2 only — Task 3 is PENDING-HUMAN)
- **Started:** 2026-05-17T03:52:00Z
- **Completed (auto-portion):** 2026-05-17T04:06:22Z
- **Tasks completed automatically:** 2 of 3
- **Tasks pending human action:** 1 (Task 3 — human-verify checkpoint)
- **Files modified:** 2 (1 created, 1 extended)

## Accomplishments

- **`bin/smoke-test-observability.sh`** (new, 232 lines, executable) — 6 sections:
  1. Prometheus `/api/v1/targets` returns ≥3 healthy active targets
  2. `up{job=router|gpu|prometheus}==1` always (always-on jobs)
  3. `up{job=vllm}==1` / `up{job=llamacpp}==1` when the corresponding compose service is `running` (auto-detected, no flag)
  4. `nvidia_smi_memory_used_bytes` returns a numeric sample — surfaces Pitfall G-3 (silent CPU fallback in WSL2) with the actionable `/usr/lib/wsl/lib` bind-mount hint
  5. Grafana datasource `prometheus-default` provisioned and named `"Prometheus"`
  6. Grafana dashboard `local-llms` provisioned with title non-empty AND `panels | length >= 6` (Plan 07-05 contract)

- **`bin/smoke-test-router.sh`** extended with `=== Phase 7 — /v1/embeddings + request_log ===` section (Phase 2-6 sections unchanged):
  1. bge-m3 present in Ollama (idempotent pull on first run)
  2. `bge-m3-ollama` → 1024-dim (OAI-02 + EMBED-01 happy path)
  3. capability gate — `qwen2.5-7b-instruct-awq` on `/v1/embeddings` → 400 (registry-enforced)
  4. zod gate — empty input → 400 (Pitfall E-1)
  5. `bge-m3-vllm` → 1024-dim (BCKND-03; gated on `docker compose ps vllm-embed` running)
  6. request_log distinct-row SQL: asserts `backend='ollama'` row always; asserts `backend='vllm-embed'` row when vLLM was exercised (Phase SC5 — empirical proof of `recordRequestOutcome` from Plan 07-04)

- **Human-verify checkpoint recipe** documented for the operator (see "User Setup Required" below).

## Task Commits

1. **Task 1: Create bin/smoke-test-observability.sh** — `c9a3369` (feat)
2. **Task 2: Extend bin/smoke-test-router.sh with Phase 7 section** — `61ded93` (feat)
3. **Task 3: Phase 7 human-verify final checkpoint** — **PENDING-HUMAN** — see operator recipe below

**Plan metadata commit:** will be added after this SUMMARY.md is written (docs: complete plan).

## Files Created/Modified

- `bin/smoke-test-observability.sh` *(new)* — standalone observability smoke. 232 lines. Executable. Reads `GRAFANA_ADMIN_PASSWORD` from caller env or `.env` (single-line grep, never `set -a`). Six sections, FAILURES counter, exit 0/1.
- `bin/smoke-test-router.sh` *(extended)* — appended `=== Phase 7 — /v1/embeddings + request_log ===` section (125 lines added, 1 line modified). Final summary banner updated from "Phase 2/3/4/5 router verification" to "Phase 2/3/4/5/7 router verification". No existing assertions removed or altered.

## Decisions Made

- **`set -uo pipefail` (not `-e`)** in observability smoke — matches existing router-smoke convention. Lets the FAILURES counter accumulate all failures so the operator sees every gap in one run.
- **Profile auto-detection via `docker compose ps`** — vLLM/llama.cpp assertions skip when the service is not running. The operator doesn't pass a flag to the smoke scripts; they introspect the live state. Keeps the recipe `bash bin/smoke-test-observability.sh && bash bin/smoke-test-router.sh` regardless of which profile is active.
- **3s sleep before request_log SQL** — empirically tuned to the Plan 07-04 buffered writer flush interval (D-B4, ~1–2s).
- **Capability-gate test always runs (not profile-gated)** — qwen2.5-7b-instruct-awq is in the registry regardless of vLLM being up; the gate is enforced at the router layer, not at the upstream backend.

## Deviations from Plan

None — Tasks 1 and 2 executed exactly as written. Task 3 is a human-verify checkpoint by design (the plan is marked `autonomous: false`); the agent surfaces the checklist rather than attempting to run it.

**Total deviations:** 0
**Impact on plan:** None.

## Issues Encountered

None during Tasks 1-2. The host running the GSD agent does not have NVIDIA GPU access and is not the operator host, so live execution of the smoke scripts is by design deferred to the human-verify step.

## User Setup Required — Task 3 Human-Verify Checkpoint (PENDING)

**This plan is not considered complete until the operator runs the checklist below on the host with the RTX 5060 Ti.**

The exact recipe (also in `07-06-PLAN.md` Task 3 `<how-to-verify>`):

1. **Bring up the stack with the vLLM profile:**
   ```bash
   docker compose --profile vllm up -d
   ```
   First cold-start: `docker compose ps vllm` shows `healthy` after 5–15 min (`start_period: 600s`). vllm-embed is faster (~3–5 min). Watch with:
   ```bash
   docker compose logs -f vllm | grep -i "capturing CUDA graphs"
   ```

2. **First-time host fixes (only if surfaced as failures):**
   - If Prometheus fails to start: `sudo chown -R 65534:65534 ${HOST_DATA_ROOT:-/srv/local-llms}/prometheus` (Pitfall P-2).
   - If `docker compose logs nvidia_gpu_exporter` shows `libnvidia-ml.so: cannot open shared object file`: uncomment the WSL2 `/usr/lib/wsl/lib` bind-mount in `compose.yml` (Pitfall G-3), then `docker compose up -d nvidia_gpu_exporter`.

3. **Pull bge-m3 into Ollama (one-time):**
   ```bash
   docker compose exec ollama ollama pull bge-m3
   ```

4. **Run the observability smoke:**
   ```bash
   bash bin/smoke-test-observability.sh
   ```
   **Expected:** every section prints `PASS:`; final line `✓ Phase 7 observability smoke PASS`; exit 0.

5. **Run the router smoke (includes the new Phase 7 section):**
   ```bash
   bash bin/smoke-test-router.sh
   ```
   **Expected:** every Phase 2-6 section passes (unchanged); Phase 7 section prints six PASS markers (or five PASS + one SKIP if vllm-embed not exercised); exit 0.

6. **Visual Grafana check (LAN bypass at `http://127.0.0.1/d/local-llms/` with `Host: grafana.<TAILNET_HOSTNAME>.ts.net` header):** dashboard renders with live data on all six panels; VRAM panel shows non-zero usage; Backend Selection shows both `ollama` and `vllm-embed` rows after the smoke runs.

7. **Sanity-check request_log distinct rows manually:**
   ```bash
   docker compose exec postgres psql -U app -d router -c \
     "SELECT backend, route, COUNT(*) FROM request_log WHERE route='/v1/embeddings' GROUP BY backend, route;"
   ```
   **Expected:** ≥ 2 rows — one for `backend='ollama'`, one for `backend='vllm-embed'`.

8. **Verify VRAM is realistic when both backends are hot:**
   ```bash
   docker compose exec vllm nvidia-smi
   ```
   **Expected:** vllm process uses ~7-8 GB VRAM (matches D-E1 static budget).

**Approve criteria (all four):**
- Both smoke scripts exit 0
- Grafana dashboard renders with live data on all six panels
- request_log has distinct rows for `backend IN ('ollama','vllm-embed')`
- nvidia-smi shows realistic VRAM (no silent CPU fallback)

**Resume signal:** Reply `approved` to mark this plan complete, OR list any failing assertion verbatim (the agent re-spawns to investigate).

**Why this step cannot be automated by the agent:** the agent's worktree has no NVIDIA GPU access, no permission to bring up the live stack, and no way to render a browser dashboard for visual inspection. These are the canonical human-verify properties.

## Next Phase Readiness

After the operator signs off Task 3:
- Phase 7 closes (7/7 requirements complete: BCKND-03, OAI-02, EMBED-01, OBS-02, OBS-03, OBS-04, OBS-05 already complete from Phase 5).
- The Wave 0 sm_120 / vLLM cold-start risk is empirically resolved.
- The smoke recipe (`bash bin/smoke-test-observability.sh && bash bin/smoke-test-router.sh && docker compose ps`) becomes the canonical Phase 7 regression check.

**Blockers:** none. The two smoke scripts are the artifacts. The human-verify checkpoint is the final gate.

## Self-Check

- [x] `bin/smoke-test-observability.sh` exists at the expected path and is executable
- [x] `bin/smoke-test-router.sh` contains the Phase 7 section
- [x] Commit `c9a3369` exists in git log (Task 1)
- [x] Commit `61ded93` exists in git log (Task 2)
- [x] All eight Task 2 automated-verify grep patterns match
- [x] All eight Task 1 automated-verify grep patterns match
- [x] No tracked files were unexpectedly deleted by either commit

---
*Phase: 07-embeddings-vllm-gpu-telemetry*
*Tasks 1-2 completed automatically: 2026-05-17*
*Task 3 awaiting operator approval on the RTX 5060 Ti host*
