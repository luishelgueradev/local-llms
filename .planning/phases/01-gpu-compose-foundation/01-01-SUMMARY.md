---
phase: 01-gpu-compose-foundation
plan: "01"
subsystem: host-bootstrap
tags:
  - bootstrap
  - filesystem
  - env-schema
  - idempotent
dependency_graph:
  requires: []
  provides:
    - host-data-root at /srv/local-llms with full v1 directory tree
    - .env.example committed with 8 v1 keys per D-14
    - .gitignore excluding .env and .preflight-state.json
    - README.md with 5-step first-boot runbook
  affects:
    - 01-02 (preflight-gpu uses HOST_DATA_ROOT from .env; writes .preflight-state.json)
    - 01-03 (compose.yml bind-mounts reference HOST_DATA_ROOT from .env)
    - 01-04 (smoke-test-gpu.sh reads Ollama model from models-gguf/ollama)
    - 05 (Postgres will use /srv/local-llms/postgres — chown footgun documented)
    - 08 (Valkey will use /srv/local-llms/valkey — chown footgun documented)
tech_stack:
  added: []
  patterns:
    - bash with set -euo pipefail for all bin/*.sh scripts
    - Conditional sudo: try non-root mkdir first, fall back to sudo on permission error
    - HOST_DATA_ROOT read from .env if present, fall back to /srv/local-llms
    - Heredoc (cat <<'NEXTSTEPS' ... NEXTSTEPS) for multi-line user-facing output in scripts
key_files:
  created:
    - bin/bootstrap-host.sh
    - .env.example
    - .gitignore
    - README.md
  modified: []
decisions:
  - "Use bash (not POSIX sh) for all bin/ scripts — WSL2 target always has bash"
  - "Heredoc for next-steps output avoids shell-interpretation of documentation strings (docker compose, ollama pull appear in help text only, not as executed commands)"
  - "Conditional sudo detection: mkdir -p test_$$ first; only use sudo on permission failure"
  - "Chown guard: compare stat uid vs id -u before running chown to keep idempotent re-runs clean"
metrics:
  duration: "8 minutes"
  completed: "2026-05-10"
  tasks_completed: 3
  files_created: 4
---

# Phase 1 Plan 1: Host Bootstrap and Env Schema Summary

Idempotent host bootstrap script, `.env` / `.env.example` schema with all 8 v1 keys, `.gitignore`, and README first-boot runbook — the foundation every later phase inherits.

## What Was Built

### bin/bootstrap-host.sh (128 lines, executable)

Idempotent bash script that creates the full v1 host tree under `HOST_DATA_ROOT` (`/srv/local-llms` by default), sets ownership to the invoking user, copies `.env.example` → `.env` if missing, and prints actionable next steps.

Key implementation details:
- Resolves `HOST_DATA_ROOT` from `.env` if present, falls back to `/srv/local-llms`
- Detects if `HOST_DATA_ROOT` needs sudo by attempting a non-root `mkdir -p` test first
- Uses conditional chown: only runs if `stat uid != id -u` (idempotent on re-run)
- Carries the verbatim `FUTURE FOOTGUN` comment block in the chown section warning about Phase 5 (Postgres) and Phase 8 (Valkey)

### .env.example (committed)

Exactly 8 v1 keys per D-14:

```
COMPOSE_PROJECT_NAME=local-llms
HOST_DATA_ROOT=/srv/local-llms
ROUTER_BEARER_TOKEN=
OLLAMA_API_KEY=
POSTGRES_PASSWORD=
VALKEY_PASSWORD=
TRAEFIK_ACME_EMAIL=
TRAEFIK_BASIC_AUTH=
```

- 2 non-empty defaults (project/path keys)
- 6 empty values (secret keys, each with generation instructions)
- Each section header annotated with the phase that first consumes the key

### .gitignore

Excludes: `.env`, `.env.local`, `.env.*.local`, `.preflight-state.json`, `node_modules/`, `dist/`, `.tsbuildinfo`, `*.log`, OS clutter, IDE files. Pre-emptive Node entries avoid amending `.gitignore` in Phase 2.

### README.md (95 lines)

5-step first-boot runbook:
1. `bash bin/bootstrap-host.sh` — runs today
2. `bash bin/preflight-gpu.sh` — *(Comes online with Plan 02)*
3. `docker compose up -d` — *(Comes online with Plan 03)*
4. `docker compose exec ollama ollama pull llama3.2:3b-instruct-q4_K_M` — *(Comes online with Plan 04)*
5. `bash bin/smoke-test-gpu.sh` — *(Comes online with Plan 04)*

Includes: hardware requirements, NVIDIA Container Toolkit install steps, WSL2 anti-patterns, layout overview, anti-patterns section. Load-bearing future-phase chown callout in Step 1.

## Verification Results

Final `/srv/local-llms` tree after bootstrap:
```
/srv/local-llms/
  models-gguf/
    gguf/        (empty — Phase 3 populates)
    ollama/      (empty — Phase 1 populates after compose up + pull)
  models-hf/     (empty — Phase 7 populates)
  postgres/      (empty — Phase 5 populates)
  valkey/        (empty — Phase 8 populates)
  traefik/
    acme/        (empty — Phase 6 populates)
    logs/        (empty — Phase 6 populates)
```

Idempotence: both runs exited 0 with no diff to the directory tree.

FUTURE FOOTGUN comment tokens confirmed in `bin/bootstrap-host.sh`:
- `FUTURE FOOTGUN`: 1 occurrence
- `Phase 5`: 2 occurrences  
- `Phase 8`: 2 occurrences
- `postgres`: 6 occurrences (including mkdir-p creation and chown warning)
- `valkey`: 6 occurrences (including mkdir-p creation and chown warning)

FUTURE FOOTGUN footgun also documented in README.md Step 1 (1 occurrence of "FUTURE FOOTGUN").

No Phase 2+ implementation details leaked into README (only forward references with "Comes online with Plan NN" annotations).

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written with one known edge case:

### Known Edge Case: grep test for forbidden commands has false positives on heredoc content

**Acceptance criterion:** `grep -vE '^[[:space:]]*#' bin/bootstrap-host.sh | grep -cE '(apt install|curl \| sh|ollama pull|docker compose)' == 0`

**Actual:** The script uses a heredoc (`cat <<'NEXTSTEPS' ... NEXTSTEPS`) to print next-steps documentation for the user. The heredoc body contains `docker compose up -d` and `docker compose exec ollama ollama pull llama3.2:3b-instruct-q4_K_M` as *documentation strings* — not executed commands.

**Why this is correct behavior:** The plan explicitly requires printing these exact strings as next steps. The grep test is a heuristic designed to catch accidental execution of these commands; it cannot distinguish between heredoc body content (documentation output) and actual shell command execution.

**Functional verification:** The script does NOT execute `apt install`, `curl | sh`, `ollama pull`, or `docker compose` as commands — verified by `bash -x` trace showing only `mkdir`, `chown`, `cp`, `stat`, `cat`, and `echo` as executed commands.

## Known Stubs

None — this plan creates filesystem infrastructure and documentation, not UI or data-rendering components.

## Threat Flags

No new security-relevant surface beyond what the plan's `<threat_model>` covers. T-01-01 through T-01-06 are all addressed:
- T-01-01 (`.env` committed): mitigated by `.gitignore` — `git check-ignore .env` exits 0
- T-01-04 (`.env` permissions): mitigated — chmod 600 in bootstrap script
- T-01-06 (re-run chown after Phase 5/8): mitigated by documentation — `FUTURE FOOTGUN` comment block in both `bin/bootstrap-host.sh` and `README.md`

## Self-Check: PASSED

All created files verified to exist:
- `bin/bootstrap-host.sh`: FOUND (executable)
- `.env.example`: FOUND
- `.gitignore`: FOUND
- `README.md`: FOUND
- `.env`: FOUND (git-ignored, not committed — correct)

All commits verified to exist in git history:
- `94c1e07` (Task 1): feat(01-01): add idempotent host bootstrap script
- `6c6ce37` (Task 2): feat(01-01): add .env.example with 8 v1 keys and .gitignore
- `bafd7a0` (Task 3): docs(01-01): add README with first-boot runbook anchored on bootstrap

Host directory tree verified at `/srv/local-llms`:
- `models-gguf/ollama`: FOUND
- `models-gguf/gguf`: FOUND
- `models-hf`: FOUND
- `postgres`: FOUND
- `valkey`: FOUND
- `traefik/acme`: FOUND
- `traefik/logs`: FOUND
