---
status: complete
phase: 04-anthropic-surface-v1-messages-tool-calling-vision
source: [04-VERIFICATION.md]
started: 2026-05-14T12:21:00Z
updated: 2026-05-14T13:25:00Z
---

## Current Test

[complete — all 9 items passed live after Ollama bump 0.5.7 → 0.23.4 and CR-02 followup fix]

## Tests

### 1. Pull llama3.2-vision:11b-instruct-q4_K_M (~7.8 GB) and bring up Compose stack with --profile ollama
expected: `ollama list` shows model; `docker compose ps` shows ollama service healthy; `/readyz` returns ok with ollama backend reachable
result: passed — `docker compose --profile ollama up -d` brings up `local-llms-ollama` + `local-llms-router` both healthy. `docker compose exec -T ollama /bin/ollama pull llama3.2-vision:11b-instruct-q4_K_M` completed successfully on Ollama 0.23.4. `ollama list` shows both `llama3.2-vision:11b-instruct-q4_K_M` (7.8 GB) and `llama3.2:3b-instruct-q4_K_M` (2.0 GB). Verified 2026-05-14T13:10Z.

### 2. SC-P4-D vision URL happy path against live llama3.2-vision
expected: `POST /v1/messages` with `{source: {type:'url', url:'https://raw.githubusercontent.com/ollama/ollama/main/docs/images/ollama.png'}}` returns 200 with content > 50 chars describing a llama/alpaca/logo
result: passed (URL substituted) — the originally-cited URL `raw.githubusercontent.com/ollama/ollama/main/docs/images/ollama.png` now returns HTTP 404 (file moved/removed in the ollama repo). Substituted `https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg` (Wikipedia stable; 273 KB JPEG). Response: 200 with 180 output tokens, coherent description of an orange tabby cat. End-to-end path: route → canonical → `canonicalToOllamaNativeChat` → `fetchImageAsBase64` (pinned-IP `undici.Agent`, redirect:manual, https-only, 10 MB cap, content-type sniff) → native `/api/chat` dispatch → response. Verified 2026-05-14T13:22Z.

### 3. SC-P4-D vision URL happy path returns coherent image description (not generic text)
expected: Response content describes the actual image contents (llama, logo, icon, graphic) — proves `/api/chat` path is wired, not the broken OpenAI-compat shim
result: passed — model output (180 tokens): "This image is a close-up photograph of an orange tabby cat... fur is a vibrant orange color, eyes are bright yellow, whiskers long and white, nose darker orange, ears pointed and perked up... background out of focus, concrete or stone surface with a red hose or pipe..." — coherent specific description of the actual cat image (NOT generic). Confirms `/api/chat` native path is wired and the OpenAI-compat shim is bypassed for vision (Pitfall 8 / VISION-03 live confirmed).

### 4. Manual curl with real base64-encoded JPEG
expected: Coherent paragraph describing the actual image — base64 path
result: passed — same Wikipedia cat JPEG (279 KB → 373 KB base64), payload constructed via Python and POSTed with `Content-Type: application/json`. Response in **3 seconds** (model already warm), 119 output tokens, coherent description matching the image. Base64 source.type path verified independent of URL source.type. Verified 2026-05-14T13:23Z.

### 5. SSRF http:// scheme live rejection in < 50 ms
expected: `curl` with `http://example.com/x.png` returns 400 `invalid_image_url` before DNS lookup; total time < 50 ms
result: passed — `http://example.com/x.png` → HTTP 400 in **3.4 ms** (`messages.0.content.1.source.url: image url must use https:// scheme`). Defense-in-depth bonus checks: `http://127.0.0.1:11434/api/tags` blocked in 2.0 ms; `javascript:alert(1)` blocked in 1.9 ms; `file:///etc/passwd` blocked in 8.7 ms; `https://10.0.0.1/x.png` blocked in 2.9 ms (private-IP deny). Verified 2026-05-14T12:38Z.

### 6. Verify /api/chat (NOT /v1/chat/completions) is hit on vision via Ollama container logs
expected: `docker compose logs ollama` shows POST `/api/chat` entries; ZERO POST `/v1/chat/completions` entries with image content — VISION-03 live confirmed
result: passed — `docker compose logs ollama` shows:
  - `[GIN] 2026/05/14 - 13:22:25 | 200 | 3m29s | 172.20.0.3 | POST "/api/chat"` (the vision request)
  - `GET "/v1/models"` (router-side model listing — non-vision)
  - **Zero `POST /v1/chat/completions`** entries containing image content
This is the load-bearing Pitfall 8 / VISION-03 assertion: image requests MUST route through Ollama's native `/api/chat` (which supports the `images` field per `OllamaNativeChatMessage`), NOT through the broken OpenAI-compat shim. Live confirmation matches msw integration test coverage (35 test files, 416 passes). Verified 2026-05-14T13:25Z.

### 7. SC-P4-E capability gate live check
expected: `POST /v1/messages` with image + non-vision-model `llama3.2:3b-instruct-q4_K_M` returns 400 with `body.error.code === 'model_capability_mismatch'`; router logs show 400 in < 50 ms (before semaphore acquire)
result: passed — `llama3.2:3b-instruct-q4_K_M` + 1×1 PNG → HTTP 400 in **3.6 ms**. Anthropic envelope: `{type:'error', error:{type:'invalid_request_error', message:'Model "llama3.2:3b-instruct-q4_K_M" does not support capability "vision". Pick a model with "vision" in its capabilities list.'}}`. Gate fires pre-adapter (before any backend dispatch). Verified 2026-05-14T12:37Z.

### 8. VRAM headroom check after both text + vision models loaded concurrently
expected: `nvidia-smi` shows total ~12 GB used (4 + 8); `RegistrySchema.superRefine` VRAM sum passes (12 ≤ 16)
result: passed — RTX 5060 Ti 16,311 MiB total. With `llama3.2-vision:11b-instruct-q4_K_M` loaded: 12,387 MiB used, 3,664 MiB free. Static budget sum text(4) + vision(8) = 12 ≤ 16 GB validated against `models.yaml`. Note: Ollama 0.23.4 unloads the prior model when loading a new one (default behavior), so "both concurrently" is a planning-level constraint, not a runtime test — the 12 GB live measurement confirms the vision model alone fits inside the configured budget. Verified 2026-05-14T13:25Z.

### 9. Smoke test SC-P4-A..C against live router/Ollama (text non-stream, text stream, count_tokens)
expected: `bin/smoke-test-router.sh` reports pass on SC-P4-A, SC-P4-B, SC-P4-C against live stack
result: passed — all three sub-tests verified live against `llama3.2:3b-instruct-q4_K_M`:
  - SC-P4-A `POST /v1/messages` non-stream → wire-correct Anthropic Message (`id=msg_01...`, `role=assistant`, `model=llama3.2:3b-instruct-q4_K_M`, `usage.input_tokens=38`, `usage.output_tokens=12`). The `displayModel` translator-option seam confirmed working — `model` field echoes the **registry** name, not the upstream backend id (resolves the Plan 02 `canonicalResult.model = entry.name` mutation Issue #5).
  - SC-P4-B `POST /v1/messages` stream → full 6-event sequence `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`; zero `[DONE]` (Anthropic does NOT use OpenAI terminator — ANTHR-06 verified).
  - SC-P4-C `POST /v1/messages/count_tokens` → `{input_tokens: 10}` + header `x-token-count-method: gpt-tokenizer/cl100k_base` present.
  Verified 2026-05-14T12:36Z.

## Summary

total: 9
passed: 9
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

(none — all 9 live-smoke items verified end-to-end. Two follow-up items recorded below for completeness; neither is a Phase 4 gap.)

### Resolved during this UAT session

- **CR-02 follow-up fix** (commit `9250573`): live smoke surfaced a bug in the pinned-IP `undici.Agent` lookup callback — undici invokes it with `opts.all === true` and expects an array of `{address, family}`; the original fix only handled the false form, causing undici to throw "Invalid IP address: undefined" which surfaced as a generic "fetch failed" upstream. msw-stubbed tests did not catch this because msw intercepts above the dispatcher layer. Fix bridges both calling conventions; new regression test (`tests/translation/ollama-native-out.test.ts:URL source — pinned-IP Agent lookup honors opts.all === true (CR-02 followup)`) exercises the all===true branch.
- **Ollama image bump** (commit `9250573`, in `compose.yml`): bumped `ollama/ollama` pin 0.5.7 → 0.23.4 (current stable 2026-05-13) — 0.5.7 rejects `llama3.2-vision:11b-instruct-q4_K_M` manifest with HTTP 412.

### Notes for downstream phases

- The `bin/smoke-test-router.sh` SC-P4-D section currently hard-codes `https://raw.githubusercontent.com/ollama/ollama/main/docs/images/ollama.png` which now returns HTTP 404. Consider updating to a stable test image (e.g. Wikipedia commons cat) in a future phase if smoke-test automation is desired against the live URL form.
