---
phase: 03-multi-backend-dispatch-llama-cpp-registry-hardening
reviewed: 2026-05-15T12:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - router/src/app.ts
  - router/src/backends/adapter.ts
  - router/src/backends/factory.ts
  - router/src/backends/llamacpp-openai.ts
  - router/src/backends/ollama-openai.ts
  - router/src/backends/liveness.ts
  - router/src/routes/readyz.ts
  - router/src/routes/v1/models.ts
  - router/src/routes/v1/chat-completions.ts
  - router/src/concurrency/semaphore.ts
  - router/src/errors/envelope.ts
  - router/src/config/registry.ts
  - router/src/config/env.ts
  - router/src/index.ts
  - router/models.yaml
  - compose.yml
  - bin/smoke-test-router.sh
findings:
  critical: 0
  warning: 3
  info: 4
  total: 7
status: issues_found
---

# Phase 03: Code Review Report (Refresh)

**Reviewed:** 2026-05-15T12:00:00Z
**Prior review:** 2026-05-13 (status: issues_found, critical: 1, warning: 4, info: 3, total: 8)
**Refresh history:** prior: 2026-05-13; current: 2026-05-15
**Depth:** standard
**Files Reviewed:** 17
**Status:** issues_found

## Summary

Three fix commits landed between the prior and current pass, closing the sole Critical finding and two of the four Warnings. The remaining findings are two carry-over Warnings (WR-02 and WR-04) and one new Warning (WR-05) introduced in the smoke-test's Phase 3.B `SKIP_LLAMACPP` path. Four Info items carry over from the prior pass; one new Info item is added for the accepted-but-silently-ignored `backends.base_url` field in models.yaml.

The router's core dispatch path (factory, adapters, registry, semaphore) is clean. No new Critical findings.

---

## Closed Since Prior Pass

| Prior ID | Commit | What Was Fixed |
|----------|--------|----------------|
| CR-01 | `4818ba4` | `registerChatCompletionsRoute` and `registerMessagesRoute` now receive `opts.makeAdapter ?? defaultMakeAdapter` from `factory.ts`, ensuring `LlamacppOpenAIAdapter` is selected for `llamacpp` entries. Confirmed at `app.ts:398` and `app.ts:409`. |
| WR-01 | `ee63f9c` | `opts.semaphores.get(entry.backend)` moved inside the `try` block at `chat-completions.ts:197`; a missing entry now routes through the centralized error handler with proper socket listener cleanup. |
| WR-03 | `b73a866` | After appending the hot-reload canary comment to `models.yaml`, the script now strips all `# smoke-test-router hot-reload canary` lines via `grep -v` + atomic `mv` (lines 347-349). Re-running the smoke test no longer leaves a permanently-growing `models.yaml`. |

---

## Warnings

### WR-02: `INTERVAL_MS` in readyz.ts has no programmatic link to the scheduler's `intervalMs`

**File:** `router/src/routes/readyz.ts:28`
**Issue:** The stale-detection threshold is computed as `STALE_FACTOR * INTERVAL_MS` where `INTERVAL_MS = 10_000` is a module-level constant with only a prose comment saying "Must match the scheduler's intervalMs default in app.ts / makeLivenessScheduler." The scheduler's `intervalMs` is independently set to `10_000` at `app.ts:285`. These two values are not linked at compile time or at runtime. If the scheduler interval is tuned (e.g., increased to `30_000` for a lower-traffic deployment), `readyz.ts` will silently compute a stale threshold 3x too tight, causing backends to appear `stale` within 20 s instead of 60 s. No compile-time or test gate catches this drift.

**Fix:** Export the interval constant from a shared location and import it in both files:

```typescript
// router/src/config/constants.ts  (new file)
export const LIVENESS_INTERVAL_MS = 10_000;

// router/src/app.ts
import { LIVENESS_INTERVAL_MS } from './config/constants.js';
const schedulerOpts = { intervalMs: LIVENESS_INTERVAL_MS, ... };

// router/src/routes/readyz.ts
import { LIVENESS_INTERVAL_MS } from '../../config/constants.js';
// replace hardcoded 10_000 reference:
const stale = age > STALE_FACTOR * LIVENESS_INTERVAL_MS;
```

### WR-04: `OLLAMA_URL` parsed from env but never consumed — dead configuration

**File:** `router/src/config/env.ts:11`
**Issue:** `EnvSchema` declares `OLLAMA_URL` (with default `http://ollama:11434/v1`). `compose.yml` sets it in the production `router:` environment block (`compose.yml:218`). However, `index.ts` never reads `env.OLLAMA_URL`; all backend URLs come exclusively from `models.yaml` per-model `backend_url` fields. The parsed value is silently discarded. An operator who changes `OLLAMA_URL` in `.env` expecting it to reroute the Ollama backend will see no effect, which can silently mask configuration mistakes.

**Fix:** Remove `OLLAMA_URL` from `EnvSchema` and from the `compose.yml` `router:` environment block, or add a comment explaining why it is retained:

```typescript
// Option A — remove entirely (recommended):
// Delete: OLLAMA_URL: z.string().url().default('http://ollama:11434/v1'),
// Delete from compose.yml: - OLLAMA_URL=http://ollama:11434/v1

// Option B — annotate intent if keeping for future tooling:
OLLAMA_URL: z.string().url().default('http://ollama:11434/v1'),
// NOTE: Not consumed by the router. Backend URLs are authoritative from
// models.yaml backend_url fields. Reserved for Phase 8 admin tooling.
```

### WR-05 (NEW): `skip()` called at line 536 before it is defined at line 662

**File:** `bin/smoke-test-router.sh:536`
**Issue:** When `SKIP_LLAMACPP=1` is set, the script executes `skip "Phase 3.B..."` at line 536 (inside the `if [[ -f "${GGUF_PATH}" ]]; then` block at line 429). The `skip()` function is not defined until line 662, and `SKIPS=0` is not initialized until line 661. The script runs with `set -uo pipefail` but without `set -e`, so the call to the undefined `skip` command fails silently with exit code 127 and the script continues. The `SKIPS` counter is never incremented. The final summary prints `Skipped: 0` even when the operator set `SKIP_LLAMACPP=1`, giving a false signal that all Phase 3 sections ran without skips.

**Fix:** Move the `SKIPS=0` initialization and `skip()` function definition to immediately after the `fail()` and `pass()` definitions (around line 106), before any phase sections:

```bash
# Place these immediately after the existing fail() / pass() definitions (~line 106):
SKIPS=0
skip() { echo "[smoke-test-router] SKIP: $*"; SKIPS=$((SKIPS + 1)); }
```

Then remove the duplicate definitions at lines 661-662.

---

## Info

### IN-01: Hot-reload does not rebuild semaphore map for new backends

**File:** `router/src/index.ts:74-87`
**Issue:** The `semaphoreMap` is built once at `buildApp()` time from the initial registry snapshot. The `onReload` callback in `index.ts` calls only `app.liveness.start(urls)` — it does not update `semaphoreMap`. If `models.yaml` is hot-reloaded with a new backend name (e.g., adding a `vllm` entry when Phase 7 widens the enum), `opts.semaphores.get('vllm')` at `chat-completions.ts:197` will throw `Error("No semaphore for backend \"vllm\"")`, producing a 500 response for every request to that backend until the router restarts. Within Phase 3's scope (ollama + llamacpp both present at boot) this is unreachable because the zod schema restricts `backend` to `['ollama', 'llamacpp']`.

**Suggestion:** Before Phase 7, add semaphore initialization to the `onReload` callback, or document in a comment at the `onReload` site that adding a new backend type requires a router restart.

### IN-02: Smoke-test script header and banner still say "Phase 2 Router Verification"

**File:** `bin/smoke-test-router.sh:2`, `:58`, `:111`
**Issue:** The script file-level comment (`# bin/smoke-test-router.sh — end-to-end router verification for local-llms Phase 2`), the `usage()` text (`End-to-end Phase 2 verification`), and the runtime banner (`local-llms — Phase 2 Router Verification`) all say "Phase 2" despite the script now covering Phases 2, 3, 4, and 5. The final summary at line 1200 (`Phase 2/3/4/5 router verification: COMPLETE.`) is already correct but the header is not.

**Fix:** Update lines 2, 58, and 111:

```bash
# Line 2:
# bin/smoke-test-router.sh — end-to-end router verification for local-llms Phases 2–5

# Line 58 (inside usage()):
  End-to-end Phase 2–5 verification — asserts SC1..SC5 (Phase 2), multi-backend
  dispatch (Phase 3), Anthropic surface + vision (Phase 4), Postgres + Observability (Phase 5).

# Line 111 (runtime banner):
echo "[smoke-test-router]  local-llms — Phase 2-5 Router Verification"
```

### IN-03: Production `router:` service omits `MODELS_YAML_PATH` — relies on schema default

**File:** `compose.yml:217-228`
**Issue:** The production `router:` environment block does not set `MODELS_YAML_PATH`. It relies on the env schema default (`'/app/models.yaml'` at `env.ts:15`), which happens to match the bind-mount destination (`./router/models.yaml:/app/models.yaml:ro` at `compose.yml:239`). The `router-dev:` service correctly sets `MODELS_YAML_PATH=/app/models.yaml` explicitly (`compose.yml:280`). If the bind-mount destination is changed in a future phase without also updating the env schema default, the production router will fail to find `models.yaml` at runtime with no startup validation error.

**Fix:**

```yaml
# compose.yml router service environment:
environment:
  - ROUTER_BEARER_TOKEN=${ROUTER_BEARER_TOKEN}
  - MODELS_YAML_PATH=/app/models.yaml   # matches volume mount; explicit > implicit default
  - PORT=3000
```

### IN-04 (NEW): `backends.base_url` accepted by schema but silently ignored at runtime

**File:** `router/models.yaml:3,7`, `router/src/config/registry.ts:37`
**Issue:** The `BackendsSection` schema accepts `base_url: z.string().url().optional()`. `models.yaml` defines `ollama.base_url: http://ollama:11434/v1` and `llamacpp.base_url: http://llamacpp:8080/v1`. No code in `registry.ts`, `app.ts`, or `factory.ts` reads `reg.backends?.[name].base_url` — the effective URL per model is each `ModelEntry.backend_url` field. An operator who edits `backends.ollama.base_url` expecting it to reroute traffic will see no effect. The field has no schema comment explaining its accepted-but-ignored status, unlike `concurrency` on `ModelEntrySchema` which has an explicit `D-B6` note.

**Fix:** Either remove `base_url` from `BackendsSection` and `models.yaml`, or add a schema comment:

```typescript
const BackendsSection = z.record(
  z.string(),
  z.object({
    // base_url: accepted for documentation/readability only. NOT used at runtime.
    // Effective backend URL per model is each ModelEntry.backend_url (Phase 3 D-B1).
    base_url: z.string().url().optional(),
    concurrency: z.number().int().positive().default(2),
    queue_max_wait_ms: z.number().int().positive().default(30_000),
  }),
);
```

---

_Reviewed: 2026-05-15T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
