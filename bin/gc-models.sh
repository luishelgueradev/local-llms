#!/usr/bin/env bash
# bin/gc-models.sh — DESTRUCTIVE (with --apply): garbage-collect unreferenced
# model files under ${HOST_DATA_ROOT}/models-gguf/ + ${HOST_DATA_ROOT}/models-hf/
# against the model entries declared in router/models.yaml.
#
# WARNING — DATA LOSS (only with --apply):
#   `--apply` MOVES unreferenced files into ${HOST_DATA_ROOT}/.gc-trash/<ts>/
#   via `mv` (atomic, same filesystem). It does NOT call `rm` (T-09-D
#   mitigation). The operator manually removes the trash dir after confirming
#   the GC was correct. Trash retention is the operator's responsibility — this
#   script does NOT auto-purge.
#
#   Default mode is DRY-RUN: prints the candidate list, never touches the
#   filesystem.
#
# Usage:
#   bin/gc-models.sh                                  # dry-run (default)
#   bin/gc-models.sh --apply                          # interactive confirm
#   bin/gc-models.sh --apply --yes                    # non-interactive
#   bin/gc-models.sh -h | --help                      # this help
#
# Trash dir convention:
#   ${HOST_DATA_ROOT}/.gc-trash/<ISO-8601-timestamp>/<relative-path>
#
# Allowlist guarantee (T-09-E mitigation):
#   The script REFUSES to operate on any path that, after `readlink -f`
#   resolution, does NOT start with one of:
#     ${HOST_DATA_ROOT}/models-gguf/
#     ${HOST_DATA_ROOT}/models-hf/
#   Symlinks are excluded from the candidate set (`find ... -not -type l`).
#
# What is NOT GC'd (documented limitations — see README §Operations):
#   - Anything under models-gguf/ollama/ — Ollama's internal blob store. Use
#     `docker compose exec ollama ollama rm <model>` to free those blobs
#     through Ollama's own GC.
#   - Dotfiles / hidden directories (.gc-trash/ itself, .cache/, etc.).
#   - Any file whose basename contains a substring of a `name:` or
#     `backend_model:` value in router/models.yaml (coarse — intentional
#     false-positive bias).
#
# Exit codes:
#   0  Dry-run completed OR --apply moved all queued files successfully.
#   1  Pre-flight failure (missing models.yaml, unreadable HOST_DATA_ROOT,
#      node/tsx unavailable) OR confirmation refused OR one or more mv
#      operations failed.
#
# References:
#   - .planning/phases/09-operations-hardening/09-01-PLAN.md (OPS-01)
#   - bin/restore-drill.sh — destructive-ops template (Pattern B; --yes flag +
#     interactive confirmation phrase; FAILURES counter)
#   - router/src/ops/gcModels.ts — parser logic (re-used here via `node -e`)

set -uo pipefail

# ─── Locate repo root + worktree paths ───────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

# ─── Failure tracking — Pattern G (PATTERNS.md §G) ───────────────────────────
FAILURES=0
fail() { echo "[gc-models] FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }
pass() { echo "[gc-models] PASS: $*"; }

# ─── CLI ─────────────────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
Usage: bin/gc-models.sh [--apply] [--yes]

  (no args)           DRY-RUN. List unreferenced model files; never delete.
  --apply             DESTRUCTIVE: move unreferenced files to .gc-trash/<ts>/.
                      Requires interactive 'GC' confirmation phrase OR --yes.
  --yes               Skip the interactive 'GC' phrase (still DESTRUCTIVE).
  -h | --help         This help.

The script scans:
  ${HOST_DATA_ROOT}/models-gguf/gguf/   (file-level matching)
  ${HOST_DATA_ROOT}/models-hf/          (top-level dir matching)

Files / dirs are REFERENCED (kept) if their basename or any path segment
matches a `name:` or `backend_model:` entry in router/models.yaml. Files
under models-gguf/ollama/ are ALWAYS kept — use `docker compose exec ollama
ollama rm <model>` for Ollama's blob store. Dotfiles are always kept.

DESTRUCTIVE mode (--apply) moves files via `mv` to
  ${HOST_DATA_ROOT}/.gc-trash/<ISO-timestamp>/<relative-path>
and prints the trash dir. The operator removes the trash dir manually.
This script never calls `rm` (T-09-D safety).

Confirmation phrase: type 'GC' verbatim at the prompt.
USAGE
}

APPLY=0
YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=1
      shift
      ;;
    --yes)
      YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[gc-models] ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# ─── Env resolution: HOST_DATA_ROOT (same idiom as restore-drill.sh:116-138) ─
# Caller env wins; otherwise extract a single variable from .env without
# sourcing the entire file.
if [[ -z "${HOST_DATA_ROOT:-}" ]] && [[ -f "${REPO_ROOT}/.env" ]]; then
  HOST_DATA_ROOT=$(
    grep -E '^HOST_DATA_ROOT=' "${REPO_ROOT}/.env" \
      | tail -1 \
      | cut -d= -f2- \
      | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
  )
fi
HOST_DATA_ROOT="${HOST_DATA_ROOT:-/srv/local-llms}"

# ─── Pre-flight ──────────────────────────────────────────────────────────────
MODELS_YAML="${REPO_ROOT}/router/models.yaml"
if [[ ! -f "${MODELS_YAML}" ]]; then
  echo "[gc-models] ERROR: models.yaml not found at ${MODELS_YAML}" >&2
  exit 1
fi

if [[ ! -d "${HOST_DATA_ROOT}" ]]; then
  echo "[gc-models] ERROR: HOST_DATA_ROOT does not exist: ${HOST_DATA_ROOT}" >&2
  echo "[gc-models]        Did you run bin/bootstrap-host.sh?" >&2
  exit 1
fi

# Resolve the two allowlisted roots once (readlink -f → canonical path).
ROOT_GGUF="$(readlink -f "${HOST_DATA_ROOT}/models-gguf" 2>/dev/null || true)"
ROOT_HF="$(readlink -f "${HOST_DATA_ROOT}/models-hf" 2>/dev/null || true)"
if [[ -z "${ROOT_GGUF}" ]] || [[ ! -d "${ROOT_GGUF}" ]]; then
  echo "[gc-models] ERROR: ${HOST_DATA_ROOT}/models-gguf does not resolve to a directory" >&2
  exit 1
fi
if [[ -z "${ROOT_HF}" ]] || [[ ! -d "${ROOT_HF}" ]]; then
  echo "[gc-models] ERROR: ${HOST_DATA_ROOT}/models-hf does not resolve to a directory" >&2
  exit 1
fi

# Node must be available (router parser runs via `node -e`).
if ! command -v node >/dev/null 2>&1; then
  echo "[gc-models] ERROR: 'node' is not on PATH — required to invoke the parser" >&2
  exit 1
fi

# ─── Parser invocation — pull referenced token set via tsx ───────────────────
# We invoke router/scripts/gc-classify.ts via tsx so the parser stays single-
# source-of-truth (router/src/ops/gcModels.ts) and we don't reimplement
# substring matching in awk. tsx is already a devDependency.
#
# A file (vs `tsx --eval`) lets the import './src/ops/gcModels.ts' resolve
# relative to the script regardless of the CWD the operator runs us from.
#
# Output (per stdin line): <0|1>\t<reason>\t<relPath>
ROUTER_DIR="${REPO_ROOT}/router"
CLASSIFY_HELPER="${ROUTER_DIR}/scripts/gc-classify.ts"
if [[ ! -d "${ROUTER_DIR}/node_modules/tsx" ]]; then
  echo "[gc-models] ERROR: tsx not found at ${ROUTER_DIR}/node_modules/tsx" >&2
  echo "[gc-models]        Run: cd router && npm install" >&2
  exit 1
fi
TSX_BIN="${ROUTER_DIR}/node_modules/.bin/tsx"
if [[ ! -x "${TSX_BIN}" ]]; then
  echo "[gc-models] ERROR: tsx binary not executable at ${TSX_BIN}" >&2
  exit 1
fi
if [[ ! -f "${CLASSIFY_HELPER}" ]]; then
  echo "[gc-models] ERROR: classifier helper missing: ${CLASSIFY_HELPER}" >&2
  exit 1
fi

# ─── Build candidate list ────────────────────────────────────────────────────
# Candidates:
#   - Regular files (not symlinks) directly under models-gguf/gguf/.
#   - Top-level entries (files OR dirs, not symlinks) directly under models-hf/.
# Explicitly EXCLUDED via find prune:
#   - models-gguf/ollama/        (Ollama's blob store; opaque to coarse parse)
#   - .gc-trash/                 (recursion safety — never GC the trash)
#   - any dotfile / dot-dir      (handled by classifyCandidate as hidden-file)
CANDIDATES_FILE="$(mktemp)"
trap 'rm -f "${CANDIDATES_FILE}"' EXIT

# models-gguf/gguf/*.gguf — files only.
if [[ -d "${ROOT_GGUF}/gguf" ]]; then
  find "${ROOT_GGUF}/gguf" \
    -maxdepth 1 \
    -mindepth 1 \
    -type f \
    -not -type l \
    -not -name '.*' \
    2>/dev/null \
    | while IFS= read -r f; do
        # Re-resolve via readlink -f and verify allowlist prefix (T-09-E).
        RESOLVED="$(readlink -f "$f" 2>/dev/null || true)"
        if [[ -z "${RESOLVED}" ]]; then
          continue
        fi
        if [[ "${RESOLVED}" != "${ROOT_GGUF}/"* ]]; then
          echo "[gc-models] WARN: skipping path outside allowlist: ${f} → ${RESOLVED}" >&2
          continue
        fi
        # Emit as a path relative to HOST_DATA_ROOT.
        echo "${RESOLVED#${HOST_DATA_ROOT}/}"
      done >> "${CANDIDATES_FILE}"
fi

# models-hf/<top-level-entry> — both files and dirs.
find "${ROOT_HF}" \
  -maxdepth 1 \
  -mindepth 1 \
  -not -type l \
  -not -name '.*' \
  2>/dev/null \
  | while IFS= read -r e; do
      RESOLVED="$(readlink -f "$e" 2>/dev/null || true)"
      if [[ -z "${RESOLVED}" ]]; then
        continue
      fi
      if [[ "${RESOLVED}" != "${ROOT_HF}/"* ]] && [[ "${RESOLVED}" != "${ROOT_HF}" ]]; then
        echo "[gc-models] WARN: skipping path outside allowlist: ${e} → ${RESOLVED}" >&2
        continue
      fi
      echo "${RESOLVED#${HOST_DATA_ROOT}/}"
    done >> "${CANDIDATES_FILE}"

CANDIDATE_COUNT="$(wc -l < "${CANDIDATES_FILE}" | tr -d ' ')"
echo "[gc-models] Scanning ${CANDIDATE_COUNT} candidate(s) under ${HOST_DATA_ROOT}/{models-gguf/gguf,models-hf}"

# ─── Classify candidates via the parser ──────────────────────────────────────
CLASSIFIED_FILE="$(mktemp)"
trap 'rm -f "${CANDIDATES_FILE}" "${CLASSIFIED_FILE}"' EXIT

if [[ "${CANDIDATE_COUNT}" -gt 0 ]]; then
  if ! (cd "${ROUTER_DIR}" && "${TSX_BIN}" "${CLASSIFY_HELPER}" "${MODELS_YAML}") \
       < "${CANDIDATES_FILE}" > "${CLASSIFIED_FILE}" 2>/tmp/gc-models-parser.err; then
    echo "[gc-models] ERROR: classifier failed. Stderr:" >&2
    cat /tmp/gc-models-parser.err >&2 || true
    rm -f /tmp/gc-models-parser.err
    exit 1
  fi
  rm -f /tmp/gc-models-parser.err
fi

# ─── Build the unreferenced (to-GC) list ─────────────────────────────────────
UNREF_FILE="$(mktemp)"
trap 'rm -f "${CANDIDATES_FILE}" "${CLASSIFIED_FILE}" "${UNREF_FILE}"' EXIT

# Each line of CLASSIFIED_FILE: <0|1><TAB><reason><TAB><relPath>
# Filter referenced=0 only.
while IFS=$'\t' read -r REF REASON RELPATH; do
  if [[ "${REF}" == "0" ]] && [[ -n "${RELPATH}" ]]; then
    echo "${RELPATH}" >> "${UNREF_FILE}"
  fi
done < "${CLASSIFIED_FILE}"

UNREF_COUNT="$(wc -l < "${UNREF_FILE}" | tr -d ' ')"

# ─── Print report ────────────────────────────────────────────────────────────
echo ""
echo "[gc-models] ============================================================"
if [[ "${APPLY}" == "1" ]]; then
  echo "[gc-models]  MODE: --apply (DESTRUCTIVE; move-to-trash)"
else
  echo "[gc-models]  MODE: dry-run (no filesystem changes)"
fi
echo "[gc-models]  HOST_DATA_ROOT: ${HOST_DATA_ROOT}"
echo "[gc-models]  models.yaml   : ${MODELS_YAML}"
echo "[gc-models]  Candidates    : ${CANDIDATE_COUNT}"
echo "[gc-models]  Unreferenced  : ${UNREF_COUNT}"
echo "[gc-models] ============================================================"

if [[ "${UNREF_COUNT}" -eq 0 ]]; then
  echo "[gc-models] Nothing to GC — every candidate is referenced by router/models.yaml."
  exit 0
fi

# Print each unreferenced path with size.
TOTAL_BYTES=0
echo ""
echo "[gc-models] Unreferenced files / dirs:"
while IFS= read -r REL; do
  ABS="${HOST_DATA_ROOT}/${REL}"
  if [[ -e "${ABS}" ]]; then
    # Use du -sb for both files and dirs (apparent size, bytes).
    SIZE_BYTES="$(du -sb "${ABS}" 2>/dev/null | awk '{print $1}')"
    SIZE_BYTES="${SIZE_BYTES:-0}"
    SIZE_HUMAN="$(du -sh "${ABS}" 2>/dev/null | awk '{print $1}')"
    SIZE_HUMAN="${SIZE_HUMAN:-?}"
    TOTAL_BYTES=$((TOTAL_BYTES + SIZE_BYTES))
    printf '  %8s  %s\n' "${SIZE_HUMAN}" "${REL}"
  else
    printf '  %8s  %s  (vanished — race?)\n' "?" "${REL}"
  fi
done < "${UNREF_FILE}"

# Human-readable total.
TOTAL_HUMAN="$(numfmt --to=iec --suffix=B "${TOTAL_BYTES}" 2>/dev/null || echo "${TOTAL_BYTES} bytes")"
echo ""
echo "[gc-models] Total reclaimable: ${TOTAL_HUMAN}"

# ─── Dry-run terminus ────────────────────────────────────────────────────────
if [[ "${APPLY}" != "1" ]]; then
  echo ""
  echo "[gc-models] Dry-run complete. Re-run with --apply to move these to .gc-trash/."
  exit 0
fi

# ─── --apply: confirmation gate ──────────────────────────────────────────────
echo ""
echo "[gc-models] WARNING: --apply will MOVE the above files into:"
TS="$(date -u +"%Y-%m-%dT%H-%M-%S")"
TRASH_DIR="${HOST_DATA_ROOT}/.gc-trash/${TS}"
echo "[gc-models]            ${TRASH_DIR}/"
echo "[gc-models]          Trash is NOT auto-purged; remove it manually after"
echo "[gc-models]          confirming the GC was correct."
echo ""

if [[ "${YES}" != "1" ]]; then
  if [[ ! -t 0 ]]; then
    echo "[gc-models] ERROR: --apply requires either --yes or an interactive TTY." >&2
    echo "[gc-models]        Type 'GC' at the prompt to proceed, or pass --yes." >&2
    exit 1
  fi
  read -r -p "Type 'GC' to proceed (anything else aborts): " CONFIRM
  if [[ "${CONFIRM}" != "GC" ]]; then
    echo "[gc-models] aborted — confirmation phrase not provided."
    exit 1
  fi
fi

# ─── Move-to-trash (atomic mv within the same filesystem; T-09-D) ────────────
# Each iteration below does:  mv ${SRC} ${HOST_DATA_ROOT}/.gc-trash/${TS}/${REL}
# This is the load-bearing T-09-D mitigation: `mv` to .gc-trash/ — NEVER `rm`.
mkdir -p "${TRASH_DIR}"
MOVED=0
while IFS= read -r REL; do
  SRC="${HOST_DATA_ROOT}/${REL}"
  DST="${TRASH_DIR}/${REL}"
  if [[ ! -e "${SRC}" ]]; then
    fail "source vanished (race?): ${SRC}"
    continue
  fi
  # Re-assert allowlist on SRC (defense-in-depth — T-09-E).
  RESOLVED_SRC="$(readlink -f "${SRC}" 2>/dev/null || true)"
  if [[ -z "${RESOLVED_SRC}" ]]; then
    fail "could not resolve source: ${SRC}"
    continue
  fi
  if [[ "${RESOLVED_SRC}" != "${ROOT_GGUF}/"* ]] && [[ "${RESOLVED_SRC}" != "${ROOT_HF}/"* ]]; then
    fail "refusing to GC path outside allowlist: ${SRC} → ${RESOLVED_SRC}"
    continue
  fi
  # Create the parent dir lazily under TRASH_DIR.
  DST_PARENT="$(dirname "${DST}")"
  mkdir -p "${DST_PARENT}"
  if mv "${SRC}" "${DST}" 2>/dev/null; then
    pass "moved ${REL} → ${DST}"
    MOVED=$((MOVED + 1))
  else
    fail "mv failed: ${SRC} → ${DST}"
  fi
done < "${UNREF_FILE}"

# ─── Final summary ───────────────────────────────────────────────────────────
echo ""
echo "[gc-models] ============================================================"
if [[ "${FAILURES}" -eq 0 ]]; then
  echo "[gc-models]  PASS — GC complete: ${MOVED} item(s) moved to trash."
  echo "[gc-models]  Trash dir: ${TRASH_DIR}"
  echo "[gc-models]  Remove manually after confirming, e.g.:"
  echo "[gc-models]      rm -rf '${TRASH_DIR}'"
  echo "[gc-models] ============================================================"
  exit 0
else
  echo "[gc-models]  FAIL — ${FAILURES} item(s) did not move."
  echo "[gc-models]  Moved: ${MOVED} / Failed: ${FAILURES}"
  echo "[gc-models]  Trash dir (partial): ${TRASH_DIR}"
  echo "[gc-models] ============================================================"
  exit 1
fi
