---
phase: 6
slug: traefik-tls-open-webui
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-16
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from 06-RESEARCH.md §"Validation Architecture" (lines 671–715). This file mirrors phases 02–05's VALIDATION.md shape and is the artifact gsd-plan-checker's Dim 8e looks for.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bash smoke tests via `bin/smoke-test-traefik.sh` (new, Wave 0) + existing `router/` vitest suite (untouched — router code is not modified in Phase 6) |
| **Config file** | `bin/smoke-test-traefik.sh` (Plan 06-04 Task 1 creates). Sources `.env` for `TAILNET_HOSTNAME`, `ROUTER_BEARER_TOKEN`, `TRAEFIK_BASIC_AUTH_USER`, `TRAEFIK_BASIC_AUTH_PASS_PLAIN` (the plain password — the htpasswd hash lives in `TRAEFIK_BASIC_AUTH`). |
| **Quick run command** | `bash bin/smoke-test-traefik.sh --quick` (skips the 120s+ SSE assertion; ~15 s) |
| **Full suite command** | `bash bin/smoke-test-traefik.sh` (all five SC assertions; ~3 min) |
| **Estimated runtime** | ~15 s (--quick) / ~3 min (full) |

---

## Sampling Rate

- **After every task commit:** Static `docker compose config` lint + `grep` against `traefik/` directory — sub-second.
- **After every plan wave:** `bash bin/smoke-test-traefik.sh --quick` (~15 s).
- **Before `/gsd-verify-work`:** Full suite must be green (`bash bin/smoke-test-traefik.sh` — full ~3 min, requires GPU-up router + Ollama profile + Tailscale Services bootstrapped + `.env` populated).
- **Max feedback latency:** 15 s for quick gate; ~180 s for full SSE gate.

---

## Per-Task Verification Map

Derived directly from 06-RESEARCH.md §"Phase Requirements → Test Map" (lines 683–699). Every row maps a phase requirement → a behavior → an automated assertion that lives in `bin/smoke-test-traefik.sh`.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | EDGE-04 | T-6-Bearer-Leak | Traefik SSE knobs explicit (`responseHeaderTimeout: 0s`, `idleConnTimeout: 0s`); no `compress` middleware on streaming routes | static | `grep -E "responseHeaderTimeout\|idleConnTimeout" traefik/traefik.yml` matches `0s`; `grep -ri compress traefik/` returns nothing | ❌ W0 | ⬜ pending |
| 06-01-02 | 01 | 1 | EDGE-04 + Phase-5-carry-forward | T-6-Metrics-Recon | `metrics-blackhole` middleware defined (`ReplacePathRegex` → `/__metrics_blocked__`); `webui-basic-auth` middleware defined | static | `yq '.http.middlewares.metrics-blackhole' traefik/dynamic/middlewares.yml` returns the regex; `yq '.http.middlewares.webui-basic-auth' …` returns basic-auth config | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 2 | EDGE-03 | T-6-Bypass-Backend | Router prod service has no `0.0.0.0:*` mapping; `127.0.0.1:3000:3000` removed; router-dev keeps its host port (planner-discretion) | static | `docker compose config \| grep -E "^\s+- \"127\.0\.0\.1:" \| grep -v -E "(traefik\|router-dev)"` returns nothing | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 2 | EDGE-02 | — | Four-network topology preserved: router on `app` + `backend` + `data` + `edge` (newly added) | static | `docker compose config \| yq '.services.router.networks \| keys'` returns `[app, backend, data, edge]` | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 2 | EDGE-01 + EDGE-05 | T-6-TLS-MITM | Router edge router exists with `Host(router.${TAILNET_HOSTNAME}.ts.net)` rule + `metrics-blackhole@file` middleware attached | smoke | `curl -fsS https://router.${TAILNET_HOSTNAME}.ts.net/healthz` returns 200 with valid cert; `curl -i http://router.…/healthz` returns 308 (Tailscale Serve auto-redirect) | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 2 | D-B1 | T-6-Metrics-Recon | External GET `/metrics` returns 404 (NOT 403 — must not leak path existence) | smoke | `curl -s -o /dev/null -w '%{http_code}' https://router.${TAILNET_HOSTNAME}.ts.net/metrics` returns `404` | ❌ W0 | ⬜ pending |
| 06-02-01 | 02 | 2 | D-B2 | — | Internal `/metrics` scrape works for Phase 7 Prometheus | smoke | `docker compose exec traefik wget -qO- http://router:3000/metrics \| head` shows `# HELP …` Prometheus exposition | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 3 | WEBUI-01 | — | OWUI runs behind Traefik on `chat.${TAILNET_HOSTNAME}.ts.net` | smoke | `curl -fsS -u admin:password https://chat.${TAILNET_HOSTNAME}.ts.net/health` returns `{"status":"OK"}` | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 3 | WEBUI-02 | T-6-OWUI-V1-Quirk | OWUI base URL has NO `/v1` suffix (OWUI 0.9 appends it; doubled suffix breaks) | static | `docker compose config \| yq '.services.openwebui.environment.OPENAI_API_BASE_URLS'` returns exactly `http://router:3000` (no `/v1`) | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 3 | WEBUI-03 | T-6-OWUI-Admin-Takeover | `WEBUI_AUTH=False` from boot zero (Pitfall 10 — irreversible after first admin); basic-auth gate on `chat.*` subdomain only | smoke | `curl -i https://chat.${TAILNET_HOSTNAME}.ts.net` returns `401 Basic` without creds; `-u admin:password` returns 200; OWUI page does NOT prompt for login form | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 3 | WEBUI-04 | — | OWUI uses shared Postgres `openwebui` DB (Phase 5 D-B6 created it empty) | smoke | `docker compose exec postgres psql -U app -d openwebui -c '\dt'` shows OWUI tables (e.g. `user`, `chat`, `model`) after first OWUI boot | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 3 | WEBUI-05 | — | OWUI auto-discovers via router's `/v1/models` | smoke | OWUI container logs show successful `GET /v1/models` to router AND OWUI's `/api/models` returns the router's registry models | ❌ W0 | ⬜ pending |
| 06-03-01 | 03 | 3 | D-C6 (defense-in-depth) | T-6-OWUI-Bypass | `ENABLE_OLLAMA_API=False` — OWUI does not auto-add Ollama direct-connect on same Docker network | static | `docker compose config \| yq '.services.openwebui.environment.ENABLE_OLLAMA_API'` returns `False` (or `false`/`0` — accept any falsy) | ❌ W0 | ⬜ pending |
| 06-04-01 | 04 | 4 | EDGE-06 | T-6-Streaming-Buffer | 120s+ generation streamed through Tailscale → Traefik → router → Ollama: no 502, no stall, deltas <1s apart | smoke | `curl -N --max-time 180 -H "Authorization: Bearer $TOKEN" -d '{"model":"…","messages":[…],"stream":true,"max_tokens":1200}' https://router.${TAILNET_HOSTNAME}.ts.net/v1/chat/completions` — exit 0, total elapsed >120s, no `502`, deltas <1s apart (timestamp diff per line in `awk`) | ❌ W0 | ⬜ pending |
| 06-04-02 | 04 | 4 | EDGE-03 (regression gate) | — | After all plans applied: ONLY Traefik publishes host ports | smoke | `docker compose config \| grep -E "^\s+- \"(127\.0\.0\.1\|0\.0\.0\.0)" \| grep -v -E "(traefik\|router-dev)"` returns nothing | ❌ W0 | ⬜ pending |
| 06-04-03 | 04 | 4 | All SCs | — | README §Phase 6 documents: Tailscale Services prereq (admin + host), htpasswd `$$` recipe, EDGE-05 + EDGE-06 evidence commands, `WEBUI_AUTH=False` first-boot warning | static | `grep -E "Tailscale Services\|svc:router\|htpasswd.*sed.*\\\\\\$" README.md` matches; `grep -E "WEBUI_AUTH=False" README.md` matches | ❌ W0 | ⬜ pending |
| 06-04-04 | 04 | 4 | SC1–SC5 live | — | Human-verify checkpoint: live stack passes all 5 ROADMAP success criteria | manual | Operator runs `bash bin/smoke-test-traefik.sh` against the live stack with Tailscale Services bootstrapped; verifies the SC1–SC5 evidence table; types "approved" or describes issues | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `bin/smoke-test-traefik.sh` — new file, covers all 13 of the assertions in the table above (Plan 06-04 Task 1)
- [ ] `traefik/traefik.yml` — static config with explicit `serversTransport.forwardingTimeouts.{responseHeaderTimeout, idleConnTimeout}: 0s` (Plan 06-01 Task 1)
- [ ] `traefik/dynamic/middlewares.yml` — `metrics-blackhole` (ReplacePathRegex) + `webui-basic-auth` (BasicAuth) middlewares (Plan 06-01 Task 1)
- [ ] `compose.yml` mutations — new `traefik:` service (Plan 06-01 Task 2); `router:` host-port removal + `edge` network + Traefik labels (Plan 06-02 Task 1); new `openwebui:` service with 10-env-var contract (Plan 06-03 Task 1)
- [ ] `.env.example` mutations — add `TAILNET_HOSTNAME`, add `OWUI_SECRET_KEY`, annotate `TRAEFIK_ACME_EMAIL` as unused (Tailscale Serve owns TLS), refresh `TRAEFIK_BASIC_AUTH` comment with `htpasswd -nB admin | sed 's/\$/\$\$/g'` recipe; append `TRAEFIK_BASIC_AUTH_USER` + `TRAEFIK_BASIC_AUTH_PASS_PLAIN` (smoke-only, plain) (Plan 06-01 Task 1 + Plan 06-04 Task 1)
- [ ] `README.md` §Phase 6 — Tailscale Services prereq + bootstrap commands, htpasswd recipe, EDGE-05 + EDGE-06 evidence commands, `WEBUI_AUTH=False` first-boot warning (Plan 06-04 Task 3)
- [ ] No vitest test framework change — router code unchanged in this phase; the router/vitest suite stays green by construction

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Browser-driven OWUI chat flow on `chat.<tailnet>.ts.net` | WEBUI-01 + WEBUI-05 | Human sensory check — confirm OWUI renders, the basic-auth challenge prompts, the model picker shows the registry models, and a streaming chat works visibly. Automated `curl` confirms the wire but not the rendered UX. | Open `https://chat.${TAILNET_HOSTNAME}.ts.net` in a browser on a tailnet member. Pass the basic-auth challenge (admin / `$TRAEFIK_BASIC_AUTH_PASS_PLAIN`). Confirm: no signup/login prompt inside OWUI; model dropdown lists `llama3.2:3b-instruct-q4_K_M` (and any other registry models); send "hello", see streaming response complete. |
| Tailscale Services admin-console state | EDGE-01 prereq | The two `svc:router` and `svc:chat` services live in the Tailscale admin console, not in repo state. Verification is visual against `https://login.tailscale.com/admin`. | Confirm `svc:router` and `svc:chat` exist in the tailnet's Services page; both target this node. |
| 120s+ smoke from outside the host | EDGE-06 | The full assertion requires a real tailnet member device (laptop / phone with Tailscale) hitting `router.<tailnet>.ts.net` from outside Docker. Local-host loopback bypass exercises a different code path. | Run the EDGE-06 curl recipe from a separate tailnet device. Total elapsed >120s, no 502, deltas <1s apart by visual inspection. |

---

## Validation Sign-Off

- [ ] All 13 plan tasks have `<automated>` verify or are gated by a Wave 0 file that does (Plan 06-04 Task 1 — `bin/smoke-test-traefik.sh` — is the Wave 0 carrier for the smoke assertions)
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify (only Plan 06-04 Task 4 is manual; bracketed by automated Tasks 1–3)
- [ ] Wave 0 covers all MISSING references (file checklist above)
- [ ] No watch-mode flags (`bin/smoke-test-traefik.sh` is one-shot, exits with status code)
- [ ] Feedback latency < 15 s for `--quick`; < 180 s for full
- [ ] `nyquist_compliant: true` set in frontmatter (will flip from `false` after `bin/smoke-test-traefik.sh` lands and passes Plan 06-04 Task 1's acceptance criteria)

**Approval:** pending
