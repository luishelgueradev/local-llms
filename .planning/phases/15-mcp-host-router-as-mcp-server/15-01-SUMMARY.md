---
phase: 15
plan: 1
subsystem: router
tags: [mcp, dependencies, env-config]
status: complete
requirements: [MCPS-01]
dependency_graph:
  requires: []
  provides:
    - "@modelcontextprotocol/sdk dependency available for Plan 15-03+ imports (server/mcp.js, server/streamableHttp.js, types.js)"
    - "EnvSchema.MCP_ENABLED / MCP_SESSION_TTL_SEC / MCP_GC_INTERVAL_MS available for Plan 15-03+ plugin wiring"
  affects:
    - "router/package.json + router/package-lock.json — new transitive deps land in lockfile (78 added packages)"
    - "router/src/config/env.ts — three new keys on Env type widen consumer surface (auto-inferred from z.infer)"
    - "/.env.example — operator-facing documentation gains Phase 15 block"
tech-stack:
  added:
    - "@modelcontextprotocol/sdk@^1.29.0 (installed 1.29.0, integrity sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==)"
  patterns:
    - "z.coerce ladder for env-var validation (existing pattern, extended)"
    - "describe-block append to existing env.test.ts (existing pattern, extended)"
key-files:
  created:
    - .planning/phases/15-mcp-host-router-as-mcp-server/deferred-items.md
  modified:
    - router/package.json
    - router/package-lock.json
    - router/src/config/env.ts
    - router/tests/config/env.test.ts
    - .env.example
decisions:
  - "Used npm not pnpm — router/ has package-lock.json, no pnpm-lock.yaml; plan's pnpm path was a fallback"
  - "Appended tests to router/tests/config/env.test.ts (existing canonical) not router/tests/unit/config/env.test.ts (plan's path, does not exist)"
  - "Updated repo-root .env.example not router/.env.example — root file is where every existing router env var (CIRCUIT_*, ROUTER_*, etc.) lives; creating router/.env.example would split operator surface"
metrics:
  duration_minutes: 4
  completed: 2026-05-31T04:03:11Z
  tasks_completed: 4
  files_changed: 5
  commits: 3
---

# Phase 15 Plan 01: Foundation — MCP SDK dependency + env vars Summary

## One-liner

Landed `@modelcontextprotocol/sdk@^1.29.0` (verified provenance) and widened `EnvSchema` + repo-root `.env.example` with the three D-15 MCP host env vars (`MCP_ENABLED`, `MCP_SESSION_TTL_SEC`, `MCP_GC_INTERVAL_MS`).

## Task 1 — Package Legitimacy Gate (pre-approved by orchestrator)

The orchestrator ran the four `npm view` checks BEFORE spawning the executor. Recorded approval:

| Check | Result |
|-------|--------|
| `repository.url` | `git+https://github.com/modelcontextprotocol/typescript-sdk.git` (matches official `modelcontextprotocol` GitHub org) |
| `maintainers` | Includes Anthropic employees (`fweinberger@anthropic.com`, `ashwin@anthropic.com`, plus `jspahrsummers`, `pcarleton`, `thedsp`, `ochafik`) |
| `scripts.postinstall` | `undefined` (no postinstall hook) |
| `dist.integrity` | `sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==` |

**Post-install cross-check:** The integrity hash on `router/package-lock.json` for `node_modules/@modelcontextprotocol/sdk` after `npm install` is `sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==` — **bit-for-bit match** with the pre-install captured hash. Tarball was not tampered with between metadata fetch and install.

T-15-01-SC mitigation: **complete**.

## Task 2 — `npm install @modelcontextprotocol/sdk@^1.29.0`

- Edited `router/package.json` dependencies (alphabetically after `@bram-dc/fastify-type-provider-zod`).
- Ran `npm install` (NOT `pnpm install` — repo uses npm; `pnpm-lock.yaml` is absent, `package-lock.json` is the authoritative lockfile).
- Result: `added 78 packages, audited 368 packages in 8s`. Five npm-audit advisories (4 moderate, 1 high) noted but NOT acted on — out of scope for Plan 15-01 (Rule scope boundary: not introduced by this task; pre-existing in the dep graph).
- Installed version: **1.29.0** (semver match for `^1.29.0`).
- Verified all three downstream import paths exist:
  - `router/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`
  - `router/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js`
  - `router/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js`
- `npm run typecheck` clean (no SDK code imported yet, baseline pass).

### Transitive dep summary

`npm install` added 78 packages (full graph: 368). The router only imports from three SDK subpaths (`/server/mcp.js`, `/server/streamableHttp.js`, `/types.js`), so the runtime exposure is narrow. The transitive set is the SDK's published `dependencies` block; nothing was bypassed via `--ignore-scripts` because `scripts.postinstall` was already undefined on the top-level package.

**Commit:** `dfb16a2`

## Task 3 — EnvSchema widening + unit tests

- `router/src/config/env.ts` appended three z.coerce entries after `ROUTER_EMBED_CACHE_TTL_SEC`:
  - `MCP_ENABLED: z.coerce.boolean().default(true)`
  - `MCP_SESSION_TTL_SEC: z.coerce.number().int().positive().default(3600)`
  - `MCP_GC_INTERVAL_MS: z.coerce.number().int().positive().default(1_800_000)`
- Inline comment block documents Phase 15 / D-15 rationale, including the Zod-v4 `z.coerce.boolean()` quirk (`Boolean(value)` semantics: any non-empty string is truthy; explicit-disable is `MCP_ENABLED=` or unset → empty string → false).
- `Env` type via `z.infer<typeof EnvSchema>` auto-widens — no type alias edit needed.
- `router/tests/config/env.test.ts` gained a new `describe` block with 7 cases:
  1. Defaults case (true / 3600 / 1_800_000)
  2. Override coercion case
  3. Empty-string → false
  4. `MCP_SESSION_TTL_SEC=0` rejected
  5. Negative `MCP_SESSION_TTL_SEC` rejected
  6. `MCP_GC_INTERVAL_MS=0` rejected
  7. Negative `MCP_GC_INTERVAL_MS` rejected
- All 17 tests pass (10 pre-existing CIRCUIT_* + ROUTER_RATE_LIMIT_RPM cases + 7 new MCP_* cases).
- `npm run typecheck` clean.

**Commit:** `d23adbe`

## Task 4 — `.env.example` Phase 15 block

- Appended a Phase 15 header block after the Phase 9 NTFY_URL section in repo-root `.env.example`.
- All three env var lines start with `# ` (commented out per plan acceptance criteria — defaults kick in when var is absent).
- Includes an inline note on the empty-string-as-false quirk so operators don't accidentally type `MCP_ENABLED=false` expecting it to disable the plugin (any non-empty string is truthy via `z.coerce.boolean()`).

**Commit:** `5b74ada`

## Deviations from Plan

### Rule 3 — Path corrections (blocking-issue fixes)

**1. [Rule 3 - Wrong path] Test file lives at `router/tests/config/env.test.ts` not `router/tests/unit/config/env.test.ts`**
- **Found during:** Task 3 read_first scan
- **Issue:** Plan instructed to create or extend `router/tests/unit/config/env.test.ts`; that directory does not exist. The actual existing env test file is at `router/tests/config/env.test.ts` (alongside `registry.test.ts`, `registryCache.test.ts`, etc., per the Plan 08-04 baseline).
- **Fix:** Appended the new describe block to the existing `router/tests/config/env.test.ts`, honoring the plan's stated fallback clause: *"If router/tests/unit/config/env.test.ts already exists, append the new cases to its existing describe block instead of duplicating boilerplate."*
- **Commit:** `d23adbe`

**2. [Rule 3 - Wrong path] `.env.example` lives at repo root, not `router/.env.example`**
- **Found during:** Task 4 read_first
- **Issue:** Plan named `router/.env.example`. No such file exists; the operator-facing env example for the entire stack lives at `/home/luis/proyectos/local-llms/.env.example` (repo root). All other router env vars currently documented there are: `ROUTER_BEARER_TOKEN`, `OLLAMA_API_KEY`, `CIRCUIT_FAILURE_THRESHOLD`, `CIRCUIT_WINDOW_MS`, `CIRCUIT_COOLDOWN_MS`, `ROUTER_RATE_LIMIT_RPM`, `ROUTER_EMBED_CACHE_TTL_SEC`, `VRAM_ENVELOPE_GB`. Creating `router/.env.example` would split the operator surface into two files; no consumer (compose.yml, Dockerfile, bin/bootstrap-host.sh) reads `router/.env.example`.
- **Fix:** Appended the Phase 15 block to repo-root `.env.example`, keeping a single source of truth for operators.
- **Commit:** `5b74ada`

**3. [Rule 3 - Wrong package manager] Used npm not pnpm**
- **Found during:** Task 2 read_first
- **Issue:** Plan defaulted to `pnpm install`. `router/pnpm-lock.yaml` does NOT exist; `router/package-lock.json` (205 KB) is the live lockfile and `npm` is the active package manager (the plan's own action block included an `ls router/pnpm-lock.yaml` fallback gate, which I exercised).
- **Fix:** Ran `npm install` — added 78 packages, updated `package-lock.json`. No second lockfile introduced.
- **Commit:** `dfb16a2`

### Non-deviation: pre-existing untracked file noted in `deferred-items.md`

Discovered an untracked file `router/tests/unit/dispatch/preflight.test.ts` (mtime `2026-05-31 04:02:17`, ~9.5 KB) that references "Phase 15 / MCPS-01 / D-09 / applyPreflight". This file is **not** an output of Plan 15-01 (Plan 15-01 only touches package.json + env.ts + .env.example) and was either pre-staged for Plan 15-02 / 15-03 (where `applyPreflight` ships per CONTEXT.md D-09) or left over from an earlier abandoned session. Git log shows commit `0084840 test(15-02): add failing unit-test matrix for applyPreflight helper` exists in history but the file is currently untracked — consistent with a soft-reset that left the file in the working tree. Logged in `.planning/phases/15-mcp-host-router-as-mcp-server/deferred-items.md` for the next plan's executor to reconcile. NOT deleted, NOT committed.

## Authentication Gates

None. No auth required for `npm install` against the public registry (anonymous, integrity-pinned).

## Verification Results

| Check | Result |
|-------|--------|
| `cd router && npm run typecheck` | 0 errors |
| `cd router && npx vitest run tests/config/env.test.ts` | 17/17 pass |
| `grep '@modelcontextprotocol/sdk' router/package.json` | 1 occurrence |
| `ls router/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js` | exists |
| `ls router/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js` | exists |
| `ls router/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js` | exists |
| `grep -c 'MCP_ENABLED:' router/src/config/env.ts` | 1 |
| `grep -c 'MCP_SESSION_TTL_SEC:' router/src/config/env.ts` | 1 |
| `grep -c 'MCP_GC_INTERVAL_MS:' router/src/config/env.ts` | 1 |
| `grep -c 'MCP_ENABLED' .env.example` | 3 (header doc + comment + commented line) |
| `grep -c 'MCP_SESSION_TTL_SEC' .env.example` | 1 |
| `grep -c 'MCP_GC_INTERVAL_MS' .env.example` | 1 |
| Post-install integrity hash matches orchestrator pre-capture | YES (bit-for-bit match) |

## Success Criteria

1. ✓ Package legitimacy gate passed (orchestrator pre-approval recorded inline + post-install integrity hash cross-checked).
2. ✓ `@modelcontextprotocol/sdk@^1.29.0` in `router/package.json` `dependencies`; resolvable in `node_modules` at v1.29.0.
3. ✓ EnvSchema parses MCP_ENABLED / MCP_SESSION_TTL_SEC / MCP_GC_INTERVAL_MS with defaults (true / 3600 / 1_800_000).
4. ✓ Repo-root `.env.example` documents the three new keys under a Phase 15 header.
5. ✓ All existing tests continue to pass (10 pre-existing env tests + 7 new MCP cases = 17/17).
6. ✓ `npm run typecheck` clean.

## Known Stubs

None. This is a foundation plan — three env vars are declared but unused; that is by design (their consumers ship in Plan 15-03+). Plan-15-01's `must_haves.truths` make no claim about runtime consumption.

## Threat Flags

None new. The plan's `<threat_model>` covers both surfaces (T-15-01-SC supply chain — mitigated by Task 1 gate + integrity cross-check; T-15-01-EN env disclosure — accepted, defaults preserve behavior). No NEW security-relevant surface was introduced beyond what the plan anticipated.

## Self-Check: PASSED

- `router/package.json` contains `@modelcontextprotocol/sdk`: **FOUND**
- `router/package-lock.json` updated with SDK + 78 transitive deps: **FOUND**
- `router/src/config/env.ts` contains `MCP_ENABLED:` `MCP_SESSION_TTL_SEC:` `MCP_GC_INTERVAL_MS:`: **FOUND** (1 each)
- `router/tests/config/env.test.ts` contains `Plan 15-01 / D-15` describe block: **FOUND**
- Repo-root `.env.example` contains `Phase 15` header + three commented MCP vars: **FOUND**
- `.planning/phases/15-mcp-host-router-as-mcp-server/deferred-items.md` exists: **FOUND**
- Commit `dfb16a2` (feat install): **FOUND** in `git log --oneline --all`
- Commit `d23adbe` (feat EnvSchema): **FOUND** in `git log --oneline --all`
- Commit `5b74ada` (docs .env.example): **FOUND** in `git log --oneline --all`
