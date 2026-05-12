# Phase 2: MVP Vertical Slice — Router + Ollama + SSE — Pattern Map

**Mapped:** 2026-05-12
**Files analyzed:** 31 (4 modified infra + 1 modified README + 12 new TS sources + 11 new test files + 7 new build/config + 1 new bash script + 1 new YAML registry)
**Analogs found:** 7 in-repo on-disk + 24 spec-only (RESEARCH.md / CLAUDE.md) — no pre-existing TypeScript code in repo
**Reading scope:** `02-CONTEXT.md`, `02-RESEARCH.md` (targeted reads of §Architectural Responsibility Map, §Standard Stack, §Recommended Project Structure, §Pattern 1–4, §Anti-Patterns, §Don't Hand-Roll, §Code Examples, §State of the Art, §Assumptions Log), `02-VALIDATION.md`, `compose.yml`, `bin/smoke-test-gpu.sh`, `bin/preflight-gpu.sh` (head), `.env.example`, `README.md` (verify section).

---

## Analog Source Legend

Each new file is mapped to one of three analog sources:

| Code | Meaning |
|------|---------|
| **DISK** | An existing on-disk file in this repo serves as a directly-mirrored analog. Planner copies bash style, compose style, env style, README style. |
| **SPEC** | No on-disk analog exists (router is greenfield TypeScript). The "analog" is a documented code excerpt in `02-RESEARCH.md` Pattern 1–4 / §Code Examples or `CLAUDE.md` "Multi-stage Dockerfile pattern — router". Planner copies the documented excerpt verbatim into the planned implementation. |
| **HYBRID** | A DISK analog exists for *style* (bash conventions, file headers, exit-code discipline) but the *body* is novel. Planner mirrors the DISK style and writes the novel body. |

---

## File Classification

| New / Modified File | Role | Data Flow | Analog Source | Closest Analog | Match Quality |
|---------------------|------|-----------|---------------|----------------|---------------|
| `router/src/index.ts` | bootstrap | request-response | SPEC | RESEARCH §Pattern 1 (Fastify v5 + zod + SSE) | spec-exact |
| `router/src/app.ts` | bootstrap (factory) | request-response | SPEC | RESEARCH §Pattern 1 — `buildApp()` block | spec-exact |
| `router/src/config/env.ts` | config | startup-load | SPEC | RESEARCH §Standard Stack (zod schema pattern) | spec-partial |
| `router/src/config/registry.ts` | config | file-watch + atomic-swap | SPEC | RESEARCH §Code Examples — `models.yaml` schema; §Don't Hand-Roll "File watch debounce + atomic swap" row; §Pitfall 6, 7 | spec-exact |
| `router/src/auth/bearer.ts` | middleware (preHandler) | request-response | SPEC | RESEARCH §Code Examples — "Bearer auth — constant-time compare with length-padding" | spec-exact |
| `router/src/backends/adapter.ts` | interface | n/a (type only) | SPEC | RESEARCH §Pattern 2 — `BackendAdapter` interface (D-B2) | spec-exact |
| `router/src/backends/ollama-openai.ts` | adapter (service) | streaming + request-response | SPEC | RESEARCH §Pattern 2 — `OllamaOpenAIAdapter` impl block | spec-exact |
| `router/src/routes/healthz.ts` | route handler | request-response | SPEC | RESEARCH §Open Question 1 recommendation — synchronous `200 {status, registry_models}` | spec-partial |
| `router/src/routes/v1/chat-completions.ts` | route handler | streaming + request-response | SPEC | RESEARCH §Pattern 3 — full `streamHandler` block with abort + heartbeat | spec-exact |
| `router/src/sse/stream.ts` | utility | streaming (transform) | SPEC | RESEARCH §Pattern 3 (the `async function*` block); §Code Examples — "Mid-stream error frame (D-C2)" | spec-exact |
| `router/src/sse/heartbeat.ts` | utility | event-driven (interval) | SPEC | RESEARCH §Pattern 3 lines 485–488 + Pitfall 3 (cleanup contract) | spec-exact |
| `router/src/errors/envelope.ts` | utility | n/a (pure transform) | SPEC | RESEARCH §Don't Hand-Roll "HTTP error envelope" row + CONTEXT D-C1 / D-C2 | spec-exact |
| `router/src/log/logger.ts` | config | event-driven (logging) | SPEC | RESEARCH §Pattern 4 — pino `loggerOptions` block | spec-exact |
| `router/tests/msw/handlers.ts` | test fixture | streaming (mock upstream) | SPEC | RESEARCH §Pitfall 2 description + msw v2 `setupServer()` convention | spec-partial |
| `router/tests/setup.ts` | test config | n/a | SPEC | vitest convention (`beforeAll`/`afterAll`) | generic |
| `router/tests/unit/bearer.test.ts` | test (unit) | request-response | SPEC | RESEARCH §Pattern bearer + §Assumptions A2 (timing harness) | spec-partial |
| `router/tests/unit/registry.test.ts` | test (unit) | file-watch | SPEC | RESEARCH §Pitfall 6 (debounce) + §Code Examples (schema) | spec-partial |
| `router/tests/unit/envelope.test.ts` | test (unit) | n/a | SPEC | CONTEXT D-C1 / D-C2 (envelope shape) | spec-partial |
| `router/tests/unit/sse/heartbeat.test.ts` | test (unit) | event-driven | SPEC | RESEARCH §Pitfall 3 (cleanup contract) | spec-partial |
| `router/tests/unit/sse/stream.test.ts` | test (unit) | streaming | SPEC | RESEARCH §Pattern 3 generator + D-C2 wire bytes | spec-partial |
| `router/tests/unit/log/redact.test.ts` | test (unit) | event-driven | SPEC | RESEARCH §Pattern 4 + §Pitfall 5 + SC5 grep contract | spec-partial |
| `router/tests/integration/chat-completions.stream.test.ts` | test (integration) | streaming | SPEC | RESEARCH §Pattern 3 + §Pitfall 2 (msw + abort harness) | spec-partial |
| `router/tests/integration/chat-completions.nonstream.test.ts` | test (integration) | request-response | SPEC | RESEARCH §Pattern 2 non-stream branch | spec-partial |
| `router/tests/integration/auth.test.ts` | test (integration) | request-response | SPEC | RESEARCH §Code Examples bearer + ROUTE-04 skip-list | spec-partial |
| `router/tests/integration/hotreload.test.ts` | test (integration) | file-watch | SPEC | RESEARCH §Pitfall 7 (fs.watch on bind mount) | spec-partial |
| `router/package.json` | build config | n/a | SPEC | RESEARCH §Standard Stack — verbatim install block | spec-exact |
| `router/tsconfig.json` | build config | n/a | SPEC | VALIDATION §Wave 0 + RESEARCH §Standard Stack note (`verbatimModuleSyntax`) | spec-partial |
| `router/tsup.config.ts` | build config | n/a | SPEC | VALIDATION §Wave 0 (`format: 'esm'`, `target: 'node22'`) | spec-partial |
| `router/vitest.config.ts` | build config | n/a | SPEC | VALIDATION §Wave 0 (`include: ['tests/**/*.test.ts']`, `environment: 'node'`) | spec-partial |
| `router/biome.json` (or `eslint.config.js`) | build config | n/a | SPEC | CLAUDE.md §Development Tools (Biome endorsed); planner picks one | generic |
| `router/Dockerfile` | build config | n/a | SPEC | CLAUDE.md "Multi-stage Dockerfile pattern — router" (4 stages, D-A2) | spec-exact |
| `router/.dockerignore` | build config | n/a | SPEC | RESEARCH §Recommended Project Structure (`node_modules`, `dist`, `.env*`) | spec-partial |
| `router/models.yaml` | data (declarative) | startup-load | SPEC | RESEARCH §Code Examples — first concrete entry block | spec-exact |
| `compose.yml` | infra (modify) | n/a | DISK | `compose.yml` lines 87–162 (Ollama service block) | role-match |
| `bin/smoke-test-router.sh` | bash (new) | request-response + streaming | DISK | `bin/smoke-test-gpu.sh` (entire file) — SAME role and data flow | exact |
| `bin/smoke-test-gpu.sh` | bash (modify) | request-response | DISK | itself — replace `curl http://127.0.0.1:11434/...` with `docker compose exec -T ollama curl http://localhost:11434/...` per RESEARCH Assumption A5 | self-edit |
| `.env.example` | config (no-op) | n/a | DISK | `.env.example` line 18 (`ROUTER_BEARER_TOKEN=` already declared) | exact (no change) |
| `README.md` | docs (modify) | n/a | DISK | `README.md` lines 82–96 (the "Verify GPU is actually being used" section — same template) | exact |

---

## Pattern Assignments

### `compose.yml` — APPEND `router:` service + REMOVE Ollama host port (infra modify)

**Analog:** `compose.yml` lines 87–162 (existing `ollama:` service block). Same file is edited in-place.

**Style points to mirror exactly** (DISK analog):

- **Block header banner** — every service in the file opens with a 3-line header comment block in this exact form (verified from lines 52–57 and 87–88):
  ```yaml
    # ── Router (Phase 2 — D-A1, D-A4, ROUTE-01) ─────────────────────────────────
    router:
      build: ./router
  ```
- **Anchor + key references** — DO NOT use the `<<: *gpu` anchor on `router:` (the router has no GPU; CONTEXT D-A1 / RESEARCH §Architectural Responsibility Map row "Container build / runtime"). The anchor is for GPU services only.
- **`container_name`** — follow the `${COMPOSE_PROJECT_NAME:-local-llms}-router` pattern (lines 59, 90).
- **Pinned image policy** — for `build: ./router` no image tag is needed at build time, but the runtime stage of the Dockerfile MUST be `node:22-bookworm-slim` (CONTEXT D-A2; CLAUDE.md anti-pattern list rejects `:latest` and `node:22-alpine`).
- **Networks list** — uses the existing `app` + `backend` networks (CONTEXT §Integration Points; RESEARCH §System Architecture Diagram). Phase 1 lines 38–48 already declare them — never invent new networks (Phase 1 D-13 is locked).
- **`depends_on:` block** — mirror the `ollama: depends_on: { gpu-preflight: { condition: service_completed_successfully } }` style (lines 157–161). Router uses `ollama: { condition: service_healthy }`.
- **Healthcheck** — mirror the multi-line block style (lines 145–156). Use `node -e fetch(...)` per RESEARCH §Open Question 2 recommendation (avoid installing `curl` to keep the image small; the Phase 1 Ollama healthcheck already documented this exact rationale at lines 146–151).
- **Environment block** — `- KEY=${KEY}` form (lines 135–144), inline-comment-rich.

**Body to write** (specific to router; no DISK body to copy):
```yaml
  # ── Router (Phase 2 — D-A1, D-A4, ROUTE-01..ROUTE-08) ──────────────────────
  # The single externally-reachable model surface (localhost-only until Phase 6
  # puts Traefik in front). Joins app + backend; D-13 networks unchanged.
  router:
    build: ./router
    container_name: ${COMPOSE_PROJECT_NAME:-local-llms}-router
    restart: unless-stopped
    environment:
      - ROUTER_BEARER_TOKEN=${ROUTER_BEARER_TOKEN}
      - OLLAMA_URL=http://ollama:11434/v1
      - PORT=3000
      - LOG_LEVEL=info
      - NODE_ENV=production
    ports:
      # localhost-only — D-A4. Phase 6 (Traefik) removes this.
      - "127.0.0.1:3000:3000"
    networks:
      - app       # later: webui (Phase 6)
      - backend   # talks to ollama (and Phase 3+ runtimes)
    volumes:
      # Bind-mount the registry so fs.watch sees host edits — RESEARCH Pitfall 7.
      # Named volumes are unreliable for fs.watch across drivers.
      - ./router/models.yaml:/app/models.yaml:ro
    healthcheck:
      # node:22-bookworm-slim does NOT ship curl; use node -e fetch instead
      # (RESEARCH §Open Question 2). Same rationale as Phase 1's `ollama list`
      # healthcheck (compose.yml lines 146–151).
      test: ["CMD-SHELL", "node -e \"fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval: 10s
      timeout: 3s
      start_period: 15s
      retries: 5
    depends_on:
      ollama:
        condition: service_healthy
```

**Removal** (DISK self-edit) — DELETE lines 113–114:
```yaml
    ports:
      - "127.0.0.1:11434:11434"
```
The pre-announcing comment on lines 108–112 is the load-bearing context for *why* this can be removed — leave a one-line tombstone comment in its place pointing at Phase 2 D-A4 so the audit trail survives.

---

### `bin/smoke-test-router.sh` (NEW bash script) — DISK analog: `bin/smoke-test-gpu.sh`

**Analog:** `bin/smoke-test-gpu.sh` (entire 401-line file). Same role (operator-facing smoke test that asserts a single phase's success criteria), same data flow (HTTP requests + post-flight assertions). This is a near-verbatim style copy with new assertion bodies.

**Header pattern** (lines 1–30 of `bin/smoke-test-gpu.sh`):
```bash
#!/usr/bin/env bash
# bin/smoke-test-router.sh — end-to-end router verification for local-llms Phase 2
#
# What this script asserts (ROADMAP success criteria SC1–SC5):
#   SC1. POST /v1/chat/completions stream=true returns OpenAI-shape SSE chunks
#        terminated by data:[DONE], with usage in the final non-empty chunk.
#   SC2. POST /v1/chat/completions stream=false returns a ChatCompletion with usage.
#   SC3. Killing the curl mid-stream causes Ollama's /api/ps to drop the model
#        (or size_vram→0) within ~2 s — abort propagation works end-to-end.
#   SC4. /healthz returns 200 with no Authorization header; missing/wrong bearer
#        on /v1/* returns 401; models.yaml hot-reload picks up an added comment
#        within 500 ms (no router restart).
#   SC5. `docker compose logs router` contains zero matches for the bearer token
#        value or `authorization:[ ]*bearer` patterns.
#
# Usage:  bash bin/smoke-test-router.sh [options]
# Flags:  see usage() below.
#
# Exit codes:
#   0  All assertions pass — router vertical slice proven end-to-end.
#   1  One or more assertions failed — diagnostic printed; see /v1/chat/completions
#      logs (`docker compose logs router`) for upstream-side details.
#
# Design notes:
#   - Mirrors bin/smoke-test-gpu.sh (Phase 1) — same FAILURES counter,
#     `set -uo pipefail`, sectioned output, exit 0/1 discipline.
#   - Reads ROUTER_BEARER_TOKEN from .env (same pattern as preflight-gpu.sh
#     lines 107–125 — caller env wins, then .env, then hard fail).
#   - Uses `docker compose exec -T ollama curl ...` (NOT host port) for any
#     direct-Ollama probe — Phase 2 removes the host port (D-A4 + RESEARCH A5).
```

**Failure counter pattern** (lines 92–102 of `bin/smoke-test-gpu.sh`) — copy verbatim:
```bash
set -uo pipefail

FAILURES=0

fail() {
  echo "[smoke-test] FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "[smoke-test] PASS: $*"
}
```

**Section banner pattern** (lines 107–113 + 240–242 + 380–401):
```bash
echo ""
echo "[smoke-test] ================================================================"
echo "[smoke-test]  local-llms — Phase 2 Router Verification"
echo "[smoke-test]  Router URL : ${ROUTER_URL}"
echo "[smoke-test]  Model      : ${MODEL}"
echo "[smoke-test] ================================================================"
echo ""
```

**Final summary pattern** (lines 380–401) — copy verbatim shape, change body fields.

**SC3 assertion strategy** — adapt the existing Step 4 `/api/ps` JSON-parser block (lines 282–346 of `bin/smoke-test-gpu.sh`) by:
1. Starting the curl in background (`curl -N ... &; CURL_PID=$!`).
2. Sleeping ~2 s to ensure model is loaded + streaming.
3. `kill $CURL_PID`.
4. Polling `docker compose exec -T ollama curl -fsS http://localhost:11434/api/ps` (NOT host port — Phase 2 removes it) until either: `size_vram == 0` (model unloaded), the model disappears from the list, or 3 s elapsed. The 3 s ceiling is the SC3 contract ("returns to idle ~1 s" — give it 3× margin).
5. The Python JSON parser in lines 296–313 is reusable; re-paste the env-var-passing pattern (lines 217–226) verbatim — it solved CR-02 injection.

**SC5 assertion** (the new SC5 — there is no analog in `smoke-test-gpu.sh`):
```bash
# SC5: zero matches for bearer/authorization in router logs.
LEAK_COUNT=$(docker compose logs router 2>&1 | grep -ciE 'bearer [a-z0-9_]+|authorization:[[:space:]]*bearer' || true)
if [[ "$LEAK_COUNT" -ne 0 ]]; then
  fail "SC5: found ${LEAK_COUNT} potential bearer-token log leak lines (expected 0)"
else
  pass "SC5: zero bearer/authorization matches in router logs"
fi
```

**Anti-pattern flags** (from PROJECT context):
- DO NOT use `set -e` — the `set -uo pipefail` + FAILURES counter is the project convention (see lines 28, 31, 91–92 of `bin/smoke-test-gpu.sh`). `set -e` aborts on first failure and loses diagnostic coverage.
- DO NOT shell-interpolate JSON request bodies; use the env-var-to-python pattern (lines 193–201, 217–226 of `bin/smoke-test-gpu.sh`) for ANY curl that posts JSON — this addresses CR-02 (resolved in Phase 1 retro).

---

### `bin/smoke-test-gpu.sh` (MODIFY in-place) — RESEARCH Assumption A5

**Analog:** itself. The script currently hits `http://127.0.0.1:11434` directly via the host port (lines 38, 130, 132, 287). When Phase 2 removes that host port (compose.yml lines 113–114 deletion above), this script breaks unless updated in the same wave. RESEARCH §Assumptions Log A5 explicitly flags this as **MEDIUM-HIGH** risk.

**Required edits** (RESEARCH A5 option (a)):

| Line(s) | Current | Replace with |
|---------|---------|--------------|
| 38 | `readonly OLLAMA_URL="http://127.0.0.1:11434"` | (keep variable name; change to in-container URL OR add a `OLLAMA_EXEC` helper) |
| 130–146 | Pre-flight uses `curl -fsS "${OLLAMA_URL}/api/tags"` from host | Replace with `docker compose exec -T ollama curl -fsS http://localhost:11434/api/tags` |
| 203–206 | Step 1 `curl -fsS ... "${OLLAMA_URL}/api/generate"` | Same — exec-pipe via Ollama container |
| 287 | Step 4 `curl -s --max-time 5 "${OLLAMA_URL}/api/ps"` | Same — exec-pipe via Ollama container |

**Cleanest implementation pattern** (planner discretion):
```bash
# Helper that abstracts the host-port-vs-exec choice. Phase 2 forces exec
# (the port is gone); Phase 6 may choose differently.
ollama_curl() {
  docker compose exec -T "${OLLAMA_SVC}" curl -fsS "$@"
}
# Then: TAGS_RESPONSE=$(ollama_curl "http://localhost:11434/api/tags" 2>/dev/null || true)
```
This isolates the ONE behavioral change to a single helper, keeps all assertion logic byte-identical, and makes the diff reviewable.

**Why this is in this wave, not deferred:** RESEARCH Assumption A5 is explicit — removing the host port WITHOUT updating this script makes Phase 1 regression-test red. Both edits MUST land together.

---

### `.env.example` — NO CHANGE (verification only)

**Analog:** `.env.example` line 18 (`ROUTER_BEARER_TOKEN=`). Already in place from Phase 1 D-14 (RESEARCH §Runtime State Inventory row "Secrets / env vars" verified this).

**Action:** Confirm during planning that `.env.example` is unchanged and that the comment block at lines 14–18 still accurately describes Phase 2's consumption. If a doc tweak is desired (e.g. cross-reference the smoke test), keep it to comment lines only — do not add or rename keys (Phase 1 D-14 locks the schema; future phases append, never rename).

---

### `README.md` — APPEND "Verify the router works" section

**Analog:** `README.md` lines 82–96 (the existing "Verify GPU is actually being used" step 5). Same role (operator verification step), same data flow (run a bash script, interpret pass/fail), same audience (someone bringing the stack up the first time).

**Style points to mirror** (DISK):

- **Numbered step continuation** — Phase 1 is steps 1–5; Phase 2 appends step 6 in the same `## First boot` section.
- **Triple-backtick command block** with the literal `bash bin/smoke-test-router.sh`.
- **"What the script does" bulleted explanation** — verbatim shape from line 88 onward.
- **"Exits 0 on full pass" trailing paragraph** — verbatim shape from line 94 onward.
- **Blockquote diagnostic note** (`> **If ...**`) — verbatim shape from line 96; Phase 2 candidate is "If SC3 fails, check that you removed the Ollama host port and updated `bin/smoke-test-gpu.sh` per Phase 2 D-A4".

**Body to write** — point at SC1–SC5; one paragraph per criterion is too long. Compress to a single sentence per SC plus a "What this proves" bullet block, mirroring the Phase 1 brevity.

**Anti-pattern flag:** do NOT add a brand-new `## Phase 2: Verify the router` h2-level section. The Phase 1 `## First boot` is the canonical onboarding flow; appending step 6 keeps the narrative single-track. The `## What Phase 1 establishes` h2 (line 98) is precedent — Phase 2 may add an analogous `## What Phase 2 establishes` block AFTER step 6 if the planner wants to document the new locked-in decisions (D-A1..D-D4) for future phases to inherit.

---

### `router/Dockerfile` (NEW) — SPEC analog: CLAUDE.md "Multi-stage Dockerfile pattern — router"

**Analog:** CLAUDE.md §"Multi-stage Dockerfile pattern — router" — declared in CONTEXT.md D-A2 to be followed exactly. There is no on-disk Dockerfile to copy from; this is the authoritative spec.

**4-stage shape** (D-A2 + CLAUDE.md):
1. **`deps`** — `npm ci` only, cached separately. Mount `package.json` + `package-lock.json` only.
2. **`build`** — copies `src/`, runs `tsup src/index.ts --format esm --target node22 --out-dir dist`.
3. **`prod-deps`** — `npm ci --omit=dev` to a clean `node_modules/`.
4. **`runtime`** — base `node:22-bookworm-slim` (NEVER `node:22-alpine` — STATE.md anti-pattern; CLAUDE.md "What NOT to Use" row 1). Copies `dist/` from stage 2 + prod `node_modules/` from stage 3. `ENTRYPOINT ["node", "dist/index.js"]`.

**Required header line** (Docker BuildKit syntax; from CLAUDE.md):
```dockerfile
# syntax=docker/dockerfile:1.7
```

**Critical pin** (CLAUDE.md "What NOT to Use"):
- Final stage: `FROM node:22-bookworm-slim` — pinning to a digest (`@sha256:...`) is at planner discretion but recommended.
- NEVER `:latest`, NEVER `:alpine`.

**.dockerignore body** (RESEARCH §Recommended Project Structure):
```
node_modules
dist
.env*
tests
*.md
```

---

### `router/package.json` (NEW) — SPEC analog: RESEARCH §Standard Stack install block

**Analog:** RESEARCH §Standard Stack lines 169–194 (the `npm install` block + the `pino` no-pin note). Lift verbatim.

**Critical version pins** (CONTEXT §canonical_refs lines 149–157 + RESEARCH §Standard Stack table):
- `fastify@^5.8.5`
- `fastify-sse-v2@^4.2.2` (newer than CONTEXT floor `^4.2.1` — accept either; semver-compatible)
- `@bram-dc/fastify-type-provider-zod@^7.0.1` (the Fastify-5 fork — NOT `turkerdev/fastify-type-provider-zod` which targets v4)
- `zod@^4.4.3` (v4 import path is `from 'zod/v4'`)
- `openai@^6.37.0` (newer than CONTEXT floor `^6.30.0`)
- `js-yaml@^4.1.1`

**Do NOT pin `pino` directly** — RESEARCH §Standard Stack note line 196: "`pino` is a transitive dep of Fastify v5. Fastify chooses the matching pino major version."

**`scripts` block** — planner discretion. Suggested minimum:
```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:unit": "vitest run tests/unit"
  }
}
```

**`type: \"module\"`** — required (`tsup` builds ESM with `--format esm`; the runtime needs ESM resolution).

---

### `router/src/index.ts` + `router/src/app.ts` (NEW) — SPEC analog: RESEARCH §Pattern 1

**Analog:** RESEARCH §Pattern 1 (lines 343–377). Lift the `buildApp()` function verbatim into `app.ts`. `index.ts` becomes a thin bootstrap that calls `buildApp()` and `app.listen({ port, host: '0.0.0.0' })`.

**Critical excerpt** (RESEARCH lines 357–376):
```typescript
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,        // pass OPTIONS, not an instance — Fastify v5 contract
    bodyLimit: 8 * 1024 * 1024,   // 8 MB; Phase 4 vision blows past 1 MB easily
    trustProxy: false,            // Phase 6 (Traefik) flips this to true
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(FastifySSEPlugin);

  const typed = app.withTypeProvider<ZodTypeProvider>();
  // ... register routes on `typed`
  return app;
}
```

**Critical anti-patterns** (CONTEXT D-A2 + RESEARCH §State of the Art):
- Do NOT pass a pre-instantiated `pino()` instance — Fastify v5 contract changed. Pass options.
- Do NOT register `@fastify/compress` (PITFALL 4 — gzip buffers SSE).
- Do NOT set `Content-Type` headers on streaming routes — `fastify-sse-v2` does this.

---

### `router/src/auth/bearer.ts` (NEW) — SPEC analog: RESEARCH §Code Examples bearer block

**Analog:** RESEARCH §Code Examples lines 728–784 (the `makeBearerHook` function with `crypto.timingSafeEqual` + length-padding). Lift verbatim.

**Skip-list contract** (line 734):
```typescript
const PUBLIC_PATHS = new Set(['/healthz']);
```
Phase 3 will add `/readyz` to this set. ROUTE-04 is the single source of truth for the skip list.

**Critical points**:
- NEVER `===` compare bearer tokens (CONTEXT D-C3 implicit; RESEARCH §Don't Hand-Roll row "Constant-time bearer compare"; STATE.md anti-pattern list).
- NEVER log the supplied token (line 752: `req.log.warn({ url: req.url, hasHeader: ... }` — note: `hasHeader` is a boolean, not the header value).
- Length-padding pattern (lines 763–774) is non-obvious and load-bearing for SC5; the test in `tests/unit/bearer.test.ts` MUST exercise both equal-length and mismatched-length branches.

**Error envelope** — uses the OpenAI shape from D-C1 (RESEARCH lines 753–756, 778–780):
```typescript
{ error: { message: '...', type: 'authentication_error', code: 'unauthorized', param: null } }
```

---

### `router/src/config/registry.ts` (NEW) — SPEC analog: RESEARCH §Code Examples + Pitfall 6, 7

**Analog:** RESEARCH §Code Examples lines 805–828 (the `ModelEntrySchema` + `RegistrySchema` zod definitions). Lift the schema verbatim. The watcher + atomic-swap is described in RESEARCH §Don't Hand-Roll row "File watch debounce + atomic swap":
> `node:fs.watch(path, listener)` + a 10-line debounce (250 ms — RESEARCH Pitfall 6) + `let registry: Registry` reassignment (single-threaded JS = atomic).

**Critical schema points** (D-B4 forward-compat — RESEARCH lines 813–822):
- Phase 2 reads `name`, `backend`, `backend_url`, `backend_model`.
- Phase 2 ACCEPTS but ignores `capabilities`, `vram_budget_gb`, `concurrency`, `max_model_len`, `profile` (these are `.optional()` on the schema). Future phases tighten validation; never rewrite YAML between phases.

**Watcher pitfalls** (RESEARCH Pitfall 6, 7):
- 250 ms debounce is required — editors write twice (truncate-then-write).
- Do NOT swap in an invalid registry — keep the previous one in memory (CONTEXT D-C3 row "models.yaml hot-reload validation fail").
- `fs.watch` may be flaky on WSL2 bind mounts (RESEARCH Assumption A4 + Pitfall 7) — escape hatch is `fs.watchFile` polling; the `tests/integration/hotreload.test.ts` is the canary.

---

### `router/src/backends/{adapter,ollama-openai}.ts` (NEW) — SPEC analog: RESEARCH §Pattern 2

**Analog:** RESEARCH §Pattern 2 lines 387–446. Lift `BackendAdapter` interface and `OllamaOpenAIAdapter` class verbatim.

**Critical points** (CONTEXT D-B1, D-B3):
- `apiKey: 'ollama'` (NOT empty string — SDK v6 throws at construction time on `''`).
- `stream_options: { include_usage: true }` on every streaming call — satisfies OAI-05 / SC1.
- `signal` propagation: `this.client.chat.completions.create({...}, { signal })` — undici closes the upstream socket. RESEARCH §Don't Hand-Roll row "AbortController → upstream socket close".

**Phase 3 hand-off** — the `BackendAdapter` interface is the seam Phase 3 widens (drop in `LlamacppOpenAIAdapter` with no router code change, per Phase 3 SC1). The Phase 2 implementation MUST keep all Ollama-specific behavior INSIDE `OllamaOpenAIAdapter`; the route handler in `chat-completions.ts` only sees `BackendAdapter`.

---

### `router/src/routes/v1/chat-completions.ts` (NEW) — SPEC analog: RESEARCH §Pattern 3

**Analog:** RESEARCH §Pattern 3 lines 463–523 (the full `streamHandler` with abort + heartbeat + close-handler). This is the load-bearing code for SC3; copy verbatim.

**Critical wiring** (RESEARCH lines 466–488):
1. `AbortController` created at the top.
2. `req.raw.once('close', onClose)` — `'close'`, NOT `'aborted'` (RESEARCH §Anti-Patterns "req.raw.on('aborted')" row).
3. `onClose` calls BOTH `controller.abort(...)` AND `heartbeat.stop()`.
4. `controller.signal` is passed to `adapter.chatCompletionsStream(params, signal)` — THE single most important line for SC3 (RESEARCH Pitfall 2).
5. Heartbeat starts AFTER first byte; cleared in `onClose` AND in the iterator's `finally` (belt-and-suspenders — RESEARCH §Anti-Patterns "Forgetting to clear setInterval" row).
6. `controller.signal.aborted` guard inside the catch (lines 503–506) — APIUserAbortError from a client disconnect should NOT emit an error frame.
7. Synthesize `data: [DONE]` regardless of upstream (line 498) — wire-format consistency with Phase 3 (vLLM/llama.cpp may not emit it).

**Non-stream branch** — uses `adapter.chatCompletions(params, signal)` and `reply.send(result)`. No SSE plugin involved. Same `AbortController` + `req.raw.once('close', ...)` pattern still applies (timeout / disconnect cleanup).

---

### `router/src/sse/{stream,heartbeat}.ts` (NEW) — SPEC analog: RESEARCH §Pattern 3 + §Code Examples mid-stream frame

**`heartbeat.ts`** — the `startHeartbeat(reply.raw, 15_000)` helper referenced by Pattern 3 line 488. Returns an object with:
- `.stop()` — clears the interval (cleanup contract).
- `.bytesSinceStart` — counter (used by mid-stream error log line 514).
- `.msSinceStart` — time-since-start (used by mid-stream error log line 514).

The interval body writes `: keep-alive\n\n` (a comment line; SSE spec — pings without payload). Source: RESEARCH Pattern 3 inline comment lines 486–487.

**`stream.ts`** — the async generator that wraps an upstream `AsyncIterable<ChatCompletionChunk>` into the `{ data: ... }` events `reply.sse(...)` consumes. Pure transform; unit-testable without Fastify.

**Mid-stream error frame** (D-C2 — RESEARCH §Code Examples lines 833–839 — exact wire bytes):
```
event: error
data: {"error":{"message":"upstream connection reset","type":"upstream_error","code":"econnreset"}}

data: [DONE]

```
The `tests/unit/sse/stream.test.ts` MUST snapshot-test this byte-exact (RESEARCH §Code Examples line 841 explicitly notes "Two trailing newlines after each `data:` line, blank line between events").

---

### `router/src/errors/envelope.ts` (NEW) — SPEC analog: RESEARCH §Don't Hand-Roll + CONTEXT D-C1, D-C2

**Analog:** RESEARCH §Don't Hand-Roll row "HTTP error envelope" + CONTEXT D-C1 / D-C2 / D-C3 (the locked HTTP status + log map).

**`toOpenAIErrorEnvelope(err)` switch table** (RESEARCH §Don't Hand-Roll row):
| `err.constructor.name` | type | code | HTTP |
|------------------------|------|------|------|
| `ZodError` | `invalid_request_error` | `invalid_request` | 400 |
| `RegistryUnknownModelError` (custom) | `not_found_error` | `model_not_found` | 404 |
| `APIConnectionError` (openai SDK) | `upstream_error` | `econnrefused` | 502 |
| `APIError` (openai SDK, 5xx) | `upstream_error` | `upstream_5xx` | 502 |
| `APITimeoutError` | `timeout_error` | `upstream_timeout` | 504 |
| `APIUserAbortError` | n/a — DO NOT emit envelope (client gone) | — | — |
| `BearerAuthError` (custom) | `authentication_error` | `unauthorized` | 401 |
| default | `internal_error` | `internal_error` | 500 |

**Two emit paths** (D-C1, D-C2):
1. **Pre-stream** (HTTP not yet sent) — `reply.code(status).send(envelope)` — JSON body, OpenAI shape.
2. **Mid-stream** (HTTP already 200, SSE in flight) — yield `{ event: 'error', data: JSON.stringify(envelope) }`, then `{ data: '[DONE]' }`. RESEARCH lines 833–839.

The unit test `tests/unit/envelope.test.ts` MUST cover both paths and every row of the table above.

---

### `router/src/log/logger.ts` (NEW) — SPEC analog: RESEARCH §Pattern 4

**Analog:** RESEARCH §Pattern 4 lines 538–565. Lift `loggerOptions` verbatim.

**Critical points** (RESEARCH §Pattern 4 + Pitfall 5 + ROUTE-05):
- Use OBJECT form `redact: { paths, censor }` — NOT array form (lines 541–560).
- `censor: '[REDACTED]'` — NEVER `remove: true` (line 556 explains the SC5 grep contract: prove redaction is *active*, not absent).
- `redact.paths` MUST include all five forms (lines 543–553):
  - `req.headers.authorization`
  - `req.headers.cookie`
  - `req.headers["proxy-authorization"]`
  - `*.apiKey` + `*.api_key` (defensive — Phase 2 doesn't accept body apiKey, but redact-by-default beats redact-by-remembering)
  - `headers.authorization` + `headers.cookie` (top-level forms when an err object is logged with a root `headers` field)
- `pino-pretty` transport ONLY when `NODE_ENV !== 'production'` (lines 562–565). NEVER bundle `pino-pretty` into the prod image (CLAUDE.md §Development Tools row).

The `tests/unit/log/redact.test.ts` MUST log a synthetic record containing a fake bearer header and assert the output string contains `[REDACTED]` and does NOT contain the bearer value.

---

### `router/models.yaml` (NEW) — SPEC analog: RESEARCH §Code Examples first concrete entry

**Analog:** RESEARCH §Code Examples lines 788–803. Lift verbatim — the `llama3.2:3b-instruct-q4_K_M` entry already aligned with Phase 1's pulled model.

**Forward-compat fields** (D-B4) — present, accepted by zod, ignored at runtime in Phase 2. Phase 3 starts consuming `capabilities`, `vram_budget_gb`, `concurrency`, `max_model_len`, `profile` — no YAML rewrite required between phases.

---

### `router/src/routes/healthz.ts` (NEW) — SPEC analog: RESEARCH §Open Question 1

**Analog:** RESEARCH §Open Questions Q1 recommendation (line 876):
> `/healthz` returns `200 {"status":"ok", "service":"router", "phase":2, "registry_models":N}` synchronously, no upstream calls.

**Critical points**:
- NO upstream Ollama probe (Phase 3's `/readyz` adds that — keeps `/healthz` from being a DoS pivot).
- NO bearer auth (ROUTE-04; in `PUBLIC_PATHS` skip-list of `bearer.ts`).
- Returns `registry_models: N` so the Compose healthcheck has a non-trivial liveness signal (process up + registry parsed).

---

### `router/tests/**` (NEW — 11 test files) — SPEC analog: VALIDATION §Wave 0 + RESEARCH coverage

**General testing pattern** (no DISK analog; this is the first test code in the repo):
- **Framework:** `vitest@^2.14.6`. Config: `tests/**/*.test.ts`, `environment: 'node'`.
- **Mock library:** `msw@^2.14.6` for upstream Ollama HTTP. `tests/setup.ts` runs `setupServer()` in `beforeAll` and stops in `afterAll`.
- **No Docker in tests** — integration tests run the Fastify app in-process with `app.inject(...)` or `app.listen({ port: 0 })` + native fetch. RESEARCH §Validation Architecture line 28: full vitest <30s, no Docker.

**Per-file coverage map** (lifted from VALIDATION §Per-Task Verification Map):

| Test file | Requirements covered | Critical assertion(s) |
|-----------|----------------------|------------------------|
| `unit/bearer.test.ts` | ROUTE-03, SC4 | constant-time pass; mismatched-length false; pad branch never returns true; missing/wrong header → 401 |
| `unit/registry.test.ts` | ROUTE-02, SC4 | zod accepts forward-compat fields; rejects missing required; debounce coalesces double-write; invalid YAML keeps prev registry |
| `unit/envelope.test.ts` | D-C1, D-C2 | every err.constructor.name → expected status/type/code; mid-stream frame byte-exact |
| `unit/sse/heartbeat.test.ts` | ROUTE-08 | interval fires every 15s; `.stop()` clears interval; clears on iterator finally too |
| `unit/sse/stream.test.ts` | ROUTE-08, OAI-04 | wraps async iterable into `{data:...}` events; synthesizes `[DONE]`; emits D-C2 frame on error |
| `unit/log/redact.test.ts` | ROUTE-05, SC5 | record with fake bearer → output contains `[REDACTED]` and NOT the bearer value |
| `integration/chat-completions.stream.test.ts` | SC1, SC3 (mocked), OAI-04, OAI-05 | wire-format snapshot; usage in final chunk; abort-mid-stream → upstream signal aborted within 50ms |
| `integration/chat-completions.nonstream.test.ts` | SC2, OAI-05 | usage in body; ChatCompletion shape |
| `integration/auth.test.ts` | SC4, ROUTE-03, ROUTE-04 | `/healthz` 200 with no auth; `/v1/*` 401 missing/wrong; 200 with correct |
| `integration/hotreload.test.ts` | SC4, ROUTE-02 | write models.yaml; await debounce; new model resolves; canary for RESEARCH A4 (fs.watch on WSL2) |
| `tests/msw/handlers.ts` | (fixture) | OpenAI-shape SSE chunks identical to live Ollama 0.5.7 — RESEARCH verified the chunk shape against the real backend |

---

## Shared Patterns

### Cross-Cutting Pattern A: Bearer auth preHandler

**Source:** `router/src/auth/bearer.ts` (RESEARCH §Code Examples bearer block)
**Apply to:** ALL routes EXCEPT those in `PUBLIC_PATHS` (Phase 2: only `/healthz`)

The preHandler is registered globally on the Fastify instance (RESEARCH §Architectural Responsibility Map row "Bearer auth check"). The skip-list pattern means new routes auto-inherit auth unless explicitly added to `PUBLIC_PATHS`. ROUTE-04 is the single source of truth for which paths skip.

```typescript
app.addHook('preHandler', makeBearerHook(env.ROUTER_BEARER_TOKEN));
```

### Cross-Cutting Pattern B: Error envelope

**Source:** `router/src/errors/envelope.ts` + CONTEXT D-C1, D-C2, D-C3
**Apply to:** ALL routes (every error path + every catch block in route handlers)

Two emit paths only — pre-stream (`reply.code(N).send(envelope)`) and mid-stream (yield `{ event: 'error', data }` then `{ data: '[DONE]' }`). NO custom JSON shapes per route — the single `toOpenAIErrorEnvelope(err)` helper is the only source.

Phase 4 will add an Anthropic-shape envelope (`{ "type": "error", "error": { "type", "message" } }`) for `/v1/messages`. Phase 2 emits OpenAI shape ONLY (D-C1).

### Cross-Cutting Pattern C: AbortController + signal propagation

**Source:** `router/src/routes/v1/chat-completions.ts` (RESEARCH §Pattern 3)
**Apply to:** EVERY route that calls a `BackendAdapter` method (Phase 2: just `/v1/chat/completions`; Phase 3+: `/v1/messages`, `/v1/embeddings`)

The chain is load-bearing for SC3:
```
req.raw.on('close')  →  controller.abort()  →  signal passed to SDK  →  undici closes upstream TCP
```
Forget any link → SC3 silently fails (RESEARCH §Architectural Responsibility Map row "Abort propagation"). The unit test in `tests/integration/chat-completions.stream.test.ts -t 'aborts upstream on client disconnect'` is the regression canary.

### Cross-Cutting Pattern D: pino redact

**Source:** `router/src/log/logger.ts` (RESEARCH §Pattern 4)
**Apply to:** Configured ONCE at the root logger; applies to ALL Fastify access logs, route handler logs, error handler logs (RESEARCH §Architectural Responsibility Map row "Log redaction").

The SC5 grep test in `bin/smoke-test-router.sh` is the cross-cutting verification. ANY new log statement that includes a request/response object inherits redaction automatically — but a hand-rolled `req.log.warn(JSON.stringify(req.headers))` would bypass it (string-as-message vs object-as-payload). Convention: `req.log.warn({ url, method, ... }, 'message')` — pass payloads as objects so redact processes them.

### Cross-Cutting Pattern E: zod schemas via type provider

**Source:** `@bram-dc/fastify-type-provider-zod` registered in `app.ts` (RESEARCH §Pattern 1)
**Apply to:** EVERY route declaration — validation + TypeScript-typed `request.body` in one step

Pattern (lifted from RESEARCH §Don't Hand-Roll row "Fastify route schema validation"):
```typescript
typed.post('/v1/chat/completions', {
  schema: { body: ChatCompletionRequestSchema },
}, handler);
```

Auto-emits 400 with structured zod issue list on validation failure — D-C3 row "Zod request validation fail".

---

## No Analog Found

Every Phase 2 file maps to either a DISK analog or a SPEC excerpt — there are no files with NO analog. The list below is files where the analog is **generic test/build convention**, not project-specific:

| File | Role | Reason | Planner guidance |
|------|------|--------|------------------|
| `router/tests/setup.ts` | test config | No project-specific msw setup convention exists yet (this is the first test code in the repo). | Standard vitest + msw v2 `setupServer()` boilerplate. ~10 lines. |
| `router/biome.json` (or `eslint.config.js`) | build config | CLAUDE.md endorses Biome but doesn't pin a config. Planner picks. | Recommend Biome for speed. Default config + a few rule overrides for the project (e.g. allow `console.log` only in `bin/` scripts — not applicable to TS). |
| `router/tsconfig.json` | build config | Generic Node 22 + ESM + strict TypeScript convention. | `target: es2023`, `module: nodenext`, `moduleResolution: nodenext`, `strict: true`, `verbatimModuleSyntax: true`, `noUncheckedSideEffectImports: true` — RESEARCH §Standard Stack TypeScript row + CLAUDE.md "v5.6 has `verbatimModuleSyntax` and `--noUncheckedSideEffectImports` which catch the common SDK-import footguns". |
| `router/tsup.config.ts` | build config | Generic single-entry ESM bundle. | `{ entry: ['src/index.ts'], format: 'esm', target: 'node22', clean: true, sourcemap: true }` — VALIDATION §Wave 0. |
| `router/vitest.config.ts` | build config | Generic vitest for Node. | `{ test: { include: ['tests/**/*.test.ts'], environment: 'node', setupFiles: ['./tests/setup.ts'] } }` — VALIDATION §Wave 0. |

---

## Anti-Patterns to Reject (Standing Rules from CLAUDE.md / STATE.md / Phase 1 retros)

If ANY of the new files violate these, the planner MUST flag and the executor MUST refuse:

| Anti-pattern | Where it would surface | Why rejected | Source |
|-------------|------------------------|--------------|--------|
| `node:22-alpine` (or any Alpine) in `router/Dockerfile` runtime stage | `router/Dockerfile` stage 4 | musl libc breaks `pg-native`/`bcrypt`/native deps; opaque debugging | CLAUDE.md "What NOT to Use" row 1; STATE.md anti-pattern list |
| `:latest` tag anywhere | `router/Dockerfile`, `compose.yml` | Silent format/API breakage on `docker compose pull` | CLAUDE.md "What NOT to Use" row 2; Phase 1 INFRA-04 |
| `@fastify/compress` registered (or any compress middleware on streaming routes) | `router/src/app.ts`, `router/src/routes/v1/chat-completions.ts` | gzip buffers SSE chunks until flush — defeats SSE entirely | RESEARCH Pitfall 1 + 4; CLAUDE.md "What NOT to Use" row "Compress middleware on SSE" |
| `===` for bearer compare | `router/src/auth/bearer.ts` | Timing-leaks the token's prefix-match length | RESEARCH §Anti-Patterns "Plain `===` for the bearer check"; STATE.md anti-pattern list; CLAUDE.md "What NOT to Use" implicit |
| `req.raw.on('aborted')` instead of `req.raw.on('close')` | `router/src/routes/v1/chat-completions.ts` | `'aborted'` is HTTP/1.1-only; doesn't fire on H/2 (Phase 6 lands H/2 via Traefik) | RESEARCH §Anti-Patterns row "req.raw.on('aborted')" |
| Forgetting to clear `setInterval` for the heartbeat | `router/src/sse/heartbeat.ts`, `router/src/routes/v1/chat-completions.ts` close handler | Open-handle leak; process won't exit cleanly; SC3 silently fails | RESEARCH §Anti-Patterns row "Forgetting to clear setInterval"; Pitfall 3 |
| `new OpenAI({ apiKey: '' })` or `new OpenAI({})` | `router/src/backends/ollama-openai.ts` | SDK v6 throws at construction time on empty apiKey | RESEARCH §Anti-Patterns row "new OpenAI({apiKey:''})"; CONTEXT D-B1 |
| Mounting `models.yaml` as a Docker named volume | `compose.yml` `volumes:` block under `router:` | `fs.watch` on docker-managed volume mount is unreliable across drivers | RESEARCH §Anti-Patterns last row; Pitfall 7 |
| `:latest` Docker image, OR public-internet exposure of router | `compose.yml` `router.ports:` block | Bearer alone is insufficient on the open internet — Phase 2 is `127.0.0.1:3000:3000`-only | CONTEXT D-A4; CLAUDE.md "What NOT to Use" "Direct browser → router CORS without auth"; README.md line 131 |
| `pino-pretty` bundled into prod image | `router/package.json` `dependencies:` (vs `devDependencies:`) | Pretty-print is dev-only — prod stays JSON | RESEARCH §Pattern 4 line 562; CLAUDE.md §Development Tools row |
| `set -e` in `bin/smoke-test-router.sh` | new bash file | Loses diagnostic coverage when early checks fail; project convention is `set -uo pipefail` + FAILURES counter | DISK analog `bin/smoke-test-gpu.sh` lines 28, 31, 91–92 |
| `git status -uall` | not applicable to phase code, but flag if it appears in any new bin/ script | Memory issues on large repos; Phase 1 retro lesson | CLAUDE.md commit guidelines; STATE.md |

---

## Metadata

**Analog search scope:**
- `compose.yml`, `bin/smoke-test-gpu.sh`, `bin/preflight-gpu.sh`, `.env.example`, `README.md` — all read.
- RESEARCH.md §§Pattern 1–4, Code Examples, Don't Hand-Roll, Anti-Patterns, Standard Stack, Architectural Responsibility Map, Recommended Project Structure, Common Pitfalls (1–7), State of the Art, Open Questions, Assumptions Log — all read in targeted ranges.
- VALIDATION.md — full file read (Wave 0 list).
- CLAUDE.md (project context) — Multi-stage Dockerfile pattern, "What NOT to Use", Streaming gotchas, Stack pins — referenced from system context.

**Files scanned (DISK):** 5 (compose.yml, smoke-test-gpu.sh, preflight-gpu.sh head, .env.example, README.md verify section).

**Spec analogs catalogued:** 24 (every TS source + every test + the Dockerfile + package.json).

**Pre-existing TS code in repo:** none. The router is greenfield. SPEC analogs are the only source for TS bodies; planner copies RESEARCH §Pattern 1–4 / §Code Examples blocks verbatim.

**Pattern extraction date:** 2026-05-12.

---

## PATTERN MAPPING COMPLETE

**Phase:** 02 - mvp-vertical-slice-router-ollama-sse
**Files classified:** 31
**Analogs found:** 7 DISK + 24 SPEC = 31 / 31 (100% coverage; 0 files without an analog)

### Coverage
- Files with exact DISK analog: 7 (`compose.yml` modify, `bin/smoke-test-router.sh` new, `bin/smoke-test-gpu.sh` self-edit, `.env.example` no-op, `README.md` append, plus `compose.yml` Ollama-block style mirror twice)
- Files with exact SPEC analog (verbatim-liftable from RESEARCH/CLAUDE): 13 (`router/src/index.ts`, `app.ts`, `auth/bearer.ts`, `config/registry.ts` schema, `backends/adapter.ts`, `backends/ollama-openai.ts`, `routes/v1/chat-completions.ts`, `sse/stream.ts`, `sse/heartbeat.ts`, `errors/envelope.ts`, `log/logger.ts`, `models.yaml`, `Dockerfile`)
- Files with partial SPEC analog (style + conventions, but body to be written from coverage table): 11 (all test files + `routes/healthz.ts`)
- Files with generic-convention analog only: 5 (`tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `biome.json` or `eslint.config.js`, `tests/setup.ts`, `.dockerignore`)
- Files with NO analog: 0

### Key Patterns Identified
- **Bash scripts:** `set -uo pipefail` + `FAILURES` counter + `pass()`/`fail()` helpers + sectioned banner output + exit 0/1; envvar-passing-to-python for any JSON construction (CR-02 hardening). Source: `bin/smoke-test-gpu.sh` (DISK).
- **Compose service blocks:** banner comment header citing CONTEXT decisions; `${COMPOSE_PROJECT_NAME:-local-llms}-svc` container_name pattern; pinned image tags only; `depends_on` with explicit `condition:`; healthcheck command appropriate to the in-image binaries (no curl on slim Node images — use `node -e fetch` per RESEARCH Open Question 2). Source: `compose.yml` `ollama:` block (DISK).
- **TypeScript files:** SPEC-driven from RESEARCH §Patterns 1–4 — Fastify v5 with `logger: options` (NOT instance), `@bram-dc/fastify-type-provider-zod`, `fastify-sse-v2` `reply.sse(asyncIterable)`, `crypto.timingSafeEqual` with length-padding, pino redact OBJECT form with `[REDACTED]` censor.
- **Streaming + abort:** the load-bearing chain is `req.raw.on('close')` → `controller.abort()` → `signal` passed to `client.chat.completions.create(..., { signal })` → undici closes the upstream TCP. Heartbeat helper exposes `.stop()` cleared in BOTH the close handler AND the iterator's `finally` (belt-and-suspenders).
- **No on-disk TypeScript code exists** — every TS file's analog is a documented spec excerpt (RESEARCH or CLAUDE.md). The planner should paste those excerpts verbatim into plan actions; the executor should treat the spec excerpts as the canonical body.

### File Created
`/home/luis/proyectos/local-llms/.planning/phases/02-mvp-vertical-slice-router-ollama-sse/02-PATTERNS.md`

### Ready for Planning
Pattern mapping complete. Planner can now reference DISK analogs (file + line numbers) and SPEC analogs (RESEARCH section + line numbers) in 02-PLAN-*.md actions.
