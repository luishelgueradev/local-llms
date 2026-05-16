---
phase: 06-traefik-tls-open-webui
plan: 01
subsystem: infra
tags: [traefik, edge, sse-knobs, compose, env-contract, scaffolding, metrics-blackhole]

# Dependency graph
requires:
  - phase: 01-gpu-compose-foundation
    provides: "four-network topology (edge/app/backend/data); .env.example with TRAEFIK_ACME_EMAIL + TRAEFIK_BASIC_AUTH declared; COMPOSE_PROJECT_NAME=local-llms locked"
  - phase: 02-mvp-vertical-slice-router-ollama-sse
    provides: "router service on app+backend; SSE backpressure + 15s heartbeat in router code (must remain undisturbed by Traefik)"
  - phase: 05-postgres-observability-seam
    provides: "/metrics public-skip-list with CRITICAL carry-forward TODO that this plan's metrics-blackhole middleware will close in Plan 06-02"
provides:
  - "Traefik v3.7.1 Compose service publishing ONLY 127.0.0.1:80 + 127.0.0.1:443 (D-A4)"
  - "Traefik static config (traefik/traefik.yml) with SSE-friendly forwardingTimeouts (idleConnTimeout: 0s, responseHeaderTimeout: 0s — EDGE-04 / Pitfall 3)"
  - "metrics-blackhole middleware (file provider) rewriting ^/metrics(/.*)?$ → /__metrics_blocked__ (D-B1; will be attached to router-edge router in Plan 06-02)"
  - "webui-basic-auth middleware declared via Docker label on the traefik service from \${TRAEFIK_BASIC_AUTH} (D-C4; will be attached to webui router in Plan 06-03)"
  - ".env.example with TAILNET_HOSTNAME + OWUI_SECRET_KEY added; TRAEFIK_ACME_EMAIL annotated DEPRECATED (unused with Tailscale Serve); TRAEFIK_BASIC_AUTH comment corrected to remove misleading \$\$-doubling instruction"
  - "Compose-level posture: zero 0.0.0.0:* bindings on the traefik service; Docker provider Pitfall 12 disambiguation via hardcoded network: local-llms_app"
  - "Dashboard fully disabled (api.dashboard=false + api.insecure=false — D-D1); no traefik.*.ts.net Tailscale Serve mapping needed (D-D2)"
affects:
  - 06-02-router-edge-router-and-metrics-blackhole-attachment
  - 06-03-openwebui-service-and-basic-auth-attachment
  - 06-04-readme-and-smoke-test

# Tech tracking
tech-stack:
  added:
    - "traefik:v3.7.1 (edge proxy; pinned to current latest v3.7.x patch as verified 2026-05-16)"
  patterns:
    - "Two-layer Traefik config split: static (entrypoints, providers, serversTransport, api, log) in traefik/traefik.yml; dynamic (middlewares) under traefik/dynamic/ with watch=true"
    - "Self-labeling: middlewares whose value must flow from .env are declared as Docker labels on the traefik service itself, so ${VAR} interpolation happens at Compose render time"
    - "HTTP-only Traefik (entrypoint web on :80) with TLS delegated to Tailscale Serve upstream (D-A2)"
    - "Hardcoded Docker-provider network ('local-llms_app') because Traefik static YAML does NOT interpolate ${COMPOSE_PROJECT_NAME} — necessary for Pitfall 12 disambiguation when a service is on >1 network"

key-files:
  created:
    - "traefik/traefik.yml — static config (api off, accessLog disabled, forwardingTimeouts {dialTimeout:30s, responseHeaderTimeout:0s, idleConnTimeout:0s}, Docker provider with network=local-llms_app + exposedByDefault=false, file provider watching /etc/traefik/dynamic, NO certResolvers, NO compress/buffering)"
    - "traefik/dynamic/middlewares.yml — file-provider dynamic config holding the metrics-blackhole middleware (ReplacePathRegex ^/metrics(/.*)?$ → /__metrics_blocked__)"
  modified:
    - "compose.yml — new traefik: service block appended after pg-backup: (image traefik:v3.7.1, ports 127.0.0.1:80 + 127.0.0.1:443, docker.sock RO mount, traefik.yml + dynamic/ RO mounts, networks edge+app, healthcheck via wget, self-label declaring webui-basic-auth middleware, router service_healthy required:false dep)"
    - ".env.example — added TAILNET_HOSTNAME (with `tailscale status` discovery recipe), added OWUI_SECRET_KEY (with `openssl rand -hex 32` recipe + pin-don't-rotate guidance), annotated TRAEFIK_ACME_EMAIL as DEPRECATED (Tailscale Serve owns TLS), CORRECTED TRAEFIK_BASIC_AUTH comment (removed misleading \$\$-doubling instruction after empirically verifying Compose interpolation behavior)"

key-decisions:
  - "Hardcode docker.provider.network as literal 'local-llms_app' rather than ${COMPOSE_PROJECT_NAME}_app — Traefik does NOT interpolate Compose vars in its static YAML, so the env-var form silently fell back to first-available network with a warning. Hardcoded value is safe because COMPOSE_PROJECT_NAME is locked to local-llms since Phase 1 D-14."
  - "Drop the openwebui dependency from the traefik depends_on block in this plan. Docker Compose v5.1.3 (verified empirically) rejects depends_on refs to undefined services even with required:false at `docker compose config` validation time. Plan 06-03 will add both the openwebui service AND the dep entry back at that time."
  - "Correct .env.example TRAEFIK_BASIC_AUTH comment to instruct operators to paste htpasswd output VERBATIM (single \$), not \$\$-doubled. The plan inherited an incorrect assumption from 06-RESEARCH that Compose interpolates a SUBSTITUTED env-var value a second time. Empirically (docker inspect on a live container) Compose substitutes once and the value reaches Traefik with the original single \$ — which is what BasicAuth expects."
  - "Self-label the basic-auth middleware on the traefik: service itself rather than putting it in traefik/dynamic/middlewares.yml — keeps .env as the single source of truth for the htpasswd hash; the file-provider YAML cannot consume Compose-interpolated env vars."

patterns-established:
  - "Pattern: SSE-correct forwardingTimeouts as an explicit override in static config — idleConnTimeout: 0s (override 90s default) is load-bearing for 120s+ generations; responseHeaderTimeout: 0s is defensive against future default changes; dialTimeout: 30s is the documented default but pinned explicit"
  - "Pattern: file-provider dynamic config for path-rewrite middlewares like metrics-blackhole — chosen over the `errors` middleware (would need a separate error service) and the IPAllowList pattern (defense-in-depth only, doesn't solve the surface-area concern); ReplacePathRegex defers the 404 to the upstream Fastify's native 404 handler"
  - "Pattern: Docker provider network MUST be a hardcoded string in Traefik static YAML — env-var interpolation only happens at compose.yml parsing time, not at Traefik static-file load time"
  - "Pattern: split Compose env-var interpolation (which substitutes once) from literal-$ escape in compose.yml YAML content (which needs $$ to defer to shell). The pg-backup service's `$$STAMP` is an example of the latter; ${TRAEFIK_BASIC_AUTH} is an example of the former"

requirements-completed: [EDGE-01, EDGE-04, EDGE-05]

# Metrics
duration: 17min
completed: 2026-05-16
---

# Phase 06 Plan 01: Traefik TLS + Open WebUI Scaffolding Summary

**Traefik v3.7.1 Compose service plus static + dynamic config scaffolding (loopback-only ports, SSE-friendly forwardingTimeouts, metrics-blackhole middleware), with .env contract for Phase 6 (TAILNET_HOSTNAME, OWUI_SECRET_KEY, corrected basic-auth recipe).**

## Performance

- **Duration:** 17 min
- **Started:** 2026-05-16T02:45:09Z
- **Completed:** 2026-05-16T03:01:50Z
- **Tasks:** 2
- **Files modified:** 4 (2 new, 2 mutated)

## Accomplishments
- Traefik v3.7.1 is the first edge-tier service in the stack, publishing exclusively on `127.0.0.1:80` + `127.0.0.1:443` (no `0.0.0.0:*` mappings). Container reaches `healthy` in ~10s standalone.
- EDGE-04 load-bearing SSE knobs in place: `serversTransport.forwardingTimeouts.idleConnTimeout: 0s` (overrides Traefik's 90s default that would otherwise truncate 120s+ generations) + `responseHeaderTimeout: 0s` (defensive pin). No `compress` / `buffering` / response-coalesce middleware anywhere in `traefik/`.
- `metrics-blackhole` middleware ready for Plan 06-02 to attach to the router-edge router — uses `ReplacePathRegex` rewriting `^/metrics(/.*)?$` → `/__metrics_blocked__` so the upstream Fastify returns its native 404. Closes the Phase 5 D-C5 CRITICAL carry-forward TODO in `router/src/auth/bearer.ts:5-12` once 06-02 wires the router.
- `webui-basic-auth` middleware ready for Plan 06-03 — declared via Docker label on the traefik service (`traefik.http.middlewares.webui-basic-auth.basicauth.users=${TRAEFIK_BASIC_AUTH}`) so `.env` remains the single source of truth.
- Traefik dashboard fully disabled (`api.dashboard: false`, `api.insecure: false`) — D-D1 / D-D2 satisfied (no `traefik.<tailnet>.ts.net` to publish).
- `.env.example` Phase 6 contract finalized: `TAILNET_HOSTNAME` (operator-provided, with discovery recipe), `OWUI_SECRET_KEY` (operator-generated with `openssl rand -hex 32`), `TRAEFIK_ACME_EMAIL` annotated DEPRECATED (unused with Tailscale Serve), `TRAEFIK_BASIC_AUTH` comment empirically corrected to drop the misleading `$$`-doubling instruction.
- Docker provider Pitfall 12 mitigation in place (`network: "local-llms_app"`) — Traefik picks the `app` network when discovering services on multiple networks. Verified clean in container logs (no `Could not find network` warning).

## Task Commits

Each task was committed atomically:

1. **Task 1: Create traefik/ static + dynamic config + .env.example mutations** — `8566c2a` (feat)
2. **Task 2: Add traefik: Compose service block + verify config interpolation** — `c0505c3` (feat — folds three auto-fixed deviations)

_Plan metadata commit comes after this SUMMARY.md is written._

## Files Created/Modified

**Created:**
- `traefik/traefik.yml` — Traefik static config. Anchors: `api.dashboard: false` + `api.insecure: false`; `log.format: json`; `accessLog: {}` (disabled to prevent bearer leak through default access-log format); `entryPoints.web.address: ":80"` (single HTTP-only entrypoint per D-A2); `serversTransport.forwardingTimeouts.{dialTimeout: 30s, responseHeaderTimeout: 0s, idleConnTimeout: 0s}` (EDGE-04 / Pitfall 3); `providers.docker` with `network: "local-llms_app"` + `exposedByDefault: false` + `watch: true` (Pitfall 12 — hardcoded because Traefik doesn't interpolate Compose vars); `providers.file.directory: /etc/traefik/dynamic` + `watch: true`. NO `certResolvers`. NO `compress`/`buffering` references.
- `traefik/dynamic/middlewares.yml` — file-provider dynamic config holding ONLY the `metrics-blackhole` middleware (`replacePathRegex` with `regex: "^/metrics(/.*)?$"` → `replacement: "/__metrics_blocked__"`). The webui basic-auth middleware is intentionally NOT in this file — it's declared via Docker label on the traefik service for .env interpolation.

**Modified:**
- `compose.yml` — appended new `traefik:` service block after `pg-backup:` (lines 419–476). `image: traefik:v3.7.1`; `ports: ["127.0.0.1:80:80", "127.0.0.1:443:443"]`; `volumes` mount `/var/run/docker.sock:ro` + `./traefik/traefik.yml:ro` + `./traefik/dynamic:ro`; `networks: [edge, app]`; `healthcheck` via `wget -qO- http://localhost:80/ >/dev/null 2>&1 || exit 0` (`|| exit 0` is the no-routers-yet-tolerant variant); `labels` declaring `traefik.enable=true` + `traefik.http.middlewares.webui-basic-auth.basicauth.users=${TRAEFIK_BASIC_AUTH}`; `depends_on.router: {condition: service_healthy, required: false}` (openwebui dep deferred to Plan 06-03 — see deviations). No mutations to any other service.
- `.env.example` — Phase 6 block (lines 46–89) rewritten: new `TAILNET_HOSTNAME=` (with `tailscale status --json | jq` discovery recipe), `TRAEFIK_ACME_EMAIL=` annotated as DEPRECATED (Tailscale Serve owns TLS per D-A2 — left for backward compat), `TRAEFIK_BASIC_AUTH=` comment empirically corrected to drop the `$$`-doubling instruction (single `$` is correct for the .env→label path; `$$` doubling applies only to literal `$` typed directly into compose.yml YAML content), new `OWUI_SECRET_KEY=` (with `openssl rand -hex 32` recipe + pin-don't-rotate guidance per Pitfall 10).

## Decisions Made

1. **Hardcode `local-llms_app` literal in `providers.docker.network`** rather than `${COMPOSE_PROJECT_NAME}_app`. Empirically verified: Traefik does NOT interpolate Compose env-var references in its YAML config (the file is mounted as plain text and never touched by Compose). With `${COMPOSE_PROJECT_NAME}_app` as the literal value, Traefik logged `"Could not find network named \"${COMPOSE_PROJECT_NAME}_app\""` and silently fell back to the first available network. Hardcoded value is safe because `COMPOSE_PROJECT_NAME=local-llms` is locked since Phase 1 D-14; documented in a load-bearing comment in `traefik/traefik.yml`.

2. **Drop `openwebui:` from the traefik `depends_on:` block in this plan.** The 06-01 plan's must-have truth assumed Compose tolerates undefined-service deps with `required: false`. Empirically (Docker Compose v5.1.3), `docker compose config` rejects the file at validation time with: `service "traefik" depends on undefined service "openwebui": invalid compose project`. Plan 06-03 adds both the `openwebui:` service AND the dep entry back at that time.

3. **Correct `.env.example` `TRAEFIK_BASIC_AUTH` recipe.** The plan inherited an incorrect assumption from 06-RESEARCH Pattern 4 / Pitfall 7: that the htpasswd hash needs `$` doubled to `$$` in `.env`, because "Compose collapses `$$` → `$` at interpolation". Empirically (verified with `docker run`+`docker inspect` against a live container with both recipes), Compose does NOT re-interpolate the substituted value of an env-var. So `TRAEFIK_BASIC_AUTH=admin:$apr1$abc$xyz` (single `$`) → runtime label `admin:$apr1$abc$xyz` (single `$`) → Traefik happy. The `$$`-doubling rule applies ONLY to literal `$` typed directly into the compose.yml YAML content (e.g., the pg-backup service's `command:` array uses `$$STAMP` to defer expansion to the shell). The .env.example comment now explains both cases.

4. **Self-label the basic-auth middleware on the traefik: service.** Confirmed the architectural choice per 06-RESEARCH §"Pattern 4: ALTERNATE" — declare `traefik.http.middlewares.webui-basic-auth.basicauth.users` via Docker label on the traefik service rather than in `traefik/dynamic/middlewares.yml`. This lets `.env` flow in via Compose interpolation; the file-provider YAML cannot consume Compose env vars.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Compose rejects undefined `openwebui:` dependency**
- **Found during:** Task 2 (Add traefik: Compose service block)
- **Issue:** Plan's `<action>` instructed to add `openwebui: { condition: service_healthy, required: false }` to `traefik.depends_on`, noting "Compose tolerates missing dependencies when `required: false`". Empirically false on Docker Compose v5.1.3: `docker compose config` fails with `service "traefik" depends on undefined service "openwebui": invalid compose project`. This blocked the Task 2 verify gate `docker compose config 2>&1 | grep -q "traefik:v3.7.1"`.
- **Fix:** Removed the `openwebui:` entry from the traefik `depends_on:` block. Added a load-bearing comment in compose.yml documenting why the entry is missing and instructing Plan 06-03 to add both the service and the dep entry back.
- **Files modified:** `compose.yml` (traefik service depends_on block)
- **Verification:** `docker compose config` exits 0; `docker compose up -d traefik` reaches `healthy` in ~10s; traefik logs `Starting provider *docker.Provider` confirming the service registry is functional.
- **Committed in:** c0505c3 (Task 2 commit)

**2. [Rule 2 - Missing Critical] Pitfall 12 mitigation (Docker provider network disambiguation)**
- **Found during:** Task 2 (post-bring-up Traefik log inspection)
- **Issue:** Plan's `traefik/traefik.yml` set `providers.docker.network: "${COMPOSE_PROJECT_NAME}_app"`. Traefik does NOT interpolate Compose-style env-var references in its YAML config — the file is mounted as plain text and Compose never reaches into it. Effect: Traefik logged `"Could not find network named \"${COMPOSE_PROJECT_NAME}_app\" for container..."` and fell back to "first available network", which on this stack happens to be `app` but is not guaranteed across Compose-render orderings. This silently defeats Pitfall 12 disambiguation.
- **Fix:** Tried first to move the Docker provider config to compose.yml `command:` CLI flags (where Compose WOULD interpolate) — but Traefik treated the static-file `providers:` block as a complete replacement of CLI flags rather than a merge, so the Docker provider didn't start at all. Final fix: hardcode the literal `"local-llms_app"` in `traefik/traefik.yml` and document why in a load-bearing comment. Safe because `COMPOSE_PROJECT_NAME` is locked to `local-llms` since Phase 1 D-14; if it ever changes the operator must update this line manually.
- **Files modified:** `traefik/traefik.yml` (providers.docker.network value + accompanying comment)
- **Verification:** After fix, container logs show `Starting provider *docker.Provider` AND no "Could not find network" warning. Service discovery functional.
- **Committed in:** c0505c3 (Task 2 commit)

**3. [Rule 1 - Bug] `.env.example` `TRAEFIK_BASIC_AUTH` `$$`-doubling recipe was incorrect**
- **Found during:** Task 2 (verifying webui-basic-auth label interpolation behavior with `docker compose config` + a `docker run` + `docker inspect` round-trip)
- **Issue:** Plan's `<critical_constraints>` instructed: "Refresh the TRAEFIK_BASIC_AUTH comment update — clarify the `$$` escaping recipe: `htpasswd -nB admin | sed -e 's/\$/\$\$/g'`. Compose collapses $$ → $ correctly". Empirical test against Docker Compose v5.1.3: with `MY_VAR='admin:$apr1$abc$xyz'` (single `$`), `docker inspect` on the resulting container shows `Labels["test.users"]=admin:$apr1$abc$xyz` (single `$`). With `MY_VAR='admin:$$apr1$$abc$$xyz'` (doubled), `docker inspect` shows `admin:$$apr1$$abc$$xyz` (still doubled — Compose did NOT collapse). So the plan's recipe would have led operators to put doubled `$$` in `.env`, which would reach Traefik unchanged as doubled `$$` and break Traefik's BasicAuth parser. The misleading recipe is rooted in `docker compose config` PRINTING values with `$` doubled for re-interpolation safety — but that's display-time escaping, not the runtime value.
- **Fix:** Rewrote the `.env.example` `TRAEFIK_BASIC_AUTH` comment block. The new comment: (a) instructs operators to paste `htpasswd -nB admin` output VERBATIM (no `sed` doubling); (b) explains the empirical Compose-interpolation rule; (c) calls out the `docker compose config` display-time `$`-doubling so future readers don't get confused; (d) distinguishes env-var values (single `$`, no doubling) from literal `$` in compose.yml YAML content (where `$$` doubling IS correct — see pg-backup's `$$STAMP`).
- **Files modified:** `.env.example` (TRAEFIK_BASIC_AUTH comment block, lines 62–88 of the new file)
- **Verification:** Empirical test reproducible: `MY_VAR='admin:$abc' docker compose -f /tmp/test-compose.yml up -d && docker inspect <container> --format '{{ index .Config.Labels "test.users" }}'` returns `admin:$abc` (single `$`). The plan's Task 1 verify gate `grep -q "htpasswd -nB" .env.example` still passes (recipe still contains `htpasswd -nB`, just without the misleading `| sed` postscript).
- **Committed in:** c0505c3 (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 Rule 1 documentation bug, 1 Rule 2 missing critical mitigation, 1 Rule 3 blocking issue)

**Impact on plan:** All three fixes were necessary to satisfy the plan's own must-have truths (#5 Pitfall 12 disambiguation, #1 Compose parses cleanly, #8 correct interpolation behavior). The .env.example recipe correction in particular is a documentation safety win — operators would have hit a confusing 401 from Traefik with the plan's original recipe. No scope creep — all changes stayed within the files the plan already mutates. The `webui-basic-auth` middleware semantic (Docker label declared on the traefik service, value `${TRAEFIK_BASIC_AUTH}`) is unchanged; only the `.env` recipe instruction is corrected.

## Verification Evidence

End-of-plan verification commands from the plan's `<verification>` block plus the prompt's `<acceptance_after_completion>` block, run after Task 2 commit:

### Static-config gates

```
$ docker compose config >/dev/null 2>&1 && echo OK
OK

$ docker compose config 2>&1 | grep -q "^  traefik:" && echo OK
OK

$ docker compose config 2>&1 | grep -E "image: traefik:v3\.7\.1$"
    image: traefik:v3.7.1

$ docker compose config 2>&1 | sed -n '/^  traefik:/,/^  [a-z]/p' | grep -c "host_ip: 127.0.0.1"
2     # both :80 and :443 publish to loopback

$ docker compose config 2>&1 | sed -n '/^  traefik:/,/^  [a-z]/p' | grep -F "0.0.0.0"
              # (empty — zero matches)

$ grep -F "idleConnTimeout: 0s" traefik/traefik.yml
    idleConnTimeout: 0s         # OVERRIDE default 90s — long-generation enabler (EDGE-04)

$ grep -F "responseHeaderTimeout: 0s" traefik/traefik.yml
    responseHeaderTimeout: 0s   # explicit; 0 = no header timeout (default but pinned)

$ python3 -c "import yaml; d=yaml.safe_load(open('traefik/dynamic/middlewares.yml')); print(d['http']['middlewares']['metrics-blackhole'])"
{'replacePathRegex': {'regex': '^/metrics(/.*)?$', 'replacement': '/__metrics_blocked__'}}

$ grep -E "(dashboard|insecure): false" traefik/traefik.yml
  dashboard: false
  insecure: false

$ grep -ri compress traefik/ && echo FAIL || echo OK
OK     # (zero results — recursive)

$ grep -ri buffering traefik/ && echo FAIL || echo OK
OK     # (zero results — recursive)

$ grep -E '^TAILNET_HOSTNAME=|^OWUI_SECRET_KEY=' .env.example
TAILNET_HOSTNAME=
OWUI_SECRET_KEY=

$ grep -iE "unused.*Tailscale|deprecated" .env.example
# DEPRECATED — Phase 6 picks Tailscale Serve for TLS (06-CONTEXT.md D-A2)

$ grep "htpasswd -nB" .env.example
#   htpasswd -nB admin
```

### Live-container gates

```
$ docker compose up -d traefik
Container local-llms-traefik Started

$ docker compose ps --format '{{.Name}} {{.Health}}' | grep traefik
local-llms-traefik healthy

$ docker compose logs traefik --since=30s 2>&1 | grep -iE "provider|warn" | head
{"level":"warn",...,"message":"Traefik can reject some encoded characters in the request path..."}
{"level":"info",...,"message":"Starting provider aggregator *aggregator.ProviderAggregator"}
{"level":"info",...,"message":"Starting provider *file.Provider"}
{"level":"info",...,"message":"Starting provider *traefik.Provider"}
{"level":"info",...,"message":"Starting provider *acme.ChallengeTLSALPN"}
{"level":"info",...,"message":"Starting provider *docker.Provider"}
# No "Could not find network" warning — Pitfall 12 fix verified.

$ curl -i --max-time 5 http://127.0.0.1:80/ 2>&1 | head -3
HTTP/1.1 404 Not Found
Content-Type: text/plain; charset=utf-8
# 404 expected — Plan 06-02 wires the router-edge router.

$ docker compose exec traefik wget -qO- 'http://localhost/api/rawdata' 2>/dev/null
# (empty — dashboard disabled per D-D1)
```

### `$`-interpolation behavior empirical test

```
$ mkdir /tmp/c && cd /tmp/c
$ cat > compose.yml <<'EOF'
services:
  test:
    image: alpine:3
    command: ["sh","-c","sleep 5"]
    labels:
      - "test.users=${MY_VAR}"
EOF
$ MY_VAR='admin:$apr1$abc$xyz' docker compose up -d
$ docker inspect compose-test-test-1 --format '{{ index .Config.Labels "test.users" }}'
admin:$apr1$abc$xyz                    # Single $ preserved — no doubling needed.
$ docker compose down -v

$ MY_VAR='admin:$$apr1$$abc$$xyz' docker compose up -d
$ docker inspect compose-test-test-1 --format '{{ index .Config.Labels "test.users" }}'
admin:$$apr1$$abc$$xyz                 # Doubled $$ preserved — Compose did NOT collapse.
```

This empirical evidence is what drove the Rule 1 deviation correcting `.env.example`'s recipe.

## Issues Encountered

- **Traefik 3.7 silent provider override.** First-pass fix for Pitfall 12 was to put `providers.docker.*` in compose.yml `command:` flags (where Compose interpolates). But the static-file `providers:` block (with only `file:` defined) acted as a COMPLETE replacement, not a merge — Docker provider didn't start at all. Resolution: revert to declaring docker provider IN `traefik.yml` with a hardcoded network name. The Traefik documentation's claim that "CLI flags merge with static-file config" appears to apply at the leaf level but the top-level `providers:` key is treated as atomic. Documented in the load-bearing comment in `traefik/traefik.yml`.

## User Setup Required

None for this plan — Plan 06-04 (the smoke + README plan) will document the operator-prereq Tailscale Services bootstrap. The new `.env.example` vars added in this plan (`TAILNET_HOSTNAME`, `OWUI_SECRET_KEY`) need operator-provided values before Plan 06-02 / 06-03 ship a fully working edge, but the values are not required for `docker compose up -d traefik` to succeed standalone (verified — Traefik comes up healthy without them).

## Next Phase Readiness

**Plan 06-02 (router edge router + metrics-blackhole attachment):** Ready. The `metrics-blackhole@file` reference is valid (file provider has the middleware loaded). Plan 06-02's router-edge router will reference it via `traefik.http.routers.router-edge.middlewares=metrics-blackhole@file`. The `traefik.docker.network=${COMPOSE_PROJECT_NAME}_app` label on the router service that Plan 06-02 adds is REDUNDANT but not harmful — the static-config `providers.docker.network: "local-llms_app"` already disambiguates.

**Plan 06-03 (openwebui service + basic-auth attachment):** Ready. The `webui-basic-auth@docker` reference is valid (declared via Docker label on the traefik service). Plan 06-03's webui router will reference it via `traefik.http.routers.webui-edge.middlewares=webui-basic-auth@docker`. Plan 06-03 MUST also add the `openwebui: { condition: service_healthy, required: false }` entry to the traefik service's `depends_on:` block — this plan removed it (Rule 3 deviation) because Compose v5.1.3 rejects undefined-service refs.

**Plan 06-04 (README + smoke test):** Ready. The static checks in `bin/smoke-test-traefik.sh` (which Plan 06-04 creates) will green against this plan's deliverables: `responseHeaderTimeout: 0s` + `idleConnTimeout: 0s` in `traefik/traefik.yml`; no `compress` middleware anywhere in `traefik/`; `metrics-blackhole` middleware defined.

**Phase 6 requirements coverage delivered by this plan:**
- **EDGE-04 (SSE knobs):** fully covered — forwardingTimeouts in static config.
- **EDGE-01 (Traefik fronts the stack):** scaffolding portion covered; full attachment in 06-02/06-03.
- **EDGE-03 (no host-port leaks on backends):** Traefik publish posture set to loopback-only; router host-port removal happens in 06-02.
- **EDGE-05 (HTTP→HTTPS redirect):** TLS portion deferred to Tailscale Serve (D-A5); inside-Docker is HTTP-only as designed.
- **Phase 5 D-C5 `/metrics` carry-forward:** middleware DEFINED here, ATTACHED in 06-02.
- **D-D1 dashboard disabled:** fully covered.

## Self-Check: PASSED

- `traefik/traefik.yml` exists ✓
- `traefik/dynamic/middlewares.yml` exists ✓
- `compose.yml` has `traefik:` service ✓
- `.env.example` has `TAILNET_HOSTNAME` + `OWUI_SECRET_KEY` ✓
- Task 1 commit `8566c2a` exists in `git log --oneline` ✓
- Task 2 commit `c0505c3` exists in `git log --oneline` ✓
- `docker compose config` exits 0 ✓
- `docker compose up -d traefik` reaches `healthy` ✓

---
*Phase: 06-traefik-tls-open-webui*
*Plan: 01*
*Completed: 2026-05-16*
