# Phase 4: Anthropic Surface — `/v1/messages`, Tool Calling, Vision - Context

**Gathered:** 2026-05-13
**Status:** Ready for planning (research flag: YES — `/gsd-plan-phase 4` must run with research)

<domain>
## Phase Boundary

Land the **single hardest item** in the project: bidirectional **Anthropic ↔ canonical ↔ OpenAI** translation with typed streaming events, parallel tool calls, and vision — on top of the small Phase 2/3 stack so tests are fast and the canonical-shape decision propagates correctly into every later phase (Phase 5+ inherits it, Phase 7 vLLM and Phase 8 OllamaCloud must plug into the same seam).

**Surface delivered:**
- **`POST /v1/messages`** — non-stream + stream — typed SSE events `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop` (+ `ping`), in correct order, with `input_tokens` on `message_start` and `output_tokens` on `message_delta` (ANTHR-01, ANTHR-06, ANTHR-07).
- **`POST /v1/messages/count_tokens`** — heuristic estimate via `gpt-tokenizer` (ANTHR-02).
- **Top-level `system` field** honored as system prompt; **strict role alternation** rejected with structured error; **`anthropic-version` request header echoed** in response (ANTHR-03, ANTHR-04, ANTHR-05).
- **Bidirectional tool calling**: OpenAI tool defs on `/v1/chat/completions` → canonical → backend; Anthropic tool defs on `/v1/messages` native (no translation hop); parallel `tool_use` blocks round-trip; `tool_result` blocks with `is_error: true` round-trip; `stop_sequences` ⇄ `stop` mapping (ANTHR-08, TOOL-01..04).
- **Round-trip golden tests** OpenAI ↔ canonical ↔ Anthropic — single + parallel + `is_error` + `tool_choice` — pass in CI (TOOL-05).
- **Vision** — image input (URL + base64) on both protocols (VISION-01); capability gating returns structured 400 *before* hitting backend (VISION-02); Ollama vision routed via **native `/api/chat`**, never the broken OpenAI-compat shim (VISION-03).

**Hard architectural moves:**
- New **internal canonical shape** (hand-rolled types in `router/src/translation/canonical.ts`) that mirrors Anthropic content blocks 1:1 — strict superset of OpenAI shape, separate inbound + outbound translators per protocol.
- **`BackendAdapter` widening:** add `chatCompletionsCanonical(canonical, signal)` + streaming variant; **both** `/v1/chat/completions` and `/v1/messages` flow through canonical (no single-hop OpenAI↔Anthropic path anywhere). Phase 2's direct `chatCompletions(req: OpenAI)` methods are deprecated/removed in favor of the canonical entry point.
- **Ollama adapter internal split**: `OllamaOpenAIAdapter.chatCompletionsCanonical()` inspects content blocks; image-bearing requests dispatch to native `/api/chat` via the `ollama-native-out` translator; text/tool requests stay on the OpenAI-compat path. The split is hidden behind the adapter seam — routes see ONE entry point.
- New **vision model** added to `models.yaml` under `backend: ollama`: `llama3.2-vision:11b-instruct-q4_K_M` (~7–8 GB) with `capabilities: [chat, vision]`. Ollama VRAM sum becomes 4 + 8 = 12 GB ≤ 16 envelope ✓.

**Explicitly out of Phase 4** (each lives in its own phase per ROADMAP.md):
- `/v1/embeddings` → Phase 7 (with Ollama + vLLM embedding models).
- vLLM backend itself → Phase 7.
- Ollama Cloud backend (`backend: ollama-cloud`) → Phase 8.
- `X-Model-Backend` response header, `Idempotency-Key`, server-side rate limit (Valkey) → Phase 8.
- Postgres `request_log`, Prometheus `/metrics`, `X-Agent-Id` header surfacing → Phase 5.
- Traefik / TLS / Open WebUI → Phase 6.
- Per-model concurrency (D-B6 of Phase 3 keeps it accepted-but-ignored) → Phase 7 (where one vLLM serves embeddings + chat).
- PDF document blocks, extended-thinking blocks, structured outputs → v2 backlog (DOCS-01, THINK-01, STRUCT-01).
- Anthropic `cache_control` passthrough → no-op in Phase 4 (purely local Anthropic-shape responses); Phase 8 evaluates when cloud-backed requests land.

</domain>

<decisions>
## Implementation Decisions

### Canonical shape + translator location
- **D-A1:** **Internal canonical shape mirroring Anthropic 1:1.** Hand-rolled TS types + zod schemas in `router/src/translation/canonical.ts` — not a direct re-export of `@anthropic-ai/sdk`'s types. Same wire shape (`Message`, `ContentBlock` union of `TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock`, top-level `system`, `stop_sequences`, etc.) but our own definitions so adapters don't transitively import SDK types. Keeping pace with SDK additions (PDF blocks, thinking blocks) is a planned-maintenance task tracked as a future-phase concern — they're in v2 backlog (DOCS-01, THINK-01).
- **D-A2:** **Dedicated translator module per direction.** File layout under `router/src/translation/`:
  - `canonical.ts` — types + zod schemas + shape validators (role-alternation refinement, `system` placement, `tool_use`/`tool_result` pairing checks).
  - `openai-in.ts` — `openAIRequestToCanonical(body): CanonicalRequest`. Handles OpenAI message array → canonical content blocks, OpenAI `tools[]` → canonical `tools[]`, system message extraction (first `role: "system"` → top-level `system`), `stop` → `stop_sequences`, `tool_choice` mapping.
  - `openai-out.ts` — `canonicalToOpenAIResponse(canonical): ChatCompletion` + stream variant emitting OpenAI-shape `delta` chunks.
  - `anthropic-in.ts` — `anthropicRequestToCanonical(body): CanonicalRequest`. Handles top-level `system`, validates role alternation strictly (rejects with structured error at this layer).
  - `anthropic-out.ts` — `canonicalToAnthropicResponse(canonical): Message` + stream variant emitting typed `message_*` / `content_block_*` events with proper input/output token splitting.
  - `ollama-native-out.ts` — `canonicalToOllamaNativeChat(canonical): OllamaNativeChatRequest` (the `images: [base64]` form). Used by `OllamaOpenAIAdapter.chatCompletionsCanonical` internally for vision-bearing requests.
- **D-A3:** **Both routes flow through canonical.** `/v1/chat/completions` becomes: zod parse → `openAIRequestToCanonical` → `adapter.chatCompletionsCanonical` → `canonicalToOpenAIResponse` (or streaming variant). `/v1/messages` becomes: zod parse → `anthropicRequestToCanonical` → `adapter.chatCompletionsCanonical` → `canonicalToAnthropicResponse`. Round-trip golden tests live as identity tests against the live routes — no separate "translator" test surface needed. **No single-hop OpenAI↔Anthropic translation exists anywhere in the codebase.**
- **D-A4:** **`@anthropic-ai/sdk` is used for type cross-checks only**, not in the adapter import graph. Tests assert canonical-out shapes satisfy `@anthropic-ai/sdk`'s `Message`/`MessageStream` types so we catch drift. Adapters never import from the SDK.

### Adapter surface (`BackendAdapter` widening)
- **D-B1:** **Add canonical methods to `BackendAdapter`:**
  ```ts
  chatCompletionsCanonical(canonical: CanonicalRequest, signal: AbortSignal): Promise<CanonicalResponse>;
  chatCompletionsCanonicalStream(canonical: CanonicalRequest, signal: AbortSignal): Promise<AsyncIterable<CanonicalStreamEvent>>;
  ```
  These become the canonical (pun intended) entry points used by all routes.
- **D-B2:** **Phase 2's `chatCompletions` / `chatCompletionsStream` methods are removed.** `OllamaOpenAIAdapter` keeps `probeLiveness` unchanged. The route handler in `chat-completions.ts` is rewritten to use the canonical entry point. The `factory.ts` makeAdapter contract is unchanged (still returns `BackendAdapter`). The semaphore + abort signal + `safeRelease` plumbing is untouched.
- **D-B3:** **`OllamaOpenAIAdapter.chatCompletionsCanonical` internally splits on content:** if any block in `canonical.messages[*].content` has `type: "image"` → call native `/api/chat` (no SDK; raw `fetch` via undici with the `ollama-native-out` translator). Else → `canonicalToOpenAI` internally, call `client.chat.completions.create`, translate the OpenAI response back to canonical. The split is invisible above the adapter. *Vision-via-OpenAI-compat is never the chosen path on Ollama, even if the model claims to support it* (Pitfall 8 / VISION-03).
- **D-B4:** **`LlamacppOpenAIAdapter.chatCompletionsCanonical`** uses the OpenAI-compat path for everything in Phase 4 — llama.cpp-server's vision support is via the llava sub-protocol which we explicitly defer; Phase 4 does NOT serve vision through llama.cpp. The vision model lives on Ollama (D-C1).
- **D-B5:** **Streaming canonical events**. `CanonicalStreamEvent` is an union: `{ type: 'message_start', message: ... }`, `{ type: 'content_block_start', index, content_block }`, `{ type: 'content_block_delta', index, delta }`, `{ type: 'content_block_stop', index }`, `{ type: 'message_delta', delta, usage }`, `{ type: 'message_stop' }`, `{ type: 'ping' }`. Anthropic-out serializes these to typed SSE events verbatim; OpenAI-out reassembles them into delta chunks. Heartbeats: keep Phase 2's 15s heartbeat infra; on `/v1/messages` emit `event: ping\ndata: {"type": "ping"}` instead of `:keepalive` comment frame.

### Vision routing + model
- **D-C1:** **Vision model added to `models.yaml`:** new entry under `backend: ollama`:
  ```yaml
  - name: llama3.2-vision:11b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1   # OpenAI-compat URL for probeLiveness; adapter internally uses /api/chat
    backend_model: llama3.2-vision:11b-instruct-q4_K_M
    capabilities: [chat, vision]
    vram_budget_gb: 8                     # rough; planner verifies against real container measurement
    concurrency: 2
    max_model_len: 8192
    profile: ollama
  ```
  Ollama backend VRAM sum becomes 4 + 8 = 12 GB ≤ 16. README adds the one-time `ollama pull llama3.2-vision:11b-instruct-q4_K_M` step. *(Planner verifies the exact tag is current in Ollama's catalog at planning time.)*
- **D-C2:** **Capability gating (VISION-02) fires BEFORE the adapter call.** Implementation: after `registry.resolve(model)` but before `adapter.chatCompletionsCanonical`, the route handler walks `canonical.messages` for `type: "image"` blocks; if any are found AND the resolved entry's `capabilities` does NOT include `"vision"` → throw a new `CapabilityNotSupportedError` which the centralized error handler maps to `400` with envelope `{ type: "invalid_request_error", code: "model_capability_mismatch", param: "model" }`. Same pattern as `RegistryUnknownModelError`.
- **D-C3:** **Capability checks for `tools`** follow the same pattern but are SOFT in Phase 4: if the request has `tools[]` and the model lacks `"tools"` capability, log a warn but pass through (some models support tool-calling-without-declaration). VISION-02 is HARD because vision misroutes silently corrupt; tools misroutes just produce a bad completion. *Re-evaluate after first real-world bug.*
- **D-C4:** **Ollama native `/api/chat` request shape** (used by adapter internally):
  ```json
  {
    "model": "llama3.2-vision:11b-instruct-q4_K_M",
    "messages": [
      { "role": "user", "content": "what is in this image?", "images": ["<base64-without-data-url-prefix>"] }
    ],
    "stream": true,
    "options": { "temperature": 0.7, ... }
  }
  ```
  `images` is an array of base64 strings WITHOUT the `data:image/...;base64,` prefix. Both URL inputs (canonical `{type: "image", source: {type: "url", url: "..."}}`) and base64 inputs (canonical `{type: "image", source: {type: "base64", media_type: "...", data: "..."}}`) get normalized to bare base64 by `ollama-native-out.ts` (URL → fetch → encode; document the egress requirement). *Planner: confirm Phase 1 D-A2's egress allowlist permits fetching arbitrary image URLs OR document the restriction.*

### Tool calling translation (TOOL-01..05)
- **D-D1:** **Full golden test suite** lands in Phase 4 — TOOL-05 is satisfied at the HIGHEST scope: single tool call, parallel tool calls (multiple `tool_use` blocks in one assistant message), `tool_result` with `is_error: true`, `tool_choice` mapping (`auto` / `any` / `tool: <name>` ⇄ `auto` / `required` / `function: {name}`). Fixtures live in `router/tests/translation/golden/` with one file per direction × per scenario.
- **D-D2:** **JSON.stringify discipline (Pitfall 5)** lives in the translators, NOT the adapters:
  - `openai-in.ts`: `tool_calls[i].function.arguments` (string) → `JSON.parse` → `tool_use.input` (object). Catch parse errors → `400 invalid_request: tool_call arguments not valid JSON`.
  - `openai-out.ts`: canonical `tool_use.input` (object) → `JSON.stringify` → OpenAI `tool_calls[i].function.arguments` (string).
  - `anthropic-in.ts` + `anthropic-out.ts`: pass through (both sides are objects).
  - Adapters NEVER stringify/parse tool args — that boundary lives exclusively in the translators.
- **D-D3:** **`tool_choice` mapping table** (canonical = Anthropic-shape):
  | OpenAI | Canonical (Anthropic) | Notes |
  |---|---|---|
  | `"auto"` (default) | `{type: "auto"}` | |
  | `"required"` | `{type: "any"}` | Anthropic equivalent of "model MUST call a tool" |
  | `{type: "function", function: {name: "X"}}` | `{type: "tool", name: "X"}` | |
  | `"none"` | strip `tools[]` entirely + don't set `tool_choice` | Anthropic has no equivalent — easier to drop tools |
- **D-D4:** **`parallel_tool_calls: false` (OpenAI-only)** is recorded in canonical as `_meta.disable_parallel_tools: true` and emitted on outbound OpenAI as `parallel_tool_calls: false`. On outbound Anthropic, surfaces as `tool_choice: {type: "tool", name: <chosen>}` only when the model picks ONE tool; otherwise dropped silently with a debug log. *Planner can refine if researcher reports a cleaner mapping.*
- **D-D5:** **`stop_sequences` ⇄ `stop` mapping (ANTHR-08):**
  - OpenAI `stop: string` → canonical `stop_sequences: [string]`.
  - OpenAI `stop: string[]` → canonical `stop_sequences: string[]` (Anthropic caps at 5; if input has >5, reject with `400 invalid_request: too many stop_sequences (max 5)` — this is Anthropic's documented limit, surface honestly).
  - Canonical `stop_sequences` → OpenAI `stop` (always as array form; OpenAI accepts both).

### `count_tokens` + Anthropic event IDs (ANTHR-02, ANTHR-06)
- **D-E1:** **`POST /v1/messages/count_tokens` uses `gpt-tokenizer` (cl100k_base) server-side.** Add `gpt-tokenizer@^2.x` to router deps. Encoder loaded once at boot (module-level), reused per request — zero per-request init. Algorithm: serialize the canonical request to the same string form that would be sent to the backend (system + each message's text content; image blocks contribute the documented Anthropic per-image overhead of `(width × height) / 750` tokens or a fixed 1568 fallback if dimensions unknown), tokenize, return `{ input_tokens: N }`. Response shape matches Anthropic's: `{ "input_tokens": 5 }`.
- **D-E2:** **Inaccuracy disclaimer.** Response includes a router-emitted header `X-Token-Count-Method: gpt-tokenizer/cl100k_base` so agents can decide whether to trust it within ±5% (typical English/code) or ±15% (CJK scripts). Not a body field — keeps the response shape verbatim Anthropic.
- **D-E3:** **`message_start.id` format: `msg_<ulid>`.** Add `ulid@^2.x` to router deps. ULID generated once per request inside the canonical `Message` builder; reused across `message_start` and the non-stream response body. Documented in pino logs alongside `req.id` so `request_id ↔ message_id` join queries are trivial in Phase 5's Postgres.
- **D-E4:** **`content_block.id` for `tool_use` blocks: `toolu_<ulid>`** (Anthropic convention — `toolu_` prefix for tool_use ids, `msg_` for messages). Translators carry the id through the OpenAI ↔ Anthropic mapping (OpenAI's `tool_calls[i].id` = canonical `tool_use.id`).
- **D-E5:** **`anthropic-version` request header echo (ANTHR-05).** Echo whatever the client sent verbatim in the response header. If the client sends nothing, do NOT inject a default — let the absence be visible (some agents test for it). If the client sends an unknown version, log a warn but still echo and proceed; we don't gate features on version in Phase 4.

### Routes + auth + capability gating wiring
- **D-F1:** **New routes registered in `app.ts`:**
  - `POST /v1/messages` → `registerMessagesRoute(app, { registry, makeAdapter, semaphores })` — bearer-gated; same semaphore acquire + heartbeat + abort pattern as `/v1/chat/completions`.
  - `POST /v1/messages/count_tokens` → `registerCountTokensRoute(app, { registry })` — bearer-gated; no backend call; no semaphore acquire (it's pure CPU); rate-limit headroom irrelevant in Phase 4 (Phase 8 adds rate-limit globally).
- **D-F2:** **Bearer auth skip-list unchanged.** Public-without-auth = `/healthz`, `/readyz` only. `/v1/messages*` joins the bearer-required surface alongside `/v1/chat/completions` and `/v1/models`.
- **D-F3:** **Existing chat-completions route is refactored** to flow through canonical (D-A3). Phase 2's "minimal validation + passthrough" style is preserved at the zod layer; the canonical translation happens AFTER zod validation and BEFORE semaphore acquire. The route file's overall shape (try/finally + onClose + safeRelease + heartbeat) is untouched — only the middle three lines change.
- **D-F4:** **`SSE event order invariant`** for `/v1/messages` (ANTHR-06): translator builds the event sequence by accumulating chunks from `chatCompletionsCanonicalStream`; events are emitted in their natural order from the canonical stream. The stream translator MUST emit `message_start` before any `content_block_*`, MUST close every opened block with `content_block_stop`, and MUST emit `message_delta` (with `output_tokens`) before `message_stop`. These invariants are unit-tested at the translator level.
- **D-F5:** **Error frames mid-stream on `/v1/messages`** — Anthropic uses `event: error\ndata: {"type": "error", "error": {...}}` (not `[DONE]` like OpenAI). Add an `anthropicErrorFrame(envelope)` helper alongside the existing `midStreamErrorFrameLines`. Centralized error handler is unchanged; the stream branch in `messages.ts` picks the right frame helper based on protocol.

### Claude's Discretion
- Exact filenames / module layout under `router/src/translation/` — keep the names suggested in D-A2 unless the planner finds a friction during type definition. Document the chosen layout.
- Exact zod schema for `CanonicalRequest` / `Message` / `ContentBlock` — planner picks shape during plan-phase based on what makes test fixtures readable.
- ULID vs nanoid implementation pin (`ulid` package vs `@bogeychan/ulid` vs DIY) — planner picks; pin the chosen package version in the plan.
- `gpt-tokenizer` package vs `@dqbd/tiktoken` (Rust native) — planner picks based on bundle size + cold start cost. D-E1 specifies cl100k_base; either package can deliver that.
- Image-URL fetching policy in `ollama-native-out.ts`: timeout (10s?), max body size (10 MB?), allowed schemes (http, https only). Planner picks defaults; document in the README.
- Per-image token-overhead formula in `count_tokens` (D-E1): the "(W × H) / 750 or 1568 fallback" comes from Anthropic's docs — planner verifies this is still current at planning time; if it changed, use the new formula and document.
- `tool_choice` mapping edge cases (D-D3 covers the common four; planner verifies edge cases like Anthropic's `disable_parallel_tool_use: true` modifier against the researcher's findings).
- pino log shape for translation events: at debug level only (`{ event: 'translate', direction: 'anthropic_in', blocks: 3, tools: 1, ms: 0.4 }`). Planner picks fields; no logs at info level for translation (would spam at request volumes).
- Vitest test layout: `router/tests/translation/{openai-in,openai-out,anthropic-in,anthropic-out,golden}.test.ts`. Golden fixtures live as JSON files under `router/tests/translation/golden/`.
- Whether to add a `router/tests/integration/messages.{nonstream,stream}.test.ts` parallel to the existing `chat-completions.*.test.ts` (recommended yes — covers the route + zod + adapter wiring end-to-end with msw-style stubbed upstreams).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase context (this directory)
- `.planning/phases/04-anthropic-surface-v1-messages-tool-calling-vision/04-CONTEXT.md` — this file (locked decisions D-A1..D-F5)
- `.planning/phases/04-anthropic-surface-v1-messages-tool-calling-vision/04-DISCUSSION-LOG.md` — discussion audit trail (humans only; not consumed by agents)
- `.planning/phases/03-multi-backend-dispatch-llama-cpp-registry-hardening/03-CONTEXT.md` — Phase 3 locked decisions: `BackendAdapter` widening pattern (D-A7 / D-A8), `AdapterFactory` (D-C5 row of "Claude's Discretion"), semaphore wiring (D-B1..B6), registry tightening (D-E1..E3), `LlamacppOpenAIAdapter` template (D-A4..A8). Phase 4 adds a NEW canonical method to `BackendAdapter` — same widening pattern as Phase 3 added `probeLiveness`.
- `.planning/phases/02-mvp-vertical-slice-router-ollama-sse/02-CONTEXT.md` — Phase 2 locked decisions: openai SDK upstream pattern (D-B1), error envelope shape (D-C1..C4), SSE infra (heartbeat, abort propagation, backpressure), zod validation style ("minimal validation + passthrough").
- `.planning/phases/01-gpu-compose-foundation/01-CONTEXT.md` — Phase 1 locked decisions: host data root (D-01), `x-gpu` anchor, networks (D-13), `.env` contract (D-14), Ollama image pin.

### Project-level
- `.planning/PROJECT.md` — Core Value, Constraints (16 GB VRAM cap), **Key Decisions** (especially "Anthropic translation: normalize internally to canonical Anthropic-shape (strict superset of OpenAI). Translate inbound + outbound separately. Round-trip golden tests"), Out-of-Scope.
- `.planning/REQUIREMENTS.md` — v1 requirement IDs (this phase covers **ANTHR-01..08, TOOL-01..05, VISION-01..03** — 16 requirements).
- `.planning/ROADMAP.md` §"Phase 4: Anthropic Surface — `/v1/messages`, Tool Calling, Vision" — Goal + 5 Success Criteria (the verification anchor).
- `.planning/STATE.md` — accumulated context, standing anti-patterns (no `compress` middleware on `/v1/messages` either), Phase 4 listed as "research-flagged: Anthropic translation is the hardest piece".
- `CLAUDE.md` — full stack spec including:
  - §"Core Technologies — Router" — `openai@^6` + `@anthropic-ai/sdk@^0.95` (types only) + zod v4.
  - §"Supporting Libraries — Router" — `fastify-sse-v2` for SSE; `@bram-dc/fastify-type-provider-zod` for typed routes.
  - §"Streaming gotchas — Fastify + SSE" — abort/heartbeat/backpressure patterns Phase 2 already implements; Phase 4 must not regress them.
  - §"Ollama Cloud — API surface (2026)" — `https://ollama.com/api/chat` cloud equivalent (Phase 8); Phase 4's `ollama-native-out` translator forward-compats here.

### Research (READ BEFORE PLANNING — research flag YES)
- `.planning/research/SUMMARY.md` §"Phase 4: Anthropic protocol surface — `/v1/messages` + tool calling" — phase rationale + research flag list (canonical-shape choice, parallel-tool-call streaming, `input_json_delta` chunking, `cache_control` passthrough, `is_error: true` round-trip).
- `.planning/research/SUMMARY.md` line 109 — **Anthropic ↔ OpenAI tool-calling translation drift** — canonical-shape recommendation + golden-test mandate.
- `.planning/research/PITFALLS.md` **Pitfall 5: Anthropic ↔ OpenAI tool-calling translation — the silent corruption** — wire-format diffs table, canonical normalization mandate, JSON.stringify discipline, role-alternation validation, `is_error: true` semantics, common symptoms list.
- `.planning/research/PITFALLS.md` **Pitfall 8: Ollama OpenAI-compat endpoint quirks (vision + role conventions + name resolution)** — **load-bearing for VISION-03**: Ollama `/v1/chat/completions` re-translates image_url into `images: ["<base64>"]` and has known issues on newer multimodal models; ROUTE via native `/api/chat`. Vision returning text-that-ignores-image is the bug class.
- `.planning/research/FEATURES.md` §Anthropic surface — typed streaming events, `message_start` / `content_block_delta` / `message_stop` ordering, usage-token splitting (input on `message_start`, output on `message_delta`), 15s heartbeat (ping events on `/v1/messages`).
- `.planning/research/ARCHITECTURE.md` §3 — data flow for `/v1/chat/completions` and `/v1/messages`: translate inbound to canonical, dispatch, re-emit wire format. **Never single-hop.**

### Existing router code (read before editing)
- `router/src/backends/adapter.ts` — `BackendAdapter` interface; Phase 4 adds `chatCompletionsCanonical` + stream variant. Removes Phase 2's `chatCompletions` / `chatCompletionsStream`.
- `router/src/backends/ollama-openai.ts` — reference impl; Phase 4 adds the internal vision split (image-bearing → native `/api/chat`).
- `router/src/backends/llamacpp-openai.ts` — Phase 3 impl; Phase 4 just gives it the new canonical method (no vision branch — D-B4).
- `router/src/backends/factory.ts` — unchanged contract; returns `BackendAdapter` keyed by `entry.backend`.
- `router/src/config/registry.ts` — Phase 4 adds **NO** zod-schema changes (capabilities already include `vision` and `tools`); only adds a new model entry in `models.yaml`.
- `router/src/routes/v1/chat-completions.ts` — refactored to flow through canonical (D-A3 / D-F3); semaphore + heartbeat + abort plumbing unchanged.
- `router/src/routes/v1/models.ts` — emits the new model with `capabilities: [chat, vision]`; no code change beyond config.
- `router/src/auth/bearer.ts` — public-path skip-list unchanged; `/v1/messages*` is bearer-gated by default.
- `router/src/errors/envelope.ts` — Phase 4 adds `CapabilityNotSupportedError` (400 → invalid_request) and `anthropicErrorFrame()` helper (mid-stream Anthropic error event shape).
- `router/src/sse/heartbeat.ts` + `sse/stream.ts` — reused; messages route uses a different frame helper (Anthropic typed events) but the heartbeat + backpressure infra is identical.
- `router/models.yaml` — Phase 4 adds entry #3: `llama3.2-vision:11b-instruct-q4_K_M` :: `ollama` :: `[chat, vision]` :: vram_budget 8.
- `router/tests/` — Phase 4 adds `tests/translation/` (unit tests for translators + golden fixtures) AND `tests/integration/messages.{nonstream,stream}.test.ts` (route-level end-to-end with msw-stubbed Ollama).
- `bin/smoke-test-router.sh` — Phase 4 extends with `/v1/messages` (stream + non-stream) + `/v1/messages/count_tokens` + vision happy path against `llama3.2-vision`.
- `README.md` — adds the one-time `ollama pull llama3.2-vision:11b-instruct-q4_K_M` step and a "Phase 4: Anthropic surface" operational section.

### External docs (verify still current at planning time — research flag)
- Anthropic Messages API reference — `https://docs.anthropic.com/en/api/messages` (request/response shapes, `system` field, role alternation rules, `anthropic-version` header).
- Anthropic streaming events — `https://docs.anthropic.com/en/api/messages-streaming` (typed event ordering, `input_json_delta` chunking for `tool_use` blocks, `message_delta.usage.output_tokens`).
- Anthropic count_tokens — `https://docs.anthropic.com/en/api/messages-count-tokens` (request/response shape, per-image overhead formula).
- Anthropic tool use — `https://docs.anthropic.com/en/docs/build-with-claude/tool-use` (`tool_choice` modes, `is_error: true` semantics, parallel tools, `disable_parallel_tool_use`).
- OpenAI tool calling — `https://platform.openai.com/docs/guides/function-calling` (`tool_calls[].function.arguments` string-encoded, `tool_choice` modes, `parallel_tool_calls` flag).
- OpenAI vision — `https://platform.openai.com/docs/guides/vision` (image_url content block shape, URL vs base64).
- Ollama native API — `https://docs.ollama.com/api/generate` AND `https://docs.ollama.com/api/chat` (`images: [base64]` array on messages, no data-url prefix).
- Ollama vision capabilities — `https://docs.ollama.com/capabilities/vision` (which model tags expose vision; the known-broken OpenAI-compat issue for Ollama Cloud vision: `https://github.com/NousResearch/hermes-agent/issues/14592`).
- `gpt-tokenizer` package — `https://www.npmjs.com/package/gpt-tokenizer` (cl100k_base encoder; pin a version at planning time).
- `ulid` package — `https://www.npmjs.com/package/ulid` (or alternative; planner picks).
- LiteLLM Anthropic adapter — `https://docs.litellm.ai/docs/providers/anthropic` (reference impl for the same translation problem; useful sanity check on canonical-shape edge cases).
- openai-agents-python #1797 — `https://github.com/openai/openai-agents-python/issues/1797` (`tool_result` blocks before `tool_use` blocks — a class of bug to write a test against).

### New router npm deps (Phase 4 adds)
- `gpt-tokenizer@^2.x` — count_tokens encoder (cl100k_base).
- `ulid@^2.x` — `msg_<ulid>` + `toolu_<ulid>` generation.
- `@anthropic-ai/sdk@^0.95` — TYPES ONLY (devDep or peerDep; never imported in runtime adapter code). Used in tests for canonical-out validation.
- (potentially) `undici@^7` if direct `fetch` to `http://ollama:11434/api/chat` needs keep-alive tuning. Planner evaluates; default Node 22 fetch may suffice.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`router/src/backends/adapter.ts`** — `BackendAdapter` interface already widened once in Phase 3 (added `probeLiveness`). Phase 4 widens again with `chatCompletionsCanonical` + stream. Pattern is established: extend the interface, update both adapters in parallel, route handler picks the right method per call. Phase 3 already proved the seam is the abstraction.
- **`router/src/backends/factory.ts`** — `makeAdapter(entry)` keyed by `entry.backend` is the dispatch point that Phase 3 hardened (CR-01 fix). Phase 4 changes NOTHING here.
- **`router/src/sse/heartbeat.ts` + `sse/stream.ts`** — 15s heartbeat, backpressure via `reply.raw.write()` return-value, abort wiring. Phase 4 reuses verbatim; the `/v1/messages` stream branch uses Anthropic-typed event frames (via `reply.sse({event: 'message_start', data: ...})`) instead of OpenAI `delta` chunks.
- **`router/src/concurrency/semaphore.ts`** — `BackendSemaphore` + `safeRelease` idempotency pattern. Phase 4 `/v1/messages` reuses identically.
- **`router/src/errors/envelope.ts`** — `mapToHttpStatus` + `toOpenAIErrorEnvelope` + `BearerAuthError` + `RegistryUnknownModelError` + `BackendSaturatedError`. Phase 4 adds `CapabilityNotSupportedError` (400) + `anthropicErrorFrame()` helper. `mapToHttpStatus` and the OpenAI envelope shape remain authoritative for `/v1/chat/completions`; `/v1/messages` errors get a separate body shape (Anthropic's `{ type: "error", error: {...} }`).
- **`router/src/auth/bearer.ts`** — onRequest hook + constant-time compare. Phase 4 adds nothing (public skip-list unchanged).
- **`router/src/routes/v1/chat-completions.ts`** — the route shape (try/finally, onClose, safeRelease, heartbeat) is the template for `/v1/messages`. Phase 4 lifts ~70% of this file into a shared route-helper or duplicates with discipline. Planner picks.
- **`router/src/config/registry.ts`** — `capabilities` enum already includes `vision` and `tools`. Phase 4 only adds a YAML entry; zero schema change.
- **`bin/smoke-test-router.sh`** — Phase 2/3 section pattern; Phase 4 appends a "Phase 4 — Anthropic surface + vision" section.

### Established Patterns
- **One canonical shape, two translators per direction** (D-A1, D-A2) — Phase 4 INTRODUCES this pattern; later phases (Phase 7 vLLM, Phase 8 OllamaCloud) must follow it (new adapter implements `chatCompletionsCanonical`, no new translator file unless backend wire format differs from OpenAI-compat).
- **Adapter-internal protocol split** (D-B3) — `OllamaOpenAIAdapter` chooses native vs compat based on content inspection. Phase 8's `OllamaCloudAdapter` will mirror this pattern for vision (cloud has the same broken `/v1/chat/completions` for vision per Pitfall 8).
- **Capability-gating-before-adapter** (D-C2, D-C3) — new pattern: route handler walks canonical request, throws typed error mapped to 400, never hits the backend on mismatch.
- **Translators own protocol-format details** (D-D2) — JSON.stringify/parse for tool args, role-alternation refinement, `tool_choice` mapping. Adapters never know about wire format quirks.
- **`error` SSE frames per protocol** (D-F5) — OpenAI uses `event: error` + `[DONE]`; Anthropic uses `event: error` with the typed error body. Both shapes live in `errors/envelope.ts`.
- **`onClose` listener on `req.raw.socket`** (NOT `req.raw`) — Phase 2 BLOCKER fix; reuse on `/v1/messages` without re-discovering.
- **`include_usage: true` on streaming requests** to get the final `output_tokens` chunk — Phase 2 pattern; Phase 4 reuses for the `message_delta.usage.output_tokens` value.

### Integration Points
- **`router/src/translation/`** (new directory) — six files: `canonical.ts`, `openai-in.ts`, `openai-out.ts`, `anthropic-in.ts`, `anthropic-out.ts`, `ollama-native-out.ts`.
- **`router/src/routes/v1/messages.ts`** (new) — `POST /v1/messages` + `POST /v1/messages/count_tokens`. Mirrors the structure of `chat-completions.ts` (semaphore acquire, abort wiring, heartbeat, sseCleanup, safeRelease) but uses `anthropic-in` → adapter → `anthropic-out` translation pipeline.
- **`router/src/backends/adapter.ts`** — extend `BackendAdapter` with `chatCompletionsCanonical` + stream. Remove `chatCompletions` / `chatCompletionsStream` from the interface.
- **`router/src/backends/ollama-openai.ts`** — rewrite to implement `chatCompletionsCanonical`. Internal split on image content: vision → native `/api/chat` (raw fetch + `ollama-native-out` translator); text/tool → existing OpenAI-compat path. `probeLiveness` unchanged.
- **`router/src/backends/llamacpp-openai.ts`** — rewrite to implement `chatCompletionsCanonical`. No vision branch (D-B4); always OpenAI-compat path. `probeLiveness` unchanged.
- **`router/src/routes/v1/chat-completions.ts`** — refactor to flow through canonical (D-A3): zod → `openai-in` → adapter → `openai-out` → reply. Semaphore/heartbeat/abort plumbing unchanged.
- **`router/src/errors/envelope.ts`** — add `CapabilityNotSupportedError` (extends Error, code: `model_capability_mismatch`); add `anthropicErrorFrame(envelope)` helper for mid-stream `/v1/messages` errors.
- **`router/src/app.ts`** — register `registerMessagesRoute` and `registerCountTokensRoute` next to `registerChatCompletionsRoute`. Plumb the same semaphore Map (D-F1 reuses Phase 3's per-backend semaphore).
- **`router/models.yaml`** — add the `llama3.2-vision:11b-instruct-q4_K_M` entry under `backend: ollama` with `capabilities: [chat, vision]` and `vram_budget_gb: 8`.
- **`router/package.json`** — add `gpt-tokenizer` + `ulid` deps; add `@anthropic-ai/sdk` as devDep (tests only).
- **`router/tests/translation/`** (new) — unit tests + golden fixtures.
- **`router/tests/integration/messages.{nonstream,stream}.test.ts`** (new) — end-to-end route tests with msw-stubbed Ollama.
- **`bin/smoke-test-router.sh`** — extend with `/v1/messages` (non-stream + stream) + vision happy-path against the new Llama 3.2-Vision model.
- **`README.md`** — Phase 4 operational section: `ollama pull llama3.2-vision:11b-instruct-q4_K_M`, sample `/v1/messages` curl, sample tool-call request body, vision URL vs base64 examples.

</code_context>

<specifics>
## Specific Ideas

- **Vision model exact tag:** `llama3.2-vision:11b-instruct-q4_K_M` — planner verifies the exact tag exists in Ollama's catalog at planning time (`ollama list` after pull). If Ollama renames the tag, swap to the current name and document in 04-CONTEXT.md errata.
- **Per-image token overhead in count_tokens:** Anthropic's documented formula is `(width × height) / 750` tokens, with a `1568` fallback if dimensions are not measurable. Planner pulls the dimensions from the base64 PNG/JPEG header at count time (10 LOC) or accepts the fallback if it's a URL we don't fetch in count_tokens (count_tokens never makes network calls; URL images get the fallback constant).
- **Golden fixture file layout** (suggested):
  ```
  router/tests/translation/golden/
    01-single-tool/
      input-openai.json
      input-anthropic.json
      canonical.json
      output-openai.json
      output-anthropic.json
    02-parallel-tools/
      ...
    03-is-error-tool-result/
      ...
    04-tool-choice-required/
      ...
    05-tool-choice-specific/
      ...
    06-vision-base64/
      ...
    07-vision-url/
      ...
  ```
  Each test reads `input-*.json`, runs through the translator stack, asserts against `canonical.json` and `output-*.json`.
- **`message_start` event payload** (Anthropic wire-correct):
  ```json
  {
    "type": "message_start",
    "message": {
      "id": "msg_01HXYZ...",
      "type": "message",
      "role": "assistant",
      "content": [],
      "model": "llama3.2-vision:11b-instruct-q4_K_M",
      "stop_reason": null,
      "stop_sequence": null,
      "usage": { "input_tokens": 12, "output_tokens": 1 }
    }
  }
  ```
  Note `usage.output_tokens: 1` on message_start (Anthropic's convention — they pre-allocate 1 for the role token). `message_delta.usage.output_tokens` overrides at end-of-stream.
- **`content_block_start` for tool_use:**
  ```json
  {
    "type": "content_block_start",
    "index": 0,
    "content_block": { "type": "tool_use", "id": "toolu_01ABC...", "name": "get_weather", "input": {} }
  }
  ```
  Then chunked `input_json_delta` events build up the input object incrementally as the model emits its tool args. Researcher confirms the chunking strategy used by Ollama's underlying model output (which is OpenAI-compat-shaped; translator emits canonical `input_json_delta` events from the OpenAI string-chunks).
- **`Capability mismatch` envelope** (404→400 distinction):
  ```json
  { "error": { "type": "invalid_request_error", "code": "model_capability_mismatch", "message": "Model 'llama3.2:3b-instruct-q4_K_M' does not support capability 'vision'. Pick a model with 'vision' in its capabilities list.", "param": "model" } }
  ```
  For `/v1/messages` use the Anthropic body shape: `{ "type": "error", "error": { "type": "invalid_request_error", "message": "..." } }`.
- **README snippet for Anthropic curl:**
  ```bash
  curl -N -H "Authorization: Bearer $LOCAL_LLMS_BEARER" \
       -H "Content-Type: application/json" \
       -H "anthropic-version: 2023-06-01" \
       -d '{
         "model": "llama3.2-vision:11b-instruct-q4_K_M",
         "max_tokens": 1024,
         "stream": true,
         "messages": [
           {"role": "user", "content": [
             {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "..."}},
             {"type": "text", "text": "What is in this image?"}
           ]}
         ]
       }' \
       http://router:3000/v1/messages
  ```

</specifics>

<deferred>
## Deferred Ideas

- **PDF document blocks** (`DOCS-01`) and **extended-thinking blocks** (`THINK-01`) — v2 backlog. Canonical shape (D-A1) accommodates both as new `ContentBlock` union variants when the time comes; Phase 4 explicitly does NOT define types for them.
- **Anthropic `cache_control` passthrough** — no-op in Phase 4 (purely-local Anthropic-shape responses; nothing to cache against). Phase 8 evaluates when cloud-backed requests land via `backend: ollama-cloud`.
- **Structured outputs / guided decoding** (`STRUCT-01`) — v2 backlog. Neither vLLM's `guided_json` nor llama.cpp's grammar mode lands here.
- **Vision on llama.cpp** (D-B4) — Phase 4 explicitly skips llama.cpp's llava sub-protocol. Vision lives on Ollama in Phase 4 + on vLLM (Qwen2-VL-AWQ) in Phase 7.
- **`X-Model-Backend` response header** (ROUTE-10) — Phase 8.
- **Server-side rate limit** (ROUTE-11) + **Idempotency-Key** (ROUTE-12) — Phase 8.
- **Postgres `request_log` capture of Anthropic-shape requests** — Phase 5. Phase 4's request body is the canonical request; Phase 5 schema decides how to serialize Anthropic-style content blocks for storage (raw JSON column likely).
- **Prometheus `/metrics`** including Anthropic-vs-OpenAI surface counters — Phase 5.
- **`tool_choice: "none"` cleaner mapping** — D-D3 currently strips `tools[]` entirely. If a planner finds Anthropic now supports `tool_choice: {type: "none"}` natively, swap. Researcher to verify.
- **Image URL fetching in non-count_tokens routes** — D-C4 fetches URL images in `ollama-native-out`. If this becomes a security concern (SSRF, egress-control bypass), add an allowlist OR push the responsibility back to clients (require base64 only). Phase 8 + Phase 9 may revisit.
- **`/v1/messages` capability gating for `tools` too** (D-C3 keeps it soft) — re-evaluate after first real-world routing bug.
- **`/v1/responses` (OpenAI new responses endpoint)** — `RESP-01` in v2 backlog.
- **Open WebUI Anthropic-connection support** — Open WebUI's connection picker hits `/v1/models` (OpenAI shape). Phase 4 makes `/v1/messages` reachable, but Open WebUI doesn't natively speak Anthropic protocol; if the user wants to compare via Anthropic surface in Open WebUI, that's a Phase 6+ exploration.
- **Whether `/v1/chat/completions` should ALSO accept Anthropic-shape inputs** — explicit no in Phase 4 (the routes are protocol-pure). Re-evaluate if agents request the convenience; the canonical translator already supports it, only the route's zod schema gates it.

</deferred>

---

*Phase: 4-Anthropic Surface — `/v1/messages`, Tool Calling, Vision*
*Context gathered: 2026-05-13*
