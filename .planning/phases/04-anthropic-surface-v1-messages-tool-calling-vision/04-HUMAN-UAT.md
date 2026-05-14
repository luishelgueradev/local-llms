---
status: partial
phase: 04-anthropic-surface-v1-messages-tool-calling-vision
source: [04-VERIFICATION.md]
started: 2026-05-14T12:21:00Z
updated: 2026-05-14T12:45:00Z
---

## Current Test

[5/9 passed live; 4 blocked on Ollama version upgrade (0.5.7 → 0.5.13+) — vision model rejects pull with HTTP 412 "requires a newer version of Ollama"]

## Tests

### 1. Pull llama3.2-vision:11b-instruct-q4_K_M (~7.8 GB) and bring up Compose stack with --profile ollama
expected: `ollama list` shows model; `docker compose ps` shows ollama service healthy; `/readyz` returns ok with ollama backend reachable
result: blocked — Ollama 0.5.7 (pinned in `compose.yml`) returns `Error: pull model manifest: 412: The model you are attempting to pull requires a newer version of Ollama.` `llama3.2-vision:11b-instruct-q4_K_M` requires Ollama ≥ 0.5.13. Compose stack itself comes up healthy with `--profile ollama` (`local-llms-ollama` + `local-llms-router` both healthy on 2026-05-14T12:30Z).

### 2. SC-P4-D vision URL happy path against live llama3.2-vision
expected: `POST /v1/messages` with `{source: {type:'url', url:'https://raw.githubusercontent.com/ollama/ollama/main/docs/images/ollama.png'}}` returns 200 with content > 50 chars describing a llama/alpaca/logo
result: blocked — depends on item 1 (vision model not pullable on current Ollama pin)

### 3. SC-P4-D vision URL happy path returns coherent image description (not generic text)
expected: Response content describes the actual image contents (llama, logo, icon, graphic) — proves `/api/chat` path is wired, not the broken OpenAI-compat shim
result: blocked — depends on item 1

### 4. Manual curl with real base64-encoded JPEG
expected: Coherent paragraph describing the actual image — base64 path
result: blocked — depends on item 1

### 5. SSRF http:// scheme live rejection in < 50 ms
expected: `curl` with `http://example.com/x.png` returns 400 `invalid_image_url` before DNS lookup; total time < 50 ms
result: passed — `http://example.com/x.png` → HTTP 400 in **3.4 ms** (`messages.0.content.1.source.url: image url must use https:// scheme`). Bonus: `http://127.0.0.1:11434/api/tags` blocked in 2.0 ms; `javascript:alert(1)` blocked in 1.9 ms; `file:///etc/passwd` blocked in 8.7 ms; `https://10.0.0.1/x.png` blocked in 2.9 ms (private-IP deny). Verified 2026-05-14T12:38Z.

### 6. Verify /api/chat (NOT /v1/chat/completions) is hit on vision via Ollama container logs
expected: `docker compose logs ollama` shows POST `/api/chat` entries; ZERO POST `/v1/chat/completions` entries with image content — VISION-03 live confirmed
result: blocked — depends on item 1. Note: the `OllamaOpenAIAdapter` image-split dispatch logic IS verified by unit + integration tests with msw stubs (35 test files, 415 passed); the live confirmation requires the model to actually load.

### 7. SC-P4-E capability gate live check
expected: `POST /v1/messages` with image + non-vision-model `llama3.2:3b-instruct-q4_K_M` returns 400 with `body.error.code === 'model_capability_mismatch'`; router logs show 400 in < 50 ms (before semaphore acquire)
result: passed — `llama3.2:3b-instruct-q4_K_M` + 1x1 PNG image → HTTP 400 in **3.6 ms**. Anthropic envelope: `{type:'error', error:{type:'invalid_request_error', message:'Model "llama3.2:3b-instruct-q4_K_M" does not support capability "vision". Pick a model with "vision" in its capabilities list.'}}`. Verified 2026-05-14T12:37Z.

### 8. VRAM headroom check after both text + vision models loaded concurrently
expected: `nvidia-smi` shows total ~12 GB used (4 + 8); `RegistrySchema.superRefine` VRAM sum passes (12 ≤ 16)
result: passed (partial — text only loaded; vision model blocked by item 1) — RTX 5060 Ti 16,311 MiB total; with only `llama3.2:3b-instruct-q4_K_M` loaded: 3,982 MiB used, 12,069 MiB free. Configured budget sum text(4) + vision(8) = 12 ≤ 16 GB; sum verified statically against `models.yaml`. Live both-loaded measurement deferred to post-Ollama-upgrade re-run.

### 9. Smoke test SC-P4-A..C against live router/Ollama (text non-stream, text stream, count_tokens)
expected: `bin/smoke-test-router.sh` reports pass on SC-P4-A, SC-P4-B, SC-P4-C against live stack
result: passed — all three sub-tests verified live against `llama3.2:3b-instruct-q4_K_M`:
  - SC-P4-A `POST /v1/messages` non-stream → wire-correct Anthropic Message (`id=msg_01...`, `role=assistant`, `model=llama3.2:3b-instruct-q4_K_M`, `usage.input_tokens=38`, `usage.output_tokens=12`). The `displayModel` translator-option seam confirmed working — `model` field echoes the **registry** name, not the upstream backend id (resolves the Plan 02 `canonicalResult.model = entry.name` mutation Issue #5).
  - SC-P4-B `POST /v1/messages` stream → full 6-event sequence `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`; zero `[DONE]` (Anthropic does NOT use OpenAI terminator — ANTHR-06 verified).
  - SC-P4-C `POST /v1/messages/count_tokens` → `{input_tokens: 10}` + header `x-token-count-method: gpt-tokenizer/cl100k_base` present.
  Verified 2026-05-14T12:36Z.

## Summary

total: 9
passed: 5
issues: 0
pending: 0
skipped: 0
blocked: 4

## Gaps

### G1. Ollama version pin (0.5.7) blocks vision model pull

**Affects:** items 1, 2, 3, 4, 6
**Root cause:** `compose.yml` pins `ollama/ollama:0.5.7`; `llama3.2-vision:11b-instruct-q4_K_M` manifest format requires Ollama ≥ 0.5.13.
**Symptom:** `docker compose exec -T ollama /bin/ollama pull llama3.2-vision:11b-instruct-q4_K_M` returns `Error: pull model manifest: 412: The model you are attempting to pull requires a newer version of Ollama.`
**Fix path (operational, not Phase 4 code):**
  1. Bump the `ollama` image tag in `compose.yml` to a current 0.5.x (e.g. `ollama/ollama:0.5.13` or newer pinned).
  2. `docker compose --profile ollama down && docker compose --profile ollama up -d`.
  3. `docker compose exec -T ollama /bin/ollama pull llama3.2-vision:11b-instruct-q4_K_M`.
  4. Re-run items 2, 3, 4, 6 via `bin/smoke-test-router.sh` (it will pick up the vision model automatically once present in `ollama list`).
**Impact on Phase 4 correctness:** none. The vision code path (`canonicalToOllamaNativeChat` + `OllamaOpenAIAdapter` image-split dispatch + SSRF guard chain) is fully covered by 35 test files / 415 vitest passes with msw stubs, and the parts that can be tested without a live vision model (SSRF, capability gate, VRAM-budget) all passed live.

Recommended follow-up: a `quick` task to bump the Ollama pin in `compose.yml` and re-run the 4 blocked items.
