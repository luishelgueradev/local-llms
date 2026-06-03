# Phase 20 Deferred Items

Out-of-scope discoveries logged per execute-plan SCOPE BOUNDARY rule.

> **2026-06-03 — ALL FOUR ITEMS CLOSED by Phase 21.** The "future smoke-hygiene plan" cited throughout this document landed as Phase 21 (HYG-01..04). Per-item resolution is tagged inline below; the file is kept verbatim as the original audit trail.

## Pre-existing smoke-test-router.sh failures (NOT caused by Plan 20-06)

After running `bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210` against the live router post-Plan-20-06 deploy, **3 pre-existing FAILures surfaced** that are unrelated to OPS-01/OPS-02:

### 1. Phase 3 — `/v1/models did not list both models` (multi-backend dispatch test)

> **✅ RESOLVED — Phase 21 / Plan 21-02 / HYG-03 — commit `95ad0eb` (2026-06-03).** The Phase 3 multi-backend section now soft-skips when `qwen2.5-7b-instruct-q4km` is absent from `/v1/models`, with a traceable rationale ("no enabled llamacpp model — qwen2.5-7b-instruct-q4km is disabled per Phase 20 / CAT-01 / D-01; flip disabled→false + start --profile llamacpp to re-include"). Operators who re-enable llamacpp continue to exercise the full Phase 3 matrix unchanged.

- **Smoke gate:** Phase 3 multi-backend dispatch test expects BOTH an `ollama` and a `llamacpp` model in `/v1/models`.
- **Root cause:** Wave 0 / Plan 20-01 disabled the 3 llamacpp/vllm/vllm-embed dead-backend aliases (`qwen2.5-7b-instruct-q4km`, `qwen2.5-7b-instruct-awq`, `bge-m3-vllm`). The router no longer has any enabled llamacpp model.
- **Current behavior:** `/v1/models` lists 11 enabled entries (all ollama / ollama-cloud).
- **Why this is intentional:** Per CONTEXT.md C1 (VRAM 16GB budget), vllm/llamacpp are redundant — Wave 0 explicitly disabled them.
- **Fix scope:** Phase 3 smoke gate needs to be updated to either (a) drop the llamacpp-required assertion, or (b) soft-skip when no llamacpp backend is declared in models.yaml. Out of scope for Plan 20-06 (OPS-01/OPS-02 only); belongs in a future smoke-hygiene plan.

### 2. Phase 3 — `POST /v1/chat/completions to llamacpp model failed or returned empty`

> **✅ RESOLVED — Phase 21 / Plan 21-02 / HYG-03 — commit `95ad0eb` (2026-06-03).** Folded into item #1's fix: the early-out skip wraps the entire Phase 3 section (`if [[ "${P3_SKIPPED:-0}" != "1" ]]; then ... fi`), so the dispatch-against-disabled-llamacpp probe no longer runs when there is nothing to test.

- **Same root cause as #1:** the test dispatches to a llamacpp alias that is now disabled. The router correctly returns model_not_found.
- **Fix scope:** Same as #1 — Phase 3 smoke section needs llamacpp-disabled guard.

### 3. Phase 7 — `capability gate returned 404 (expected 400)`

> **✅ RESOLVED — Phase 21 / Plan 21-02 / HYG-03 — commit `95ad0eb` (2026-06-03).** Capability-gate fixture flipped from disabled `qwen2.5-7b-instruct-awq` to always-enabled `chat-local` (capabilities [chat, tools, json_mode] — no embeddings). The gate now asserts the registry-enforced capability check on a real, dispatchable model and returns 400 for the right reason (not model_not_found by accident).

- **Smoke gate:** Phase 7 capability gate test expects 400 (capability mismatch) but received 404 (model not found).
- **Probable cause:** The model the test probes against was disabled by Wave 0 or removed from models.yaml at some point; the router correctly 404s before reaching capability validation.
- **Fix scope:** Phase 7 smoke section needs to use an enabled-model fixture. Out of scope for Plan 20-06.

## Status

All 3 failures pre-date Plan 20-06 and are downstream consequences of Wave 0 (Plan 20-01) disabling dead-backend aliases. The Plan 20-06 contracts (Phase 20 smoke section — 6 gates) all PASS or SKIP as documented in the plan:

- OPS-02 /healthz includes build_sha: PASS
- OPS-02 /version matches /healthz: PASS
- CAT-02 /v1/models entries have health: PASS
- CDX-01 /v1/models has recommendations map: PASS
- CAT-01 /v1/models entries < 13: PASS (11 enabled — Wave 0 disabled filter active)
- CAT-04 deprecated alias header: SKIP (D-02 LOCKED — v0.12.0 ships with deprecated_aliases empty)

## Additional pre-existing issue: smoke-test-router.sh --profile prod broken

> **✅ RESOLVED — Phase 21 / Plan 21-02 / HYG-02 — commit `f88eec3` (2026-06-03).** The router runtime stage now installs `curl` via `apt-get install -y --no-install-recommends curl` (~+3 MB). `--profile prod` runs its `docker compose exec -T router curl ...` probes without "curl: not found". Verified live post-rebuild: `docker exec local-llms-router curl --version` → `curl 7.88.1`. A companion smoke gate ("HYG-02: curl present in router runtime image") in the Phase 21 section of `bin/smoke-test-router.sh` flips fail → PASS automatically on every smoke run, locking the regression closed.

`bash bin/smoke-test-router.sh --profile prod` fails at Pre-flight because the runtime
router image does NOT have `curl` installed, and `--profile prod` routes router-bound
curl invocations through `docker compose exec -T router curl ...`. This means the `prod`
profile mode is broken in the current image.

**Workaround used during Plan 20-06 verification:** Run with explicit `--router-url
http://127.0.0.1:3210` instead, which uses host-loopback directly (host port 3210 is
bound to container port 3000 per compose.yml).

**Fix scope:** Either (a) add `curl` to the router runtime image, or (b) make `--profile prod`
target the host port `127.0.0.1:3210` directly instead of `docker compose exec router curl`.
Out of scope for Plan 20-06 — belongs in a future smoke-hygiene plan.

bin/deploy-router.sh itself does NOT depend on container-curl — it uses host curl against
`http://127.0.0.1:3210` (or `:3000` for dev) per `derive_router_url()`. The drift check
and wait_for_healthz both work correctly against the live router.
