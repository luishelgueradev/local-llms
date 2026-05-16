---
phase: 06-traefik-tls-open-webui
plan: 03
subsystem: infra
tags: [openwebui, compose, env-seeding, basic-auth, postgres-db, auto-discovery, traefik, four-network]

# Dependency graph
requires:
  - phase: 06-traefik-tls-open-webui
    plan: 01
    provides: "Traefik v3.7.1 service publishing 127.0.0.1:80/443, webui-basic-auth@docker middleware declared via Docker label on the traefik service (so ${TRAEFIK_BASIC_AUTH} flows via Compose interpolation), .env.example contract with TAILNET_HOSTNAME + OWUI_SECRET_KEY"
  - phase: 06-traefik-tls-open-webui
    plan: 02
    provides: "Pattern: explicit `traefik.docker.network=${COMPOSE_PROJECT_NAME:-local-llms}_app` label on services that join multiple networks (Pitfall 12); router-edge router naming convention `<service>-edge` (reused here as `webui-edge`)"
  - phase: 05-postgres-observability-seam
    provides: "openwebui Postgres database created EMPTY by postgres/initdb/01-init.sql; `app` role with access to both router + openwebui DBs (D-B6); empty-DB precondition required for WEBUI_AUTH=False boot-zero (Pitfall 2 / 06-RESEARCH §Pattern 5) — VERIFIED"
  - phase: 02-mvp-vertical-slice-router-ollama-sse
    provides: "ROUTER_BEARER_TOKEN env contract; router GET /v1/models for OWUI auto-discovery; bearer-auth middleware that gates OWUI's OpenAI connector"

provides:
  - "compose.yml openwebui: service block — ghcr.io/open-webui/open-webui:v0.9.0 pinned image; full 10-env-var contract; bind-mount /app/backend/data; [app, data] networks; /health healthcheck on :8080; depends_on postgres+router with required:false; 6 Traefik labels wiring `webui-edge: Host(`chat.${TAILNET_HOSTNAME}.ts.net`)` with `webui-basic-auth@docker` middleware attached + `webui-edge` service on port 8080"
  - "traefik service `depends_on:` block closes 06-01's deferred carry-forward — `openwebui: { condition: service_healthy, required: false }` is now declared (was blocked by Compose v5.1.3 undefined-service-dep rejection in 06-01)"
  - "Compose-level posture: zero host-port mappings on openwebui (EDGE-03 holds across Phase 6); networks limited to [app, data] (no backend membership — anti-bypass guarantee per D-C6); WEBUI_AUTH=False set from boot zero (D-C3 irreversible)"
  - "Auto-discovery wiring: OWUI's OpenAI connector seeded at boot with OPENAI_API_BASE_URLS=http://router:3000 (NO /v1 suffix — Pitfall 5) + OPENAI_API_KEYS=${ROUTER_BEARER_TOKEN}; OWUI will GET /v1/models on first chat-list render and populate from router/models.yaml (WEBUI-05)"

affects:
  - 06-04-readme-and-smoke-test

# Tech tracking
tech-stack:
  added:
    - "ghcr.io/open-webui/open-webui:v0.9.0 (Open WebUI v0.9 pinned patch; never :main, never :latest per CLAUDE.md)"
  patterns:
    - "Pattern: OWUI env-driven seeding (06-RESEARCH §Pattern 5) — every config knob set at first boot. The three PersistentConfig-marked vars (WEBUI_AUTH, ENABLE_OLLAMA_API, OPENAI_API_BASE_URLS/KEYS) are DB-locked after first boot — irreversible without DB wipe. Pin WEBUI_SECRET_KEY from .env (Pitfall 10) so DB backups round-trip across container recreates."
    - "Pattern: inline DATABASE_URL materialization from POSTGRES_PASSWORD (matches Phase 5 D-B6 form used on router service) — keeps the OPENWEBUI_DATABASE_URL value flowing through .env without needing a separate top-level env-var declaration. The plan's must-have truth #7 phrasing 'consumes the env already declared on the router service' was inherited as a misconception — Phase 5 declared it as a SERVICE-level env, not a top-level Compose env, so `${OPENWEBUI_DATABASE_URL}` interpolated to empty in 06-03 OWUI. Inline form is the canonical fix (Rule 2)."
    - "Pattern: `<service>-edge` Traefik router naming convention (06-02 introduced `router-edge`; 06-03 follows with `webui-edge`). Stable, greppable, no collision risk."

key-files:
  created: []
  modified:
    - "compose.yml — ADDED new `openwebui:` service block (~84 lines) immediately after the `traefik:` block. Also closed the 06-01 deferred carry-forward: `traefik:` service's `depends_on:` now declares `openwebui: { condition: service_healthy, required: false }` (was blocked at validation time by Compose v5.1.3 in 06-01). Diff: +103/-10. All other services (gpu-preflight, ollama, llamacpp, router, router-dev, postgres, pg-backup) byte-for-byte unchanged."

key-decisions:
  - "Use `webui-edge` (not `webui`) as the Traefik router name on the OWUI service's labels. The validated code snippet in 06-RESEARCH.md §'Validated Code Snippets' #6 uses `webui`, but 06-02 established the `<service>-edge` convention (`router-edge`) and the orchestrator's prompt critical_constraints explicitly named `webui-edge`. Following the established 06-02 pattern + the prompt's explicit naming wins over the research-doc draft."
  - "Inline-materialize DATABASE_URL from `${POSTGRES_PASSWORD}` instead of interpolating `${OPENWEBUI_DATABASE_URL}`. Plan must-have truth #7 phrased it as `${OPENWEBUI_DATABASE_URL}` but Phase 5 declared that var only as a SERVICE-level env on the router service — not a top-level Compose env — so it would interpolate to empty here. Inline form (`postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/openwebui`) is what Phase 5 itself uses on the router service. Documented as Rule 2 deviation below."
  - "Connect 06-01's deferred `traefik.depends_on.openwebui` entry in the same commit as the openwebui service addition. The 06-01 plan required this be done 'at that time' per the 06-01-SUMMARY.md carry-forward note; combining both edits into one task commit keeps the diff atomic and reviewable. No `docker compose config` validation failure now (verified)."
  - "Healthcheck `start_period: 30s` (not 15s like router) — OWUI 0.9 cold-boot is documented as 15-25s on first DB init (06-RESEARCH §Pattern 5). 30s provides headroom; failing fast is the wrong tradeoff here because a flapping healthcheck would prevent the openwebui dep on `traefik` from going green."

patterns-established:
  - "Pattern: When a plan's must-have truth describes consuming a `${VAR}` whose source isn't actually in `.env` (e.g., it's a service-level env declared on another service), audit at compose-config-render time and either (a) inline-materialize the actual value, or (b) elevate the var to top-level `.env`. Option (a) is preferred when the var is fully derivable from existing operator-known inputs (here: POSTGRES_PASSWORD + literal DB name); option (b) adds operator surface and is reserved for non-derivable secrets."
  - "Pattern: `WEBUI_AUTH=False` posture requires empty-DB precondition; the precondition is established structurally (Phase 5 D-B6 created an empty `openwebui` database) and is documented as a load-bearing comment in compose.yml. Operators MUST NOT 'test with auth first, disable later' — this is enshrined as Pitfall 10 in 06-RESEARCH and the irreversibility is called out in three places in the new service block."
  - "Pattern: Phase 6 services that aren't on the `edge` network rely on Traefik discovering them through the `app` network (via the `traefik.docker.network=${COMPOSE_PROJECT_NAME:-local-llms}_app` label). Both router (06-02) and now openwebui (06-03) use this same label; future services that join Traefik should follow."

requirements-completed: [WEBUI-01, WEBUI-02, WEBUI-03, WEBUI-04, WEBUI-05]

# Metrics
duration: 4min
completed: 2026-05-16
---

# Phase 06 Plan 03: Open WebUI Service + basic-auth Attachment Summary

**Open WebUI v0.9.0 added to compose.yml — single OpenAI-compatible connection to the router (no /v1 suffix), WEBUI_AUTH=False from boot zero with Traefik basic-auth at the edge, shared Postgres `openwebui` DB, auto-discovery via /v1/models, networks limited to [app, data] (anti-bypass), zero host ports, `webui-basic-auth@docker` middleware attached.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-05-16T03:14:18Z
- **Completed:** 2026-05-16T03:17:55Z
- **Tasks:** 1 (atomic single-task plan)
- **Files modified:** 1 (compose.yml — net +103/-10)

## Accomplishments

- **OWUI service block landed** at compose.yml lines ~520-602 with the full 10-env-var contract: WEBUI_AUTH=False (D-C3 boot-zero), ENABLE_SIGNUP=False (belt-and-suspenders), OPENAI_API_BASE_URLS=http://router:3000 (D-C2 NO /v1), OPENAI_API_KEYS=${ROUTER_BEARER_TOKEN} (D-C1), ENABLE_OPENAI_API=True, ENABLE_OLLAMA_API=False (D-C6 anti-bypass), DATABASE_URL inline-materialized as postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/openwebui (D-C5/WEBUI-04), WEBUI_SECRET_KEY=${OWUI_SECRET_KEY} (Pitfall 10), WEBUI_NAME=local-llms, WEBUI_URL=https://chat.${TAILNET_HOSTNAME}.ts.net.
- **Networks limited to [app, data] only.** No backend membership (anti-bypass per D-C6); no edge membership (Traefik reaches OWUI via the `app` network — the `traefik.docker.network` label disambiguates per Pitfall 12).
- **Zero host-port mappings on openwebui** — EDGE-03 holds across all Phase 6 service additions/mutations (Traefik publishes 127.0.0.1:80/443, router lost its 127.0.0.1:3000:3000 in 06-02, openwebui has none).
- **6 Traefik labels wiring `webui-edge` router** with `Host(`chat.${TAILNET_HOSTNAME}.ts.net`)` on the `web` entrypoint, `webui-basic-auth@docker` middleware attached (declared on the traefik service in 06-01), and load-balancer target on port 8080. The `<service>-edge` naming convention (`webui-edge` here, `router-edge` from 06-02) is now established as a stable Phase-6 pattern.
- **OWUI healthcheck** targets `http://localhost:8080/health` with `start_period: 30s` (OWUI 0.9 cold-boot can take 15-25s on first DB init per 06-RESEARCH §Pattern 5). `depends_on` declares postgres + router both with `required: false` so OWUI tolerates restart cycles.
- **Bind-mount** `${HOST_DATA_ROOT:-/srv/local-llms}/openwebui:/app/backend/data` — plain bind per Phase 1 D-02 layout (D-C8).
- **06-01 deferred carry-forward closed.** The `traefik:` service's `depends_on:` block now declares `openwebui: { condition: service_healthy, required: false }` — this was blocked at `docker compose config` validation time by Compose v5.1.3 in 06-01 (which had to remove the entry as a Rule 3 deviation). Now that openwebui exists, the dep entry is valid and Compose parses cleanly.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add openwebui: service block to compose.yml + close 06-01's traefik.depends_on carry-forward** — `3fe8e46` (feat — folds one auto-fixed Rule 2 deviation)

_Plan metadata commit comes after this SUMMARY.md is written._

## Files Created/Modified

**Modified:**
- `compose.yml` — appended new `openwebui:` service block after the `traefik:` service (lines ~520-602); also patched `traefik.depends_on:` to add the previously-deferred `openwebui: { condition: service_healthy, required: false }` entry. Total diff: +103/-10 (single hunk, all changes in the traefik/openwebui region; no other service touched). The 10 removed lines are 9 comment lines explaining why the openwebui-dep entry was missing in 06-01 + 1 trivial phrasing change ("router restart cycles" → "restart cycles") — all comment-only; no semantic change to any existing wired dep.

## Decisions Made

1. **Use `webui-edge` (not `webui`) as the Traefik router name.** The validated code snippet in `06-RESEARCH.md §"Validated Code Snippets" #6` uses `webui`, but the established pattern is `<service>-edge` (06-02 introduced `router-edge`) and the orchestrator prompt's `critical_constraints` explicitly named `webui-edge`. Consistency with 06-02's pattern + explicit prompt direction wins. The `webui-basic-auth@docker` middleware reference in 06-01's traefik labels is the MIDDLEWARE name (declared as `traefik.http.middlewares.webui-basic-auth.basicauth.users=...`); it is distinct from the ROUTER name (`webui-edge`) — no collision.

2. **Inline-materialize DATABASE_URL from `${POSTGRES_PASSWORD}` instead of using `${OPENWEBUI_DATABASE_URL}`.** See Rule 2 deviation below for the full audit.

3. **Bundle the 06-01 deferred `traefik.depends_on.openwebui` entry into this same task commit.** 06-01-SUMMARY.md explicitly carried-forward "Plan 06-03 MUST also add the `openwebui: { condition: service_healthy, required: false }` entry to the traefik service's `depends_on:` block". Combining both edits in the single Task 1 commit makes the diff atomic and matches the spirit of the carry-forward instruction — `docker compose config` keeps parsing cleanly throughout.

4. **`start_period: 30s` on the healthcheck (not 15s).** OWUI 0.9 cold-boot is documented as 15-25s on first DB init (when Drizzle-like migrations seed empty Postgres). 15s would risk flapping; 30s provides headroom without compromising the up-time visibility. Matches the 06-RESEARCH §Pattern 5 recommendation verbatim.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] `DATABASE_URL=${OPENWEBUI_DATABASE_URL}` resolved to empty string at compose-config render time**

- **Found during:** Task 1 verification gate `docker compose config | python3 ... grep DATABASE_URL`.
- **Issue:** The plan's must-have truth #7 instructed `DATABASE_URL=${OPENWEBUI_DATABASE_URL}` with the rationale "env was declared on router since Phase 5 D-B6; Compose substitutes from .env". This was inherited from the plan-author's misreading of Phase 5: `OPENWEBUI_DATABASE_URL` is NOT a top-level `.env` variable. Phase 5 declared it as a SERVICE-level env on the `router:` service's `environment:` block (compose.yml lines 226-227 as `- OPENWEBUI_DATABASE_URL=postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/openwebui`). Compose's interpolation scope on the `openwebui:` service does NOT inherit another service's env vars — only top-level `.env` (and shell environment). So `${OPENWEBUI_DATABASE_URL}` interpolated to an empty string in the rendered openwebui environment, which would have caused OWUI to fail on first boot trying to connect to the empty-string DSN (or worse, silently fall back to SQLite at `/app/backend/data/webui.db` and break WEBUI-04).
- **Fix:** Replaced `DATABASE_URL=${OPENWEBUI_DATABASE_URL}` with the inline form `DATABASE_URL=postgresql://app:${POSTGRES_PASSWORD}@postgres:5432/openwebui` — exact same shape Phase 5 uses on the router service for the same DSN. Added a load-bearing comment in compose.yml documenting the inheritance pitfall so future readers don't re-introduce the broken form. The wire value is byte-identical to what the plan intended; only the construction differs.
- **Files modified:** `compose.yml` (openwebui environment block, DATABASE_URL line + comment).
- **Verification:** Post-fix, `docker compose config | python3 ... | grep DATABASE_URL` returns `DATABASE_URL=postgresql://app:[REDACTED]@postgres:5432/openwebui` with `POSTGRES_PASSWORD` correctly substituted from the operator's `.env`. WEBUI-04 acceptance ("OWUI uses shared Postgres `openwebui` DB") is now structurally met.
- **Committed in:** `3fe8e46` (Task 1 commit).

---

**Total deviations:** 1 auto-fixed (1 Rule 2 — Missing Critical Functionality).

**Impact on plan:** Critical for WEBUI-04 + WEBUI-03 to actually work at first boot. Without the fix, OWUI would have either (a) failed Postgres connection and fallen back to ephemeral SQLite, breaking the shared-DB requirement, or (b) crashed during DB-driven `WEBUI_AUTH=False` enforcement (which queries the empty-users table to satisfy the Pitfall-10 precondition). No scope creep — the fix uses the existing `${POSTGRES_PASSWORD}` env that Phase 1 D-14 already locked into `.env.example`. The plan's stated GOAL (D-C5 / WEBUI-04 — "OWUI uses the shared Postgres openwebui DB") is preserved; only the construction differs.

## Issues Encountered

None beyond the Rule 2 deviation documented above. One minor procedural note (mirroring 06-02's experience): `yq` is not installed on this host, so all YAML-shape assertions in the plan's `<verify>` block were run via `python3 -c "import yaml; ..."` instead. The python equivalents are functionally identical and were comprehensive enough to cover all 20 gating checks (15 from `<verification>` + 5 from the prompt's `<acceptance_after_completion>`).

## Verification Evidence

All 20 static gating checks (the union of plan `<verification>` lines 1-10 + prompt `<acceptance_after_completion>` block) ran via `docker compose config 2>/dev/null | python3 -c "..."` after the Task 1 commit. Output verbatim:

```
1.  image pin: PASS                                              # ghcr.io/open-webui/open-webui:v0.9.0 (exact pin)
2.  WEBUI_AUTH=False: PASS                                       # D-C3 irreversible boot-zero
3.  ENABLE_OLLAMA_API=False: PASS                                # D-C6 anti-bypass
4.  OPENAI_API_BASE_URLS=http://router:3000: PASS                # D-C2 exact string
5.  No /v1 in OPENAI_API_BASE_URLS: PASS                         # Pitfall 5 regression gate
6.  DATABASE_URL resolves to postgres openwebui DB: PASS         # postgresql://app:[REDACTED]@postgres:5432/openwebui
7.  networks == [app, data]: PASS                                # NOT backend, NOT edge
8.  ports is None (EDGE-03): PASS                                # zero host-port mappings
9.  labels count == 6: PASS                                      # exactly 6 Traefik labels
10. webui-basic-auth@docker middleware attached: PASS            # D-C4
11. healthcheck targets /health on 8080: PASS                    # curl -fsS http://localhost:8080/health || exit 1
12. depends_on postgres+router with required:false: PASS         # both service_healthy + required:false
13. bind-mount /app/backend/data: PASS                           # type=bind src=/srv/local-llms/openwebui
14. traefik.depends_on.openwebui wired: PASS                     # 06-01 carry-forward closed
15. WEBUI_SECRET_KEY env present: PASS                           # value empty pending operator OWUI_SECRET_KEY in .env
16. ENABLE_SIGNUP=False: PASS                                    # belt-and-suspenders
17. ENABLE_OPENAI_API=True: PASS                                 # explicit-for-clarity
18. WEBUI_NAME=local-llms: PASS                                  # UI branding hook
19. WEBUI_URL declared (value: https://chat..ts.net): PASS       # TAILNET_HOSTNAME empty in current .env; renders correctly when set
20. restart=unless-stopped: PASS                                 # matches other services

ALL 20 GATES PASS
```

### Verification commands used (reproducible)

```
$ docker compose config 2>&1 | tail -5
          - capabilities:
              - gpu
              - utility
            count: all
            driver: nvidia
$ echo $?
0

$ git diff --stat compose.yml
 compose.yml | 113 ++++++++++++++++++++++++++++++++++++++++++++++++++++++------
 1 file changed, 103 insertions(+), 10 deletions(-)

$ git diff compose.yml | grep -c "^@@"
1
# Single hunk — confirms no other service was touched
```

### Live boot smoke (deferred to Plan 06-04)

Per the plan's `<verification>` line 11 + Wave 4 separation, live boot of openwebui is deferred to Plan 06-04. Static-config posture is now complete; 06-04 will run:

1. `TAILNET_HOSTNAME=<real> docker compose up -d openwebui && sleep 45 && docker compose ps openwebui --format '{{.Health}}'` → expect `healthy`.
2. From host: `curl -H "Host: chat.<tailnet>.ts.net" http://127.0.0.1:80/` → expect `HTTP/1.1 401 Unauthorized` from Traefik basic-auth.
3. With creds: `curl -H "Host: chat.<tailnet>.ts.net" -u "<user>:<pass>" http://127.0.0.1:80/` → expect 200 + OWUI HTML.
4. After first OWUI boot: `docker compose exec postgres psql -U app -d openwebui -c '\dt'` → expect OWUI's tables (user, chat, model, etc.) — proves WEBUI-04.
5. From OWUI internal: `docker compose exec openwebui curl -fsS -H "Authorization: Bearer $ROUTER_BEARER_TOKEN" http://router:3000/v1/models` → expect 200 + the three models from `router/models.yaml` — proves WEBUI-05 + connector wiring (no `/v1/v1/` doubling).
6. OWUI process logs scan: `docker compose logs openwebui | grep -iE "ollama|api/tags"` → expect NO matches (proves ENABLE_OLLAMA_API=False is honored — defense-in-depth against D-C6).

## User Setup Required

**Operator must populate `.env` with three Phase-6 values before bringing OWUI up (these were added to `.env.example` by Plan 06-01 but are blank by default):**

1. **`TAILNET_HOSTNAME=<your-tailnet-name>`** — discover with `tailscale status --json | jq -r '.MagicDNSSuffix' | sed 's/\.$//' | cut -d. -f1` (or just look at any of your nodes' `*.ts.net` hostnames — the `<TAILNET_HOSTNAME>` is the first segment after the node name). Used in the `Host(`chat.${TAILNET_HOSTNAME}.ts.net`)` Traefik label.

2. **`OWUI_SECRET_KEY=<32-byte-hex>`** — generate with `openssl rand -hex 32`. Pins OWUI's JWT signing key (Pitfall 10 — if not pinned, OWUI auto-generates and persists it inside the container; bind-mount survival is not guaranteed across recreates, which would invalidate sessions and corrupt encrypted-at-rest data in the OWUI DB on next boot). **Once set, DO NOT rotate — backups depend on it.**

3. **`TRAEFIK_BASIC_AUTH=<htpasswd-output>`** — already discussed in 06-01's `.env.example` block. Run `htpasswd -nB admin` (paste output VERBATIM with single `$` — 06-01 verified empirically that `$$`-doubling is WRONG for the .env→label path). Gates `chat.<tailnet>.ts.net` access since `WEBUI_AUTH=False` inside OWUI.

Plan 06-04 (README + smoke) will document these prereqs in the README's Phase 6 operational section.

## Next Phase Readiness

**Plan 06-04 (README + smoke test):** Ready. Five hand-offs:

1. **OWUI is the last new service.** No more compose.yml mutations expected in Phase 6 beyond the README + smoke script. The compose.yml end-state of 06-03 is the Phase 6 deliverable shape.
2. **Smoke can include WEBUI-03 401-then-200 posture proof.** Curl to `chat.<tailnet>.ts.net` without basic-auth creds → 401 from Traefik; with valid creds → 200 + OWUI HTML. Both prove the Traefik basic-auth middleware is intercepting at the edge (not OWUI itself).
3. **Smoke can include WEBUI-04 DB-presence proof.** After OWUI's first boot, `docker compose exec postgres psql -U app -d openwebui -c '\dt'` will list OWUI's tables (user, chat, model, etc.). Empty before, populated after — clean signal.
4. **Smoke can include WEBUI-05 auto-discovery proof.** Either via OWUI's own logs (`docker compose logs openwebui | grep -i "models"`) or via an internal curl from the openwebui container to the router's `/v1/models`. Both should succeed and return the three models from `router/models.yaml`.
5. **Smoke can include the anti-bypass proof (D-C6).** From inside the openwebui container, attempt `curl http://ollama:11434/api/tags` — should FAIL with "no route to host" or DNS error, because the openwebui service is NOT on the `backend` network where ollama lives. This proves the network-membership-based isolation, beyond just `ENABLE_OLLAMA_API=False`.

**Phase 6 requirements coverage delivered by this plan:**

- **WEBUI-01 (OWUI behind Traefik on chat subdomain):** structurally complete — Traefik label chain in place with `Host(`chat.${TAILNET_HOSTNAME}.ts.net`)`; live proof in 06-04.
- **WEBUI-02 (single OAI-compatible connection, NO /v1 suffix):** structurally complete — `OPENAI_API_BASE_URLS=http://router:3000` exact, with the regression-gate verifying `/v1` is absent.
- **WEBUI-03 (WEBUI_AUTH=False boot-zero + Traefik basic-auth edge gate):** structurally complete — `WEBUI_AUTH=False` + `ENABLE_SIGNUP=False` in env from boot zero; `webui-basic-auth@docker` middleware attached; live 401-then-200 proof in 06-04.
- **WEBUI-04 (shared Postgres openwebui DB):** structurally complete — `DATABASE_URL` resolves to the correct postgres connection string (Rule 2 deviation fixed the misconception); live `\dt` proof in 06-04.
- **WEBUI-05 (auto-discovery via /v1/models):** structurally complete — connector wired with no `/v1` suffix doubling; live curl proof in 06-04.

**Phase 6 anti-pattern guarantees preserved:**

- **D-C6 (no OWUI bypass to backends):** doubly enforced. (1) `ENABLE_OLLAMA_API=False` at the OWUI app layer. (2) `networks: [app, data]` — `backend` is absent, so even if OWUI's code tried to reach Ollama, Docker DNS would fail.
- **EDGE-03 (no host port leaks):** preserved. openwebui has no `ports:` block.
- **EDGE-04 (SSE knobs):** preserved. No `compress` or `buffering` middleware in OWUI's label chain.

## Self-Check: PASSED

- `compose.yml` modified ✓ (`git diff --stat`: 103+/-10, single hunk)
- Task 1 commit `3fe8e46` exists in `git log --oneline` ✓
- `docker compose config` exits 0 ✓
- All 20 static gating checks PASS ✓
- `openwebui:` service rendered with exact image pin, 10 env vars, [app, data] networks, no host ports, 6 Traefik labels, bind mount, healthcheck, depends_on ✓
- `traefik.depends_on.openwebui` declared (06-01 carry-forward closed) ✓
- No deletions of unrelated files ✓
- No untracked files left behind by this plan (pre-existing `.claude/`, `.env.bak.*`, `01/03-REVIEW-FIX.md` are out-of-scope) ✓
- SUMMARY.md created at `.planning/phases/06-traefik-tls-open-webui/06-03-SUMMARY.md` ✓

---
*Phase: 06-traefik-tls-open-webui*
*Plan: 03*
*Completed: 2026-05-16*
