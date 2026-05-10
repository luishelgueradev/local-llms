---
type: todo
status: pending
created: 2026-05-10
source: gsd-code-review (01-REVIEW.md)
priority: low
resolves_phase: ""
---

# Phase 01 — script cleanup follow-up

Non-blocking warnings + info items from `01-REVIEW.md` that were intentionally deferred when closing Phase 1 (the user chose "fix criticals only, file warnings as TODO"). Pick these up alongside Phase 2 router work or as a small quality-of-life pass.

## Warnings

| ID    | File                       | Line(s) | Issue |
|-------|----------------------------|---------|-------|
| WR-01 | `bin/preflight-gpu.sh`     | 97-115  | Documented HOST_DATA_ROOT priority is "env var > .env" but code does the opposite. Permanent no-op for the env-var guard. |
| WR-02 | `bin/preflight-gpu.sh`     | ~239-240| Dead variable `v` in `capture_cuda_version` — runs a redundant nvidia-smi call. |
| WR-03 | `bin/gpu-init-libcuda.sh`  | 54      | `TARGET_DIR` hardcoded to `/usr/lib/x86_64-linux-gnu`. Breaks on non-x86_64 hosts (irrelevant today; flag for future portability). |
| WR-04 | `bin/bootstrap-host.sh`    | 32-57   | `_create_dirs()` is dead in the sudo path — sudo branch inlines the seven `mkdir -p` calls. Future directory additions must be made in two places. |
| WR-05 | `bin/smoke-test-gpu.sh`    | 187-195 | (resolved by CR-02 fix in commit 5264e9e — env-var pattern now used here too. Verify and close.) |
| WR-06 | `bin/preflight-gpu.sh`     | ~555-558| Fallback JSON path: `mv "${TMPFILE}" "${STATE_FILE}"` has no error handler. Python path handles this correctly. |
| WR-07 | `bin/smoke-test-gpu.sh`    | ~373    | Success banner unconditionally prints "GPU residency: confirmed via /api/ps (size_vram > 0)" regardless of which path (python vs grep fallback) was exercised. |

## Info items

| ID    | File                       | Line | Note |
|-------|----------------------------|------|------|
| IN-01 | `.gitignore`               | 9    | `.preflight-state.json` pattern matches a file that lives outside the repo (at `HOST_DATA_ROOT`). Harmless but misleading. |
| IN-02 | `bin/preflight-gpu.sh`     | ~334 | In-container mode maps check `container_nvidia_smi` to `check_host_nvidia_smi`. Behavior is correct but the cross-naming is confusing during code archaeology. |
| IN-03 | `bin/gpu-init-libcuda.sh`  | 1    | `/bin/sh` shebang fine for current Ubuntu-based ollama image; will silently break if reused with Alpine where `ldconfig` may not exist (line 63 `|| true` makes this graceful, but worth a doc note). |

## How to close

When picked up: open as a small plan (Plan 1.1-01 or as part of Phase 2 prep) following the standard `/gsd-quick` flow per item, or batch them into a single PR. None affect Phase 1's Walking Skeleton; all five SCs pass on real hardware.
