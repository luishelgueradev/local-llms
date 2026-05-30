---
phase: 14-policy-primitives-tenant-project-id-foundation
plan: 09
status: complete
started: 2026-05-30
completed: 2026-05-30
requirements:
  - POL-01
  - POL-02
  - POL-03
key_files:
  modified:
    - router/models.yaml
    - DEPLOY.md
    - README.md
    - .planning/REQUIREMENTS.md
    - compose.yml
  created: []
commits:
  - 5f8d482 docs(14): operator policy stanza in models.yaml + POL-01 wording patch (D-03)
  - 550af17 docs(14): DEPLOY.md + README.md policy primitives sections (Phase 14 v0.11.0)
  - 65ff1e6 fix(infra): bump openwebui healthcheck start_period 30s→90s for WSL2 boot timing
  - 726a88d chore: merge executor worktree (worktree-agent-a895cba1a7d95ca43 — plan 14-09 Tasks 1+2)
---

# 14-09 — Operator Affordances + Smoke Gate

## What was done

Task 1, Task 2, and Task 3 of plan 14-09 complete. Task 3 was a human-verify
checkpoint executed by the orchestrator against the live local stack with
operator participation.

### Task 1 — `router/models.yaml` policy stanza + REQUIREMENTS POL-01 patch (commit `5f8d482`)

- Inserted a 60-line commented `# policies:` affordance block at the very top
  of `router/models.yaml`. Every line `#`-prefixed → D-04 default behavior
  unchanged (zero-config keeps allow-all semantics; `Plan 02`'s `RegistrySchema.parse`
  still returns `policies === undefined` on the live file).
- Block covers:
  - Phase 14 / v0.11.0 attribution (POL-01/POL-02).
  - Gate-position invariant — fires after the capability check and before
    `opts.breaker.check(entry.backend)` (D-09 / P8-01); violations never count
    as backend failures.
  - Allow-all defaults explicitly documented for both `policies.default.model_allowlist`
    (empty list) and per-entry `policy.cloud_allowed` (defaults to `true`).
  - Hot-reload caveat citing project memory `project_models_yaml_hot_edit.md`:
    `docker compose exec valkey valkey-cli DEL 'model-registry:*'` followed by
    `docker compose up -d --force-recreate router`. Bare `restart` will NOT
    pick up new policies (snapshot lives in Valkey).
  - Example global allowlist + example per-entry `cloud_allowed: false`.
- Patched POL-01 wording in `.planning/REQUIREMENTS.md` per CONTEXT.md D-03:
  the original "per registry entry" phrasing was a wording bug — the locked
  hybrid shape moves the allowlist to the top-level `policies.default.model_allowlist`.
- POL-02..POL-06 wording untouched (verified by line-count grep gate).

### Task 2 — DEPLOY.md + README.md policy primitives sections (commit `550af17`)

- `DEPLOY.md` gained a 136-line "Policy primitives (Phase 14 — v0.11.0)"
  section covering:
  - Stanza shape with explicit allow-all default semantics.
  - 403 envelope shapes for `model_not_in_allowlist` and `cloud_not_allowed`.
  - Gate-position invariant (D-09 / P8-01) — capability → policy → breaker.
  - Scoped-ID headers + regex shapes (`/^[A-Za-z0-9._:-]{1,128}$/` for tenant
    and project IDs; `/^[A-Za-z0-9._-]{1,64}$/` lowercased for workload class).
    Validation behavior split per D-12/D-16: 400 vs silent-NULL.
  - Where scoped IDs appear: `request_log` columns + pino structured logs.
    Explicitly NOT Prometheus labels (D-25 / P8-03 cardinality discipline).
  - Hot-reload procedure with `valkey-cli DEL` + `--force-recreate router`.
  - Migration 0005 auto-applies via Drizzle migrator on boot; rollback path
    documented.
  - Cardinality CI guard: `scripts/__tests__/check-prometheus-cardinality.test.ts`
    fails the build if `src/metrics/registry.ts` grows any `*_id` label.
- `README.md` gained a brief "Policy & multi-tenant context" subsection with
  cross-links to DEPLOY.md and `router/models.yaml`.

### Task 3 — Smoke gate (human-verified)

The 7-step smoke gate ran against the live local stack after `docker compose
build router` + `docker compose up -d --force-recreate router` brought the
container in line with Phase 14 code.

| # | Check | Result |
|---|-------|--------|
| 1 | `docker compose ps router` | ✅ Up, healthy |
| 2 | `\d request_log` lists `tenant_id`, `project_id`, `workload_class` | ✅ Three new columns present (TEXT, nullable) |
| 3 | `cd router && npm test` | ✅ 849/850 (1 WSL fs.watchFile flake on `hotreload.vram.test.ts`; passes 3/3 in isolation) |
| 4 | `cd router && npm run typecheck` | ✅ Clean |
| 5 | `bash bin/smoke-test-router.sh --router-url http://127.0.0.1:3210 SKIP_LLAMACPP=1` | ✅ **76 PASS / 0 FAIL / 4 SKIP** |
| 6 | E2E curl with `X-Tenant-ID: acme`, `X-Project-ID: agents`, `X-Workload-Class: dev` | ✅ HTTP 200, body `{"content":"ok"}`, 8.5s |
| 7 | `SELECT tenant_id, project_id, workload_class FROM request_log ORDER BY ts DESC LIMIT 1` | ✅ `acme \| agents \| dev` |

**POL Success Criterion 5** (existing smoke passes unchanged with zero policy
config / allow-all defaults): ✅ green.

**POL Success Criterion 3** (full-stack scoped-ID round trip): ✅ proved via
step 6 + step 7. The curl request with the three headers produced a
`request_log` row reflecting them exactly.

## Smoke baseline triage — operator visibility outcome

The initial smoke run with default settings produced **73 PASS / 4 FAIL / 5 SKIP**
vs. the v0.10.0 baseline of 79 PASS / 4 SKIP / 0 FAIL. All 4 failures traced
to two non-code root causes; **none are Phase 14 regressions**:

### Root cause 1 — openwebui healthcheck start_period too short for WSL2 (fixed)

3 of the 4 failures cascaded from a single source: every
`docker compose --profile {ollama|llamacpp} up -d --wait` invocation reported
`failed`, and the log line directly above each one was
`container local-llms-openwebui is unhealthy`. The `--wait` flag waits for
**all** services in the compose project to become healthy, not just those in
the named profile. openwebui's healthcheck used `start_period: 30s` with a
comment claiming 15-25s boot time; on this WSL2 host openwebui actually takes
~100s to reach healthy on cold boot.

**Fix** (commit `65ff1e6`): bumped openwebui `start_period` to 90s in
`compose.yml` with an explanatory comment. `start_period` only delays
failure-counting, so there is no boot-time cost. After the fix the cascading
3 failures disappeared (78 PASS / 1 FAIL / 4 SKIP).

### Root cause 2 — llamacpp + ollama VRAM contention (workaround documented)

The 4th failure was `SC-P4-A: empty response from /v1/messages`. Router logs
showed the actual failure was an `APIConnectionTimeoutError` from the OpenAI
SDK at the `OllamaOpenAIAdapter.chatCompletionsCanonical` call site → HTTP 504.
The same call against an idle stack returns HTTP 200 in 0.33s.

Sequence reproducing the timeout:
1. Phase 3.B brings up `--profile llamacpp` (fails due to GGUF load > start_period).
2. llamacpp container remains in the failed-start state, holding partial VRAM.
3. Phase 4 dispatches `/v1/messages` to Ollama → Ollama waits on VRAM that
   llamacpp has not yet released → request exceeds the OpenAI SDK's connection
   timeout → 504 → `curl -fsS` exits non-zero → `|| true` swallows it → script
   sees empty response → FAIL.

This is the canonical "one-backend-hot at a time" scenario from project memory
`project_vram_budget.md`. The smoke script provides a documented escape hatch
(`SKIP_LLAMACPP=1`), which is the correct option on a 16 GB VRAM host where
llamacpp + ollama cannot both stay loaded.

**Result with the openwebui fix + `SKIP_LLAMACPP=1`**: 76 PASS / 0 FAIL / 4
SKIP. The 76 PASS vs. v0.10.0's 79 PASS gap is the 3 explicit llamacpp asserts
now correctly skipped instead of attempted-then-cascade-failed — equivalent
baseline, no actual coverage lost on this host.

## Deviations / notes

- The plan listed 4 files in `files_modified`; the orchestrator added a 5th
  (`compose.yml`) as part of Task 3's smoke gate root-cause fix. This was
  out of scope of the originally planned tasks but was approved by the operator
  before close. Recorded under commits in frontmatter.
- The `dist/index.js` Phase 14 binary was deployed via `docker compose build
  router` + `docker compose up -d --force-recreate router` before Task 3 ran;
  prior to that the container had been running for 23h on the v0.10.0 image
  and reported NULL scoped IDs (expected — no Phase 14 code yet in the binary).

## POL coverage from this plan

- **POL-01** (operator can declare top-level `policies.default.model_allowlist`):
  affordance discoverable in `router/models.yaml` comment block + REQUIREMENTS
  wording matches the locked hybrid shape; allow-all default proven by the
  smoke gate's 76 PASS (zero policy config in the live `models.yaml`).
- **POL-02** (per-entry `policy.cloud_allowed: false`): same — affordance
  discoverable; default `true` semantics proven by smoke baseline staying
  green with no `policy:` blocks declared.
- **POL-03** (`X-Workload-Class` opaque metadata): documented in DEPLOY.md +
  README.md; full-stack round-trip proven in step 6+7 (header `dev` arrives
  in `request_log.workload_class`).

## Operator follow-ups (not blocking phase verification)

- `compose.yml`'s other 4 services with `start_period: 30s` (lines 167, 409,
  459, 526, 778) were not bumped. If similar WSL2 boot lag affects them, a
  follow-up infra phase can apply the same pattern.
- `bin/smoke-test-router.sh`'s SC-P4-A could be hardened to either tolerate
  the VRAM swap window or auto-detect llamacpp's failed-start state and skip
  Phase 3.B internally. Out of scope here.

## Self-Check: PASSED

All Task 1 + Task 2 grep gates met; Task 3's 7-step gate green with the noted
infrastructure fix (`65ff1e6`) and the `SKIP_LLAMACPP=1` flag (documented in
the smoke script itself).
