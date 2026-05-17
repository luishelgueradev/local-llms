---
phase: 09
plan: 01
subsystem: ops
tags: [ops, gc, models-yaml, dry-run, destructive, bash, vitest, tsx]
requires: [router/models.yaml, router/src/config/registry.ts, bin/restore-drill.sh]
provides: [bin/gc-models.sh, router/src/ops/gcModels.ts, router/scripts/gc-classify.ts, README§Operations]
affects: [router/tests/ops/, README.md]
tech-stack:
  added: []
  patterns: [destructive-ops-Pattern-B, tsx-shell-bridge, move-to-trash, readlink-allowlist]
key-files:
  created:
    - bin/gc-models.sh
    - router/src/ops/gcModels.ts
    - router/scripts/gc-classify.ts
    - router/tests/ops/gc-models.test.ts
  modified:
    - README.md
decisions:
  - "tsx helper as a FILE (router/scripts/gc-classify.ts), not `tsx --eval`: --eval resolves imports against CWD, breaks when bash is invoked from any non-router dir."
  - "Classifier emits '-' for empty reason field (not empty string): bash `read` with IFS=$'\\t' collapses consecutive tab whitespace, shifting columns when middle field is blank."
  - "Allowlist enforced at TWO layers — parser (router/src/ops/gcModels.ts rule 1) AND shell (readlink -f check before queueing + re-check before mv): defense-in-depth for T-09-E."
  - "models-gguf/ollama/ is opaque to coarse parsing — always treated as referenced; operator uses `docker compose exec ollama ollama rm`."
metrics:
  duration_minutes: 10
  tasks_completed: 2
  files_changed: 5
  tests_added: 9
  commits: 3
  completed_at: "2026-05-17T19:11:32Z"
---

# Phase 9 Plan 01: Garbage-collecting unused model files (OPS-01) Summary

`bin/gc-models.sh` scans `${HOST_DATA_ROOT}/models-gguf/gguf/` + `${HOST_DATA_ROOT}/models-hf/` against `router/models.yaml` entries; dry-run by default; `--apply` moves unreferenced files to `${HOST_DATA_ROOT}/.gc-trash/<ISO-ts>/` via atomic `mv` (never `rm`); gated by `GC` confirmation phrase + readlink-resolved allowlist (T-09-D + T-09-E mitigations).

## What shipped

### Parser TS helper (`router/src/ops/gcModels.ts`, 178 LOC)

Exports:

- **`collectReferencedTokens(yamlText: string): Set<string>`** — js-yaml parse, pulls `models[].name` AND `models[].backend_model` from every entry, returns the union. Throws descriptive `Error` on empty / malformed / missing-models input.
- **`classifyCandidate(relPath: string, tokens: Set<string>): { referenced: boolean, reason? }`** — first-match-wins decision tree:
  1. Outside allowlist (`models-gguf/` | `models-hf/`) → `referenced: true, reason: 'outside-allowlist'` (defense-in-depth at the parser layer).
  2. Any path segment starts with `.` → `referenced: true, reason: 'hidden-file'`.
  3. Under `models-gguf/ollama/` → `referenced: true, reason: 'ollama-blob-store'`.
  4. Top-level `models-hf/<org>--<repo>` reconstructs to `<org>/<repo>` and matches token set → `referenced: true, reason: 'hf-cache-dir-match'`.
  5. Any path segment contains any token as a SUBSTRING → `referenced: true, reason: 'token-substring-match'`.
  6. Otherwise → `referenced: false` (GC candidate).

Safety bias: coarse substring matching is intentional. False-positives (keeping a file that could be GC'd) are acceptable; false-negatives (deleting a referenced file) are not.

### Bash wrapper (`bin/gc-models.sh`, ~340 LOC)

- Shebang `#!/usr/bin/env bash`, `set -uo pipefail` exactly once.
- Header block with usage / exit-codes / trash convention / allowlist guarantee.
- CLI: `--apply` / `--yes` / `-h|--help`. No positional args.
- HOST_DATA_ROOT resolution: caller env wins, otherwise extract from `.env` via `grep | cut | sed` (no `source .env` — mirrors restore-drill.sh:116–138).
- Candidate scan: `find` with `-maxdepth 1`, `-not -type l`, `-not -name '.*'` against `models-gguf/gguf/` (files only) + `models-hf/` (top-level entries). Each candidate's `readlink -f` resolution must start with one of the two roots before queuing.
- Classifier invocation: `cd router && ./node_modules/.bin/tsx scripts/gc-classify.ts /path/to/models.yaml` with candidate list on stdin.
- Dry-run: print candidate list with `du -sh` per item + `numfmt`-formatted total reclaimable. Exit 0.
- `--apply`: print destructive plan + trash path; require interactive `GC` phrase OR `--yes` OR refuse with exit 1 (TTY check via `[[ -t 0 ]]`). On confirm: re-assert allowlist via readlink, `mkdir -p` parent under trash dir, `mv` the candidate. FAILURES counter tallies any move failure → exit 1.
- Trash convention: `${HOST_DATA_ROOT}/.gc-trash/$(date -u +"%Y-%m-%dT%H-%M-%S")/<rel-path>`. Sibling of `models-gguf/` + `models-hf/` → same filesystem → `mv` is atomic.

### tsx shell bridge (`router/scripts/gc-classify.ts`, 60 LOC)

stdin / stdout / argv adapter so the bash script invokes the same parser code the vitest suite covers. Single-source-of-truth — no shell duplication of substring matching.

Emits `<0|1>\t<reason-or-dash>\t<relPath>` per stdin line (the `-` placeholder for empty reason avoids bash `read` IFS-tab-collapse — see Deviations §1).

### Vitest test (`router/tests/ops/gc-models.test.ts`, 184 LOC)

9 tests, all green:

- 3× `collectReferencedTokens` cases (4-entry fixture; empty YAML; YAML without `models:`).
- 6× `classifyCandidate` cases (GGUF basename match; GGUF no-match; ollama-blob-store opacity; HF cache dir reconstruction match + no-match; dotfile rule; outside-allowlist rule).

### README §Operations + ### Garbage-collecting unused model files (OPS-01)

New top-level `## Operations` section between `## Phase 8` and `## Anti-patterns rejected` — first cross-cutting topical section (Phases 1–8 are chronological). The OPS-01 subsection documents dry-run recipe + sample output + `--apply` + `--yes` + trash semantics + allowlist guarantee + "what is NOT GC'd" disclaimer (`models-gguf/ollama/` → use `ollama rm`; substring bias; dotfiles always kept). HTML-comment anchors `<!-- OPS-02 -->`, `<!-- OPS-03 -->`, `<!-- OPS-04 -->` mark insertion points for Plans 09-02 / 03 / 04.

## Confirmation phrase + allowlist + trash convention

- **Confirmation phrase:** literal `GC` typed at stdin prompt (`read -r -p`). `--yes` flag bypasses for non-interactive. TTY-less invocation without `--yes` exits 1.
- **Allowlist:** `readlink -f` on every candidate must produce a path prefixed by `${HOST_DATA_ROOT}/models-gguf/` OR `${HOST_DATA_ROOT}/models-hf/`. Asserted at scan time AND re-asserted immediately before `mv` (defense-in-depth).
- **Trash dir:** `${HOST_DATA_ROOT}/.gc-trash/<UTC-ISO-ts>/<rel-path>`. Created lazily on first move per invocation. Never auto-purged — operator's responsibility.

## OPS-01 closure evidence

- **Artifact gates** (plan §verification):
  - `bash -n bin/gc-models.sh` → exit 0 ✓
  - `test -x bin/gc-models.sh` → exit 0 ✓
  - `grep -c 'set -uo pipefail' bin/gc-models.sh == 1` ✓
  - `grep -cE 'readlink -f' bin/gc-models.sh == 8` (>= 1 required) ✓
  - `grep -cE 'mv .*\\.gc-trash' bin/gc-models.sh == 1` (>= 1 required) ✓
  - `grep -cE "'GC'" bin/gc-models.sh == 5` (>= 1 required) ✓
  - `! grep -qE '^\\s*rm -rf' bin/gc-models.sh` ✓ (the one `rm -rf` is inside an `echo` doc string, not at line start)
  - `bin/gc-models.sh --help` exits 0 with usage ✓

- **Parser coverage:** 9/9 vitest cases pass; types resolved via tsx with no `tsc --noEmit` errors. Router build (`tsup`) → `dist/index.js 189.23 KB` clean.

- **Smoke (synthetic tree):** dry-run reports 2 unreferenced (`old-junk-model.gguf` + `Foo--Bar-7B`); `--apply --yes` moves both to `.gc-trash/<ts>/` preserving original directory structure; referenced GGUF + HF dir + Ollama blob untouched.

- **README discoverability:** `## Operations` + `### Garbage-collecting unused model files (OPS-01)` present (verified by grep gates).

OPS-01 closes structurally. Manual operator-against-live-stack smoke (not a Plan 09-01 gate) deferred to Phase 9 closure pass alongside OPS-02..04.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] tsx helper extracted to a file (not `tsx --eval`).**

- **Found during:** Task 1 first smoke test
- **Issue:** Plan's `<action>` step 3 sketched an inline `node -e "..."` or `tsx --eval "..."` invocation. tsx resolves module specifiers in `--eval` against the CWD (the directory bash was invoked from), not against the script — `import '../src/ops/gcModels.ts'` failed with `Cannot find module` when the GC script was run from the repo root.
- **Fix:** Created `router/scripts/gc-classify.ts` as a proper file. Bash invokes it via `(cd router && node_modules/.bin/tsx scripts/gc-classify.ts ${MODELS_YAML})` with the candidate list on stdin. The relative import resolves against the script's own location.
- **Files modified:** `router/scripts/gc-classify.ts` (new), `bin/gc-models.sh`
- **Commit:** 8353a23

**2. [Rule 1 — Bug] Classifier emits `-` placeholder for empty `reason`.**

- **Found during:** Task 1 second smoke test (dry-run reported "0 unreferenced" when 2 should have shown)
- **Issue:** Bash `while IFS=$'\t' read -r REF REASON RELPATH; do ...; done` collapses consecutive tab whitespace because `\t` is a POSIX IFS whitespace character. An emitted line `0\t\tmodels-gguf/foo` was parsed as `REF=0 REASON=models-gguf/foo RELPATH=""` — `REL` was always empty for unreferenced files, so the "unreferenced" filter never saw any path to act on.
- **Fix:** Classifier writes `result.reason ?? '-'` instead of `?? ''`. Single visible placeholder, never empty, parses correctly. Bash wrapper does not need to translate `-` back (the field is only used to skip referenced=1 paths; reason value is informational).
- **Files modified:** `router/scripts/gc-classify.ts`
- **Commit:** 8353a23

### No-deviation areas

- Plan's task scope split (Task 1 = script + helper + test; Task 2 = README) honored exactly.
- No router runtime code touched (Plan 09 is pure infra; gcModels.ts is reachable only via the bash script's tsx invocation — zero imports from `src/index.ts`).
- Pattern B confirmation gate (Phase 5 Plan 03) mirrored: `--yes` flag + interactive phrase + FAILURES counter pattern.

### Pre-existing flake (not caused by this plan)

`tests/integration/hotreload.vram.test.ts` fails 1/3 under full-suite CPU contention; passes in isolation. Same flake noted in STATE.md from Plan 08-09. Not caused by Plan 09-01 (gcModels.ts has zero imports into router runtime; full suite count went 683 → 691 pass / 7 skipped — +8 new from the 9 added here minus a pre-existing skipped slot freed elsewhere).

## Self-Check: PASSED

- `bin/gc-models.sh` exists, executable, syntax-clean ✓
- `router/src/ops/gcModels.ts` exists, exports `collectReferencedTokens` + `classifyCandidate` ✓
- `router/scripts/gc-classify.ts` exists ✓
- `router/tests/ops/gc-models.test.ts` exists, 9 tests pass ✓
- `README.md` has `## Operations` + `### Garbage-collecting unused model files (OPS-01)` ✓
- Commits e663217 (RED), 8353a23 (GREEN), 03ab048 (docs) present in git log ✓
- Router build clean ✓
- All plan §verification gates pass ✓
