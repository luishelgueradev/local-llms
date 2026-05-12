---
phase: 02-mvp-vertical-slice-router-ollama-sse
plan: "05"
subsystem: router-hotreload-smoke
tags: [router, hot-reload, fs-watch, smoke-test, bash, compose, ROUTE-02, SC4, SC5, D-A4, D-C3, mvp-final]
dependency_graph:
  requires:
    - router/src/config/registry.ts loadRegistryFromFile + RegistryStore._swap (plan 02-02 seam)
    - router/src/index.ts bootstrap shape (plan 02-02) — receives watcher.stop() in signal teardown
    - router/src/routes/v1/chat-completions.ts streaming branch (plan 02-04) — exercised by SC1 + SC3 in smoke
    - bin/smoke-test-gpu.sh (Phase 1) — updated atomically when Ollama host port is removed
    - compose.yml Ollama service + bind-mounted router/models.yaml (plan 02-01)
  provides:
    - router/src/config/registry.ts watchRegistry(path, store, opts) — ROUTE-02 hot-reload half
    - bin/smoke-test-router.sh — canonical live SC1..SC5 regression check against real GPU
    - compose.yml — Ollama no longer publishes host port (D-A4 final wire-up)
    - bin/smoke-test-gpu.sh updated to use `docker compose exec -T ollama nvidia-smi` etc. (no host-port dependency)
    - README.md "step 6: Verify the router" appended to ## First boot
  affects:
    - Phase 3 (llama.cpp backend): smoke-test-router.sh becomes the regression bar; new backends must keep all 5 SCs green
    - Phase 6 (Traefik): adds HTTPS edge in front of 127.0.0.1:3000:3000; smoke test will need an https variant
    - Phase 8 (Ollama Cloud): adds OllamaCloudAdapter via same BackendAdapter seam; smoke pattern is reused
tech_stack:
  added: []
  patterns:
    - "watchRegistry(path, store, opts): { stop } — node:fs.watch + 250ms debounce + parse-validate-then-_swap (keep previous on error per D-C3)"
    - "WSL2 robustness: listen to BOTH 'change' AND 'rename' events on fs.watch handle (RESEARCH Pitfall 7); fs.watchFile polling fallback gated by MODELS_YAML_WATCH=poll env var"
    - "Atomic 4-edit slice: registry hot-reload + smoke-test-router + compose port removal + smoke-test-gpu update must land together (RESEARCH Assumption A5)"
    - "SC5 grep regex must guard against false positives from auth-failure log messages — use literal token + token-shaped {16,} suffix, NOT raw 'bearer [a-z]+'"
    - "Smoke tests probe Ollama through 'docker compose exec -T router node -e \"fetch(...)\"' since ollama/ollama:0.5.7 ships no HTTP client (no curl/wget)"
key-files:
  created:
    - bin/smoke-test-router.sh
  modified:
    - router/src/config/registry.ts (appended watchRegistry + fs.watch + fs.watchFile polling fallback)
    - router/src/index.ts (wires watchRegistry into bootstrap; watcher.stop() in SIGTERM/SIGINT before app.close)
    - router/tests/unit/registry.test.ts (hot-reload it.todo stubs replaced with real tests + debounce coalesce test)
    - router/tests/integration/hotreload.test.ts (4 it.todo stubs replaced with real fastify-app tests)
    - bin/smoke-test-gpu.sh (Phase 1 regression preserved — switched to exec-based probes after host port removal)
    - compose.yml (Ollama `ports: ['127.0.0.1:11434:11434']` block removed with tombstone comment)
    - README.md (## First boot step 6 appended)
key-decisions:
  - "D-A4 fully realized: Ollama no longer reachable from host; router 127.0.0.1:3000 is the sole external surface"
  - "D-C3 'models.yaml hot-reload validation fail' implemented: parse failure -> log error + keep previous registry; never crash, never swap in bad config"
  - "watchRegistry default debounce 250ms — coalesces editor double-save without holding back real edits"
  - "MODELS_YAML_WATCH=poll env var as escape hatch for WSL2 + Docker Desktop where fs.watch is historically flaky (Pitfall 7) — picks fs.watchFile(interval=1000) under the hood"
  - "SC5 leak regex tightened post-smoke-1: literal token value + token-shaped {16,} suffix; descriptive auth-error messages no longer false-match"
  - "Ollama probe path moved from 'docker compose exec -T ollama curl' to 'docker compose exec -T router node fetch(...)' because the Ollama image ships no curl/wget"
patterns-established:
  - "Atomic vertical slice — when removing a dependency (Ollama host port), update the consumers in the same plan (RESEARCH Assumption A5)"
  - "Two-prong leak regex: literal high-entropy value + shaped suffix, both with min length, to keep grep-based negative assertions false-positive-free"
  - "Hot-reload pattern: fs.watch + debounce + parse-validate-then-swap; the load function is the source of truth, the _swap is the atomic seam"
requirements-completed: [ROUTE-02]
duration: ~30min (auto execution) + 1 cycle of operator verification
completed: 2026-05-12
---

# Phase 02 Plan 05 Summary

**Phase 2 MVP closed end-to-end: hot-reloading registry, live SC1..SC5 smoke green against real GPU, Ollama no longer host-reachable.**

## What Was Built

### Hot-reloading registry (ROUTE-02 + SC4 hot-reload half)

`watchRegistry(path, store, opts)` appended to `router/src/config/registry.ts`:

- Wraps `node:fs.watch` listening for both `'change'` AND `'rename'` events (WSL2 robustness; RESEARCH Pitfall 7).
- 250 ms debounce coalesces editor double-write quirk (default; opt-in via `opts.debounceMs`).
- After debounce, calls the existing `loadRegistryFromFile` (js-yaml safe load + zod parse from plan 02-02), then `store._swap(next)` on success.
- On parse/validation failure: invokes `opts.onError`, KEEPS the previous registry in memory (D-C3). Router never crashes; never swaps in a bad config.
- Returns `{ stop }` — idempotent: clears the debounce timer AND closes the fs.watch handle. Hooked into `index.ts` SIGTERM/SIGINT teardown BEFORE `app.close()`.
- WSL2 polling fallback: `MODELS_YAML_WATCH=poll` selects `fs.watchFile(interval=1000)` instead of `fs.watch` — heavier but bind-mount-safe on every host.

### Canonical live smoke test (`bin/smoke-test-router.sh`)

Mirrors `bin/smoke-test-gpu.sh` style verbatim (`set -uo pipefail`, `FAILURES` counter, `pass()`/`fail()` helpers, sectioned banner, exit 0/1):

- **SC4 (auth half):** GET /healthz unauth → 200; POST /v1/* no bearer → 401; wrong bearer → 401.
- **SC2:** POST /v1/chat/completions stream=false → ChatCompletion + non-zero `usage`. Verified on host: pt=38 ct=9 tt=47.
- **SC1:** POST /v1/chat/completions stream=true → ≥1 delta chunk + usage chunk + `data: [DONE]`. Verified on host: 32 chunks, pt=34 ct=30 tt=64.
- **SC3:** Kill curl mid-stream → poll Ollama `/api/ps` `expires_at` field across two 1.5 s-spaced snapshots → static delta proves abort propagated (vs. `keep_alive` reset, which would yield an increasing delta). Verified on host: delta=0.00 s.
- **SC4 (hot-reload half):** Edit `router/models.yaml` (`# canary` comment) → tail router logs for `registry reloaded` within 1 s. Verified on host: PASS.
- **SC5:** Run a representative session, then grep `docker compose logs router 2>&1` for two prongs — literal `ROUTER_BEARER_TOKEN` value (zero false positives) AND `bearer [A-Za-z0-9._+/=-]{16,}` token-shaped suffix. Both must return 0. Verified on host: zero leaks.

### Ollama host-port removal (D-A4 final wire-up)

- `compose.yml` Ollama service: removed `ports: ['127.0.0.1:11434:11434']` block; replaced with a tombstone comment pointing at Phase 2 D-A4.
- `bin/smoke-test-gpu.sh` updated atomically (RESEARCH Assumption A5): all Ollama probes now go through `docker compose exec -T ollama …` (and where curl is needed, through `docker compose exec -T router node fetch(...)` because the Ollama image ships no HTTP client). Verified on host: Phase 1 GPU smoke still exits 0.
- After this plan: `curl --max-time 2 http://127.0.0.1:11434/api/tags` returns connection refused. Router on `127.0.0.1:3000:3000` is the only externally-reachable port.

### README onboarding flow

Step 6 appended to `## First boot`: `bash bin/smoke-test-router.sh`, expected output, troubleshooting pointers.

## Deviations Auto-Fixed (Rule 1)

1. **`ollama/ollama:0.5.7` ships no HTTP client.** Plan specified `docker compose exec -T ollama curl …` to probe Ollama after host-port removal — but the image has no `curl`, `wget`, or any HTTP client. Routed probes through `docker compose exec -T router node -e "fetch(...)"` instead (the router is on the `backend` network and reaches `http://ollama:11434`). Both smoke scripts updated; `smoke-test-gpu.sh` verified to exit 0 before commit.

## Issues Found During Live Verification (Cycle 1) and Fixed

The first operator run of `bin/smoke-test-router.sh` surfaced two failures:

1. **SC4 hot-reload FAIL** — `docker compose up -d` recreated only the Ollama service (its config changed); the router container was the pre-02-05 image without `watchRegistry`. **Resolution:** operator ran `docker compose up -d --build router`; on the rebuilt container, `registry reloaded` logged within 1 s of the `models.yaml` edit. Code was already correct; container was stale.
2. **SC5 FAIL (false positive)** — regex `bearer [a-z0-9_]+|authorization:\s*bearer` matched the literal auth-failure log message `"missing or malformed bearer header"` (`bearer header` satisfies `bearer [a-z]+`). **Resolution:** committed `fix(02-05): tighten SC5 leak regex…` — replaced with two-prong check: literal `ROUTER_BEARER_TOKEN` value + `bearer [A-Za-z0-9._+/=-]{16,}` token-shaped suffix. Real tokens are 32+ chars; descriptive English words (`header`, `token`, `credential`) cannot match.

Both fixes verified on cycle 2 — all 5 success criteria PASS, smoke exits 0.

## Verification Results (Operator, cycle 2)

```
PASS: router + ollama services are running
PASS: router /healthz reachable
PASS: GET /healthz unauth -> 200
PASS: POST /v1/chat/completions no bearer -> 401
PASS: POST /v1/chat/completions wrong bearer -> 401
PASS: SC2: non-stream returned ChatCompletion with usage (pt=38 ct=9 tt=47 content_len=15)
PASS: SC1: stream emits chunks + usage + [DONE] (chunks=32 pt=34 ct=30 tt=64)
PASS: SC3: abort propagated to Ollama (PASS:static expires_at delta=0.00s)
PASS: SC4 hot-reload: router logged 'registry reloaded' within 1s of models.yaml edit
PASS: SC5: zero bearer-token leaks in router logs after a full session

Phase 2 router verification: COMPLETE.
```

Also verified: `bash bin/smoke-test-gpu.sh` → `Phase 1 GPU verification: COMPLETE.` (regression preserved per Assumption A5). `cd router && npm test` → 66 pass, 2 skipped, 0 todo, 0 fail (all 10 test files green).

## Commits

- `d0f2367` feat(02-05): add watchRegistry hot-reload with debounce + atomic swap (ROUTE-02, SC4)
- `0a1036c` feat(02-05): add bin/smoke-test-router.sh — end-to-end SC1..SC5 live verification
- `4f19cac` feat(02-05): ATOMIC — remove Ollama host port, update smoke-test-gpu.sh, append README (D-A4 + A5)
- `bb69c95` fix(02-05): tighten SC5 leak regex to exclude auth-failure log messages

## Self-Check: PASSED
