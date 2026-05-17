---
phase: 09-operations-hardening
reviewed: 2026-05-17T00:00:00Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - .env.example
  - README.md
  - bin/backup-postgres.sh
  - bin/disk-alert.sh
  - bin/gc-models.sh
  - router/scripts/gc-classify.ts
  - router/src/ops/gcModels.ts
  - router/tests/ops/gc-models.test.ts
findings:
  critical: 2
  warning: 6
  info: 4
  total: 12
status: issues_found
---

# Phase 9: Code Review Report

**Reviewed:** 2026-05-17
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Phase 9 ships four operations-hardening surfaces (OPS-01..04) split across three bash scripts (`bin/gc-models.sh`, `bin/backup-postgres.sh`, `bin/disk-alert.sh`), one TypeScript helper module + classify bridge, a test file, and a substantial README §Operations section. The work shows clear safety discipline overall — explicit allowlist guarantees, move-to-trash semantics, password-never-on-argv for restic, explicit refusal to fall back to `/` when `HOST_DATA_ROOT` is missing, redacted log statements — and the test coverage of `gcModels.ts` is correct and exhaustive against the documented decision tree.

However, the adversarial pass surfaces two BLOCKER-class defects that defeat the script-level safety contracts the headers advertise:

- **`bin/disk-alert.sh` — T-09-I-05 mitigation has a fall-through path that leaks the full `NTFY_URL` credential.** A malformed `NTFY_URL` (no `scheme://` prefix) OR one carrying URL-userinfo (`user:pass@host`) bypasses the sed-based host extraction, and the secondary log line emits the full URL — exactly the leak the mitigation is supposed to prevent.
- **`bin/gc-models.sh` — fixed `/tmp/gc-models-parser.err` path is a symlink-attack target.** Every other temp file in the script uses `mktemp`; this one is hardcoded, allowing a pre-placed symlink (even by the same user across stale sessions, or by any process in the same uid namespace) to redirect parser stderr writes onto arbitrary files.

The remaining warnings are correctness / hygiene issues — most notably a `set -e` enabled at the wrong scope, an incorrect symlink-aware path calculation in the GC candidate emitter, and a brittle `trap` overwrite chain — all of which are quality defects rather than data-loss risks.

## Critical Issues

### CR-01: `NTFY_URL` credential leak when URL is malformed or contains userinfo

**File:** `bin/disk-alert.sh:298`
**Issue:** The host-only extraction sed is supposed to be the T-09-I-05 mitigation guaranteeing the full `NTFY_URL` value never appears in any log line. The implementation has two breakdown modes that defeat that mitigation:

```bash
URL_HOST=$(echo "${NTFY_URL}" | sed -E 's|^[a-z]+://([^/]+).*|\1|')
```

1. **Malformed URL (no scheme prefix):** if an operator sets `NTFY_URL=ntfy.sh/secret-topic-abc123` (missing `https://`) — easy mistake when pasting an `openssl rand -hex 8` topic into `.env` — the sed pattern does not match and `sed` returns the input UNCHANGED. `URL_HOST` becomes `ntfy.sh/secret-topic-abc123` (i.e. the full URL — the credential). Verified:

   ```text
   $ echo "ntfy.sh/secret-topic-abc123" | sed -E 's|^[a-z]+://([^/]+).*|\1|'
   ntfy.sh/secret-topic-abc123          # the credential, unchanged
   ```

2. **URL with embedded basic-auth userinfo:** for self-hosted ntfy via Tailscale Serve where the operator has put credentials in the URL (`https://user:pass@ntfy.example.com/topic`), the sed captures `[^/]+` which includes the `user:pass@` userinfo. Verified:

   ```text
   $ echo "https://user:pass@ntfy.example.com/topic" | sed -E 's|^[a-z]+://([^/]+).*|\1|'
   user:pass@ntfy.example.com
   ```

Both leaks land in the script's stdout via the `printf '... url_host=%s ...'` (line 299), which the recommended crontab recipe redirects to `/var/log/local-llms-disk.log` — exactly the disclosure path the mitigation was designed to prevent. The header at line 22 and line 69-72 explicitly claim "Full NTFY_URL value never echoed".

**Fix:** Validate the URL shape before logging and strip userinfo. Two-step extraction:

```bash
# Step 1: refuse to log anything if NTFY_URL lacks a proper scheme://host shape.
if ! [[ "${NTFY_URL}" =~ ^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+ ]]; then
  printf '[disk-alert] LEVEL=WARN hook=ntfy curl_exit=%s url_host=<malformed-url-redacted> ts=%s hostname=%s\n' \
    "${CURL_EXIT}" "${TS}" "${HOSTNAME_SHORT}"
else
  # Step 2: extract host, stripping any userinfo (user:pass@) prefix.
  URL_HOST=$(echo "${NTFY_URL}" \
    | sed -E 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' \
    | sed -E 's|^[^/]*@||' \
    | sed -E 's|/.*$||')
  printf '[disk-alert] LEVEL=WARN hook=ntfy curl_exit=%s url_host=%s ts=%s hostname=%s\n' \
    "${CURL_EXIT}" "${URL_HOST}" "${TS}" "${HOSTNAME_SHORT}"
fi
```

Add a vitest-equivalent shell-level test (or an inline `expected-output` check) covering both leak vectors so this doesn't regress.

---

### CR-02: Fixed `/tmp/gc-models-parser.err` is a symlink-attack target (TOCTOU)

**File:** `bin/gc-models.sh:251, 253, 254, 257`
**Issue:** The script uses `mktemp` correctly for every other temp file it owns (`CANDIDATES_FILE`, `CLASSIFIED_FILE`, `UNREF_FILE`) — but for the parser stderr capture it uses a hardcoded path:

```bash
if ! (cd "${ROUTER_DIR}" && "${TSX_BIN}" "${CLASSIFY_HELPER}" "${MODELS_YAML}") \
     < "${CANDIDATES_FILE}" > "${CLASSIFIED_FILE}" 2>/tmp/gc-models-parser.err; then
  echo "[gc-models] ERROR: classifier failed. Stderr:" >&2
  cat /tmp/gc-models-parser.err >&2 || true
  rm -f /tmp/gc-models-parser.err
  exit 1
fi
rm -f /tmp/gc-models-parser.err
```

Because the filename is predictable and writeable to any process under the same uid (and on a shared `/tmp`, often world-writeable as a directory), any prior invocation of `bin/gc-models.sh` or a hostile local process can pre-create `/tmp/gc-models-parser.err` as a symlink pointing at e.g. `~/.ssh/authorized_keys`, the operator's `.env`, or another arbitrary file owned by the same user. When the script redirects stderr via `2>/tmp/gc-models-parser.err`, bash follows the symlink and TRUNCATES the target — destructive even when the parser emits zero stderr bytes. The single-user project posture (CLAUDE.md `Operacional: usuario único`) lowers the practical risk but does not eliminate it (CI agents, stale sessions, an unprivileged user via a misconfigured service account).

Note: the `rm -f /tmp/gc-models-parser.err` at lines 254 and 257 does NOT close this — by the time it runs the truncation has already happened.

**Fix:** Use `mktemp` like every other temp file in the script:

```bash
PARSER_ERR="$(mktemp)"
# Extend the existing trap to include this:
trap 'rm -f "${CANDIDATES_FILE}" "${CLASSIFIED_FILE}" "${UNREF_FILE}" "${PARSER_ERR}"' EXIT

if [[ "${CANDIDATE_COUNT}" -gt 0 ]]; then
  if ! (cd "${ROUTER_DIR}" && "${TSX_BIN}" "${CLASSIFY_HELPER}" "${MODELS_YAML}") \
       < "${CANDIDATES_FILE}" > "${CLASSIFIED_FILE}" 2>"${PARSER_ERR}"; then
    echo "[gc-models] ERROR: classifier failed. Stderr:" >&2
    cat "${PARSER_ERR}" >&2 || true
    exit 1
  fi
fi
```

This also removes the manual `rm -f` calls — the trap handles cleanup uniformly.

## Warnings

### WR-01: HOST_DATA_ROOT-as-symlink breaks the candidate path stripping

**File:** `bin/gc-models.sh:219, 239`
**Issue:** The candidate emitter computes `ROOT_GGUF` and `ROOT_HF` via `readlink -f` (lines 145-146) — they are canonical (absolute, symlink-resolved) paths. The candidate emitter then resolves each file via `readlink -f` again and strips the `HOST_DATA_ROOT` prefix to produce a relative path:

```bash
echo "${RESOLVED#${HOST_DATA_ROOT}/}"   # lines 219, 239
```

But `${HOST_DATA_ROOT}` is the LITERAL operator-provided value (e.g. `/srv/local-llms`), not the canonical path. If `HOST_DATA_ROOT` itself is a symlink (a reasonable deployment pattern — `/srv/local-llms → /mnt/data-volume`), then `RESOLVED` starts with `/mnt/data-volume/...` while the prefix being stripped is `/srv/local-llms/`. The strip fails and the absolute canonical path gets written to `CANDIDATES_FILE` as if it were a relative path.

Verified with a synthetic symlink:

```text
ROOT_GGUF=/tmp/hdrtest/link_target/models-gguf
RESOLVED=/tmp/hdrtest/link_target/models-gguf/gguf/foo.gguf
${RESOLVED#${HOST_DATA_ROOT}/} = /tmp/hdrtest/link_target/models-gguf/gguf/foo.gguf  # NOT stripped
```

Downstream effects:
1. The classifier (`gcModels.ts`) marks every entry as `outside-allowlist` (saved by the safety bias — no data loss).
2. The dry-run report's `du -sb "${HOST_DATA_ROOT}/${REL}"` (line 301) builds a nonexistent path → every candidate prints `vanished — race?` → operator sees a confusing report and may distrust the tool.
3. The `Total reclaimable` total is 0 even when there are real GC candidates → operator never reclaims disk in this configuration.

**Fix:** Strip relative to the canonical `HOST_DATA_ROOT`, not the literal one:

```bash
# Canonicalize HOST_DATA_ROOT once after the existence check:
HOST_DATA_ROOT_CANONICAL="$(readlink -f "${HOST_DATA_ROOT}" 2>/dev/null || true)"
if [[ -z "${HOST_DATA_ROOT_CANONICAL}" ]]; then
  echo "[gc-models] ERROR: cannot canonicalize HOST_DATA_ROOT=${HOST_DATA_ROOT}" >&2
  exit 1
fi

# Then use canonical for both the allowlist check AND the relative-path strip:
echo "${RESOLVED#${HOST_DATA_ROOT_CANONICAL}/}"
```

Apply consistently anywhere `${HOST_DATA_ROOT}/${REL}` is constructed (lines 298, 353, 354).

### WR-02: `set -e` enabled at line 294 of disk-alert.sh changes script semantics for the remainder

**File:** `bin/disk-alert.sh:286, 294`
**Issue:** The script header sets `set -uo pipefail` only (no `-e`). The block that wraps `curl` does:

```bash
set +e
curl --fail -sS --max-time 10 ... "${NTFY_URL}" >/dev/null 2>&1
CURL_EXIT=$?
set -e         # ← BUG: enables errexit that was never on
```

`set -e` at line 294 ENABLES `errexit` for the rest of the script — it was never on before. Verified:

```text
$- before set +e:  huB
$- after set +e:   huB         (no change — -e was already off)
$- after set -e:   ehuB        (e is now in $- — errexit is on)
```

Practical impact today is small — only `[[ ]]` tests and a `printf` follow before `exit 0`. But:
1. Any future addition between line 295 and `exit 0` that happens to exit non-zero will silently abort the script and break the "exit 0 always" contract from the header (line 40).
2. The pattern is wrong in intent. The author wanted to scope `set +e` around the `curl` call without flipping `-e` on/off; since `-e` was never on, the `set +e`/`set -e` pair is doing the opposite of guarding.

**Fix:** Just remove both `set +e` and `set -e` — the `curl ... ; CURL_EXIT=$?` capture works fine under the prevailing `set -uo pipefail`:

```bash
curl --fail -sS --max-time 10 \
  -H 'Title: local-llms disk alert' \
  -H 'Priority: high' \
  -H 'Tags: warning,disk' \
  -d "${MSG}" \
  "${NTFY_URL}" >/dev/null 2>&1
CURL_EXIT=$?
```

If the project later adopts `set -e` at the top, scope the curl with `|| true` and read `$PIPESTATUS[0]`, or with an explicit `if curl ...; then CURL_EXIT=0; else CURL_EXIT=$?; fi`.

### WR-03: Brittle `trap` overwrite chain in gc-models.sh

**File:** `bin/gc-models.sh:197, 247, 262`
**Issue:** The script installs three different `EXIT` traps, each overwriting the previous:

```bash
trap 'rm -f "${CANDIDATES_FILE}"' EXIT                                                # line 197
# ... later ...
trap 'rm -f "${CANDIDATES_FILE}" "${CLASSIFIED_FILE}"' EXIT                          # line 247
# ... later ...
trap 'rm -f "${CANDIDATES_FILE}" "${CLASSIFIED_FILE}" "${UNREF_FILE}"' EXIT          # line 262
```

The final trap covers all three files so the steady-state happy path works. But the pattern is fragile in two ways:

1. If the script exits between, say, lines 248 and 261 (e.g. an `errexit` is added later, or a child invocation aborts the parent), only `CANDIDATES_FILE` and `CLASSIFIED_FILE` are cleaned — but in *that* window `UNREF_FILE` hasn't been assigned yet, so under `set -u` the trap body would fail on `${UNREF_FILE:?}` expansion if `set -u` were respected inside `trap` (it isn't — `trap` runs with the caller's options at trap-fire time, BUT the variable expansion inside the `'...'` of the trap argument happens at trap-fire time, so the unset var would trigger `set -u`).
2. Future maintainers adding more temp files will have to remember to overwrite the trap rather than `trap -p` and extend.

**Fix:** Declare all temp file variables up front (empty), install one trap that covers them all, and assign as you go:

```bash
CANDIDATES_FILE=""
CLASSIFIED_FILE=""
UNREF_FILE=""
PARSER_ERR=""
trap 'rm -f "${CANDIDATES_FILE:-}" "${CLASSIFIED_FILE:-}" "${UNREF_FILE:-}" "${PARSER_ERR:-}" 2>/dev/null || true' EXIT

CANDIDATES_FILE="$(mktemp)"
# ... etc
```

The `:-` defaults make the trap safe to run before any temp file has been assigned. One trap, one place to extend.

### WR-04: `read -r REF REASON RELPATH` will mangle paths containing tabs

**File:** `bin/gc-models.sh:266`
**Issue:** The classifier emits `<0|1>\t<reason>\t<relPath>` lines. The shell consumes them with:

```bash
while IFS=$'\t' read -r REF REASON RELPATH; do
```

This is correct for the 3-field tab-separated shape — `read` stops splitting after the third assignment, so additional tabs in the path would be folded into `RELPATH`. Good for that case. BUT: if a path happens to contain a literal `\t`, the first tab becomes the REF/REASON separator and the rest of the path lands in RELPATH which would silently truncate or corrupt the operation. Practical risk is low (filenames with tabs are rare and would have to survive the upstream `find` printing path) but the contract is wider than the tests cover.

**Fix:** Either:
1. Document and assert "no tabs in path" upstream (the candidate emitter has full control of the path values — emit `printf '%s\0'` plus consume with `read -d ''`); or
2. Replace the tab-separated wire format with NUL-separated and consume with `read -r -d ''` in three reads per candidate.

For v1 the safer-and-cheaper change is to switch to a `|` or non-printable delimiter and add a pre-emit assertion that path contains no `|`.

### WR-05: `BACKUP_KEEP_POLICY` unquoted splat trusts operator-controlled string as restic flags

**File:** `bin/backup-postgres.sh:281`
**Issue:**

```bash
# shellcheck disable=SC2086  # intentional word-splitting of policy override
FORGET_ARGS=( ${BACKUP_KEEP_POLICY} --prune )
```

The shellcheck-disable comment acknowledges the intentional splat — but it splats verbatim into restic's argv with no sanity check. If `.env` somehow contains `BACKUP_KEEP_POLICY="--keep-tag x; rm -rf /"` or just a typo'd `--keep-daily seven`, the bad flags go straight to restic. Worse, restic versions vary in how strict they are about unknown flags — some treat unknown subcommand flags as paths.

The risk is operator-self-harm rather than supply-chain, but the existing `BACKUP_RESTIC_PASSWORD < 16` check at line 193 sets a precedent that the script DOES validate operator-supplied env vars. The retention-policy field should at minimum:

1. Pre-validate that every space-separated word starts with `--` or is a positive integer.
2. Refuse and `fail` with a clear message otherwise.

**Fix:**

```bash
if [[ -n "${BACKUP_KEEP_POLICY:-}" ]]; then
  # Cheap shape gate: every token is either --flag or a positive integer.
  for tok in ${BACKUP_KEEP_POLICY}; do
    if ! [[ "${tok}" =~ ^(--[a-z-]+|[0-9]+)$ ]]; then
      fail "BACKUP_KEEP_POLICY contains invalid token '${tok}' — must be --flag or positive integer."
      exit 1
    fi
  done
  FORGET_ARGS=( ${BACKUP_KEEP_POLICY} --prune )
fi
```

This does not constrain operators to a fixed set of flags but it eliminates the worst footguns.

### WR-06: README OPS-04 step-9 grep recipe leaks the prefix into shell history

**File:** `README.md:1635-1639, 1637`
**Issue:** The procedure carefully avoids putting the FULL old token in shell history (step 2 captures only the 8-char prefix via command substitution into `OLD_PREFIX`), then step 9 greps for it:

```bash
for svc in router openwebui traefik; do
  echo "=== $svc ==="
  docker compose logs "$svc" --since 24h 2>&1 | grep -c "$OLD_PREFIX" || echo 0
done
```

This is fine — the variable substitution happens at execution time, not write-time, so history records `grep -c "$OLD_PREFIX"` (literally), not the expanded prefix. Good.

BUT: line 1542 captures the prefix via a pipeline that includes a `grep '^ROUTER_BEARER_TOKEN=' .env`:

```bash
OLD_PREFIX=$(grep '^ROUTER_BEARER_TOKEN=' .env | sed 's/^ROUTER_BEARER_TOKEN=//' | sed 's/^local-llms_//' | head -c 8)
```

The grep argument is a literal pattern (`'^ROUTER_BEARER_TOKEN='`), so history records the command — not the token. Good. The token never lands in history through this path.

The actual concern: step 10 at line 1655 suggests cleaning history with:

```bash
history | grep -i 'bearer\|ROUTER_BEARER_TOKEN' | grep -v '^[0-9]*  history\|^[0-9]*  grep'
```

This emits matching history lines to stdout. If the operator's history contains a line like `curl -H "Authorization: Bearer <full-token-typed-inline>" ...` (an anti-pattern the procedure warns against in line 1706), then this grep PRINTS the full token to the terminal — at the point where the operator is about to clean it up. The visible-on-screen exposure is brief but acceptable for the cleanup intent.

The real omission is that the procedure does NOT also recommend purging `tmux` / `screen` scrollback or `~/.zsh_history` (only `~/.bash_history` is mentioned via `history -w`). For zsh users the recipe is wrong (`history -d <linenum>` exists in zsh but `history -w` does not — zsh writes on exit).

**Fix:** Add a one-line caveat under the "Clean shell history" bullet:

```markdown
> **Shell-specific note:** the `history -d N` + `history -w` recipe is bash-specific.
> For zsh: `history -d N` works the same; `fc -W` writes the file. For fish: `history delete --contains "bearer"`.
> Additionally, scrub any open `tmux` / `screen` scrollback (`Ctrl+b :clear-history` in tmux).
```

## Info

### IN-01: `gc-classify.ts` imports `'../src/ops/gcModels.ts'` while tests import `'../../src/ops/gcModels.js'`

**File:** `router/scripts/gc-classify.ts:22`, `router/tests/ops/gc-models.test.ts:38`
**Issue:** Inconsistent extension on cross-module imports. `gc-classify.ts` uses `.ts`; the test file uses `.js`. Both work under tsx / vitest with their respective resolvers, but the inconsistency is a future-foot-gun — if the project later switches to a stricter NodeNext resolution or tightens `verbatimModuleSyntax` (per CLAUDE.md recommendation), one of these breaks.

**Fix:** Pick one and use it everywhere. With Node 22's ESM + `"type": "module"` the canonical form is `.js` (rewriting `.ts` at build/runtime). Standardize on `.js`:

```ts
// router/scripts/gc-classify.ts
import { collectReferencedTokens, classifyCandidate } from '../src/ops/gcModels.js';
```

### IN-02: `BACKUP_LOG=$(mktemp -t backup-postgres-backup.XXXXXX)` runs before trap installation

**File:** `bin/backup-postgres.sh:243-246`
**Issue:**

```bash
BACKUP_LOG=$(mktemp -t backup-postgres-backup.XXXXXX)
trap 'rm -f "${BACKUP_LOG:-}" "${FORGET_LOG:-}" 2>/dev/null || true' EXIT
```

If the script is killed by SIGTERM between `mktemp` (line 243) and `trap` (line 246), the temp file leaks. The window is microseconds, but the canonical pattern is to install the trap first with `:-` defaults, then assign:

```bash
BACKUP_LOG=""
FORGET_LOG=""
trap 'rm -f "${BACKUP_LOG:-}" "${FORGET_LOG:-}" 2>/dev/null || true' EXIT
BACKUP_LOG=$(mktemp ...)
```

This is purely a leak-hygiene concern; not a correctness or security issue.

### IN-03: `ls -t | head -1` to pick newest dump is fragile

**File:** `bin/backup-postgres.sh:213`
**Issue:**

```bash
LATEST=$(ls -t "${BACKUP_DIR}"/router-*.dump 2>/dev/null | head -1)
```

Parsing `ls` output is a known shell anti-pattern (filenames with spaces / newlines / control chars break it). In this specific case the pg-backup sidecar emits a strict `router-YYYY-MM-DDTHH.dump` format and the operator does not control the filename, so the practical risk is zero — but the pattern is one a future code reviewer (or shellcheck) will flag.

**Fix:** Use a `find` + `sort -r | head -1` recipe that handles weird filenames:

```bash
LATEST=$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'router-*.dump' -printf '%T@\t%p\n' \
         | sort -nr \
         | head -1 \
         | cut -f2-)
```

Or, since the filename's `YYYY-MM-DDTHH` lexically sorts identically to mtime for this naming convention, simpler:

```bash
LATEST=$(printf '%s\n' "${BACKUP_DIR}"/router-*.dump | sort -r | head -1)
[[ -f "${LATEST}" ]] || LATEST=""
```

### IN-04: `gc-models.sh` dry-run report uses `du -sb` per candidate — slow on large HF dirs

**File:** `bin/gc-models.sh:301-303`
**Issue:**

```bash
SIZE_BYTES="$(du -sb "${ABS}" 2>/dev/null | awk '{print $1}')"
# ...
SIZE_HUMAN="$(du -sh "${ABS}" 2>/dev/null | awk '{print $1}')"
```

For each unreferenced candidate the script runs `du` twice — once for `-b` (apparent bytes for total) and once for `-h` (human display). `du -sb` on a multi-GB HF cache dir walks the entire tree once; doing it twice doubles the wall time. For a typical 16 GB HF dir on spinning rust this is tens of seconds.

This is out of v1 scope per the review charter (performance is excluded), but a one-line fix is in reach: run `du -sb` once, format the human suffix in shell with `numfmt`:

```bash
SIZE_BYTES="$(du -sb "${ABS}" 2>/dev/null | awk '{print $1}')"
SIZE_BYTES="${SIZE_BYTES:-0}"
SIZE_HUMAN="$(numfmt --to=iec --suffix=B "${SIZE_BYTES}" 2>/dev/null || echo "${SIZE_BYTES}B")"
```

This also makes the human-readable output consistent with the `TOTAL_HUMAN` line at line 313 which already uses `numfmt`. Captured as Info since it's both correctness-neutral and out-of-scope per v1 charter.

---

_Reviewed: 2026-05-17_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
