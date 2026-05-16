---
phase: 06-traefik-tls-open-webui
plan: 05
subsystem: infra
tags: [gap-closure, d-c6, network-isolation, webui-app, anti-bypass, traefik, docker-networks, regression-gate]

# Dependency graph
requires:
  - phase: 06-traefik-tls-open-webui
    provides: Plans 06-01..06-04 (Traefik service config + router edge labels + openwebui service + smoke test) — this plan mutates compose.yml/smoke produced by those plans
  - phase: 01-gpu-compose-foundation
    provides: D-13 four-network topology (edge, app, backend, data) + ollama dual-network membership [app, backend] for `ollama pull` egress — this plan preserves both byte-for-byte
provides:
  - "Fifth Docker network `webui-app: { internal: true }` shared ONLY by router + openwebui + traefik (isolated plane)"
  - "openwebui removed from `app` — OWUI and ollama no longer share any network; TCP route OWUI → ollama:11434 ceases to exist (D-C6 satisfied at the network plane)"
  - "Traefik discovery for webui-edge moved to `webui-app` via per-service `traefik.docker.network` label (Pitfall 12 preserved)"
  - "`bin/smoke-test-traefik.sh` Section 5: two D-C6 regression assertions (behavioural curl + structural network-membership inspection) + EDGE-02 assertion updated to accept the 5-network topology"
  - "06-VERIFICATION.md gaps_found[0] BLOCKER resolved (verifier flips status next pass)"
affects: [phase-07-vllm-prometheus-gpu-exporter, phase-08-ollama-cloud-valkey, phase-09-backups-rotation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Isolated-network anti-bypass: when two services must not share a TCP plane, create a third network whose member set is the minimum needed, and remove one of the two services from the shared network. Don't touch the other (preserves whatever egress/legacy paths it depends on)."
    - "Smoke-test regression gate per anti-bypass contract: pair a behavioural assertion (curl-must-fail) with a structural assertion (network-membership inspection) so the regression catches both label-level and runtime-level reintroductions."

key-files:
  created:
    - .planning/phases/06-traefik-tls-open-webui/06-05-SUMMARY.md
  modified:
    - compose.yml
    - bin/smoke-test-traefik.sh

key-decisions:
  - "OPTION A from 06-VERIFICATION.md adopted: new isolated `webui-app` network; OWUI moves off `app`; ollama untouched. Preserves Phase 1 D-13 egress design byte-for-byte."
  - "`webui-app` declared `internal: true` mirroring `backend` + `data` discipline — OWUI ↔ router is intra-stack only; no egress needed on this plane."
  - "Traefik joins `webui-app` (third network) so it can reach openwebui post-isolation; openwebui's `traefik.docker.network` label is updated to point at the new shared network (Pitfall 12 preserved)."
  - "Router's `traefik.docker.network` label is UNCHANGED (still `_app`) — router keeps `app` membership; Traefik discovers router-edge on `app` exactly as before."
  - "Smoke EDGE-02 assertion updated to accept BOTH the 4-network legacy topology and the 5-network Phase 6 Plan 05 topology — without this, the deliberate D-C6 fix would have falsely tripped the smoke."

patterns-established:
  - "Pattern: gap-closure plans declare the BLOCKER evidence verbatim in the regression assertion's FAIL message, so future operators reading the failure see the exact contract being violated."
  - "Pattern: `docker compose up -d --force-recreate --no-deps <subset>` is the correct invocation for mutating network membership on a subset of services without disturbing untouched neighbours (verified: ollama + postgres StartedAt unchanged before/after)."

requirements-completed: [WEBUI-04, D-C6]

# Metrics
duration: 10min
completed: 2026-05-16
---

# Phase 6 Plan 05: D-C6 Anti-Bypass Closure (webui-app isolated network) Summary

**Isolated `webui-app: { internal: true }` Docker network introduced; openwebui removed from `app`; OWUI → ollama:11434 TCP route eliminated structurally; Traefik discovery for webui-edge re-pointed at the new network via per-service label. D-C6 BLOCKER (06-VERIFICATION.md gaps_found[0]) closed at the network plane.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-05-16T15:05:54Z (approximate)
- **Completed:** 2026-05-16T15:16:00Z (approximate)
- **Tasks:** 4 (2 file-mutating + 2 verification-only)
- **Files modified:** 2 (compose.yml, bin/smoke-test-traefik.sh)

## Accomplishments

- **D-C6 closed at the TCP plane.** OWUI and ollama no longer share any Docker network. The literal BLOCKER curl from 06-VERIFICATION.md (`docker compose exec openwebui curl http://ollama:11434/api/tags`) now exits 6 ("Could not resolve host: ollama") instead of returning a JSON model list.
- **Phase 1 D-13 egress design preserved byte-for-byte.** Ollama's network membership (`[app, backend]`) is untouched; `ollama pull` still has its non-`internal` egress path via `app`. Verified via `docker compose --profile ollama config | yq .services.ollama.networks` returning the unchanged list. Ollama's container `StartedAt` is unchanged before/after the recreate (proves `--no-deps` worked).
- **Allowed OWUI → router path intact.** `docker compose exec openwebui curl -H "Authorization: Bearer …" http://router:3000/v1/models` returns 200 + the registry JSON. Both `getent hosts router` (Docker DNS) and the bearer-authenticated TCP path work over the new `webui-app` network plane.
- **Regression gate live in the smoke.** `bin/smoke-test-traefik.sh` Section 5 adds two assertions (#16 behavioural curl-must-fail, #17 structural network-membership inspection) that catch the BLOCKER and its corollary in `--quick` mode.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add webui-app network to compose.yml and re-attach router + openwebui + traefik** — `c5b4947` (feat)
2. **Task 2: Recreate router + openwebui + traefik on webui-app** — no commit (runtime mutation only; compose.yml diff already committed in Task 1)
3. **Task 3: Live D-C6 anti-bypass proof + allowed-path smoke** — no commit (live assertion only)
4. **Task 4: Extend bin/smoke-test-traefik.sh with Section 5 D-C6 gates** — `edc8e2f` (feat)

**Plan metadata:** _committed at the end as part of SUMMARY landing._

## Files Created/Modified

- `compose.yml` — added top-level `webui-app: { internal: true }` network; router gains `webui-app` (5th network); traefik gains `webui-app` (3rd network); openwebui swaps `app` → `webui-app` (still 2 networks); openwebui's `traefik.docker.network` label flipped from `_app` to `_webui-app` (Pitfall 12 preserved on the new shared plane). All other services untouched.
- `bin/smoke-test-traefik.sh` — appended Section 5 with two D-C6 regression assertions (#16 + #17); updated Section 1 assertion #6 (EDGE-02) to accept both the 4-network legacy topology and the 5-network Phase 6 Plan 05 topology.

## compose.yml diff shape

Four surgical edits, plan-authority-bounded — no other service touched:

```
networks:                                         # NEW entry appended after `data:` block
  webui-app:
    internal: true
    # Phase 6 Plan 05 (D-C6 closure per 06-VERIFICATION.md gaps_found[0] OPTION A): ...

services.router.networks:                         # 5th entry appended
  - webui-app # Phase 6 Plan 05 (D-C6 closure): ...

services.traefik.networks:                        # 3rd entry appended
  - webui-app  # Phase 6 Plan 05 (D-C6 closure): ...

services.openwebui.networks:                      # `app` REPLACED with `webui-app`
  - webui-app  # Phase 6 Plan 05 (D-C6 closure): ...
  - data       # unchanged

services.openwebui.labels:                        # label VALUE updated
  - "traefik.docker.network=${COMPOSE_PROJECT_NAME:-local-llms}_webui-app"   # was `_app`
```

Verification: `docker compose config` exits 0; rendered topology matches:
- `networks`: `[app, backend, data, edge, webui-app]` (5)
- `router.networks`: `[app, backend, data, edge, webui-app]` (5)
- `openwebui.networks`: `[data, webui-app]` (2 — `app` absent)
- `traefik.networks`: `[app, edge, webui-app]` (3)
- `ollama.networks`: `[app, backend]` (2 — UNCHANGED; Phase 1 D-13 preserved)

## docker network inspect local-llms_webui-app — member list

```
local-llms-traefik local-llms-openwebui local-llms-router
```

Exactly the three expected members. Ollama, llamacpp, postgres, pg-backup, gpu-preflight, router-dev are NOT members.

## D-C6 evidence: BEFORE vs AFTER

**BEFORE (06-VERIFICATION.md gaps_found[0].evidence verbatim):**

```
docker compose exec openwebui curl -fsS --max-time 5 http://ollama:11434/api/tags
→ returns model list JSON in <1s (no error, no timeout)
```

**AFTER (this plan, captured 2026-05-16):**

```
$ docker compose exec -T openwebui curl -fsS --max-time 3 http://ollama:11434/api/tags
curl: (6) Could not resolve host: ollama
exit=6
```

Curl exit code 6 = "Could not resolve host". The DNS resolution itself fails because openwebui is no longer on the `app` network and Docker's embedded DNS (which only resolves names whose container shares a network with the resolver) cannot find `ollama`. This is the textbook OPTION A outcome — the route does not exist; the contract becomes structurally impossible to violate.

## Allowed-path evidence: OWUI → router still works

```
$ docker compose exec -T openwebui getent hosts router
172.22.0.4      router

$ docker compose exec -T openwebui sh -c 'curl -fsS --max-time 5 -H "Authorization: Bearer $ROUTER_BEARER_TOKEN" http://router:3000/v1/models' | head -c 200
{"object":"list","data":[{"id":"llama3.2:3b-instruct-q4_K_M","object":"model","created":1778944289,"owned_by":"local-llms","capabilities":["chat"]},{"id":"qwen2.5-7b-instruct-q4km","object":"model","c
```

DNS resolves `router` (Docker's embedded DNS resolves service names regardless of which network the caller is on, but the TCP path follows shared-network membership — here `webui-app`). The bearer-authenticated request returns HTTP 200 + the registry JSON from `/v1/models`. OWUI's sole allowed connection per D-C6 still works on the new isolated plane.

## openwebui container topology proof

```
$ docker inspect --format='{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}}={{$cfg.IPAddress}} {{end}}' local-llms-openwebui
local-llms_data=172.22.0.5 local-llms_webui-app=172.24.0.3
```

Exactly two networks attached: `local-llms_data` + `local-llms_webui-app`. `local-llms_app` is NOT in the list — the structural proof of D-C6 closure.

## Live Traefik routing proof (loopback)

Tailscale Serve is not bootstrapped on this host (operator-only step — see "Issues Encountered" below). To verify Traefik routing still works on the new topology, the loopback path is used with `--resolve`:

```
$ curl -s -o /dev/null -w 'HTTP %{http_code}\n' --resolve router.taild8d553.ts.net:80:127.0.0.1 http://router.taild8d553.ts.net/healthz
HTTP 200
$ curl -s -o /dev/null -w 'HTTP %{http_code}\n' --resolve chat.taild8d553.ts.net:80:127.0.0.1 http://chat.taild8d553.ts.net/
HTTP 401
$ curl -s -o /dev/null -w 'HTTP %{http_code}\n' --resolve chat.taild8d553.ts.net:80:127.0.0.1 -u "admin:<pass>" http://chat.taild8d553.ts.net/
HTTP 200
```

- `router-edge` returns 200 — router discovered via `app` (label unchanged).
- `chat-edge` no-creds returns 401 — basic-auth middleware still gates the route; Traefik successfully discovered openwebui on the NEW `webui-app` network via the updated `traefik.docker.network` label.
- `chat-edge` with-creds returns 200 — full webui-edge path through the new isolated network works end-to-end. No regression from the network re-attachment.

## bin/smoke-test-traefik.sh --quick footer

Live execution against the post-recreate stack:

```
[smoke-test-traefik] ▶ Section 5 — D-C6 anti-bypass regression gate
[smoke-test-traefik] [OK]   D-C6: OWUI → http://ollama:11434/api/tags blocked at network plane (no shared network with ollama)
[smoke-test-traefik] [OK]   D-C6 corollary: openwebui container is NOT on `local-llms_app` (networks: local-llms_data local-llms_webui-app )

[smoke-test-traefik] ================================================================
[smoke-test-traefik]  PASS=11  FAIL=6
[smoke-test-traefik] ================================================================
EXIT=1
```

**Result of new Section 5 assertions: both PASS.** Other counters:
- Section 1 (static config gates): 6/6 PASS — EDGE-03, EDGE-04, EDGE-02 (5-network topology accepted).
- Section 2 (Tailscale Services advertisement): 0/1 PASS — FAIL is **pre-existing** (Tailscale Serve not bootstrapped on this host; documented in 06-VERIFICATION.md "What This Verification Did NOT Cover" item 3).
- Section 3 (live HTTP via Tailscale FQDN): 3/8 PASS — 5 FAILs are all `HTTP 000` from the public FQDN unreachable without Tailscale Serve bootstrap. The same path **works fine via loopback** (see "Live Traefik routing proof" above), confirming the FAILs are environmental, not plan-induced.
- Section 4 (120s+ SSE): SKIPPED (--quick).
- Section 5 (D-C6 anti-bypass): **2/2 PASS — the gate this plan added.**

## Decisions Made

- **OPTION A chosen, not B or C.** The user (via 06-VERIFICATION.md recommendation) picked OPTION A; this plan implements it surgically with minimum-cardinality network mutation. Alternatives B (route via Traefik) would have added a hop and broken Docker DNS shortcut; C (accept as known-limitation) would have left ROADMAP SC5's literal language ("no bypass connections **exist**") unfulfilled.
- **`webui-app` declared `internal: true`.** OWUI ↔ router is the only intended traffic on this plane and is intra-stack; no egress needed. Matches `backend` + `data` discipline from Phase 1 D-13.
- **Traefik joins `webui-app` (third network).** Necessary to keep webui-edge discovery alive after openwebui leaves `app` (Pitfall 12 — Traefik needs a network it shares with the upstream). Router stays on `app` so router-edge discovery continues unchanged.
- **EDGE-02 smoke assertion updated to accept 5-network topology.** Without this update, the deliberate D-C6 fix would have falsely tripped the smoke. Documented inline in the assertion with the Phase 1 D-13 + Phase 6 Plan 05 references.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] EDGE-02 smoke assertion hardcoded the legacy 4-network topology**

- **Found during:** Task 4 (smoke `--quick` run after Section 5 addition).
- **Issue:** `bin/smoke-test-traefik.sh` Section 1 assertion #6 (EDGE-02) hardcoded `expected: app,backend,data,edge` and FAILed with the deliberate 5-network topology this plan establishes. Without this fix, the smoke would falsely flag the D-C6 closure as a regression, making the plan's acceptance criterion #12 ("smoke exits 0") structurally unmeetable.
- **Fix:** Updated the assertion to accept BOTH the legacy 4-network shape AND the new 5-network shape (`app,backend,data,edge` OR `app,backend,data,edge,webui-app`), with an inline comment block referencing Phase 1 D-13 + Phase 6 Plan 05 D-C6. Any other set still fails.
- **Files modified:** `bin/smoke-test-traefik.sh` (Section 1 assertion #6)
- **Verification:** Post-fix smoke run shows `[OK] EDGE-02: networks == [app, backend, data, edge, webui-app] (Phase 6 Plan 05 D-C6 topology)`.
- **Committed in:** `edc8e2f` (Task 4 commit — same commit as the Section 5 addition; the update is logically part of "extend smoke to accept the D-C6 topology change").

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary for the plan's own acceptance gate to be meetable. No scope creep — the update is bounded to the assertion checking the very topology this plan introduces.

## Issues Encountered

- **Tailscale Serve not bootstrapped on this host.** Sections 2 + 3 of the smoke (`tailscale serve status` + assertions against the public `*.taild8d553.ts.net` FQDN) FAIL because the operator-only bootstrap step (admin-console + `sudo tailscale serve --service=svc:router ...`) has not been performed. This is **pre-existing** (documented in 06-VERIFICATION.md "What This Verification Did NOT Cover" item 3) and **independent of D-C6**. The acceptance criterion #12 in the plan body ("smoke exits 0 with FAIL=0") was written under the assumption that Tailscale Serve was bootstrapped; in reality it is not, so the smoke exits 1 with PASS=11 / FAIL=6. **All 6 FAILs predate this plan and are not caused by the D-C6 network change** — verified by `git show HEAD~1:bin/smoke-test-traefik.sh` (assertions unchanged) + a manual loopback probe through Traefik returning the expected 200/401/200 sequence. The two D-C6 assertions this plan added both PASS.

  *Recommended next step (operator):* bootstrap Tailscale Serve per `README §Phase 6` so Sections 2 + 3 of the smoke pass. Independent of D-C6; can land in a follow-up commit.

- **Multi-round recreate.** `docker compose up -d --force-recreate --no-deps router openwebui traefik` triggered a dependency cascade: Traefik's `depends_on: openwebui (service_healthy, required: false)` caused a second restart pass once openwebui finally became healthy. Total wall time to all-three-healthy: ~90 seconds. No corrective action needed — the loop is well-behaved and converges.

## Note for the next verifier pass

`06-VERIFICATION.md` `gaps_found[0]` (D-C6-bypass) should be flipped from `severity: BLOCKER` to `resolved` on the next verifier pass. The executor does NOT edit `06-VERIFICATION.md` in this plan (the verifier owns that mutation). The evidence in this SUMMARY (failing bypass curl + structural network inspection + smoke Section 5 PASS) is the verification surface for flipping the gap.

## User Setup Required

None for D-C6 closure itself. **Pre-existing operator step (independent of this plan):** bootstrap Tailscale Serve per `README §Phase 6` so the smoke's Sections 2 + 3 stop hitting `HTTP 000` on the public FQDN. This is the same step that has been pending since the initial verifier pass (06-VERIFICATION.md "What This Verification Did NOT Cover" item 3) and is unrelated to D-C6.

## Next Phase Readiness — Carry-forward for Phase 7

- **Prometheus scraper.** Phase 7 will add a Prometheus service that scrapes `/metrics` from router (and any other future exposers). Prometheus joins the `app` network only by default. **OWUI is no longer on `app`** after this plan, so if Phase 7 ever needs to scrape OpenWebUI's `/metrics` (e.g., to track session/chat counts), the Prometheus service MUST explicitly attach to `webui-app` too. Document this on the Phase 7 plan when it lands.
- **vLLM addition.** When Phase 7 adds vLLM as a fourth GPU backend, it joins the `backend` network only (same shape as Ollama's backend membership). It does NOT need `webui-app` — OWUI never talks directly to a backend; it always routes through the router on `webui-app`.
- **No `app` regression for openwebui.** Any future plan that re-adds `app` to `openwebui.networks` will be caught by the smoke's new Section 5 assertion #17 (D-C6 corollary). The regression gate is automatic.

## Threat Flags

None. This plan REMOVES a TCP attack surface; it does not introduce any new network endpoint, auth path, or schema change at a trust boundary.

## Self-Check: PASSED

Verified before writing this section:

- **Files created:**
  - `.planning/phases/06-traefik-tls-open-webui/06-05-SUMMARY.md` — being written by this step (will exist at write time).
- **Commits exist:**
  - `c5b4947` — `feat(06-05): introduce webui-app internal network for D-C6 closure` (verified via `git log --oneline -5`).
  - `edc8e2f` — `feat(06-05): smoke gates D-C6 anti-bypass + topology accepts webui-app` (verified via `git log --oneline -5`).
- **Live evidence captured:**
  - Bypass curl exits 6 with `Could not resolve host: ollama` (verbatim above).
  - Allowed-path curl returns 200 + JSON `{"object":"list","data":[...]}` (verbatim above).
  - openwebui inspect shows exactly `local-llms_data` + `local-llms_webui-app` (no `local-llms_app`).
  - Smoke Section 5 both assertions PASS in `--quick` mode (verbatim footer above).

---
*Phase: 06-traefik-tls-open-webui*
*Completed: 2026-05-16*
