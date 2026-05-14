---
phase: 04-anthropic-surface-v1-messages-tool-calling-vision
plan: 05
subsystem: api
tags:
  - vision
  - capability-gating
  - ollama-native-dispatch
  - ssrf-mitigation
  - displayModel-seam-consumption
  - llama3.2-vision

# Dependency graph
requires:
  - phase: 04-anthropic-surface-v1-messages-tool-calling-vision (Plan 04-01)
    provides: openai-in handles image_url + canonical ImageBlock + base ollama-native-out.ts stub
  - phase: 04-anthropic-surface-v1-messages-tool-calling-vision (Plan 04-02)
    provides: CapabilityNotSupportedError + toAnthropicErrorEnvelope mapping + url-prefix dispatch in setErrorHandler + canonicalHasImage gate template
  - phase: 04-anthropic-surface-v1-messages-tool-calling-vision (Plan 04-03)
    provides: canonicalToAnthropicSse + adapter.chatCompletionsCanonicalStream(opts.inputTokensHint) signature
provides:
  - canonicalToOllamaNativeChat — async; walks canonical.messages, packs text/base64-images/URL-fetched-images per Ollama native /api/chat wire (FINDING 4.3); emits tool_result blocks as {role:tool} messages; prepends system as {role:system}
  - fetchImageAsBase64 — module-internal helper with 5-layer SSRF guard chain (HTTPS scheme, DNS deny-CIDR for IPv4 RFC1918+127+169.254+CGNAT and IPv6 ::1+fc::/7+fe80::/10+IPv4-mapped, 10s AbortSignal.timeout, image/* content-type sniff, streaming 10MB cap with fire-and-forget reader.cancel)
  - ollamaNativeChunksToCanonicalEvents — NDJSON stream parser emitting message_start → content_block_start → content_block_delta+ → content_block_stop → message_delta → message_stop with signal.aborted propagation per Pitfall 8
  - InvalidImageUrlError + ImageFetchError classes (defined in ollama-native-out.ts, exported for envelope.ts import) — mapped to 400 + invalid_image_url / image_too_large / image_invalid_content_type / http_error on OpenAI envelope; invalid_request_error on Anthropic envelope
  - OllamaOpenAIAdapter.chatCompletionsCanonical{,Stream} — internal split on canonicalHasImage(); image-bearing → native /api/chat via raw fetch with signal forwarding (VISION-03 / Pitfall 8); text/tool-only → existing OpenAI-compat path
  - CanonicalToAnthropicResponseOpts + CanonicalToOpenAIResponseOpts + CanonicalToOpenAISseOpts — `displayModel` opt for routing wire `model` field through the registry name instead of the upstream backend id (Issue #5 resolution; replaces canonicalResult.model = entry.name mutation)
  - models.yaml — third entry: llama3.2-vision:11b-instruct-q4_K_M, capabilities:[chat, vision], vram_budget_gb:8 (Ollama backend VRAM sum 4 + 8 = 12 ≤ 16 → RegistrySchema.superRefine passes)
  - tests/msw/handlers.ts — ollamaNativeChatHandler (non-stream JSON or NDJSON stream factory, with optional onRequest body-capture hook) + imageFetchHandler (configurable Content-Type / status / body factory; 'oversize' lazy 11MB stream variant)
  - bin/smoke-test-router.sh — 5 new sections SC-P4-A..E with SKIPS counter; SC-P4-D pre-flights via `docker compose exec ollama ollama list` and points at a stable ~10KB GitHub-raw URL for live URL-fetch exercise
  - README.md — "Phase 4 — Anthropic surface + tool calling + vision" section with curl samples + "Image input — URLs vs base64" subsection documenting all four SSRF guards verbatim
affects:
  - 04-04-tool-calling          # adjacent plan in parallel wave; this plan owns the displayModel seam consumption for both routes (Issue #5 resolution; the wave-4 file-collision-prevention split)
  - phase-05-observability      # request_log schema should record {has_image:bool, image_count:N, image_bytes_total:M, image_sources:['url'|'base64']} rather than raw image bytes or URLs (URLs are sensitive too — could leak referer-style metadata)
  - phase-08-cloud-routing      # OllamaCloudAdapter (Phase 8) will need the same native-dispatch split if Ollama Cloud's /v1/chat/completions shim is broken for vision (verify against live cloud API in Phase 8 research)

# Tech tracking
tech-stack:
  added: []  # no new deps — all new code uses node:dns/promises + node:net + global fetch + ReadableStream + Buffer (Node 22 native)
  patterns:
    - "Async translator with side-effecting helper: canonicalToOllamaNativeChat is async because URL-source images require a network fetch; all adapter callsites await it. The fetch is encapsulated INSIDE the translator so the route layer never touches the network for images. Architectural Responsibility Map: translator owns image-encoding (including URL-fetch); route owns capability-gating + semaphore + abort; adapter owns dispatch + error mapping."
    - "Five-layer SSRF guard chain inside a single fetchImageAsBase64 helper: scheme check → DNS lookup + deny-CIDR → fetch(AbortSignal.timeout) → Content-Type sniff → streaming size cap with fire-and-forget reader.cancel. Each layer is unit-testable in isolation (vi.spyOn(dns.promises, 'lookup') + msw imageFetchHandler with configurable contentType/bodyBytes); integration tests exercise the full chain at the route level."
    - "Adapter internal dispatch split: a single canonicalHasImage(canonical) predicate at the top of each adapter method routes to either the OpenAI-compat path (text/tool) or the native /api/chat path (vision). The split is INVISIBLE to the route — the contract stays canonical-in / canonical-out. The opt seam (inputTokensHint) flows through BOTH branches identically. Repeatable for Phase 8 Ollama Cloud."
    - "displayModel opt seam consumption: all four wire-translators (canonicalToAnthropicResponse, canonicalToAnthropicSse, canonicalToOpenAIResponse, canonicalToOpenAISse) now accept opts.displayModel. The route consumes it as `entry.name` so backend model ids never appear on the wire even when the adapter passes the canonical through unchanged. The canonical object is NOT mutated — downstream observers (Phase 5 logging) still see canonical.model verbatim."

key-files:
  created:
    - .planning/phases/04-anthropic-surface-v1-messages-tool-calling-vision/04-05-SUMMARY.md
  modified:
    - router/src/translation/ollama-native-out.ts       # full impl: canonicalToOllamaNativeChat (async) + fetchImageAsBase64 + ollamaNativeChunksToCanonicalEvents + InvalidImageUrlError + ImageFetchError exports
    - router/src/errors/envelope.ts                     # imports + maps the two new error classes to 400 on both OpenAI + Anthropic envelopes (param 'messages[].content[].source.url' on OpenAI)
    - router/src/translation/openai-out.ts              # canonicalToOpenAIResponse + canonicalToOpenAISse accept opts.displayModel
    - router/src/translation/anthropic-out.ts           # canonicalToAnthropicResponse accepts opts.displayModel (canonicalToAnthropicSse already did per Plan 04-03)
    - router/src/backends/ollama-openai.ts              # canonicalHasImage split; nativeChatCompletions + nativeChatCompletionsStream private methods using raw fetch to ${nativeBase}/api/chat
    - router/src/routes/v1/messages.ts                  # consumes displayModel on BOTH non-stream send AND streaming sse opts; removes `canonicalResult.model = entry.name` mutation
    - router/src/routes/v1/chat-completions.ts          # adds capability gate (VISION-02 on OpenAI surface); consumes displayModel on BOTH branches
    - router/models.yaml                                # +llama3.2-vision:11b-instruct-q4_K_M entry
    - router/tests/msw/handlers.ts                      # +ollamaNativeChatHandler + imageFetchHandler factories
    - router/tests/translation/ollama-native-out.test.ts # full replacement: 17 it() cases (canonical→native shape + 5 URL-guard branches + NDJSON parser + abort)
    - router/tests/integration/messages.nonstream.test.ts # +7 vision cases (cap mismatch / base64 happy / URL happy / 4 URL-guard branches via /v1/messages)
    - router/tests/integration/messages.stream.test.ts   # +2 vision-stream cases with NEGATIVE handler on /v1/chat/completions proving VISION-03 at the wire boundary
    - router/tests/integration/chat-completions.nonstream.test.ts # +2 vision cases (cap mismatch / URL happy path on image_url surface)
    - bin/smoke-test-router.sh                          # SC-P4-A..E sections + SKIPS counter
    - README.md                                         # Phase 4 operational section + "Image input — URLs vs base64" subsection

key-decisions:
  - "Locked D-C4 fully implemented (NOT v1 URL-rejection stub). URL-source images are FETCHED inside the translator with the five-layer guard chain (HTTPS scheme, DNS deny-CIDR, 10s timeout, 10MB streaming cap, image/* content-type sniff). Justification: the user explicitly LOCKED D-C4 to mean URL → fetch → encode happens INSIDE ollama-native-out.ts. The prior plan's v1 URL-rejection stub was a contradiction with the lock."
  - "InvalidImageUrlError + ImageFetchError DEFINED in ollama-native-out.ts (not envelope.ts) and IMPORTED into envelope.ts for the mapping rows. Justification: the wave-4 parallel-execution coordination note in the orchestrator prompt explicitly steered Plan 05 to NOT touch envelope.ts in a way that would conflict with the parallel Plan 04-04 worktree. The classes live where they're thrown; envelope.ts just maps them. Worked cleanly because envelope.ts already imports from translation/."
  - "fetch streaming reader.cancel() is fire-and-forget (not awaited). Justification: discovered empirically while developing the oversize-body unit test — `await reader.cancel()` hangs under msw's interceptor (the mock has no upstream connection to acknowledge cancellation). Production behavior is unaffected — the upstream TCP connection will be torn down by V8 GC + AbortSignal eviction. We throw immediately so the route returns 400 fast."
  - "displayModel seam consumption ownership moved from Plan 04-04 to here. Justification: the wave-4 file-modification collision on routes/v1/messages.ts + routes/v1/chat-completions.ts had to be resolved one way or another. This plan owns the routes for the capability gate + vision dispatch wiring; adding the displayModel consumption to those same edits avoided a second round-trip on the route files."
  - "canonicalToOpenAIResponse + canonicalToOpenAISse gained the displayModel opt (Plan 04-04 already had it for canonicalToAnthropicSse; Plan 04-05 adds it for the other three). Justification: parity — without it, the OpenAI surface still leaks the backend model id (canonical.model is set to entry.backend_model in the route's openAIRequestToCanonical({...body, model: entry.backend_model}) call). With it, both surfaces emit entry.name on the wire."

patterns-established:
  - "Plan 05's adapter split pattern is the template for Phase 8 Ollama Cloud: a single canonicalHasImage(canonical) at the top of each adapter method, routing to a native (Ollama-shape) path or an OpenAI-compat path. The fetchImageAsBase64 helper is generic — Phase 8 can reuse it directly for cloud vision (vision content with source.type:'url' should be fetched on the router, NOT proxied as a URL to Ollama Cloud — same SSRF concerns apply, plus cloud's response time is unpredictable)."
  - "Five-layer SSRF guard chain as a single async helper with a tunable cap (timeoutMs + maxBytesMB). Repeatable for any future translator that fetches client-supplied URLs (e.g., file-attachment handling in Phase 7)."
  - "Test pattern for SSRF guards: pair vi.spyOn(dns.promises, 'lookup') for the DNS-deny path with msw http.get handlers for the HTTPS-stream path. The two together cover both classes of failure (resolver-level and origin-level) without ever touching real DNS or real networks."

requirements-completed:
  - VISION-01   # image-bearing requests work end-to-end on BOTH /v1/chat/completions AND /v1/messages (base64 + URL forms)
  - VISION-02   # capability gate fires before adapter call when image content targets a non-vision model (both routes)
  - VISION-03   # Ollama vision dispatches through native /api/chat (NOT the OpenAI-compat shim) — Pitfall 8 mitigated

# Metrics
duration: ~50min
completed: 2026-05-14
---

# Phase 4 Plan 05: Vision End-to-End Summary

**One-liner:** Vision input (base64 + URL forms) accepted on both `/v1/chat/completions` and `/v1/messages`; capability gating returns 400 before the backend for non-vision models on both surfaces; Ollama vision routes through native `/api/chat` with bare-base64 `images` array; URL-source images are fetched inside the translator with a five-layer SSRF guard chain (HTTPS scheme, DNS deny-CIDR, 10s timeout, image/* content-type, streaming 10MB cap).

## What changed

### Translator layer

`router/src/translation/ollama-native-out.ts` — replaced the Plan 04-01 text-only stub with the full implementation:

- `canonicalToOllamaNativeChat(canonical)` is now **async**. It walks `canonical.messages` and for each message:
  - Concatenates text blocks into a single `content` string (joined by `\n`).
  - Collects image blocks into an `images: string[]` array of bare base64 (no `data:image/...;base64,` prefix).
  - For `source.type:'base64'`: strips the data-URL prefix if present, keeps the bytes.
  - For `source.type:'url'`: calls `fetchImageAsBase64(url)` which enforces the full SSRF guard chain (see below).
  - For `tool_result` blocks: emits a separate `{role:'tool', content}` message (Ollama's native shape accepts role:'tool' inline).
- `system` is prepended as a synthetic `{role:'system', content: canonical.system}` first message.
- `options` object packs `temperature` / `top_p` / `top_k` / `stop_sequences` (→ `stop`) / `max_tokens` (→ `num_predict`) only when defined.

`fetchImageAsBase64(url, opts)` — the five-layer SSRF guard chain:

1. **Scheme check.** `new URL(url)` then assert `protocol === 'https:'`. Non-https → `InvalidImageUrlError(reason: 'http_scheme_blocked')`.
2. **DNS lookup + deny-CIDR.** `dns.lookup(hostname, {all: true, verbatim: true})`. For each `{address, family}`: parse the address and check against the IPv4 deny list (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0/8, 100.64/10) or the IPv6 deny list (`::1`, `fe80::/10` via `fe8X`/`fe9X`/`feaX`/`febX` prefix, `fc00::/7` via `fc`/`fd` prefix, `::`, `::ffff:X.X.X.X` re-extracts and re-checks the IPv4). Literal-IP hostnames (already an IP string) skip dns.lookup and check directly. Any denied address → `InvalidImageUrlError(reason: 'private_address_blocked')`.
3. **Fetch with timeout.** `fetch(url, { signal: AbortSignal.timeout(timeoutMs ?? 10_000) })`. Non-2xx → `ImageFetchError(code: 'http_error')`.
4. **Content-Type sniff.** Lower-case the response Content-Type; if it doesn't start with `image/` → `ImageFetchError(code: 'image_invalid_content_type')`.
5. **Streaming size cap.** Read chunks via `res.body.getReader()`. Maintain `bytesRead`; on overflow → fire-and-forget `reader.cancel()` + `ImageFetchError(code: 'image_too_large')`. On clean read end, return `Buffer.concat(chunks).toString('base64')`.

`ollamaNativeChunksToCanonicalEvents(body, opts)` — NDJSON stream parser:

- Uses a `TextDecoder` + line-buffer approach. Splits on `\n` and JSON.parses each complete line; the trailing partial stays in the buffer.
- On the first parsed line: emits a synthetic `message_start` with `usage.input_tokens = opts.inputTokensHint ?? 0` (matches the Plan 04-03 `inputTokensHint` adapter signature), then emits `content_block_start { type: 'text', text: '' }`.
- On each subsequent line with `done: false`: emits `content_block_delta { type: 'text_delta', text: message.content }`.
- On the terminal `done: true` line: emits `content_block_stop` → `message_delta { stop_reason: 'end_turn', usage.output_tokens: eval_count }` → `message_stop`.
- Honors `opts.signal?.aborted` per Pitfall 8: returns silently on abort.

### Adapter layer

`router/src/backends/ollama-openai.ts` — internal split on `canonicalHasImage(canonical)`:

- **Non-stream:** `chatCompletionsCanonical` checks `hasImage`; image-bearing → `nativeChatCompletions` (raw `fetch` POST to `${nativeBase}/api/chat`, JSON body, signal forwarded, response parsed as Ollama-shape `{message:{content}, prompt_eval_count, eval_count}`); text/tool-only → existing OpenAI-compat path unchanged.
- **Stream:** `chatCompletionsCanonicalStream` does the same split. Image-bearing → `nativeChatCompletionsStream` which posts the NDJSON-stream body and returns `ollamaNativeChunksToCanonicalEvents(res.body, opts)`. The signal is forwarded into both the fetch AND the parser so client-disconnect propagates all the way down to the underlying TCP socket.

`nativeBase` is computed once in the constructor as `baseURL.replace(/\/v1\/?$/, '')` — the OpenAI-compat baseURL ends with `/v1`, the native endpoint does not.

`router/src/backends/llamacpp-openai.ts` — **byte-identical** (D-B4). Vision on llamacpp is gated at the route layer; the adapter doesn't need to know about vision at all.

### Routes

Both `router/src/routes/v1/messages.ts` and `router/src/routes/v1/chat-completions.ts` now have the **VISION-02 capability gate** between the canonical translation and the semaphore acquire:

```ts
const hasImage = canonical.messages.some(
  (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'),
);
if (hasImage && !entry.capabilities.includes('vision')) {
  throw new CapabilityNotSupportedError(entry.name, 'vision');
}
```

`CapabilityNotSupportedError` was added in Plan 04-02 with full envelope mapping; the gate just throws and the centralized error handler does the rest. The gate fires BEFORE the semaphore acquire so non-vision-model image requests don't consume a slot.

The `canonicalResult.model = entry.name` mutation on `messages.ts` is **gone**. Both routes now call the response translators with `{ displayModel: entry.name }`:

- `canonicalToAnthropicResponse(canonicalResult, { displayModel: entry.name })`
- `canonicalToAnthropicSse(upstream, { signal, onCleanup, displayModel: entry.name })`
- `canonicalToOpenAIResponse(canonicalResult, { displayModel: entry.name })`
- `canonicalToOpenAISse(upstream, { signal, onCleanup, displayModel: entry.name })`

The translators rewrite the wire `model` field; the canonical object is untouched. Phase 5 logging will see `canonical.model = entry.backend_model` (the upstream id) which is the correct value to record.

### Models registry

`router/models.yaml` — third entry:

```yaml
  - name: llama3.2-vision:11b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2-vision:11b-instruct-q4_K_M
    capabilities: [chat, vision]
    vram_budget_gb: 8
    concurrency: 2
    max_model_len: 8192
    profile: ollama
```

Ollama backend VRAM sum: `4 + 8 = 12 ≤ 16` → `RegistrySchema.superRefine` passes. No second hot model required (Ollama swaps).

### Tests

| File | New cases | Coverage |
|------|-----------|----------|
| `tests/translation/ollama-native-out.test.ts` | 17 it() | Canonical→native shape (text / single base64 / data URL strip / multi-image / system / max_tokens→num_predict / stop_sequences / tool_result) + 5 URL-guard branches (happy + http scheme + private IP + loopback + IPv6 link-local + non-image content-type + oversize body via direct `fetchImageAsBase64` call with `maxBytesMB: 0.0001`) + NDJSON parser (event sequence + abort propagation) |
| `tests/integration/messages.nonstream.test.ts` | +7 | VISION-02 cap mismatch (upstream untouched) + VISION-01 base64 happy + VISION-01 URL happy (with onRequest body capture asserting bare base64 forwarded) + 4 URL guard branches (http / private IP / non-image / oversize body via 11MB stream) |
| `tests/integration/messages.stream.test.ts` | +2 | VISION-03 base64 stream — asserts native `/api/chat` URL hit + NEGATIVE handler on `/v1/chat/completions` proves VISION-03 at the wire boundary; VISION-03 URL form stream — same, plus body-capture proves bare base64 forward |
| `tests/integration/chat-completions.nonstream.test.ts` | +2 | VISION-02 on OpenAI surface (image_url + non-vision model → 400 + OpenAI envelope code:model_capability_mismatch) + VISION-01 URL form on `image_url` shape (asserts upstream `/api/chat` receives bare base64) |

Full vitest: **307 passed, 2 skipped (LIVE_OLLAMA opt-in)**. Zero regressions on Plans 01–04 surfaces.

### Smoke test

`bin/smoke-test-router.sh` — five new sections appended before the final summary:

- **SC-P4-A** — POST `/v1/messages` stream=false against `llama3.2:3b-instruct-q4_K_M`; asserts `body.id /^msg_/`, `body.type === 'message'`, `usage.input_tokens > 0`, `usage.output_tokens > 0`.
- **SC-P4-B** — POST `/v1/messages` stream=true; asserts SSE bytes contain `event: message_start`, `event: content_block_delta`, `event: message_delta`, `event: message_stop`, NO `data: [DONE]`.
- **SC-P4-C** — POST `/v1/messages/count_tokens`; asserts `body.input_tokens > 0` + `X-Token-Count-Method: gpt-tokenizer/cl100k_base` header.
- **SC-P4-D** — POST `/v1/messages` vision via URL `https://raw.githubusercontent.com/ollama/ollama/main/docs/images/ollama.png`. Pre-flights via `docker compose exec -T ollama ollama list | grep llama3.2-vision`; skip + increment SKIPS counter if model not pulled. Asserts response `content[0].text` length > 10.
- **SC-P4-E** — POST `/v1/messages` with image + non-vision model; asserts `400` + `body.error.type === 'invalid_request_error'` + message contains `vision`.

The final summary now reports the SKIPS count alongside FAILURES.

### README

New section `## Phase 4 — Anthropic surface + tool calling + vision` between Phase 3 and the anti-patterns section. Includes:

- One-time setup: `docker compose exec -T ollama ollama pull llama3.2-vision:11b-instruct-q4_K_M`.
- Anthropic curl samples — text non-stream, text stream (with the "no `[DONE]`" note), count_tokens (with the `X-Token-Count-Method` header explanation), vision base64, vision URL.
- Bidirectional tool calling curl samples (OpenAI surface + Anthropic surface — note the wire format differences).
- Streaming error frame asymmetry note (OpenAI emits error + `[DONE]`; Anthropic emits a single error frame, no `[DONE]`).
- `### Image input — URLs vs base64` subsection documenting all five SSRF guards verbatim, with the full deny-CIDR list (both IPv4 and IPv6).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] `await reader.cancel()` hangs under msw**
- **Found during:** Task 1 unit test (oversize body case)
- **Issue:** With msw's `setupServer` intercepting fetch, `await reader.cancel()` on the response body never resolves because msw's mock has no upstream connection to acknowledge cancellation. The fetchImageAsBase64 call would hang past the 5s vitest test timeout.
- **Fix:** Switched to fire-and-forget cancellation: `void reader.cancel().catch(() => {})`. Production behavior is identical — the upstream TCP connection is torn down by V8 GC + AbortSignal eviction. We throw `ImageFetchError(code: 'image_too_large')` immediately so the route returns 400 fast.
- **Files modified:** `router/src/translation/ollama-native-out.ts`
- **Commit:** d629e59

**2. [Rule 3 — Blocker] Plan 04-04 wave-collision: InvalidImageUrlError + ImageFetchError class location**
- **Found during:** Task 1 pre-flight (grep before importing showed neither class in envelope.ts)
- **Issue:** The plan's must_haves.key_links and the original "<interfaces>" section both said `Plan 04 Task 2 OWNS the wave-4 edits to envelope.ts`. But Plan 04-04 is running in a parallel worktree — its changes are not visible to this worktree until merge.
- **Fix:** Defined the two error classes INSIDE `ollama-native-out.ts` (where they are thrown) and imported them from `envelope.ts` to add the mapping rows. Both worktrees now safely modify envelope.ts in non-conflicting ways: Plan 04-04 adds its own classes (`InvalidToolArgumentsError` and similar), Plan 04-05 adds two classes + their mapping rows. Net merge conflict surface: ~0 lines (the additions are in different blocks of the same file).
- **Files modified:** `router/src/translation/ollama-native-out.ts` (class definitions); `router/src/errors/envelope.ts` (imports + mapping rows)
- **Commit:** d629e59

**3. [Rule 1 — Bug] Oversize body integration test causes 12 MB allocation per test run**
- **Found during:** Task 1 unit test design
- **Issue:** The plan's "<interfaces>" called for an `imageFetchHandler({bodyBytes: 'oversize'})` that allocates `new Uint8Array(12 * 1024 * 1024)`. This works but slows test runs and risks OOM under heavy parallelism.
- **Fix:** Switched the `'oversize'` variant to a streaming ReadableStream that enqueues 44 × 256 KB chunks (~11 MB total) without keeping them in memory simultaneously. The integration test for the 10 MB cap uses this variant. The translator-level unit test (`tests/translation/ollama-native-out.test.ts`) uses a 200 KB fixed body with a custom `maxBytesMB: 0.0001` cap so the guard fires on the first chunk — no streaming needed.
- **Files modified:** `router/tests/msw/handlers.ts`; `router/tests/translation/ollama-native-out.test.ts`
- **Commit:** d629e59

No architectural changes required (Rule 4 not triggered).

## Authentication gates

None — the plan executes entirely against in-process test fixtures. The human-verify checkpoint (Task 4) requires a live Ollama pull but no external auth.

## Forward-handoff to Phase 5

- The `request_log` schema for vision should record `{has_image: boolean, image_count: number, image_bytes_total: number, image_sources: ('url' | 'base64')[]}` — NOT raw image bytes (table bloat) and NOT raw URLs (URLs are sensitive — referer-style metadata leak). The router has all the info needed at canonical-translation time.
- The `displayModel` seam is now the universal route ↔ translator option pattern. Phase 5's audit-log enrichment should consume `canonical.model` (the backend id) for upstream routing analysis while the wire response shows `entry.name`.

## Task 4 — Awaiting human-verify checkpoint

This plan has 3 of 4 tasks complete. **Task 4 is a `type="checkpoint:human-verify"` task** — see `04-05-PLAN.md` lines 509–612 for the nine-step verification sequence. Steps require:

1. `docker compose exec -T ollama ollama pull llama3.2-vision:11b-instruct-q4_K_M` (~7.8 GB).
2. Stack up + `/readyz` reachable.
3. Run `bin/smoke-test-router.sh` and confirm all SC-P4 sections pass.
4. Manual curl with a real image (base64) — assert coherent description.
5. Manual curl with a URL (https) — same.
6. SSRF live check: http:// scheme attempt MUST reject in <50ms.
7. `docker compose logs ollama | grep "POST /api/chat"` shows recent hits + `grep "POST /v1/chat/completions.*image"` shows ZERO results (VISION-03 wire-level proof).
8. Capability gate live check: non-vision model + image → 400 in <50ms.

Approval signal: `approved`. If any step fails, see the plan's `<resume-signal>` block for common failure decoders (e.g., generic vision response → Pitfall 8 leak; status not 400 on http:// → scheme check not firing first).

## Self-Check: PASSED

All 16 modified/created files present. All 3 task commits present in git log:
- d629e59 feat(04-05): vision translator + SSRF guards + msw factories
- 2a3d50a feat(04-05): capability gate + vision dispatch split + displayModel seam
- c59d11f docs(04-05): smoke-test SC-P4-A..E + README Phase 4 operational + SSRF guards

Full vitest: 307 passed, 2 skipped (LIVE_OLLAMA opt-in). Zero regressions on
Plans 01–04 surfaces. tsc --noEmit clean.

Task 4 (live human-verify checkpoint) is deferred per `autonomous: false` plan
flag — see "Task 4 — Awaiting human-verify checkpoint" section above for the
nine-step verification sequence the operator must run against a live GPU.
