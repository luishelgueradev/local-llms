---
phase: 09-operations-hardening
fixed_at: 2026-05-17T00:00:00Z
review_path: .planning/phases/09-operations-hardening/09-REVIEW.md
iteration: 1
findings_in_scope: 8
fixed: 8
skipped: 0
status: all_fixed
---

# Phase 9: Code Review Fix Report

**Fixed at:** 2026-05-17
**Source review:** `.planning/phases/09-operations-hardening/09-REVIEW.md`
**Iteration:** 1

**Summary:**

- Findings in scope: 8 (CR-01, CR-02, WR-01..06)
- Fixed: 8
- Skipped: 0

Out-of-scope (info-tier — not addressed by this fix pass): IN-01, IN-02, IN-03, IN-04.

**Post-fix verification:**

- `bash -n` clean on `bin/disk-alert.sh`, `bin/gc-models.sh`, `bin/backup-postgres.sh`.
- `bin/disk-alert.sh --self-test-url-host` prints 7 PASS lines and exits 0.
- `cd router && npm test` → 63 test files, 692 passed / 7 skipped (the review baseline was 691; one additional passing test is reported by vitest after the fix pass — no regressions).
- End-to-end test of the new RS+NUL wire format (WR-04): `tsx scripts/gc-classify.ts` output round-trips correctly through the bash `read -d ''` consumer, and a candidate path containing a literal TAB byte survives unchanged.

## Fixed Issues

### CR-01: `NTFY_URL` credential leak when URL is malformed or contains userinfo

**Files modified:** `bin/disk-alert.sh`
**Commit:** 4b591b9
**Applied fix:** Extracted host derivation into an `extract_url_host` shell function. (a) Validates the URL shape with `[[ ... =~ ^scheme://[^/]+ ]]` BEFORE any logging — returns `<no-scheme-configured>` for malformed input instead of the raw URL. (b) Strips any `userinfo@` segment with `sed -E 's|^[^/@]*@||'` before trimming the path so basic-auth credentials never reach the log line. Added a `--self-test-url-host` flag exercising 7 canned cases (the two CR-01 repros + port-preservation + bare-path + user-without-pass + happy-path http/https). All 7 PASS on first run; the self-test locks the regex against future regression.

### CR-02: Fixed `/tmp/gc-models-parser.err` is a symlink-attack target (TOCTOU)

**Files modified:** `bin/gc-models.sh`
**Commit:** 8ff1dc4
**Applied fix:** Replaced the hardcoded `/tmp/gc-models-parser.err` path with `PARSER_ERR="$(mktemp)"`, declared `PARSER_ERR=""` up front alongside the other temp-file vars, and extended the consolidated trap (from WR-03) to clean it up via `${PARSER_ERR:-}`. Removed both manual `rm -f /tmp/gc-models-parser.err` calls — the trap handles cleanup uniformly on every exit path. Closes the symlink-attack window.

### WR-01: HOST_DATA_ROOT-as-symlink breaks the candidate path stripping

**Files modified:** `bin/gc-models.sh`
**Commit:** 71fba1f
**Applied fix:** Canonicalized `HOST_DATA_ROOT` itself with `readlink -f` into a new `HOST_DATA_ROOT_CANONICAL` variable (after the existence check) and used the canonical form as the strip prefix in both candidate emitters (gguf + hf branches). Downstream filesystem operations (`du`, `mkdir`, `mv`) now also build paths against the canonical root so source + destination stay on the same filesystem for atomic `mv`. User-facing error messages and the report banner still display the literal `${HOST_DATA_ROOT}` so output keeps matching the operator's mental model. Verified with a synthetic `/tmp` symlink — stripping against the literal path returned the full canonical path unchanged; stripping against the canonical correctly produced `models-gguf/gguf/foo.gguf`.

### WR-02: `set -e` enabled at line 294 of disk-alert.sh changes script semantics for the remainder

**Files modified:** `bin/disk-alert.sh`
**Commit:** 944bb61
**Applied fix:** Removed both `set +e` and `set -e` around the curl call. The script header sets `-uo pipefail` only — `-e` was never on, so `set +e` was a no-op and `set -e` actually flipped errexit ON for the rest of the script. Under `set -uo pipefail`, the curl call's exit status is captured cleanly via `CURL_EXIT=$?` without any errexit juggling. Comment records the rationale so a future maintainer does not reintroduce the same pattern.

### WR-03: Brittle `trap` overwrite chain in gc-models.sh

**Files modified:** `bin/gc-models.sh`
**Commit:** 024e638
**Applied fix:** Replaced the three sequentially-overwriting EXIT traps with one consolidated trap installed up front. Pre-declared `CANDIDATES_FILE`, `CLASSIFIED_FILE`, and `UNREF_FILE` (and later `PARSER_ERR` in CR-02) as empty strings; the single trap references each via `${var:-}` so it is safe to fire before any assignment has happened. Tail `2>/dev/null || true` guarantees re-entry under `set -uo pipefail` cannot itself error. Removed the two later `trap ... EXIT` reinstall calls.

### WR-04: `read -r REF REASON RELPATH` will mangle paths containing tabs

**Files modified:** `bin/gc-models.sh`, `router/scripts/gc-classify.ts`
**Commit:** ec5b541
**Applied fix:** Switched the bash ↔ tsx wire format from `\t`-separated to **ASCII RS (0x1e) for field separator + NUL (0x00) for record terminator**. NUL is the one byte POSIX guarantees cannot appear in a path → safe outer delimiter. Bash's `read` cannot use NUL as a FIELD separator (it silently strips NULs from the input stream), so we use NUL as the OUTER record terminator and RS as the inner field separator: `while IFS=$'\x1e' read -r -d '' REF REASON RELPATH; do ...` reads one record per iteration and splits its 3 fields cleanly. Verified end-to-end with `tsx scripts/gc-classify.ts | xxd` (hexdump confirms `1.token-substring-match.<path>.0.-.<path>.` pattern with 0x1e and 0x00 in the expected positions) and round-trip of a path containing a literal TAB byte preserved verbatim. The `classifyCandidate()` unit tests are unaffected — they call the function directly, not through the gc-classify.ts wire layer.

### WR-05: `BACKUP_KEEP_POLICY` unquoted splat trusts operator-controlled string as restic flags

**Files modified:** `bin/backup-postgres.sh`
**Commit:** 97a488f
**Applied fix:** Pre-validated `${BACKUP_KEEP_POLICY}` as an even-length whitespace-separated sequence of `--keep-(last|hourly|daily|weekly|monthly|yearly) <positive-integer>` pairs **before** splatting it into restic's argv. Hostile or typo'd inputs (`--keep-tag x; rm -rf /`, `--keep-daily seven`, odd-length token lists, negative or zero counts) are rejected with a clear FAIL message + exit 1. Verified against 10 canned cases — 3 valid policies pass, 7 hostile / typo'd inputs are correctly rejected. Default policy (`--keep-daily 7 --keep-weekly 4 --keep-monthly 6`) is unchanged.

### WR-06: README OPS-04 step-9 grep recipe leaks the prefix into shell history

**Files modified:** `README.md`
**Commit:** 3839c0c
**Applied fix:** Added a blockquote sub-section under the existing "Clean shell history" recipe documenting equivalents for zsh (`history -d N` works; `fc -W` replaces `history -w`; `unset HISTFILE` purges a session without writing to disk), fish (`history delete --contains "bearer"`), and tmux/screen scrollback (`Ctrl+b :clear-history` / `tmux clear-history`; `Ctrl+a H` in screen). README-only — no code or schema impact.

## Skipped Issues

None — all 8 in-scope findings were fixed.

---

_Fixed: 2026-05-17_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
