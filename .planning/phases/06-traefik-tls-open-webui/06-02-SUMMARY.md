---
phase: 06-traefik-tls-open-webui
plan: 02
subsystem: infra
tags: [router, compose, edge-network, traefik-labels, host-port-removal, metrics-blackhole, four-network]

# Dependency graph
requires:
  - phase: 06-traefik-tls-open-webui
    plan: 01
    provides: "Traefik v3.7.1 service on edge+app networks publishing 127.0.0.1:80/443; metrics-blackhole@file middleware defined in traefik/dynamic/middlewares.yml; Docker provider hardcoded to network=local-llms_app; webui-basic-auth@docker middleware declared on traefik labels"
  - phase: 02-mvp-vertical-slice-router-ollama-sse
    provides: "router: Compose service with 127.0.0.1:3000:3000 loopback bind + 3-network membership (app, backend, data) — this plan removes the bind and adds edge network"
  - phase: 05-postgres-observability-seam
    provides: "Phase 5 D-C5 CRITICAL carry-forward TODO in router/src/auth/bearer.ts:5-12 — the metrics-blackhole label attached in this plan structurally closes the TODO; live 404 proof gates in Plan 06-04"

provides:
  - "compose.yml router: service mutated — `ports: ['127.0.0.1:3000:3000']` removed (EDGE-03)"
  - "compose.yml router: service joins FOUR networks (app, backend, data, edge) — first and only service on all four per Phase 1 D-13 + ROADMAP SC2 (EDGE-02)"
  - "compose.yml router: service has 6 Traefik labels wiring the router-edge router: enable=true, docker.network=${COMPOSE_PROJECT_NAME:-local-llms}_app (Pitfall 12), Host(`router.${TAILNET_HOSTNAME}.ts.net`), entrypoints=web, middlewares=metrics-blackhole@file (D-B1 attachment), services.router-edge.loadbalancer.server.port=3000 (EDGE-01)"
  - "router-dev: service UNCHANGED — still has 127.0.0.1:3000:3000 + 3-network membership (no edge) per Pattern 6 / Claude's Discretion — dev iteration speed preserved"
  - "Live-verified end-to-end via host-header curl: Traefik routes router-edge → router /healthz returns 200; /metrics (with valid bearer) → Fastify 404 on rewritten path /__metrics_blocked__; internal docker-DNS scrape of /metrics returns Prometheus exposition format (D-B2 preserved)"

affects:
  - 06-03-openwebui-service-and-basic-auth-attachment
  - 06-04-readme-and-smoke-test

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pattern: service-on-multiple-networks + Traefik discovery → REQUIRE explicit `traefik.docker.network=${COMPOSE_PROJECT_NAME:-local-llms}_app` label even when traefik.yml's providers.docker.network already disambiguates (belt-and-suspenders; label wins per request, static config is project-wide default)"
    - "Pattern: metrics-blackhole attached via `@file` qualifier on a Docker-labeled router — references middleware defined in the file provider; the qualifier is required because Plan 06-01 also has `@docker`-qualified middlewares (webui-basic-auth) in scope"
    - "Pattern: `ports:` block removal on a service whose dev sibling KEEPS the bind — leaves the YAML body cleaner than commenting-out, and the load-bearing comment explains where external reach now flows (Tailscale → Traefik → Docker DNS) so future readers don't reintroduce the bind"

key-files:
  created: []
  modified:
    - "compose.yml — router: service: removed `ports:` block (lines 230-232 old); added `edge` to networks list as 4th entry; added new `labels:` block (6 entries, all `traefik.*`) between volumes and healthcheck. router-dev: service unchanged. Total diff: +33 / -4."

key-decisions:
  - "Use the canonical \"${COMPOSE_PROJECT_NAME:-local-llms}_app\" form for the disambiguation label (matches the existing pattern in 06-01's traefik service labels and the webui-basic-auth declaration). Traefik DOES interpolate Compose env-vars in DOCKER LABELS (unlike the static traefik.yml file which it does not). This means the label is robust to a future COMPOSE_PROJECT_NAME override, even though Phase 1 D-14 locks the project name."
  - "Use entrypoint `web` (matching the single :80 entrypoint declared in 06-01's traefik.yml). The plan prompt mentioned `websecure` as a fallback but 06-01 only declared `web` — websecure would silently never match. Verified by reading traefik/traefik.yml lines 44-48."
  - "Do NOT add `depends_on: traefik` on the router service. 06-01 already wired the dependency the correct direction: `traefik.depends_on: { router: { service_healthy, required: false } }`. Adding a circular dep would either deadlock the stack-up order or be silently ignored by Compose. The plan's `critical_constraints` flagged this as conditional (\"only if 06-01 didn't already wire this\") — 06-01 did."
  - "Note observed runtime behavior diverges slightly from the plan's documented threat-model T-06-06 disposition (which expects 404). Live test shows: (a) external /metrics WITHOUT bearer → 401 (bearer hook fires on the rewritten path /__metrics_blocked__ since it's NOT in PUBLIC_PATHS); (b) external /metrics WITH valid bearer → Fastify 404 (Route GET:/__metrics_blocked__ not found). Both outcomes still meet the threat-model goal (no metrics data leaks externally); 401 is even more opaque than 404 to an unauth'd attacker. Document for Plan 06-04 smoke author to assert either status code as a pass."

patterns-established:
  - "When a service joins >1 network, explicit `traefik.docker.network` label is the canonical 2026 belt-and-suspenders pattern — even with `providers.docker.network` set in static config. Routes per-service decisions to per-service labels."
  - "Compose env-var interpolation in Docker labels works at compose.yml render time — `${TAILNET_HOSTNAME}` and `${COMPOSE_PROJECT_NAME:-local-llms}_app` both interpolate correctly. Verified empirically with `docker inspect` post-recreate."

requirements-completed: [EDGE-02]
requirements-partial: [EDGE-01, EDGE-03, EDGE-06]

# Metrics
duration: 3min
completed: 2026-05-16
---

# Phase 06 Plan 02: Router Edge Router + Metrics-Blackhole Attachment Summary

**Surgical mutation of the prod `router:` Compose service — removed the `127.0.0.1:3000:3000` host port, added the `edge` network (router now on ALL four networks), and added six Traefik discovery labels wiring `router-edge: Host(\`router.${TAILNET_HOSTNAME}.ts.net\`)` with the `metrics-blackhole@file` middleware attached. `router-dev:` left untouched.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-16T03:06:13Z
- **Completed:** 2026-05-16T03:09:56Z
- **Tasks:** 1 (atomic single-task plan)
- **Files modified:** 1 (compose.yml — net +33/-4 lines)

## Accomplishments
- `router:` service no longer publishes any host port — `docker compose config | python3 -c "yaml.safe_load(...).get('ports')"` returns `None`. EDGE-03 wiring complete (live smoke deferred to 06-04).
- `router:` service joins `edge` network — `docker inspect local-llms-router` shows `local-llms_app, local-llms_backend, local-llms_data, local-llms_edge` (sorted). Router is the ONLY service on all four networks per Phase 1 D-13 + ROADMAP SC2.
- Six Traefik labels added with Compose env-var interpolation working: `Host(\`router.tailtest.ts.net\`)` rendered correctly when `TAILNET_HOSTNAME=tailtest` was passed; the `${COMPOSE_PROJECT_NAME:-local-llms}_app` substitution rendered to `local-llms_app`.
- `metrics-blackhole@file` middleware is now ATTACHED to the router-edge router (Plan 06-01 defined it; this plan wires it). Closes the Phase 5 D-C5 carry-forward TODO structurally (`router/src/auth/bearer.ts:5-12` — comment is left in place; cleanup happens in 06-04 after live smoke).
- End-to-end via host-header curl: `curl -H "Host: router.tailtest.ts.net" http://127.0.0.1:80/healthz` → 200 with router's JSON; `/metrics` with valid bearer → Fastify 404 on `/__metrics_blocked__`; `/metrics` without bearer → 401 (bearer hook fires first on rewritten path — even stronger than the documented 404).
- Internal Docker DNS scrape preserved: `docker compose exec traefik wget -qO- http://router:3000/metrics` returns Prometheus exposition format. D-B2 (Phase 7 prep) intact.
- `router-dev:` unchanged: still has `[{host_ip: 127.0.0.1, published: 3000, target: 3000}]` + 3-network membership (no edge) per Pattern 6.

## Task Commits

Each task was committed atomically:

1. **Task 1: Mutate router: service — remove host port, add edge network, add Traefik labels** — `975047b` (feat)

_Plan metadata commit comes after this SUMMARY.md is written._

## Files Created/Modified

**Modified:**
- `compose.yml` — `router:` service block (lines ~211-260 pre-edit, ~211-290 post-edit). Three surgical mutations:
  1. **Removed** `ports: ["127.0.0.1:3000:3000"]` (and its preceding comment). Replaced with a load-bearing comment block explaining where external reach now flows (Tailscale Serve → Traefik :80 → Docker DNS http://router:3000) and why `router-dev:` keeps its bind.
  2. **Added** `- edge` to the networks list (with an inline comment citing EDGE-02 / Phase 1 D-13 / ROADMAP SC2). The `app` entry's inline comment was updated to mention "Traefik discovers router-edge here (Pitfall 12 disambiguated via the label below)".
  3. **Added** new `labels:` block (6 entries) immediately after the `volumes:` block. Each label has a load-bearing comment explaining its purpose. The block opens with a one-line `# DO NOT add compress or buffering middleware here` reminder (EDGE-04 / Pitfall 4).

All other fields of the `router:` service (build, container_name, restart, environment, healthcheck, depends_on) are byte-for-byte unchanged. All other services in compose.yml (gpu-preflight, ollama, llamacpp, router-dev, postgres, pg-backup, traefik) are byte-for-byte unchanged.

## Decisions Made

1. **Entrypoint name = `web` (not `websecure`).** The prompt's `critical_constraints` listed `websecure` as a fallback option. Verified in `traefik/traefik.yml` lines 44-48 that 06-01 declared ONLY a `web` entrypoint at `:80` (TLS terminates upstream at Tailscale per D-A2). Using `websecure` would have silently never matched.

2. **No `depends_on: traefik` on router.** The prompt flagged this as conditional ("only if 06-01 didn't already wire this"). 06-01 wired the dep in the OPPOSITE direction: `traefik.depends_on: { router: { condition: service_healthy, required: false } }`. Adding `router.depends_on: traefik` would create a circular dep — either Compose deadlocks the up-order or silently ignores one direction. Skipped.

3. **Re-use the `${COMPOSE_PROJECT_NAME:-local-llms}_app` interpolation form** for the disambiguation label (matches 06-01's `traefik` service labels). Empirically verified Compose interpolates `${VAR}` references in Docker labels at render time (`docker inspect local-llms-router` showed `traefik.docker.network=local-llms_app` post-recreate). This is robust to a future `COMPOSE_PROJECT_NAME` override even though Phase 1 D-14 locks it.

4. **Documented threat-model T-06-06 divergence.** The plan's threat register and 06-CONTEXT D-B1 both anchor on "/metrics → 404". Live test shows the actual behavior is:
   - `/metrics` without bearer → **401** (bearer hook fires on the rewritten path `/__metrics_blocked__` since it's not in `PUBLIC_PATHS`).
   - `/metrics` with valid bearer → **404** (Fastify "Route GET:/__metrics_blocked__ not found").

   Both outcomes meet the spirit of T-06-06 (no metrics data exfilled). 401 is arguably MORE opaque than 404 to an unauthenticated attacker. Plan 06-04's smoke author should assert either status code as a pass. No code change needed — the bearer hook firing first is a defense-in-depth bonus.

## Deviations from Plan

None — plan executed exactly as written. The Task 1 `<action>` was followed verbatim, no Rule 1/2/3 auto-fixes were needed. All gating verification commands passed first try.

The observed threat-model behavior divergence (401 vs 404 for unauth'd external `/metrics`) is documented in Decisions Made #4 but is NOT a deviation — the plan's must-have truth #5 explicitly defers the live response-code assertion to Plan 06-04 smoke ("The plan-level static gate is that the label chain is present and parses."). The label chain is present and parses; static gate is met.

## Issues Encountered

None. One minor procedural note: `yq` is not installed on this host, so all YAML-shape assertions ran via `python3 -c "import yaml; ..."` instead of the `yq -e` forms in the plan's `<verify>` block. The python equivalents are functionally identical and the live container `docker inspect` checks corroborated every static result.

## Verification Evidence

### Static-config gates (rendered via `docker compose config`)

```
$ docker compose config >/dev/null 2>&1 && echo OK
OK

$ docker compose --profile dev config 2>/dev/null | python3 -c "
import sys, yaml
d = yaml.safe_load(sys.stdin)
r = d['services']['router']
print('networks (sorted):', sorted(r['networks']) if isinstance(r['networks'], list) else sorted(r['networks'].keys()))
print('ports:', r.get('ports'))
print('labels count:', len(r['labels']))
for k in sorted(r['labels'].keys() if isinstance(r['labels'], dict) else r['labels']):
    print('  ', k, '=', r['labels'][k] if isinstance(r['labels'], dict) else '')
"
networks (sorted): ['app', 'backend', 'data', 'edge']
ports: None
labels count: 6
   traefik.docker.network = local-llms_app
   traefik.enable = true
   traefik.http.routers.router-edge.entrypoints = web
   traefik.http.routers.router-edge.middlewares = metrics-blackhole@file
   traefik.http.routers.router-edge.rule = Host(`router..ts.net`)     # empty because TAILNET_HOSTNAME unset in current .env
   traefik.http.services.router-edge.loadbalancer.server.port = 3000

$ TAILNET_HOSTNAME=tailtest docker compose --profile dev config 2>/dev/null | python3 ... | grep router-edge.rule
   traefik.http.routers.router-edge.rule = Host(`router.tailtest.ts.net`)   # interpolation verified

$ docker compose --profile dev config 2>/dev/null | python3 ... | grep "router-dev"
router-dev.ports: [{'mode': 'ingress', 'host_ip': '127.0.0.1', 'target': 3000, 'published': '3000', 'protocol': 'tcp'}]   # preserved
router-dev.networks (sorted): ['app', 'backend', 'data']     # no edge — preserved
router-dev.labels: None     # unchanged

$ grep -E "router-edge\.middlewares=metrics-blackhole@file" compose.yml
      - "traefik.http.routers.router-edge.middlewares=metrics-blackhole@file"

$ awk '/^  router:$/,/^  [a-z][a-z0-9-]*:$/' compose.yml | grep -E 'compress|buffering' && echo FAIL || echo OK
OK
```

### Live-container gates

```
$ TAILNET_HOSTNAME=tailtest docker compose up -d router
 Container local-llms-router Recreated
 Container local-llms-router Started
# Healthy in ~8s.

$ docker inspect local-llms-router --format '{{ range $k, $v := .NetworkSettings.Networks }}{{ $k }}{{ "\n" }}{{ end }}' | sort
local-llms_app
local-llms_backend
local-llms_data
local-llms_edge                  # FOUR networks confirmed

$ docker inspect local-llms-router --format '{{ range $k, $v := .Config.Labels }}{{ if eq (printf "%.7s" $k) "traefik" }}{{ $k }}={{ $v }}{{ "\n" }}{{ end }}{{ end }}'
traefik.docker.network=local-llms_app
traefik.enable=true
traefik.http.routers.router-edge.entrypoints=web
traefik.http.routers.router-edge.middlewares=metrics-blackhole@file
traefik.http.routers.router-edge.rule=Host(`router.tailtest.ts.net`)
traefik.http.services.router-edge.loadbalancer.server.port=3000

$ TAILNET_HOSTNAME=tailtest docker compose up -d traefik
# Healthy in ~8s. Logs show "Starting provider *docker.Provider" with NO "Could not find network" warning.

$ curl -s -i -H "Host: router.tailtest.ts.net" http://127.0.0.1:80/healthz | head -5
HTTP/1.1 200 OK
Content-Length: 64
Content-Type: application/json; charset=utf-8
Date: Sat, 16 May 2026 03:08:37 GMT

{"status":"ok","service":"router","phase":2,"registry_models":3}

$ curl -s -i -H "Host: router.tailtest.ts.net" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:80/metrics | head
HTTP/1.1 404 Not Found
{"message":"Route GET:/__metrics_blocked__ not found","error":"Not Found","statusCode":404}
# metrics-blackhole rewrite verified — Fastify returns native 404 on the rewritten path.

$ curl -s -i -H "Host: router.tailtest.ts.net" http://127.0.0.1:80/metrics | head
HTTP/1.1 401 Unauthorized
{"error":{"message":"Missing or malformed Authorization header","type":"authentication_error","code":"unauthorized","param":null}}
# Defense-in-depth bonus: bearer hook fires on /__metrics_blocked__ since it's not in PUBLIC_PATHS.

$ curl -s -i -H "Host: notmatching.example.com" http://127.0.0.1:80/healthz | head -2
HTTP/1.1 404 Not Found
# Host-based routing confirmed — wrong host → Traefik native 404.

$ docker compose exec -T traefik wget -qO- http://router:3000/metrics | head -3
# HELP process_cpu_user_seconds_total Total user CPU time spent in seconds.
# TYPE process_cpu_user_seconds_total counter
process_cpu_user_seconds_total 0.305922
# Internal scrape via Docker DNS bypasses Traefik — D-B2 preserved.
```

## User Setup Required

None for this plan. The pre-existing `.env` requirements from 06-01 (`TAILNET_HOSTNAME` for the live router-edge router to match; `TRAEFIK_BASIC_AUTH` for 06-03) still apply, but they don't gate this plan — the stack comes up without them; Traefik just logs a warning and the router-edge router won't match real traffic (only labeled-Host curls work). The 06-04 README plan documents the operator-prereq.

## Next Phase Readiness

**Plan 06-03 (openwebui service + basic-auth attachment):** Ready. compose.yml is clean for the openwebui service block addition. Three carry-forwards for 06-03:
1. **Same Pitfall 12 disambiguation pattern.** OWUI joins `app` + `data` (two networks). 06-03 MUST add `traefik.docker.network=${COMPOSE_PROJECT_NAME:-local-llms}_app` to OWUI's labels — Traefik's static-config default (also `local-llms_app`) would pick `app` anyway here since `data` is `internal: true`, but explicit is consistent with this plan's pattern.
2. **`webui-basic-auth@docker` reference is valid.** 06-01 declared the middleware via Docker label on the `traefik` service; 06-03's webui-edge router attaches it via `traefik.http.routers.webui-edge.middlewares=webui-basic-auth@docker`.
3. **`openwebui:` depends_on update on `traefik:` service block.** 06-01 removed the openwebui dep from traefik.depends_on (Rule 3 auto-fix). 06-03 must add both the `openwebui:` service AND the dep entry back at the same time so `docker compose config` keeps parsing cleanly.

**Plan 06-04 (README + smoke test):** Ready. Three smoke assertions need to use the wiring this plan landed:
1. External /metrics block — 06-04 smoke should accept EITHER 401 OR 404 as pass (both prove no metrics exfil). Document the bearer-vs-no-bearer divergence in the smoke output.
2. Internal `/metrics` scrape via `docker compose exec traefik wget -qO- http://router:3000/metrics` — proves D-B2 (Phase 7 Prometheus prep).
3. 120s+ SSE smoke through Tailscale → Traefik → router → Ollama (EDGE-06) — uses the same Host: router.<tailnet>.ts.net path this plan wired.
4. **`bin/smoke-test-router.sh` has loopback :3000 assumptions that 06-04 MUST fix** (the host port is now gone). Replace `curl localhost:3000/...` with `curl -H "Host: router.${TAILNET_HOSTNAME}.ts.net" http://127.0.0.1:80/...` or use `docker compose exec traefik wget ...` for the internal-net path.

**Phase 6 requirements coverage delivered by this plan:**
- **EDGE-02 (four-network topology preserved with router on all 4 nets):** fully covered.
- **EDGE-01 (Traefik fronts router):** wiring portion covered; full smoke in 06-04.
- **EDGE-03 (zero host-port bindings on prod router):** wiring portion covered; full smoke in 06-04 after `bin/smoke-test-router.sh` fix.
- **EDGE-06 (120s+ SSE through edge):** label chain in place; live smoke in 06-04.
- **D-B1 (metrics-blackhole attached):** fully covered (middleware reference resolves; rewrite verified live).
- **D-B2 (internal /metrics scrape preserved):** fully covered (Docker DNS hit returns Prometheus exposition).
- **Phase 5 D-C5 /metrics carry-forward:** structurally closed; TODO comment in `router/src/auth/bearer.ts:5-12` left in place per plan's critical_constraints — 06-04 owns the comment cleanup after live smoke.

## Self-Check: PASSED

- `compose.yml` modified ✓ (verified with `git diff --stat HEAD~1 HEAD compose.yml` → 1 file changed, 33 insertions(+), 4 deletions(-))
- Task 1 commit `975047b` exists in `git log --oneline` ✓
- `docker compose config` exits 0 ✓
- `router.networks` = [app, backend, data, edge] ✓
- `router.ports` = None ✓
- `router.labels` has 6 entries, all `traefik.*` ✓
- `router-dev.ports` still contains `127.0.0.1:3000:3000` ✓
- `router-dev.networks` still = [app, backend, data] (no edge) ✓
- `docker compose exec traefik wget -qO- http://router:3000/healthz` → 200 router JSON ✓
- `curl -H "Host: router.tailtest.ts.net" http://127.0.0.1:80/healthz` → 200 (router-edge live) ✓
- Internal /metrics scrape returns Prometheus exposition ✓

---
*Phase: 06-traefik-tls-open-webui*
*Plan: 02*
*Completed: 2026-05-16*
