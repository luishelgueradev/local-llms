---
status: resolved
phase: 02-mvp-vertical-slice-router-ollama-sse
source: [02-VERIFICATION.md]
started: 2026-05-12T00:00:00Z
updated: 2026-05-12T00:00:00Z
---

## Current Test

[all tests resolved]

## Tests

### 1. SC3 live abort — kill curl mid-stream and confirm Ollama stops generating within ~1s
expected: Ollama /api/ps `expires_at` delta = 0s between two snapshots 1.5s apart (model went idle, not still generating). Code path uses `req.raw.socket?.once('close', onClose)` → `controller.abort()` → SDK signal → undici closes upstream TCP. Optional chaining (WR-05) silently no-ops when `req.raw.socket` is undefined (vitest `inject()` harness, future HTTP/2 under Traefik) — only a real TCP socket close fires the abort, so the test harness cannot replicate this end-to-end.
result: passed
evidence: |
  Operator ran `bash bin/smoke-test-router.sh` against the real GPU on 2026-05-12 (fresh run after SC5 regex fix and router rebuild):
  ```
  [smoke-test-router] SC3: kill curl mid-stream + poll Ollama /api/ps for VRAM drop ...
  [smoke-test-router] PASS: SC3: abort propagated to Ollama (PASS:static expires_at delta=0.00s)
  ```
  Static `expires_at` delta = 0.00s between the two 1.5s-spaced `/api/ps` snapshots proves Ollama stopped generating immediately after curl was killed (vs. an increasing delta which would indicate `keep_alive` reset because generation continued).
  Full run: 32 chunks streamed, then Ctrl-C, then snapshot probes — model entry's `expires_at` did not advance. All other SCs green in the same run (SC1 stream + usage + [DONE]; SC2 non-stream + usage; SC4 auth + hot-reload; SC5 zero leaks).

## Summary

total: 1
passed: 1
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

(none)
