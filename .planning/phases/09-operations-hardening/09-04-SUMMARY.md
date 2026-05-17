---
phase: 09-operations-hardening
plan: 04
subsystem: docs
tags: [ops, security, bearer-rotation, docs, openwebui, runbook]

# Dependency graph
requires:
  - phase: 02-mvp-vertical-slice-router-ollama-sse (ROUTE-03 + ROUTE-05)
    provides: constant-time bearer compare + pino redaction of authorization/cookie/*.apiKey paths — both guardrails referenced by the rotation runbook
  - phase: 06-traefik-tls-open-webui (D-C1 + CONTEXT line 16)
    provides: OPENAI_API_KEYS PersistentConfig contract — OWUI persists the seeded bearer to its openwebui DB on first boot; subsequent restarts read from DB, not env — this is THE pivot the runbook addresses
  - phase: 09-operations-hardening (Plan 09-01)
    provides: ## Operations parent section in README + Phase 5 §Restore drill procedure-shape template
  - phase: 09-operations-hardening (Plan 09-03)
    provides: <!-- OPS-04 --> anchor under ## Operations (placed by Plan 09-03's final line)
provides:
  - README §Operations §### Rotating the bearer token (OPS-04) — 10-step rotation runbook + admin-UI + direct-SQL OWUI paths + OLD_PREFIX-only verification grep + rollback note + cross-reference to other-secret rotation
affects: [v2-secret-rotation-tooling, v2-encrypted-env-at-rest, audit-log-future, alertmanager-v2]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pre-flight inventory of N consumers BEFORE generating the new secret — prevents partial rotation"
    - "OLD_PREFIX-only verification grep (first 8 hex chars, NEVER full token) — keeps the old secret out of shell history"
    - "PersistentConfig pivot — env-var swap does NOT propagate to OWUI; admin-UI or direct-SQL path required"
    - "Reversible-until-step-N procedure shape — explicit irreversibility gate (discarding the old secret)"
    - "Per-secret rotation matrix in cross-reference paragraph — different secrets have different downtime/irreversibility profiles"

key-files:
  created:
    - .planning/phases/09-operations-hardening/09-04-SUMMARY.md (this file)
  modified:
    - README.md — §Operations §### Rotating the bearer token (OPS-04) subsection (~196 LOC inserted between OPS-03 and ## Anti-patterns)

key-decisions:
  - "Docs-only, not a script — CONTEXT D-claude-discretion line 30 (operator decisions at multiple steps; admin-UI vs SQL path is a runtime pick)"
  - "OWUI Path A (admin UI) documented as the safe default; Path B (direct SQL) opt-in with explicit schema-verification operator-responsibility caveat — OWUI's persisted-config JSONB shape evolves between releases"
  - "Verification grep uses OLD_PREFIX (8 hex chars) NOT full token — T-09-I-07 mitigation (full token would land in shell history); this is THE security-hygiene pattern of the runbook"
  - "Three log surfaces checked (router, openwebui, traefik) — covers the full request path through the edge"
  - "Per-step expected outcomes match Phase 5 §Restore drill template — operator can self-verify each step without external context"
  - "Rollback note explicit + the rotation is REVERSIBLE until step 10 (discard old token) — operator can re-run smoke before committing irreversibly"
  - "Cross-reference paragraph covers other secrets (VALKEY/POSTGRES/GRAFANA/BACKUP_RESTIC/OWUI_SECRET_KEY/TRAEFIK_BASIC_AUTH) with rotation-cost taxonomy — operator can pick the right maintenance window"
  - "OWUI_SECRET_KEY explicit IRREVERSIBILITY callout — Phase 6 CONTEXT contract that rotating breaks at-rest-encrypted fields; this runbook explicitly does NOT cover it"

patterns-established:
  - "Procedure-shape template: pre-flight inventory → numbered procedure → rollback note → cross-reference → pin-assumptions → anti-patterns (reusable for any future credential-rotation runbook)"
  - "OLD_PREFIX shell-variable pattern as the de-facto canonical way to reference an old secret in a verification step without recording the secret"
  - "Path A/B documentation pattern for state that lives in TWO places (env + persisted DB) — admin-UI path documented as safe default, scripted path documented as opt-in with verification caveat"
  - "Per-secret rotation taxonomy — every secret in .env gets a one-liner explaining downtime + irreversibility (lays groundwork for a future ROTATE-MATRIX.md if v2 adds tooling)"

requirements-completed: [OPS-04]

# Metrics
duration: ~12min
completed: 2026-05-17
---

# Phase 09 Plan 04: Bearer-token rotation runbook (OPS-04) Summary

**README §Operations §Rotating the bearer token (OPS-04) — 10-step rotation runbook with OWUI PersistentConfig pivot (admin-UI Path A + direct-SQL Path B), OLD_PREFIX-only verification grep across router/openwebui/traefik logs, rollback note (fully reversible until step 10), and cross-reference matrix for VALKEY/POSTGRES/GRAFANA/BACKUP_RESTIC/OWUI_SECRET_KEY/TRAEFIK_BASIC_AUTH rotation costs.**

## Performance

- **Duration:** ~12 min (smallest plan in the phase — pure docs)
- **Started:** 2026-05-17T20:00Z
- **Completed:** 2026-05-17T20:12Z
- **Tasks:** 1
- **Files modified:** 1 (README.md — 196 LOC inserted)

## Accomplishments

- `README.md` gains `### Rotating the bearer token (OPS-04)` under `## Operations` between the OPS-03 subsection and the `## Anti-patterns rejected by this stack` section. ~196 LOC, ~10 prose blocks.
- 10-step rotation procedure (numbered, with copy-pasteable shell snippets and expected outcomes per step) — same shape as the Phase 5 §Restore drill template.
- Pre-flight consumer inventory (5 items): router process, OWUI's persisted `openwebui` DB, smoke scripts (auto-read `.env`), agent clients (Claude Code/cline/custom), operator shell history.
- OWUI `PersistentConfig` pivot documented in **two variants**:
  - **Path A — admin UI:** `https://chat.${TAILNET_HOSTNAME}.ts.net/` → Admin Panel → Settings → Connections → OpenAI API → edit `http://router:3000` entry → paste new token → save. Safe default for human operators.
  - **Path B — direct SQL:** `docker compose exec -T postgres psql -U app -d openwebui` against `OPENWEBUI_DATABASE_URL`-pointed DB. **OPERATOR-RESPONSIBILITY** caveat for the exact JSONB path (OWUI 0.9 schema evolves between releases). Opt-in for multi-environment scripted rotation.
- Verification grep recipe uses `OLD_PREFIX` (first 8 hex chars only) across three log surfaces:
  ```bash
  OLD_PREFIX=$(grep '^ROUTER_BEARER_TOKEN=' .env | sed 's/^ROUTER_BEARER_TOKEN=//' | sed 's/^local-llms_//' | head -c 8)
  for svc in router openwebui traefik; do
    docker compose logs "$svc" --since 24h 2>&1 | grep -c "$OLD_PREFIX" || echo 0
  done
  # Expected: 0 0 0
  ```
  Pino redaction (Phase 2 ROUTE-05) makes the router half always-zero; the grep is a regression check.
- Rollback note explicit — fully reversible until step 10 (discard old token). After step 10 → generate ANOTHER new token + repeat procedure.
- Cross-reference matrix for other-secret rotation (one-liner per secret with downtime + irreversibility profile):
  - `VALKEY_PASSWORD` — Valkey + router restart together, ~30 s downtime
  - `POSTGRES_PASSWORD` — `ALTER USER app WITH PASSWORD` + connection-string update + 3 service restarts, ~1–2 min downtime
  - `GRAFANA_ADMIN_PASSWORD` — rotated via Grafana admin UI (env only seeds on first boot)
  - `BACKUP_RESTIC_PASSWORD` — **CANNOT** rotate in place (restic encryption key is derived from password; re-init repo + re-publish required)
  - `OWUI_SECRET_KEY` — **IRREVERSIBLE** per Phase 6 CONTEXT; rotation breaks at-rest-encrypted fields; explicit NON-goal of OPS-04
  - `TRAEFIK_BASIC_AUTH` — regenerate htpasswd hash + restart Traefik (straightforward)
- Pin-assumptions paragraph: pino redaction (ROUTE-05), constant-time compare (ROUTE-03), OWUI `PersistentConfig` (Phase 6 CONTEXT line 16), `.env` mode 600 (bootstrap-host.sh:138).
- Anti-patterns reminder: never paste bearer to git; never expose router publicly without Tailscale; never skip step 9 grep; never `grep "$OLD_TOKEN"` (full token in shell history).
- 1 atomic commit (`1a95edc`). 0 deviations from plan.

## Task Commits

Each task was committed atomically:

1. **Task 1: README §Operations §Rotating the bearer token (OPS-04)** — `1a95edc` (docs)

**Plan metadata commit:** appended below as the final `docs(09-04): complete` commit.

## The 10-step rotation procedure (one-line summary per step)

| # | Step | Expected outcome |
| - | ---- | ---------------- |
| 1 | `openssl rand -hex 32` → password manager | New token saved off-host before any change to `.env` |
| 2 | `OLD_PREFIX=...` (first 8 hex chars only) | Shell variable for step 9 grep; full old token NEVER captured |
| 3 | Edit `.env` (editor, NOT `echo > .env`) | `ROUTER_BEARER_TOKEN=<new>` line updated, rest of `.env` intact |
| 4 | `docker compose restart router && sleep 5` | Router boots clean; no bearer mentions in log |
| 5 | OWUI **Path A** (admin UI) **OR Path B** (direct SQL) | OWUI's `openwebui` DB persists the new token; admin user + chats INTACT |
| 6 | `docker compose restart openwebui` (Path B only) | OWUI re-reads persisted config |
| 7 | Update agent clients (Claude Code / cline / custom) | Operator-side bookkeeping; smoke is the proof |
| 8 | `bash bin/smoke-test-router.sh --profile prod` | All Phase 2–8 assertions PASS; no 401/403 |
| 9 | Grep `OLD_PREFIX` across router/openwebui/traefik logs | `0 0 0` expected; non-zero → regression in pino redaction |
| 10 | Discard old token + `history -d` shell entries | Rotation IRREVERSIBLE after this point |

## The OWUI PersistentConfig pivot — why env-only rotation fails

This is the load-bearing detail OPS-04 exists to address.

- `compose.yml:968` sets `OPENAI_API_KEYS=${ROUTER_BEARER_TOKEN}` on the `openwebui:` service.
- On **first boot**, OWUI reads this env var AND persists it to the `openwebui` Postgres database (Phase 6 D-C1; CONTEXT line 16 — `OPENAI_API_KEYS` is `PersistentConfig`-marked).
- On **every subsequent restart**, OWUI reads from the DB, NOT from the env var. The env value is silently ignored.
- Therefore, `docker compose up -d openwebui` after a `.env` swap leaves OWUI using the OLD token. The operator's chat surface 401s, but the smoke test (which hits the router directly) passes — making the failure silent until OWUI is exercised.
- **The runbook addresses this** by making step 5 (OWUI stored-connection update) explicitly between step 4 (router restart) and step 8 (smoke). Path A is the safe default; Path B is opt-in for scripted environments.

This is the kind of inter-phase contract that only documentation can address — Phase 6 set the contract, Phase 9 OPS-04 documents how to operate around it.

## The OLD_PREFIX-only verification pattern (security hygiene)

The plan's threat model (T-09-I-07) flagged a naive verification approach: an operator copy-pastes the full old token into a shell variable, runs `grep "$OLD_TOKEN" ...`, and the full token lands in `~/.bash_history`. This defeats the rotation — the OLD token is now searchable on the operator's machine for the lifetime of the shell history file.

The runbook's mitigation:

- **Step 2** captures only the **first 8 hex chars** of the old token via a `sed | head -c 8` pipeline that NEVER expands the full token into a shell argument.
- **Step 9's grep** uses `"$OLD_PREFIX"` (the 8-char variable), not the full token.
- **Step 10** unsets `OLD_PREFIX` AND runs `history -d` on any earlier shell lines that captured the full token (e.g. from a debug `curl -H "Authorization: Bearer ..."` the operator might have run during incident triage before the rotation).

8 hex chars (32 bits of entropy) is enough to grep effectively against the log volume of a single-host stack (~thousands of lines per day) — non-malicious collisions are vanishingly rare. The remaining ~224 bits of entropy in the rest of the token mean the prefix-alone is not useful as an authentication credential.

This pattern is reusable for any future credential-rotation runbook (BACKUP_RESTIC_PASSWORD, VALKEY_PASSWORD, etc. if v2 ships rotation tooling for those).

## Three log surfaces checked

The verification grep iterates over `router`, `openwebui`, `traefik`:

- **`router`:** pino redaction (ROUTE-05) means the router emits ZERO `Authorization`-header matches by design. The grep is a regression check — if it returns non-zero, redaction has a hole, file a follow-up plan.
- **`openwebui`:** OWUI logs `OPENAI_API_KEYS` at first-boot in some 0.9 builds. Matches OLDER than the rotation timestamp are acceptable (first-boot was before the rotation); matches POST-rotation are a regression.
- **`traefik`:** Traefik forwards the `Authorization` header without logging it. Non-zero hits suggest the operator left Traefik at DEBUG log level — drop back to INFO.

## Explicit non-goals carried forward to v2

- **Automated bearer rotation tooling** — REQUIREMENTS.md / CONTEXT §Deferred line 87. The runbook is the v1 stance.
- **Encrypted `.env` at rest** (sops / age / vault) — CONTEXT §Deferred line 85. The current `.env` mode 600 is the v1 stance.
- **Rotation procedures for `VALKEY_PASSWORD` / `POSTGRES_PASSWORD` / `GRAFANA_ADMIN_PASSWORD` / `BACKUP_RESTIC_PASSWORD`** — README cross-references each with a one-liner cost/irreversibility profile but does NOT document step-by-step procedures. v2 territory with longer maintenance windows.
- **Rotation procedure for `OWUI_SECRET_KEY`** — **EXPLICITLY NOT COVERED** (Phase 6 CONTEXT irreversibility — breaks at-rest-encrypted OWUI fields). If an operator must rotate, they accept re-entry of every per-user persisted secret in the OWUI admin panel.
- **Rotation procedure for `TRAEFIK_BASIC_AUTH`** — straightforward (regenerate htpasswd + restart Traefik); covered by the cross-reference paragraph one-liner but not given its own subsection.
- **Audit logging of when rotations happened** — no audit log in v1. The operator's git history on `.env.example` (whenever a comment changes) is the de-facto audit; the actual `.env` is gitignored.
- **Forced rotation on schedule** (cron-driven reminder) — operator's responsibility. The runbook recommends quarterly cadence; not enforced.
- **CI lint that blocks `ROUTER_BEARER_TOKEN=` literals in PRs** — would need a separate hook + pattern. v2 if the project grows beyond single-operator.

## OWUI_SECRET_KEY irreversibility callout (NOT covered by OPS-04)

Worth highlighting separately because it is the single secret in `.env` that an operator might mistakenly attempt to rotate using this runbook's procedure shape.

- `OWUI_SECRET_KEY` is the symmetric key Open WebUI uses to encrypt at-rest fields in the `openwebui` Postgres database — specifically, per-user persisted API keys for downstream providers (when OWUI is configured with multi-provider connections), OAuth client secrets, and similar secret material.
- Rotating `OWUI_SECRET_KEY` breaks decryption of every encrypted row. OWUI does NOT auto-rotate the at-rest cipher; there is no in-place re-encryption tooling in 0.9.
- The READme explicitly states this is NOT covered by OPS-04. If an operator must rotate (suspected key exposure), they accept re-entering every per-user provider key in the OWUI admin panel afterwards.

## Files Created/Modified

- `README.md` — `### Rotating the bearer token (OPS-04)` subsection inserted under `## Operations` between the OPS-03 anchor and the `## Anti-patterns rejected by this stack` heading. ~196 LOC.

## Decisions Made

None beyond those captured in the plan's `<must_haves>`. The plan was executed exactly as written. Specifically:

- The plan's `<must_haves>` listed both Path A (admin UI) and Path B (direct SQL) as required documentation variants. Both are documented. Path A is the safe default; Path B carries the explicit "schema verification is the operator's responsibility" caveat per `<interfaces>` line 97 (CONTEXT line 16's PersistentConfig contract makes the JSONB shape OWUI-version-specific).
- The plan called for grep-recipe verification across `router`, `openwebui`, `traefik` log surfaces. All three included.
- The plan's "Pin assumptions" paragraph was fleshed out with explicit references to ROUTE-03 / ROUTE-05 / Phase 6 CONTEXT line 16 / bootstrap-host.sh:138 — every claim has a code-location anchor.

## Deviations from Plan

None — plan executed exactly as written. All 12 verify gates from the plan's `<verify>.automated` block pass on the first run:

| Gate | Expected | Actual |
| ---- | -------- | ------ |
| `### Rotating the bearer token (OPS-04)` subsection | == 1 | 1 |
| `ROUTER_BEARER_TOKEN` mentions | >= 5 | 28 |
| `OPENAI_API_KEYS` mentions | >= 1 | 4 |
| `openssl rand -hex 32` mentions | >= 1 | 3 |
| `docker compose restart router` mentions | >= 1 | 3 |
| `smoke-test-router` mentions | >= 5 | 11 |
| `history -d` OR `password manager` | >= 1 | 8 |
| `OWUI_SECRET_KEY` | >= 1 | 3 |
| `## Anti-patterns rejected` heading | == 1 | 1 |
| `## Operations` heading | == 1 | 1 |
| `PersistentConfig` | >= 1 | 3 |
| `OLD_PREFIX` | >= 1 | 6 |

Numbered-step count under the subsection: 15 lines starting with `^[0-9]+\.` (10 main steps + 5 Path-A sub-steps), matching the plan's `<verify>` informational note.

## Issues Encountered

None.

## User Setup Required

None for plan closure. The runbook is a procedure the operator follows **when** they need to rotate (suspected exposure, periodic rotation, post-incident hygiene) — not a one-time bootstrap step.

When the operator next rotates `ROUTER_BEARER_TOKEN`, they follow the 10-step procedure in README §Operations §Rotating the bearer token (OPS-04). Recommended cadence: quarterly. No automation gates the schedule — operator's responsibility.

## Next Phase Readiness

- **OPS-04 closes.** All four Phase 9 operations-hardening requirements (OPS-01 + OPS-02 + OPS-03 + OPS-04) are delivered.
- **Phase 9 closes.** This is the last plan of Phase 9. Milestone v0.9.0 closure follows once STATE.md + ROADMAP.md + REQUIREMENTS.md are updated by the final metadata commit.
- **Phase 8 carry-over:** Plan 08-10 Task 2 still PENDING-HUMAN (operator runs the full smoke + replies `approved` for Phase 8 closure). Unchanged by this plan.
- **Phase 7 carry-over:** Plan 07-06 Task 3 still PENDING-HUMAN. Unchanged by this plan.
- **No carry-over from Plan 09-04.** Pure docs — no tests, no new dependencies, no new env validation, no router code change.

## Self-Check: PASSED

- README.md contains `### Rotating the bearer token (OPS-04)` (1 occurrence; matches the plan's gate of `== 1`).
- All 10 numbered procedure steps present (`grep -cE '^[0-9]+\.'` under the subsection = 15, comprising the 10 main steps + 5 sub-steps for Path A).
- OWUI Path A (admin UI navigation: `Admin Panel → Settings → Connections → OpenAI API`) + Path B (`docker compose exec -T postgres psql -U app -d openwebui`) both documented.
- `OLD_PREFIX` referenced 6 times across the subsection — captured in step 2, used in step 9 grep, unset in step 10.
- `OWUI_SECRET_KEY` referenced 3 times — once in the cross-reference paragraph, twice in the irreversibility callout.
- Rollback note present (`If step 8's smoke fails ... revert .env to the old token ...`).
- Anti-patterns reminder present (`NEVER paste the bearer ... NEVER expose the router publicly without Tailscale ... NEVER skip step 9's verification grep ... NEVER use grep "$OLD_TOKEN" instead of grep "$OLD_PREFIX"`).
- `## Operations` parent section preserved (1 occurrence).
- `## Anti-patterns rejected by this stack` section preserved (1 occurrence).
- All 12 plan-`<verify>` automated gates pass on `git diff`-clean tree.
- Commit `1a95edc` (docs — README OPS-04 subsection) present in `git log`.

---
*Phase: 09-operations-hardening*
*Completed: 2026-05-17*
