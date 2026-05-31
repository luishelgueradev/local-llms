# Phase 16 — Deferred Items

Out-of-scope discoveries logged during plan execution per scope-boundary rule.

## 2026-05-31 — Plan 16-04 execution

- **Live tunnel rebuild + recreate required to roll out Phase 16 to the deployed router endpoint.** Done by the orchestrator immediately after Plan 16-04 shipped (`docker compose build router && docker compose up -d --force-recreate router`); the running container at `http://localhost:3210` / `https://local-llms.luishelguera.dev` now serves the Phase 16 streaming path. Documented in STATE.md.

- **Smoke flake: `compose --profile llamacpp up -d --wait failed (GGUF load may exceed 60s start_period)`** — surfaced on the second consecutive smoke run after the Phase 16 rebuild. The llamacpp container's healthcheck `start_period: 60s` is insufficient for the qwen2.5-7b GGUF cold-load on WSL2 + shared-GPU when the host has just cycled multiple `--profile X up/down` operations. Cascade: Phase 3.B → Phase 4 setup (`--profile ollama up -d --wait failed`) → SC-P4-A/B/D empty responses.
  - Pre-existing flake (NOT introduced by Phase 16). The smoke script itself documents the workaround: `SKIP_LLAMACPP=1 bash bin/smoke-test-router.sh ...`.
  - Phase 16 RESS-01..04 PASS on every smoke run regardless of this flake (Phase 16 section is gated only on the ollama profile being up, which works fine when run in isolation).
  - Resolution path: extend the llamacpp service healthcheck `start_period` in `compose.yml` from `60s` to `180s` (matches the `OLLAMA_LOAD_TIMEOUT:5m0s` discipline added in Phase 15.1) — out of scope for Phase 16.
  - Verification of Phase 16: the *first* post-rebuild smoke run had 88 PASS / 1 FAIL (the FAIL was the Phase 13 obsolete deferral marker, fixed in commit `705e1cc`); the *second* smoke run (immediately after the fix) had Phase 15 MCP-01..03 + Phase 16 RESS-01..04 all PASS, and the only fails were the llamacpp cold-load cascade.
