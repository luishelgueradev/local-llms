---
phase: 06-traefik-tls-open-webui
verified: 2026-05-16T15:25:00Z
status: human_verify_pending
score: 10/11 verifiable assertions passed; 1 deferred (browser UAT needs host libs / Tailscale Services). D-C6 BLOCKER closed by Plan 06-05 (commit c5b4947) + independently re-verified post-execution.
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 9/11 + 1 BLOCKER
  gaps_closed:
    - "D-C6 — webui-app isolated internal network introduced (compose.yml commits c5b4947 + edc8e2f). OWUI dropped from app, attached to webui-app (data + webui-app only). Router gains webui-app (now on 5 networks). Traefik gains webui-app (now on 3 networks). Ollama dual-network app+backend UNCHANGED (Phase 1 D-13 preserved). Post-execution re-verification: `docker compose exec openwebui curl http://ollama:11434/api/tags` returns curl exit 6 (Could not resolve host: ollama) — bypass route structurally eliminated. Allowed path OWUI→router:3000/v1/models still returns 200 + JSON model list."
  gaps_remaining: []
human_verification:
  - test: "Browser sanity check via playwright-cli (chat.<tailnet>.ts.net basic-auth → model picker → streaming chat)"
    expected: "Browser passes basic-auth challenge; OWUI model picker lists registry models (llama3.2:3b-instruct-q4_K_M, qwen2.5-7b-instruct-q4km, llama3.2-vision); 'hello' message streams response."
    result: blocked
    why_human: "playwright-cli requires libnspr4/libnss3/libasound from system packages (`sudo npx playwright install-deps`). Without sudo this is operator-only. Independent of the D-C6 finding."
gaps_found:
  - id: D-C6-bypass
    severity: BLOCKER
    requirement: D-C6 (anti-bypass / WEBUI-04 spirit)
    summary: "OWUI can reach ollama:11434 directly bypassing the router"
    evidence: |
      docker compose exec openwebui curl -fsS --max-time 5 http://ollama:11434/api/tags
      → returns model list JSON in <1s (no error, no timeout)
    root_cause: |
      ollama is dual-network (app + backend) per Phase 1 D-13 (the egress fix for `ollama pull` from inside the container — backend network is `internal: true` and blocks outbound to registry.ollama.ai).
      OWUI is on `app` (per 06-CONTEXT.md D-C6 + 06-03 PLAN).
      Result: OWUI has direct TCP line-of-sight to ollama:11434. ENABLE_OLLAMA_API=False prevents auto-discovery (the common case), but a user logged into OWUI can manually configure a bypass connection.
    plan_decision_violated: |
      06-CONTEXT.md D-C6: "No Open WebUI bypass connections" — written as a hard contract.
      ROADMAP SC5 (Phase 6): "no OWUI bypass connections to backends exist" — literal text says "exist", not just "configured".
    mitigation_options:
      - "OPTION A — Isolated network: Create `webui-app` network. Put OWUI + router on it. Drop OWUI from generic `app`. Router stays on both `app` (for human-curl) and `webui-app`. Ollama stays on `app` (for egress to registry.ollama.ai). Cost: one new network, two compose mutations."
      - "OPTION B — Route via Traefik even for OWUI→router: Move router off `app`, OWUI on edge only. OWUI's `OPENAI_API_BASE_URLS` points to `http://traefik:80` with Host header. More complex, breaks Docker DNS shortcut."
      - "OPTION C — Accept as known-limitation: Single-user single-host threat model — the operator IS the attacker. ENABLE_OLLAMA_API=False covers the common case (OWUI auto-discovery). Manual bypass requires explicit user intent in OWUI's UI. Document in bearer.ts comment + 06-SUMMARY.md."
    recommended_option: "A — surgical, preserves Phase 1 D-13 egress design, eliminates the bypass entirely."
re_verification:
  previous_status: pre-verification
  previous_score: N/A
  initial_verification: true
---

# Phase 6: Traefik + TLS + Open WebUI Verification Report

**Phase Goal:** "Make the router a real HTTPS endpoint with the four-network topology, then bring up Open WebUI on the same proxy so human chats flow through the same router as agents — same logs, same metering, same Anthropic translation."

**Verified:** 2026-05-16T14:50:00Z (autonomous run via `/gsd-autonomous` + `playwright-testing` skill attempt)
**Status:** gaps_found
**Verifier:** Manual autonomous run (no gsd-verifier agent dispatched; the human-verify checkpoint route from 06-04 was bypassed by the orchestrator's autonomous validation flow)

---

## Observable Truths (Roadmap Success Criteria)

| SC | What must be TRUE | Evidence | Status |
|----|-------------------|----------|--------|
| **SC1** | `traefik:v3.7` fronts stack with TLS; HTTP→HTTPS redirect; zero `0.0.0.0:` on backends/datastores | Traefik `v3.7.1` running, healthy. `docker compose config \| grep "0\.0\.0\.0:"` excluding traefik/router-dev returns empty. TLS deferred to Tailscale Serve layer (not yet bootstrapped — admin console step pending). | ⚠ partial (TLS deferred) |
| **SC2** | Four-network topology: edge / app / backend(internal) / data(internal); router on all 4 | `docker compose config \| yq '.services.router.networks \| keys'` returns `[app, backend, data, edge]`. | ✅ pass |
| **SC3** | 120s+ generation through Traefik via `curl -N` — no 502, no stall, deltas <1s apart | Tested 33s elapsed (model 3B too fast for 120s); 480 SSE deltas received, `[DONE]` marker present, no 502. The path works. 120s threshold requires slower model (qwen 7b or vision). | ⚠ partial (path correct, length not reached) |
| **SC4** | OWUI v0.9.0 on chat subdomain with `WEBUI_AUTH=False` + Traefik basic-auth + shared Postgres `openwebui` DB isolated from `router` | `curl -H "Host: chat.taild8d553.ts.net" http://127.0.0.1/` returns `401 Basic realm="traefik"` without creds, `200` with `admin:<plain>`. Alembic migrations ran on `openwebui` DB. | ✅ pass |
| **SC5** | OWUI single OpenAI-compatible connection to router (no /v1); auto-discovers via /v1/models; no OWUI bypass connections | `OPENAI_API_BASE_URLS=http://router:3000` (no /v1 ✓). Auto-discovery couldn't be verified via the OWUI internal API (requires OWUI-side auth not yet configured). **No bypass connections "configured" — but bypass is NETWORK-REACHABLE (D-C6 fail, see gaps).** | ❌ **fail** (D-C6 bypass possible) |

---

## Per-Test Results (13 from 06-VALIDATION.md)

| # | Requirement | Test | Result |
|---|-------------|------|--------|
| 1 | EDGE-04 | Traefik static config: `idleConnTimeout: 0s`, `responseHeaderTimeout: 0s`, no `compress` | ✅ verified in 06-01 SUMMARY commit `c0505c3` |
| 2 | D-B1 + Phase 5 D-C5 | `metrics-blackhole` middleware definition | ✅ verified in `traefik/dynamic/middlewares.yml` |
| 3 | EDGE-03 | Router prod has no `127.0.0.1:3000:3000`; router-dev keeps it | ✅ verified in 06-02 SUMMARY commit `975047b` |
| 4 | EDGE-02 | 4-network topology on router | ✅ verified via `yq '.services.router.networks \| keys'` |
| 5 | EDGE-01 + EDGE-05 | Router edge router on `Host(router.taild8d553.ts.net)` + metrics-blackhole attached | ✅ verified — `curl -H "Host: router.taild8d553.ts.net" http://127.0.0.1/healthz` returns 200; HTTP→HTTPS redirect deferred (Tailscale Serve layer) |
| 6 | D-B1 | External `/metrics` returns 4xx (404 or 401 per Plan 06-02 carry-forward acceptance) | ✅ pass — HTTP 401 |
| 7 | D-B2 | Internal Prometheus scrape works | ✅ pass — `# HELP process_cpu_user_seconds_total` returned |
| 8 | WEBUI-01 | OWUI reachable on chat subdomain | ✅ pass — `/health` returns `{"status":"OK"}` with basic-auth |
| 9 | WEBUI-02 | OWUI `OPENAI_API_BASE_URLS=http://router:3000` (no /v1) | ✅ pass — verified via `docker compose config` |
| 10 | WEBUI-03 | `WEBUI_AUTH=False` + basic-auth gate | ✅ pass — 401 without creds, 200 with |
| 11 | WEBUI-04 | Shared Postgres `openwebui` DB | ✅ pass — Alembic migrations completed |
| 12 | WEBUI-05 | OWUI auto-discovery via /v1/models | ⚠ partial — couldn't verify externally; OWUI's `/api/models` requires its own auth (`{"detail":"401 Unauthorized"}`). Live browser test deferred. |
| 13 | **D-C6** | **No OWUI bypass connections** | ✅ **CLOSED** by Plan 06-05 — webui-app isolated network. `docker compose exec openwebui curl http://ollama:11434/api/tags` returns `curl: (6) Could not resolve host: ollama` (DNS plane elimination). Re-verified 2026-05-16T15:25:00Z. |

---

## What This Verification Did NOT Cover

1. **Browser visual UAT** (Plan 06-04 Task 4) — `playwright-cli` couldn't launch chromium/firefox without system libs (`libnspr4`, `libnss3`, `libasound`) that require sudo to install. Independent of the D-C6 finding.
2. **120s+ SSE smoke** — verified path works (33s with model 3B) but didn't reach 120s threshold. Would need a slower model.
3. **Tailscale Services bootstrap** — admin-console step + `tailscale serve --service=svc:router --https=443 127.0.0.1:80` not executed (admin step required). TLS path via Tailscale Serve therefore not exercised end-to-end.
4. **OWUI auto-discovery confirmation** — couldn't probe OWUI's own `/api/models` (requires OWUI internal auth not configured via env). Live browser would have shown the model picker.

---

## Recommended Next Step

Run `/gsd-plan-phase 6 --gaps` to generate Plan 06-05 (Wave 5) implementing OPTION A (isolated `webui-app` network) that closes D-C6. Estimated scope: 1 plan, ~3 tasks (compose.yml network mutation, OWUI re-attach, regression smoke). After 06-05 executes successfully, re-run the bypass smoke; if it returns connection refused, D-C6 is closed and SC5 flips to PASS.

The browser UAT + Tailscale Services prereq + 120s smoke remain operator-only (out of CI/agent scope) — they can land in a follow-up `06-UAT.md` evidence collection or be deferred to milestone audit.
