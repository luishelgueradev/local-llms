---
status: partial
phase: 04-anthropic-surface-v1-messages-tool-calling-vision
source: [04-VERIFICATION.md]
started: 2026-05-14T12:21:00Z
updated: 2026-05-14T12:21:00Z
---

## Current Test

[awaiting human testing — Plan 04-05 Task 4 live-GPU smoke]

## Tests

### 1. Pull llama3.2-vision:11b-instruct-q4_K_M (~7.8 GB) and bring up Compose stack with --profile ollama
expected: `ollama list` shows model; `docker compose ps` shows ollama service healthy; `/readyz` returns ok with ollama backend reachable
result: [pending]

### 2. SC-P4-D vision URL happy path against live llama3.2-vision
expected: `POST /v1/messages` with `{source: {type:'url', url:'https://raw.githubusercontent.com/ollama/ollama/main/docs/images/ollama.png'}}` returns 200 with content > 50 chars describing a llama/alpaca/logo
result: [pending]

### 3. SC-P4-D vision URL happy path returns coherent image description (not generic text)
expected: Response content describes the actual image contents (llama, logo, icon, graphic) — proves `/api/chat` path is wired, not the broken OpenAI-compat shim
result: [pending]

### 4. Manual curl with real base64-encoded JPEG
expected: Coherent paragraph describing the actual image — base64 path
result: [pending]

### 5. SSRF http:// scheme live rejection in < 50 ms
expected: `curl` with `http://example.com/x.png` returns 400 `invalid_image_url` before DNS lookup; total time < 50 ms
result: [pending]

### 6. Verify /api/chat (NOT /v1/chat/completions) is hit on vision via Ollama container logs
expected: `docker compose logs ollama` shows POST `/api/chat` entries; ZERO POST `/v1/chat/completions` entries with image content — VISION-03 live confirmed
result: [pending]

### 7. SC-P4-E capability gate live check
expected: `POST /v1/messages` with image + non-vision-model `llama3.2:3b-instruct-q4_K_M` returns 400 with `body.error.code === 'model_capability_mismatch'`; router logs show 400 in < 50 ms (before semaphore acquire)
result: [pending]

### 8. VRAM headroom check after both text + vision models loaded concurrently
expected: `nvidia-smi` shows total ~12 GB used (4 + 8); `RegistrySchema.superRefine` VRAM sum passes (12 ≤ 16)
result: [pending]

### 9. Smoke test SC-P4-A..C against live router/Ollama (text non-stream, text stream, count_tokens)
expected: `bin/smoke-test-router.sh` reports pass on SC-P4-A, SC-P4-B, SC-P4-C against live stack
result: [pending]

## Summary

total: 9
passed: 0
issues: 0
pending: 9
skipped: 0
blocked: 0

## Gaps
