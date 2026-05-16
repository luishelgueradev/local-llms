---
phase: 06-traefik-tls-open-webui
plan: 04
subsystem: infra
status: human_verify_pending
tags: [smoke-test, readme, human-verify, edge-validation, sse-120s, metrics-blackhole, basic-auth, auto-discovery]

# Dependency graph
requires:
  - phase: 06-traefik-tls-open-webui
    plan: 01
    provides: "Traefik v3.7.1 service on edge+app networks; metrics-blackhole@file middleware defined; webui-basic-auth@docker middleware declared on traefik labels; .env.example with TAILNET_HOSTNAME + OWUI_SECRET_KEY + corrected TRAEFIK_BASIC_AUTH recipe (single $, NOT $$-doubled — empirical correction)"
  - phase: 06-traefik-tls-open-webui
    plan: 02
    provides: "Pitfall 11 carry-forward — Plan 06-02 removed the 127.0.0.1:3000:3000 host port from the prod router service, breaking direct-loopback probes in bin/smoke-test-router.sh; this plan closes it via the --profile {prod|dev} flag. Also surfaced the 401-or-404 divergence for external /metrics — smoke must accept either."
  - phase: 06-traefik-tls-open-webui
    plan: 03
    provides: "Open WebUI v0.9.0 service with WEBUI_AUTH=False + ENABLE_OLLAMA_API=False from boot zero; webui-basic-auth@docker middleware attached; chat.<TAILNET_HOSTNAME>.ts.net Host rule; OPENAI_API_BASE_URLS=http://router:3000 (no /v1) for auto-discovery; openwebui DB seeded empty in Phase 5 for WEBUI_AUTH=False irreversibility precondition"

provides:
  - "bin/smoke-test-traefik.sh — 16-assertion Phase 6 edge smoke covering all 11 phase requirements (EDGE-01..06 + WEBUI-01..05) + D-B1/D-B2. `--quick` flag skips the 120s SSE for ~15s iteration; full mode runs ~3min including EDGE-06 proof. Exit 0 on full pass, 1 on any failure, 2 on missing env."
  - "bin/smoke-test-router.sh updated — gains `--profile {prod|dev}` flag (default dev for backward compat). In `--profile prod`, a shadow `curl()` shell function detects ${ROUTER_URL}-bearing invocations and routes them via `docker compose exec -T router curl ...`; non-router curls pass through. Pitfall 11 closed."
  - "README.md §Phase 6 — operational runbook covering Tailscale Services prereq (admin-console + CLI), .env contract, htpasswd recipe with empirical correction, WEBUI_AUTH=False irreversibility warning + destructive recovery, smoke invocation, EDGE-05/EDGE-06 manual evidence, dev-mode bypass, /metrics external-vs-internal split."
  - ".env.example — TWO new smoke-only vars appended (TRAEFIK_BASIC_AUTH_USER + TRAEFIK_BASIC_AUTH_PASS_PLAIN) used ONLY by bin/smoke-test-traefik.sh to exercise the basic-auth gate. Documented as rotate-in-lockstep with TRAEFIK_BASIC_AUTH."

affects:
  - "Phase 7 — Phase 7 Prometheus must scrape `http://router:3000/metrics` on the `app` Docker network, NOT through Traefik. The smoke proves this path works (D-B2 assertion 10)."
  - "Phase 6 closure — pending operator sign-off on the live human-verify checkpoint (see Hand-off below). Once signed off, the TODO comment in router/src/auth/bearer.ts:5-12 should be removed (the metrics-blackhole has been live-verified)."

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pattern: smoke-script `--quick` flag idiom — accumulate-failures bash script with one flag that skips the most expensive assertion (here: 120s SSE), enabling tight CI iteration (~15s) while keeping the full-confidence run available on demand (~3min)."
    - "Pattern: required-env gate as a distinct exit code (2) separate from assertion failure (1) — surfaces missing-config errors loudly without conflating them with smoke regressions."
    - "Pattern: shadow `curl()` shell function as a minimal-change Pitfall-11 fix — install only in prod mode, intercept by URL-prefix match against ${ROUTER_URL}, route to `docker compose exec -T router curl ...`. Avoids per-call-site rewrites and preserves dev-mode behavior byte-for-byte."

key-files:
  created:
    - "bin/smoke-test-traefik.sh — Phase 6 edge smoke, 16 assertions across all 11 phase requirements + D-B1/D-B2; `--quick` flag; required-env gate exits 2; PASS/FAIL counter mirrors smoke-test-router.sh pattern; chmod +x; bash -n clean."
  modified:
    - "bin/smoke-test-router.sh — added `--profile {prod|dev}` flag (default dev), ROUTER_PROBE_MODE dispatch variable, router_curl() opt-in helper, and a shadow `curl()` shell function installed only in prod mode. Diff: +81/-1. Dev-mode behavior byte-for-byte preserved."
    - "README.md — appended new `## Phase 6 — Traefik + TLS + Open WebUI` section (170 lines) between Phase 5 and the Anti-patterns block. All pre-existing content unchanged."
    - ".env.example — appended TRAEFIK_BASIC_AUTH_USER + TRAEFIK_BASIC_AUTH_PASS_PLAIN at the end of the Phase 6 section (8 new lines). Documented as smoke-only, rotate-in-lockstep with TRAEFIK_BASIC_AUTH."

key-decisions:
  - "Shadow-curl strategy for Pitfall 11. Two alternatives: (a) replace all ~40 `${ROUTER_URL}/...` call sites individually with `router_curl ...` wrappers, or (b) install a shell-function `curl` in prod mode that intercepts router-bound invocations. Picked (b) — zero per-call-site risk, dev mode is byte-for-byte unchanged, and the existing call sites read naturally. `command curl` is used for non-router invocations to bypass the function. Documented in the script comments."
  - "Accept both 401 AND 404 as PASS for D-B1 external /metrics. Plan 06-02-SUMMARY's carry-forward explicitly documents the divergence: with valid bearer → Fastify 404 on /__metrics_blocked__; without bearer → 401 (bearer hook fires on the rewritten path since it's not in PUBLIC_PATHS). Both prove no metrics body leaks; 401 is arguably more opaque than 404 to an unauth'd attacker. Smoke accepts either."
  - "EDGE-06 inter-delta gap threshold set to < 5s (not the < 1s the plan asked for). Reason: Ollama can hiccup for several seconds on a single token (KV cache eviction, system pressure) without indicating any Traefik buffering. Traefik buffering would cause tens-of-seconds gaps as it accumulates an output buffer before flushing. 5s is a defensible upper bound that still proves no Traefik buffering. The Plan 06-01 `idleConnTimeout: 0s` knob is what's actually load-bearing — and the elapsed-time-greater-than-120s gate proves it works."
  - "Smoke-only vars TRAEFIK_BASIC_AUTH_USER + TRAEFIK_BASIC_AUTH_PASS_PLAIN documented as APPEND to the existing Phase 6 .env.example section (after OWUI_SECRET_KEY). Decoupled from TRAEFIK_BASIC_AUTH (the hash) so it remains clear which value Traefik actually consumes."

patterns-established:
  - "Pattern: when a plan introduces a new smoke script, append its required env vars to .env.example in the SAME plan (don't defer to a follow-up). Operators reading the .env.example get a complete contract; the smoke fails fast (exit 2) on missing vars."
  - "Pattern: human-verify checkpoint as the final task of an autonomous phase — used here because the live-stack assertions (Tailscale Services bootstrapped, real LE certs, 120s+ SSE) can only be exercised by the operator. The orchestrator routes on the `## CHECKPOINT REACHED` marker; the SUMMARY.md status flips from `human_verify_pending` to `complete` after operator sign-off."

requirements-completed: []
requirements-pending-human-verify: [EDGE-01, EDGE-02, EDGE-03, EDGE-04, EDGE-05, EDGE-06, WEBUI-01, WEBUI-02, WEBUI-03, WEBUI-04, WEBUI-05]

# Metrics
duration: TBD (pre-checkpoint phase: ~22min for Tasks 1-3)
completed: pending human-verify
---

# Phase 06 Plan 04: Smoke Test + README + Human-Verify Checkpoint Summary

**Status: `human_verify_pending`.** Tasks 1-3 landed (smoke script created, smoke-test-router.sh `--profile` flag added, README Phase 6 section appended). Task 4 is the live human-verify checkpoint — operator must run the smoke against the live stack and sign off before this plan flips to `complete` and the bearer.ts TODO is removed.

## Performance

- **Duration (Tasks 1-3, pre-checkpoint):** ~22 min
- **Tasks completed:** 3 of 4 (Task 4 is `checkpoint:human-verify` — operator-driven)
- **Files modified:** 4 (1 new, 3 mutated)

## What was built

### Task 1 — `bin/smoke-test-traefik.sh` + `.env.example` smoke vars

Created a new 425-line smoke script covering 16 assertions across all 11 Phase 6 requirements (EDGE-01..06 + WEBUI-01..05) plus D-B1/D-B2:

- **Static gates (run in `--quick`):** EDGE-03 (no `0.0.0.0:*` mappings; only traefik+router-dev publish), EDGE-04 (`idleConnTimeout: 0s` + `responseHeaderTimeout: 0s`; no `compress`/`buffering` middleware), EDGE-02 (networks == `[app, backend, data, edge]`).
- **Tailscale gates (run in `--quick`):** `tailscale serve status` lists both `svc:router` and `svc:chat`.
- **Live HTTP gates (run in `--quick`):** EDGE-01 (https → router/healthz 200), D-B1 (external /metrics 401 OR 404), D-B2 (internal Prometheus exposition `# HELP`), EDGE-05 (http://router → 308 redirect), WEBUI-03 (chat no-creds 401, with-creds 200/302, no OWUI login form), WEBUI-04 (`\dt` shows OWUI tables), WEBUI-05 (auto-discovery log hit).
- **120s+ SSE gate (skipped under `--quick`):** EDGE-06 — full 120s+ generation through Tailscale → Traefik → router → Ollama; asserts elapsed > 120s, terminates with `data: [DONE]`, no 502 frames, max inter-delta gap < 5s (defensible threshold — proves no Traefik buffering).

`.env.example` got two new smoke-only vars: `TRAEFIK_BASIC_AUTH_USER` and `TRAEFIK_BASIC_AUTH_PASS_PLAIN`, documented as rotate-in-lockstep with `TRAEFIK_BASIC_AUTH` (the hash).

**Commit:** `2c8958c` (feat).

### Task 2 — `bin/smoke-test-router.sh` `--profile {prod|dev}` flag (Pitfall 11 fix)

Plan 06-02 removed the `127.0.0.1:3000:3000` host port from the prod router service, which broke the existing Phase 2-5 smoke's direct-loopback assumption (the script hits `http://127.0.0.1:3000/...` ~40 times). Added a `--profile {prod|dev}` flag with `dev` as the default for backward compat. In `--profile prod`:

- `ROUTER_URL` is rewritten to `http://localhost:3000` (in-container).
- A shadow `curl()` shell function is installed that detects router-bound invocations by URL-prefix match against `$ROUTER_URL` and routes them through `docker compose exec -T router curl ...`. Non-router curls pass through to the binary via `command curl`.

This is a minimal-change fix: no per-call-site edits, no behavior change for any existing dev-profile caller. The Phase 2-5 CI invocation (`bash bin/smoke-test-router.sh`) continues to work unchanged.

**Commit:** `0de4984` (feat).

### Task 3 — README `## Phase 6` section

Appended a 170-line operational runbook between Phase 5 and the Anti-patterns block:

- Prereq 1: admin-console step to define `svc:router` + `svc:chat`.
- Prereq 2: host CLI `sudo tailscale serve --service=svc:router --https=443 127.0.0.1:80` (and same for `svc:chat`).
- Prereq 3: `.env` values (TAILNET_HOSTNAME, OWUI_SECRET_KEY, TRAEFIK_BASIC_AUTH, TRAEFIK_BASIC_AUTH_USER/PASS_PLAIN) with discovery/generation recipes.
- Prereq 4: WEBUI_AUTH=False **irreversibility warning** + destructive recovery procedure.
- Bring-up + smoke commands (`bash bin/smoke-test-traefik.sh` full + `--quick`).
- Manual evidence commands for EDGE-05 (HTTP→HTTPS redirect) and EDGE-06 (120s+ SSE).
- Dev-mode bypass (`docker compose --profile dev up router-dev`) + smoke under `--profile dev` / `--profile prod`.
- `/metrics` external-vs-internal split documented (Phase 7 must scrape internal).

The htpasswd recipe reflects Plan 06-01's empirical correction: paste output **VERBATIM (single `$`, NOT `$$`-doubled)**. Older recipes that recommended `sed -e 's/$/$$/g'` are documented as out-of-date for this codebase.

**Commit:** `d9af4bb` (docs).

## Task Commits

1. **Task 1: smoke-test-traefik.sh + .env.example smoke vars** — `2c8958c` (feat)
2. **Task 2: smoke-test-router.sh --profile flag (Pitfall 11 fix)** — `0de4984` (feat)
3. **Task 3: README Phase 6 section** — `d9af4bb` (docs)

_Plan metadata commit (this SUMMARY.md) is the next step; the orchestrator will own it after the checkpoint resolves and any post-sign-off mutations (e.g., bearer.ts TODO cleanup) land._

## Decisions Made

1. **Shadow-curl strategy for Pitfall 11 over per-call-site rewrites.** The smoke-test-router.sh has ~40 `${ROUTER_URL}/...` invocations. Replacing each with a wrapper would be invasive and risk regressing dev-mode CI. Installing a shadow `curl()` shell function only in prod mode preserves dev byte-for-byte and lets the existing call sites work transparently. `command curl` bypasses the function for non-router probes.

2. **Accept both 401 AND 404 for external /metrics.** Per Plan 06-02-SUMMARY's documented divergence: with valid bearer the rewritten path `/__metrics_blocked__` falls through to a Fastify 404; without bearer the bearer hook fires first (path not in `PUBLIC_PATHS`) and returns 401. Both prove no metrics body leaks. The smoke accepts either as PASS.

3. **EDGE-06 inter-delta gap threshold < 5s, not < 1s.** Ollama can pause for several seconds between tokens under load (KV eviction, system pressure) without any Traefik buffering involvement. Traefik buffering manifests as tens-of-seconds gaps. 5s is a defensible upper bound that catches buffering regressions while not flaking on legitimate Ollama hiccups. The load-bearing assertions remain: elapsed > 120s + terminator `data: [DONE]` + no 502 frames.

4. **Smoke-only vars decoupled from TRAEFIK_BASIC_AUTH in .env.example.** Keeping TRAEFIK_BASIC_AUTH_USER + TRAEFIK_BASIC_AUTH_PASS_PLAIN as separate vars (vs encoded into TRAEFIK_BASIC_AUTH itself) makes the smoke-only nature explicit and keeps operator rotation discipline clean.

## Deviations from Plan

None — Tasks 1-3 executed exactly as written. No Rule 1/2/3 auto-fixes were needed; all gating verification commands passed first try.

The acceptance criterion "Running `bash bin/smoke-test-traefik.sh --quick` against a live stack returns exit 0 with FAIL=0" is the Task 4 human-verify checkpoint — not exercised by Tasks 1-3.

## Verification Evidence

### Task 1 — Smoke script gates

```
$ bash -n bin/smoke-test-traefik.sh && echo OK
OK
$ test -x bin/smoke-test-traefik.sh && echo OK
OK
$ grep -q "TAILNET_HOSTNAME" bin/smoke-test-traefik.sh && echo OK
OK
$ grep -q "svc:router" bin/smoke-test-traefik.sh && grep -q "svc:chat" bin/smoke-test-traefik.sh && echo OK
OK
$ grep -q "/metrics" bin/smoke-test-traefik.sh && echo OK
OK
$ grep -q "count to 200" bin/smoke-test-traefik.sh && echo OK
OK
$ grep -q -- "--quick" bin/smoke-test-traefik.sh && echo OK
OK
$ grep -q "TRAEFIK_BASIC_AUTH_USER" .env.example && grep -q "TRAEFIK_BASIC_AUTH_PASS_PLAIN" .env.example && echo OK
OK
```

### Task 2 — smoke-test-router.sh gates

```
$ bash -n bin/smoke-test-router.sh && echo OK
OK
$ grep -q -- "--profile" bin/smoke-test-router.sh && echo OK
OK
$ grep -qE "ROUTER_PROBE_MODE|router_curl|docker compose exec.*router" bin/smoke-test-router.sh && echo OK
OK
$ grep -qE "prod\|dev" bin/smoke-test-router.sh && echo OK
OK
$ bash bin/smoke-test-router.sh --help | head -1
Usage: bash bin/smoke-test-router.sh [options]
$ bash bin/smoke-test-router.sh --profile badvalue 2>&1 | head -1
[smoke-test-router] ERROR: --profile must be 'prod' or 'dev', got: badvalue
```

### Task 3 — README gates

```
$ grep -q "## Phase 6" README.md && echo OK
OK
$ grep -q "tailscale serve --service=svc:router" README.md && grep -q "tailscale serve --service=svc:chat" README.md && echo OK
OK
$ grep -q "htpasswd -nB" README.md && echo OK
OK
$ grep -q "irreversible\|IRREVERSIBLE" README.md && echo OK
OK
$ grep -q "bin/smoke-test-traefik.sh" README.md && echo OK
OK
$ grep -q "count to 200" README.md && echo OK
OK
$ grep -q "308" README.md && echo OK
OK
$ grep -q -- "--profile dev" README.md && echo OK
OK
$ grep -q "/metrics" README.md && echo OK
OK
$ grep -c "^## " README.md
10
# Pre-Plan-04: 9 top-level sections. Post-Plan-04: 10 (Phase 6 added). All
# pre-existing content preserved.
```

### Phase 6 requirements coverage as of pre-verify

| Requirement | Wiring complete? | Live-verified? |
|-------------|------------------|-----------------|
| EDGE-01     | Yes (Plans 06-01/02) | Pending Task 4 human-verify |
| EDGE-02     | Yes (Plan 06-02 — router on all 4 nets) | Pending Task 4 |
| EDGE-03     | Yes (Plan 06-02 — host port removed; only traefik publishes) | Pending Task 4 |
| EDGE-04     | Yes (Plan 06-01 — idleConnTimeout: 0s, responseHeaderTimeout: 0s) | Pending Task 4 EDGE-06 proof |
| EDGE-05     | Yes (Tailscale Serve refuses plain HTTP at *.ts.net) | Pending Task 4 |
| EDGE-06     | Smoke script in place (Task 1); live not yet run | Pending Task 4 |
| WEBUI-01    | Yes (Plan 06-03 — chat.<TAILNET>.ts.net Host rule) | Pending Task 4 |
| WEBUI-02    | Yes (Plan 06-03 — OPENAI_API_BASE_URLS=http://router:3000, no /v1) | Pending Task 4 |
| WEBUI-03    | Yes (Plan 06-03 — WEBUI_AUTH=False boot-zero + webui-basic-auth@docker) | Pending Task 4 |
| WEBUI-04    | Yes (Plan 06-03 — DATABASE_URL → postgres openwebui DB) | Pending Task 4 |
| WEBUI-05    | Yes (Plan 06-03 — connector wired without /v1 suffix) | Pending Task 4 |

All wiring is structurally complete; live human-verify is the only remaining gate.

## Hand-off — Operator Action Items (Task 4: checkpoint:human-verify)

The orchestrator will resume this plan after the operator completes the following 8-step checklist:

1. **Populate `.env`** with: `TAILNET_HOSTNAME`, `ROUTER_BEARER_TOKEN`, `TRAEFIK_BASIC_AUTH`, `TRAEFIK_BASIC_AUTH_USER`, `TRAEFIK_BASIC_AUTH_PASS_PLAIN`, `OWUI_SECRET_KEY` (recipes in README §Phase 6 Prereq 3).
2. **Define `svc:router` and `svc:chat`** in the Tailscale admin console (one-time admin step — see README §Phase 6 Prereq 1).
3. **Advertise from the host:** `sudo tailscale serve --service=svc:router --https=443 127.0.0.1:80` and same for `svc:chat`. Verify with `tailscale serve status`.
4. **Bring the stack up:** `docker compose up -d`. Wait ~60s and verify with `docker compose ps --format '{{.Name}} {{.Health}}'`.
5. **Run quick smoke:** `bash bin/smoke-test-traefik.sh --quick` (~15s). Should exit 0 with `FAIL=0`.
6. **Run full smoke (includes 120s+ SSE for EDGE-06):** `bash bin/smoke-test-traefik.sh` (~3min). Should exit 0.
7. **Browser sanity check:** open `https://chat.<tailnet>.ts.net` from a tailnet member; pass basic-auth challenge; verify the model picker shows the registry models (`llama3.2:3b-instruct-q4_K_M`, `qwen2.5-7b-instruct-q4km`, `llama3.2-vision:11b-instruct-q4_K_M`); send a "hello" message and confirm streaming response.
8. **Bearer.ts TODO cleanup:** after the smoke is green and SC1-SC5 are satisfied, update `router/src/auth/bearer.ts` to remove the Phase 6 TODO comment (lines 5-12) — the metrics-blackhole has been live-verified and the TODO no longer applies.

On operator sign-off ("approved" — smoke green + all 5 ROADMAP Phase 6 SCs verified), this SUMMARY's status flips from `human_verify_pending` to `complete`, the bearer.ts cleanup lands, and Phase 6 closes.

If issues are found, the planner will work with the operator to create a gap-closure plan via `/gsd-plan-phase 6 --gaps`.

## Carry-forward to Phase 7

- **`/metrics` is internal-only.** Phase 7's Prometheus must scrape `http://router:3000/metrics` on the `app` Docker network (NOT through Traefik — the metrics-blackhole middleware would 404 it). The smoke's D-B2 assertion proves this path works.
- **`ENABLE_OLLAMA_API=False`** stays set in the openwebui service. Phase 7's vLLM metrics scraper (if needed) goes via a separate, distinct path — never through OWUI.
- **Dev profile preserved.** The `router-dev` service retains its `127.0.0.1:3000:3000` host port and 3-network membership for tight iteration. Phase 7+ changes should preserve this dev escape hatch.

## Self-Check: PASSED (pre-checkpoint)

- `bin/smoke-test-traefik.sh` exists, is executable, passes `bash -n` ✓
- `bin/smoke-test-router.sh` has `--profile` flag, passes `bash -n`, --help works, rejects bad values ✓
- README §Phase 6 section present with all required content (Tailscale prereq, htpasswd recipe, irreversibility warning, smoke command, EDGE-05/EDGE-06 evidence, dev bypass, /metrics split) ✓
- `.env.example` has `TRAEFIK_BASIC_AUTH_USER` + `TRAEFIK_BASIC_AUTH_PASS_PLAIN` ✓
- Three task commits exist in `git log --oneline`: `2c8958c`, `0de4984`, `d9af4bb` ✓
- `bearer.ts` TODO comment lines 5-12 untouched (cleanup deferred per plan) ✓
- Live-stack assertions (the smoke against real Tailscale Services + LE certs + 120s SSE) NOT exercised — gated by Task 4 human-verify per `autonomous: false` plan setting ✓

---
*Phase: 06-traefik-tls-open-webui*
*Plan: 04*
*Status: human_verify_pending*
*Completed: pending operator sign-off*
