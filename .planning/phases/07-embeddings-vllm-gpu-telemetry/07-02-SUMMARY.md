---
phase: 07-embeddings-vllm-gpu-telemetry
plan: 02
subsystem: observability-compose-stack
tags: [prometheus, grafana, nvidia_gpu_exporter, compose, traefik, wsl2, obs-02, obs-03, obs-04]
dependency_graph:
  requires:
    - phase-01-d-02-host-data-root          # ${HOST_DATA_ROOT}/prometheus + grafana bind-mounts
    - phase-01-d-13-networks                # backend + app already declared
    - phase-06-d-c4-webui-basic-auth        # Grafana reuses Phase 6's basic-auth middleware (D-D8)
    - phase-06-d-a3-tailscale-serve         # grafana.<tn>.ts.net is a third Tailscale Serve hostname (operator-deferred)
    - phase-07-01-env-grafana-admin-password # Plan 07-01 already added GRAFANA_ADMIN_PASSWORD to .env.example
    - phase-07-01-vllm-compose-block        # vllm/vllm-embed exist so the Prometheus scrape config can target them
  provides:
    - phase-07-prometheus-scrape-config     # prometheus/prometheus.yml — 5 scrape jobs
    - phase-07-grafana-datasource           # grafana/provisioning/datasources/datasource.yml
    - phase-07-grafana-edge-route           # grafana.<TAILNET>.ts.net via webui-basic-auth@docker
    - phase-07-gpu-exporter-service         # nvidia_gpu_exporter:9835 scraped by Prometheus
    - phase-07-host-dir-prometheus          # /srv/local-llms/prometheus (uid 65534 ownership policy documented)
    - phase-07-host-dir-grafana             # /srv/local-llms/grafana (invoking-user ownership)
  affects:
    - phase-07-plan-05-grafana-dashboard    # local-llms.json fills the bind-mount this plan declared
    - phase-07-plan-06-live-boot-verify     # smoke asserts up{job="..."} on the scrape targets this plan registered
tech-stack:
  added:
    - "prom/prometheus:v3.10.0 (TSDB + scrape engine; 15s scrape_interval, 15d retention)"
    - "grafana/grafana-oss:12.4.3 (Pitfall G-1 pin update over CONTEXT D-D3's stale 11.x)"
    - "utkuozdemir/nvidia_gpu_exporter:1.4.1 (Pitfall G-2 pin update over CONTEXT D-C1's 1.3.0)"
  patterns:
    - "Declarative observability provisioning — datasource UID pinned in YAML so Plan 07-05's dashboard JSON binds to a stable identifier (Pitfall P-1)"
    - "Reused Phase 6 webui-basic-auth@docker middleware on a third edge router (grafana-edge) — single operator credential surface across router-edge + webui-edge + grafana-edge"
    - "WSL2 nvidia-smi bind-mount source-path detection — used /usr/lib/wsl/lib/{nvidia-smi,libnvidia-ml.so.1} on this host (Pitfall G-3); native-Linux alternatives kept as commented entries"
    - "Bind-mount-source pre-creation in bin/bootstrap-host.sh DIRS array — single source of truth pattern continued from Plan 07-01 (vllm-compile-cache) and Phase 5 (postgres-data uid 70)"
key-files:
  created:
    - prometheus/prometheus.yml
    - grafana/provisioning/datasources/datasource.yml
    - grafana/provisioning/dashboards/.gitkeep
    - grafana/dashboards/.gitkeep
  modified:
    - compose.yml
    - bin/bootstrap-host.sh
decisions:
  - "WSL2 host path detection: bound /usr/lib/wsl/lib/nvidia-smi → /usr/bin/nvidia-smi (container) and /usr/lib/wsl/lib/libnvidia-ml.so.1 → /usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1 (container). Native-Linux source paths are kept as commented alternatives. Rule 3 deviation — Linux source paths do not exist on this WSL2 host so the plan's verbatim binds would fail."
  - "Pin updates over CONTEXT.md applied verbatim per 07-RESEARCH: gpu-exporter 1.4.1 (vs CONTEXT D-C1's 1.3.0), grafana-oss 12.4.3 (vs CONTEXT D-D3's 11.x), prometheus v3.10.0 (was already an open D-D1 — research closed it)."
  - "Dashboard JSON bind-mount path declared NOW but file is empty / absent until Plan 07-05 lands. Grafana boots with the datasource alive and no dashboard — that satisfies OBS-04's plan-boundary success criterion (datasource provisioned, edge reachable, dashboard JSON deferred)."
  - "Three new services on default profile (NOT under profiles: [vllm]) so observability stays alive when vllm profile is down. Prometheus targets for vllm/vllm-embed will show up=0 in that state — expected and documented."
metrics:
  duration_minutes: 8
  completed_date: "2026-05-16"
  commits: 4
outcome: complete
requirements-completed: [OBS-02, OBS-03]
---

# Phase 7 Plan 02: Observability Compose Stack Summary

**Three new always-on observability services (nvidia_gpu_exporter 1.4.1 + prometheus v3.10.0 + grafana-oss 12.4.3) with declarative scrape config and pinned-UID datasource provisioning, edge-routed via reused Phase 6 basic-auth middleware.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-16T20:43Z (approx)
- **Completed:** 2026-05-16T20:51Z
- **Tasks:** 3 (plus 1 bootstrap-host.sh extension per Rule 3 / orchestrator critical_constraints)
- **Files modified:** 2 modified, 4 created

## Accomplishments

- nvidia_gpu_exporter service block added with EXPLICIT WSL2 bind-mounts for nvidia-smi + libnvidia-ml.so.1 (R-6 Option B + Pitfall G-3 host-path detection). Joins backend network only.
- prometheus service block added with file-mounted scrape config; 15s interval; 15d retention; backend network only.
- grafana service block added with declarative datasource provisioning; Traefik labels for grafana.<TAILNET>.ts.net through the reused webui-basic-auth@docker middleware (D-D8).
- prometheus/prometheus.yml created — 5 scrape jobs covering router, vllm+vllm-embed (profile-gated, up=0 until --profile vllm active), llamacpp, nvidia_gpu_exporter, and self.
- grafana/provisioning/datasources/datasource.yml created — Prometheus default datasource at http://prometheus:9090 with pinned UID `prometheus-default` (Pitfall P-1).
- bin/bootstrap-host.sh extended — DIRS array now includes ${HOST_DATA_ROOT}/prometheus and /grafana; targeted chown 65534:65534 added for the prometheus dir (Pitfall P-2 — prom runs as nobody).
- Host dirs `/srv/local-llms/prometheus` and `/srv/local-llms/grafana` pre-created on this host (operator chown still required for prometheus — see Known Stubs below).

## Task Commits

Each task was committed atomically:

1. **Task 1: Add nvidia_gpu_exporter + prometheus + grafana services to compose.yml** — `27a9e69` (feat)
2. **Task 2: Create prometheus/prometheus.yml scrape config** — `b8c35ab` (feat)
3. **Task 3: Create grafana/provisioning/datasources/datasource.yml + dashboard placeholders** — `bab8c8a` (feat)
4. **(Rule 3 deviation) Pre-create prometheus + grafana host dirs in bootstrap-host.sh** — `eddb2ce` (feat)

Plan 07-03 (router-side vLLM adapter) committed in parallel between Tasks 2 and 3 — disjoint file set, no merge conflicts.

## Files Created/Modified

### Created
- `prometheus/prometheus.yml` — 5 scrape jobs (router:3000, vllm:8000+vllm-embed:8000, llamacpp:8080, nvidia_gpu_exporter:9835, self-scrape localhost:9090). Global scrape_interval 15s.
- `grafana/provisioning/datasources/datasource.yml` — Prometheus default datasource; uid `prometheus-default`; editable:false; jsonData.timeInterval 15s matches Prometheus global scrape.
- `grafana/provisioning/dashboards/.gitkeep` — placeholder so the directory tracks in git; Plan 07-05 fills it with local-llms.yml + local-llms.json.
- `grafana/dashboards/.gitkeep` — sibling placeholder matching orchestrator acceptance-check expectation.

### Modified
- `compose.yml` — three new top-level service blocks (~194 lines) inserted between the vllm-embed and router blocks. Each block carries the file's `# ── Section header ────` style with a multi-line docstring per the project's voice.
- `bin/bootstrap-host.sh` — DIRS array gained two entries (prometheus, grafana); echo block expanded; user-owned chown loop gained grafana; targeted chown 65534:65534 added for prometheus (Pitfall P-2). bash -n passes.

## Verbatim acceptance evidence

```
[1/12] docker compose config 2>&1 | grep -c WARN returns 0
       PASS (count: 0)
[2/12] services list includes nvidia_gpu_exporter + prometheus + grafana
       services: ['gpu-preflight','grafana','nvidia_gpu_exporter','openwebui','pg-backup','postgres','prometheus','router','traefik']
       PASS
[3/12] nvidia_gpu_exporter.image == utkuozdemir/nvidia_gpu_exporter:1.4.1
       PASS
[4/12] nvidia_gpu_exporter.volumes include nvidia-smi + libnvidia-ml.so binds
       sources: ['/usr/lib/wsl/lib/nvidia-smi','/usr/lib/wsl/lib/libnvidia-ml.so.1']
       targets: ['/usr/bin/nvidia-smi','/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1']
       PASS — WSL2 paths bound to standard container paths
[5/12] prometheus.image == prom/prometheus:v3.10.0
       PASS
[6/12] grafana.image == grafana/grafana-oss:12.4.3
       PASS
[7/12] grafana.labels include grafana-edge rule + webui-basic-auth middleware
       rule: Host(`grafana.taild8d553.ts.net`)
       middlewares: webui-basic-auth@docker
       PASS
[8/12] prometheus/prometheus.yml exists                                PASS
[9/12] scrape_configs length == 5                                      PASS
[10/12] grafana/provisioning/datasources/datasource.yml exists         PASS
[11/12] grafana/dashboards directory exists                            PASS
[12/12] /srv/local-llms/prometheus AND /srv/local-llms/grafana exist   PASS
```

`docker compose config -q` exits 0 on the default profile.

## WSL2 nvidia path detection

```
$ find /usr -name 'nvidia-smi*' 2>/dev/null
/usr/lib/wsl/lib/nvidia-smi
/usr/lib/wsl/drivers/nvmdi.inf_amd64_*/nvidia-smi
/usr/lib/wsl/drivers/nvmdi.inf_amd64_*/nvidia-smi.exe

$ find /usr -name 'libnvidia-ml*' 2>/dev/null
/usr/lib/wsl/lib/libnvidia-ml.so.1
/usr/lib/wsl/drivers/nvmdi.inf_amd64_*/libnvidia-ml.so.1
/usr/lib/wsl/drivers/nvmdi.inf_amd64_*/libnvidia-ml_loader.so

$ ls /usr/bin/nvidia-smi 2>&1
ls: cannot access '/usr/bin/nvidia-smi': No such file or directory

$ ls /usr/lib/x86_64-linux-gnu/libnvidia-ml* 2>&1
ls: cannot access '/usr/lib/x86_64-linux-gnu/libnvidia-ml*': No such file or directory
```

Conclusion: this WSL2 host (Linux 6.6.87.2-microsoft-standard-WSL2, kernel-projected NVIDIA driver 595.97) keeps the Windows-projected nvidia binaries exclusively under `/usr/lib/wsl/lib/`. The canonical INSTALL.md bind-mount sources do NOT exist. Bind-mount the WSL2 source paths to the container's standard Linux locations so the gpu-exporter binary (which dlopens `libnvidia-ml.so.1` from the standard loader path) finds them.

Verified at the inside-container level via a separate test:

```
$ docker run --rm --gpus all nvidia/cuda:12.9.0-base-ubuntu24.04 bash -c \
    'ls -la /usr/bin/nvidia-smi /usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1'
-r-xr-xr-x 2 root root 828128 Mar 17 23:37 /usr/bin/nvidia-smi
-r-xr-xr-x 2 root root 284928 Mar 17 23:37 /usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1
```

The NCT runtime projects the WSL2 host files into those standard paths INSIDE containers that use the `x-gpu` anchor — but the gpu-exporter image (a FROM-scratch static Go binary) does not invoke the NCT projection the same way, so the explicit binds in this plan's compose block are required regardless of host kind.

## Decisions Made

- **Rule 3 deviation: WSL2 path substitution.** The plan's `<action>` block (and 07-RESEARCH §R-6 Option B verbatim) lists `/usr/bin/nvidia-smi` and `/usr/lib/x86_64-linux-gnu/libnvidia-ml.so*` as bind-mount sources. On this WSL2 host those sources do not exist (see detection block above). Without substitution, `docker compose up nvidia_gpu_exporter` would create empty directories at those paths instead of binding files, causing the exporter to fail with `nvidia-smi: command not found`. Substituted to `/usr/lib/wsl/lib/nvidia-smi` and `/usr/lib/wsl/lib/libnvidia-ml.so.1` (the only paths that actually exist) bound to the container's standard Linux locations. Native-Linux alternatives kept as commented entries so future deploys on bare Ubuntu/Debian can flip the bind sources back with a single edit.
- **Pin updates over CONTEXT.md.** Applied 07-RESEARCH's three closed-pitfall pin updates without further discussion — they were already research-blessed: gpu-exporter 1.4.1 (G-2 SIGTERM fix), grafana-oss 12.4.3 (G-1 stale-version fix), prometheus v3.10.0 (CLOSED R-4 — schema unchanged from v2 so the migration is a no-op).
- **Dashboard JSON bind declared but file deferred.** The plan explicitly wants the bind-mount declared NOW so Plan 07-05 just commits the JSON file later. Grafana boots cleanly with the datasource provisioned and no dashboard — which is the OBS-04-at-this-plan-boundary contract (datasource alive; dashboard JSON deferred to Plan 07-05).
- **Three observability services default-profile (NOT vllm-profile-gated).** Per CONTEXT §"Prometheus + Grafana as new Compose services... in default profile (always-on observability)". Operator can run the stack without vllm; Prometheus scrape targets for vllm/vllm-embed will show up=0 in that state. Documented in the prometheus.yml docstring.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] WSL2 nvidia-smi + libnvidia-ml.so.1 source-path substitution**

- **Found during:** Task 1 (drafting the nvidia_gpu_exporter service block).
- **Issue:** The plan's `<action>` block + 07-RESEARCH §R-6 verbatim list the canonical Linux paths (`/usr/bin/nvidia-smi`, `/usr/lib/x86_64-linux-gnu/libnvidia-ml.so{,.1}`) as bind-mount sources. On this WSL2 host (Linux 6.6.87.2-microsoft-standard-WSL2 with Windows-projected NVIDIA driver), those source paths do not exist — `find /usr -name 'nvidia-smi*'` returns only `/usr/lib/wsl/lib/nvidia-smi`. Using the canonical sources would cause Docker to silently create empty directories at the bind-mount source paths and then fail to mount them as files into the container (Compose v5.x semantics).
- **Fix:** Replaced the bind-mount sources with the WSL2-resident paths (`/usr/lib/wsl/lib/nvidia-smi` and `/usr/lib/wsl/lib/libnvidia-ml.so.1`) while keeping the container target paths at their standard Linux locations (`/usr/bin/nvidia-smi`, `/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1`) so the gpu-exporter binary finds them at its expected dlopen path. Native-Linux alternatives kept as commented YAML lines so a future deploy on bare Ubuntu/Debian can flip the bind sources with a single comment swap.
- **Files modified:** compose.yml (nvidia_gpu_exporter service block).
- **Verification:** `docker compose config -q` exits 0; the rendered config shows the substituted sources binding to the standard targets. A docker run smoke against `nvidia/cuda:12.9.0-base-ubuntu24.04` confirms that NCT projects those exact target paths inside containers using the x-gpu anchor — but gpu-exporter's FROM-scratch image does NOT use the anchor, so the explicit binds in this block are required regardless of host kind.
- **Committed in:** `27a9e69` (Task 1 commit).
- **Rationale:** Rule 3 — without this substitution, the gpu-exporter container would fail at startup on every `docker compose up nvidia_gpu_exporter` on this host. The orchestrator's `<critical_constraints>` explicitly listed this case ("check both paths. Use the one that exists.") so the substitution is in-bounds.

**2. [Rule 3 - Blocking] Pre-created prometheus + grafana host dirs + extended bin/bootstrap-host.sh**

- **Found during:** Task 1 verification (the prometheus + grafana bind-mount sources would not exist on a fresh host).
- **Issue:** The compose blocks bind-mount `${HOST_DATA_ROOT}/prometheus` and `${HOST_DATA_ROOT}/grafana` for persistent state. Neither path existed on this host. On first `docker compose up`, Compose's auto-create-missing-bind-source behavior would create them as root-owned (since dockerd runs as root), causing Pitfall P-2 (prometheus UID 65534 cannot write) and a wrong-uid Grafana state dir. Same pattern as Plan 07-01's vllm-compile-cache.
- **Fix:** (a) `mkdir -p /srv/local-llms/prometheus /srv/local-llms/grafana` so the dirs exist now; (b) extended `bin/bootstrap-host.sh` DIRS array with both entries, expanded the echo block, added grafana to the user-owned chown loop, and added a targeted `sudo chown 65534:65534 ${HOST_DATA_ROOT}/prometheus` rule (mirroring the existing postgres 70:70 pattern from Phase 5). The orchestrator's `<critical_constraints>` explicitly called this out ("EXTEND `bin/bootstrap-host.sh` to include the new dirs in DIRS array").
- **Files modified:** bin/bootstrap-host.sh (DIRS array + echo block + chown loop + targeted prometheus chown).
- **Verification:** `bash -n bin/bootstrap-host.sh` passes; live run on this host created both dirs and reported the targeted-chown lines (chowns themselves require tty-attached sudo, same as the pre-existing postgres lines — operator step).
- **Committed in:** `eddb2ce` (separate commit since it's a hostname/bootstrap concern, not part of any single task).
- **Rationale:** Rule 3 — without this fix, the operator's first `docker compose up -d prometheus grafana` would either fail or silently create wrong-ownership dirs that take a manual `sudo chown` to recover from. Aligns with Phase 1 D-02's "single source of truth for the v1 host directory list" and the Plan 07-01 + Phase 5 precedent.

### Did NOT deviate

- DID NOT touch any router code (router/src/, router/models.yaml) — Plan 07-03 owns that, running in parallel.
- DID NOT touch vllm/vllm-embed services (Plan 07-01 territory).
- DID NOT modify Phase 6 services (ollama, postgres, pg-backup, router, openwebui, traefik, gpu-preflight).
- DID NOT run `docker compose up` (per critical_constraints — Plan 07-06 owns the live boot).
- DID NOT publish host ports on any of the new services (D-D6 + D-C2 — internal scrape only; edge access via Traefik for Grafana).
- DID NOT modify the existing traefik `depends_on:` block (Grafana is reached via Docker provider label discovery; no explicit upstream-dep wiring needed).
- DID NOT create grafana/provisioning/dashboards/local-llms.json or grafana/provisioning/dashboards/local-llms.yml — Plan 07-05 owns those.
- DID NOT create .env entries — Plan 07-01 already declared GRAFANA_ADMIN_PASSWORD in .env.example; the operator's value generation is the user-setup step.

---

**Total deviations:** 2 auto-fixed (both Rule 3 / blocking).
**Impact on plan:** Both deviations were called out by the orchestrator's `<critical_constraints>` — they are in-bounds executions of the plan, not scope creep.

## Issues Encountered

- None during planned work. The WSL2 path detection (deviation 1) was anticipated by the orchestrator's critical_constraints and resolved with one substitution.

## Hand-off to Plan 07-05 (Grafana Dashboard)

- The bind-mount target `./grafana/provisioning/dashboards/local-llms.json:/etc/grafana/dashboards/local-llms.json:ro` is already declared in compose.yml. Plan 07-05 needs to commit:
  - `grafana/provisioning/dashboards/local-llms.yml` — dashboard provider config (apiVersion: 1; path: /etc/grafana/dashboards).
  - `grafana/provisioning/dashboards/local-llms.json` — the dashboard JSON itself with the 5 panels per Phase 7 SC4 (VRAM, request rate, TTFT, latency, error rate, backend selection). The JSON's datasource references MUST use `uid: prometheus-default` so the Pitfall P-1 pinning chain holds.
- The placeholder `.gitkeep` files Plan 07-02 added under `grafana/provisioning/dashboards/` and `grafana/dashboards/` can stay or be removed by Plan 07-05 (they only exist to make the directories git-trackable until the real files land).

## Hand-off to Plan 07-06 (Live boot + smoke)

- Three new services join the default profile. `docker compose up -d` (no `--profile`) brings them up alongside Phase 1-6 services.
- Pre-flight checklist for the operator before Plan 07-06's live boot:
  1. Ensure `.env` has `GRAFANA_ADMIN_PASSWORD` set (Plan 07-01 declared it in `.env.example`; operator generates via `openssl rand -hex 24`).
  2. Run `bin/bootstrap-host.sh` with sudo (or follow up with manual `sudo chown 65534:65534 /srv/local-llms/prometheus` per Pitfall P-2).
  3. Operator must add a Tailscale Serve mapping `svc:grafana → grafana.<tn>.ts.net → http://127.0.0.1:80` (third hostname after router + chat; deferred operator step per D-D7). Until then, Grafana reachable via `127.0.0.1:80` with `Host: grafana.<tn>.ts.net` header (Phase 6 LAN bypass pattern).
- Smoke targets Plan 07-06 will assert on (already aligned with this plan's scrape config):
  - `up{job="router"} == 1`
  - `up{job="llamacpp"} == 1` (when `--profile llamacpp` active)
  - `up{job="gpu"} == 1`
  - `up{job="prometheus"} == 1`
  - `up{job="vllm"} == 0` (default profile) → `== 1` after `--profile vllm` activation
  - Grafana `/api/datasources/uid/prometheus-default` returns 200

## Known Stubs

- **`grafana/provisioning/dashboards/local-llms.json` is not yet created.** Plan 07-05 fills it. Until then, Grafana boots with the datasource alive but no dashboard. The compose.yml bind-mount declares the path; on first `docker compose up grafana` before Plan 07-05 lands, Docker will create the source as an empty directory (since the file doesn't exist) and the dashboard provider will fail to load — but the datasource provisioning still completes, which is what this plan's success criterion asks for. Mitigation: `.gitkeep` files exist under both `grafana/provisioning/dashboards/` and `grafana/dashboards/` so the directories themselves track in git.
- **Targeted chown 65534:65534 on `/srv/local-llms/prometheus` was deferred.** The bootstrap-host.sh `sudo chown` step requires a tty-attached sudo (no askpass available in the agent shell). The directory currently has uid 1000 (luis) ownership. Operator runs `bin/bootstrap-host.sh` interactively before first `docker compose up -d prometheus` OR runs `sudo chown -R 65534:65534 /srv/local-llms/prometheus` manually. This is the same pattern as Phase 5's pg-backup uid 70 chown (already-documented operator step).

## Threat Flags

- **Grafana edge exposure: T-07-04 / T-07-06 are mitigated** per the plan's threat register. `GF_AUTH_ANONYMOUS_ENABLED=false`, `GF_USERS_ALLOW_SIGN_UP=false`, admin password from `.env`, Traefik basic-auth gating at the edge. Two-layer auth (Traefik basic-auth + Grafana admin user) is the documented single-operator pattern.
- **No NEW external surface introduced.** The three services are internal-scrape only (gpu-exporter, prometheus) or reach the edge only via the reused Phase 6 basic-auth middleware (grafana). No host ports published. No new CORS / public DNS surface.
- **Threat surface scan result:** No flags. Files added do not introduce new auth paths, file-access patterns, or schema changes at trust boundaries beyond what the threat register already covers.

## Self-Check

- [x] `compose.yml` updated — `git show --stat 27a9e69 -- compose.yml` reports +194 lines.
- [x] `prometheus/prometheus.yml` created — `git show --stat b8c35ab` reports the new file.
- [x] `grafana/provisioning/datasources/datasource.yml` created — `git show --stat bab8c8a` reports the new file.
- [x] `grafana/provisioning/dashboards/.gitkeep` + `grafana/dashboards/.gitkeep` created — same commit.
- [x] `bin/bootstrap-host.sh` extended — `git show --stat eddb2ce` reports +20/-1 lines; `bash -n bin/bootstrap-host.sh` passes.
- [x] `docker compose config -q` exits 0 (default profile).
- [x] `docker compose config` lists nvidia_gpu_exporter + prometheus + grafana.
- [x] `grep -c WARN` on `docker compose config 2>&1` returns 0.
- [x] Image pins all 3 verified: `utkuozdemir/nvidia_gpu_exporter:1.4.1`, `prom/prometheus:v3.10.0`, `grafana/grafana-oss:12.4.3`.
- [x] nvidia_gpu_exporter has both /dev/nvidiactl + /dev/nvidia0 devices AND explicit volume binds for nvidia-smi + libnvidia-ml.so.1 (WSL2 source paths substituted).
- [x] Grafana Traefik labels: `traefik.docker.network=${COMPOSE_PROJECT_NAME:-local-llms}_app` + grafana-edge router rule with `webui-basic-auth@docker` middleware.
- [x] prometheus.yml has 5 scrape jobs (router, vllm, llamacpp, gpu, prometheus self).
- [x] datasource.yml has apiVersion 1 + uid: prometheus-default + url http://prometheus:9090.
- [x] /srv/local-llms/prometheus + /srv/local-llms/grafana directories exist.
- [x] Commits exist in git history:
  - `27a9e69 feat(07-02): add nvidia_gpu_exporter + prometheus + grafana services`
  - `b8c35ab feat(07-02): add prometheus/prometheus.yml scrape config`
  - `bab8c8a feat(07-02): add grafana provisioning datasource + dashboard placeholders`
  - `eddb2ce feat(07-02): pre-create prometheus + grafana host dirs in bootstrap-host.sh`

## Self-Check: PASSED
