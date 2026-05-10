#!/bin/sh
# bin/gpu-init-libcuda.sh — libcuda.so.1 projection workaround for
# Docker Desktop on Windows + WSL2.
#
# Why this exists
# ---------------
# Docker Desktop on Windows enables GPU containers via WSL2 driver
# projection. It exposes /dev/dxg, projects nvidia-smi, and projects
# libcuda.so under /usr/lib/wsl/drivers/<adapter-uuid>/libcuda.so.1.1
# — but it does NOT create the standard `libcuda.so.1` symlink in any
# linker search path. CUDA runtimes (the ollama llama_server, vLLM,
# llama.cpp) call dlopen("libcuda.so.1") and fail with:
#
#   error while loading shared libraries: libcuda.so.1: cannot open
#   shared object file: No such file or directory
#
# On native Linux with nvidia-container-toolkit installed, that symlink
# is created automatically by the container hook. On Docker Desktop's
# WSL2 GPU integration, the hook is not invoked.
#
# What this does
# --------------
# At container start, BEFORE exec'ing the real entrypoint:
#   1. If libcuda.so.1 is already in a standard linker path (native
#      Linux + NCT, or any image that already ships it): no-op.
#   2. Otherwise, find the WSL2-projected libcuda.so.1.1 and symlink
#      it as /usr/lib/x86_64-linux-gnu/libcuda.so{,.1}, then refresh
#      the linker cache.
#   3. Exec "$@" — the caller's command (e.g. /bin/ollama serve).
#
# Idempotent. Safe on every restart. Silently no-ops on systems where
# libcuda is already discoverable.

set -eu

# 1) Already-discoverable case → skip.
if ldconfig -p 2>/dev/null | grep -q "^[[:space:]]*libcuda\.so\.1[[:space:]]"; then
  exec "$@"
fi

# 2) Look for the WSL2 driver projection.
WSL_LIBCUDA=""
if [ -d /usr/lib/wsl ]; then
  WSL_LIBCUDA=$(find /usr/lib/wsl -maxdepth 4 -name 'libcuda.so.1.1' -type f 2>/dev/null | head -1)
fi

if [ -z "$WSL_LIBCUDA" ]; then
  # Neither native NCT nor WSL2 projection found. Don't add fake symlinks
  # — let the real entrypoint fail with its real diagnostic.
  exec "$@"
fi

# 3) Project libcuda into a standard linker path.
TARGET_DIR=/usr/lib/x86_64-linux-gnu
ln -sf "$WSL_LIBCUDA" "$TARGET_DIR/libcuda.so.1"
ln -sf "$WSL_LIBCUDA" "$TARGET_DIR/libcuda.so"

# Some distros also dlopen libnvidia-ml.so.1 by name — same projection issue.
WSL_DIR=$(dirname "$WSL_LIBCUDA")
[ -f "$WSL_DIR/libnvidia-ml.so.1" ] && ln -sf "$WSL_DIR/libnvidia-ml.so.1" "$TARGET_DIR/libnvidia-ml.so.1" || true

# Refresh ldconfig cache so dlopen("libcuda.so.1") resolves.
ldconfig 2>/dev/null || true

exec "$@"
