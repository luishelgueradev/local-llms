# Phase 4: Anthropic Surface — `/v1/messages`, Tool Calling, Vision - Research

**Researched:** 2026-05-13
**Domain:** Bidirectional Anthropic ↔ canonical ↔ OpenAI translation with typed SSE, parallel tool calls, and vision, over a Fastify v5 router that already speaks OpenAI compat.
**Confidence:** HIGH on Anthropic wire format (verified against current docs 2026-05-13), HIGH on Ollama native `/api/chat` shape, HIGH on tool_choice mapping (one correction vs CONTEXT.md), HIGH on count_tokens response shape and per-image formula, HIGH on stream library and ULID/tokenizer pins.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Canonical shape + translator location**
- **D-A1:** Internal canonical shape mirroring Anthropic 1:1. Hand-rolled TS types + zod schemas in `router/src/translation/canonical.ts` — not a direct re-export of `@anthropic-ai/sdk`'s types.
- **D-A2:** Dedicated translator module per direction under `router/src/translation/`: `canonical.ts`, `openai-in.ts`, `openai-out.ts`, `anthropic-in.ts`, `anthropic-out.ts`, `ollama-native-out.ts`.
- **D-A3:** Both `/v1/chat/completions` AND `/v1/messages` flow through canonical. No single-hop OpenAI↔Anthropic translation exists anywhere.
- **D-A4:** `@anthropic-ai/sdk` is types-only (tests). Adapters never import from the SDK.

**Adapter surface (`BackendAdapter` widening)**
- **D-B1:** Add `chatCompletionsCanonical(canonical, signal): Promise<CanonicalResponse>` and `chatCompletionsCanonicalStream(canonical, signal): Promise<AsyncIterable<CanonicalStreamEvent>>` to `BackendAdapter`.
- **D-B2:** Phase 2's `chatCompletions` / `chatCompletionsStream` are REMOVED from the interface. `probeLiveness` unchanged. `factory.makeAdapter` contract unchanged.
- **D-B3:** `OllamaOpenAIAdapter.chatCompletionsCanonical` internally splits on content: image-bearing → native `/api/chat` (raw fetch via undici, `ollama-native-out` translator); else → existing OpenAI-compat path. Split invisible above the adapter seam.
- **D-B4:** `LlamacppOpenAIAdapter.chatCompletionsCanonical` uses OpenAI-compat for everything in Phase 4 — vision lives on Ollama (D-C1). No llava sub-protocol work.
- **D-B5:** `CanonicalStreamEvent` is a union of `message_start | content_block_start | content_block_delta | content_block_stop | message_delta | message_stop | ping`. Anthropic-out serializes verbatim; OpenAI-out reassembles into delta chunks. Heartbeats: 15s pattern preserved; `/v1/messages` emits `event: ping\ndata: {"type":"ping"}` instead of `:keepalive` comment frames.

**Vision routing + model**
- **D-C1:** Add `llama3.2-vision:11b-instruct-q4_K_M` to `models.yaml` under `backend: ollama` with `capabilities: [chat, vision]` and `vram_budget_gb: 8`. Ollama VRAM sum 4 + 8 = 12 GB ≤ 16.
- **D-C2:** Capability gating fires BEFORE the adapter call. New `CapabilityNotSupportedError` mapped to 400 via the centralized error handler (envelope `{type: "invalid_request_error", code: "model_capability_mismatch", param: "model"}`).
- **D-C3:** Capability check for `tools` is SOFT in Phase 4 (warn-log, pass through). Vision misroutes silently corrupt; tool misroutes just produce a bad completion.
- **D-C4:** Ollama native `/api/chat` shape: `messages[i].content` (string) + `messages[i].images: [<bare base64>]` — NO `data:image/...;base64,` prefix. Translator normalizes URL + base64 inputs to bare base64.

**Tool calling translation**
- **D-D1:** Full golden suite — single, parallel, `is_error: true`, `tool_choice=required/any/specific`, vision base64, vision URL. Fixtures under `router/tests/translation/golden/`.
- **D-D2:** JSON.stringify discipline lives in translators, NOT adapters. `openai-in`: parse `tool_calls[i].function.arguments` (string) → object. `openai-out`: stringify canonical `tool_use.input` (object) → string. Anthropic side passes through (both objects). Adapters never touch tool args.
- **D-D3:** `tool_choice` mapping table:
  - OpenAI `"auto"` ↔ canonical `{type:"auto"}`
  - OpenAI `"required"` ↔ canonical `{type:"any"}`
  - OpenAI `{type:"function", function:{name:"X"}}` ↔ canonical `{type:"tool", name:"X"}`
  - OpenAI `"none"` → strip `tools[]` (Anthropic has no equivalent). **[See FINDING 3.4 — this mapping needs revision in 2026.]**
- **D-D4:** `parallel_tool_calls: false` (OpenAI-only) recorded in canonical as `_meta.disable_parallel_tools: true`. On outbound OpenAI: `parallel_tool_calls: false`. On outbound Anthropic: surfaces via the `disable_parallel_tool_use` modifier on `tool_choice` (planner refines based on FINDING 3.4 below).
- **D-D5:** `stop_sequences` ⇄ `stop` mapping. OpenAI string → canonical `[string]`. OpenAI array → canonical array (reject if >5 entries — Anthropic limit). Canonical → OpenAI as array form.

**count_tokens + event IDs**
- **D-E1:** `POST /v1/messages/count_tokens` uses `gpt-tokenizer` (cl100k_base). Encoder loaded once at boot. Per-image overhead via `(W × H) / 750` with 1568 fallback when dimensions unknown. Response shape: `{ "input_tokens": N }` verbatim Anthropic.
- **D-E2:** Response header `X-Token-Count-Method: gpt-tokenizer/cl100k_base` so agents can decide whether to trust it.
- **D-E3:** `message_start.id` format: `msg_<ulid>`. Add `ulid@^2.x` (planner verifies — see FINDING 8.2: latest is 3.0.2).
- **D-E4:** `content_block.id` for `tool_use` blocks: `toolu_<ulid>` (Anthropic prefix convention). Translators carry the id through OpenAI `tool_calls[i].id` ↔ canonical `tool_use.id`.
- **D-E5:** `anthropic-version` request header echoed verbatim. If client sends nothing, no default injected. If unknown version, warn-log but echo and proceed.

**Routes + auth + capability gating**
- **D-F1:** `POST /v1/messages` and `POST /v1/messages/count_tokens` register next to `/v1/chat/completions`. Both bearer-gated. Messages route uses semaphore + heartbeat + abort like chat-completions. count_tokens is pure CPU — no semaphore.
- **D-F2:** Bearer skip-list unchanged (`/healthz`, `/readyz` only).
- **D-F3:** Existing chat-completions route refactored to flow through canonical (D-A3). Phase 2's "minimal validation + passthrough" zod style preserved; canonical translation happens AFTER zod, BEFORE semaphore acquire. Semaphore/heartbeat/abort plumbing untouched.
- **D-F4:** SSE event-order invariant on `/v1/messages` — `message_start` before any `content_block_*`; every opened block closed with `content_block_stop`; `message_delta` (with `output_tokens`) before `message_stop`. Unit-tested at translator level.
- **D-F5:** Error frames mid-stream: Anthropic uses `event: error\ndata: {"type":"error", "error":{...}}` (not `[DONE]` like OpenAI). New `anthropicErrorFrame(envelope)` helper alongside existing `midStreamErrorFrameLines`.

### Claude's Discretion
- Exact filenames / module layout under `router/src/translation/` (planner refines if friction during type definition).
- Exact zod schema shape for `CanonicalRequest` / `Message` / `ContentBlock`.
- ULID vs nanoid implementation pin (`ulid` vs `@bogeychan/ulid` vs DIY). **Recommended:** `ulid@^3.0.2` (FINDING 8.2).
- `gpt-tokenizer` vs `@dqbd/tiktoken` (planner picks based on bundle/cold-start). **Recommended:** `gpt-tokenizer@^3.x` (FINDING 8.1).
- Image-URL fetching policy in `ollama-native-out.ts`: timeout, max body size, allowed schemes. **Recommended:** 10s timeout, 10 MB cap, `http|https` only (planner documents).
- Per-image token-overhead formula in `count_tokens` — Anthropic doc confirms `(W × H) / 750` still current in 2026 (FINDING 2.2), and Claude Opus 4.7 has a higher cap (4784 tokens / 2576 px long edge) — but cl100k_base local estimate uses the 1568-cap heuristic.
- `tool_choice` mapping for `"none"` and `disable_parallel_tool_use` — **must revise D-D3 / D-D4 per FINDING 3.4** below; Anthropic now natively supports `{type:"none"}` AND `disable_parallel_tool_use`.
- pino log shape for translation events (debug level only).
- Vitest test layout: `router/tests/translation/{openai-in,openai-out,anthropic-in,anthropic-out,golden}.test.ts` + integration tests `router/tests/integration/messages.{nonstream,stream}.test.ts`.

### Deferred Ideas (OUT OF SCOPE)
- **PDF document blocks** (DOCS-01) — v2 backlog. Canonical accommodates as new `ContentBlock` variant when the time comes; Phase 4 does NOT define types for them.
- **Extended-thinking blocks** (THINK-01) — v2 backlog. Anthropic's `thinking` content blocks with `thinking_delta` and `signature_delta` events (FINDING 1.2) are documented but DEFERRED.
- **Anthropic `cache_control` passthrough** — no-op in Phase 4. Phase 8 evaluates with cloud-backed requests.
- **Structured outputs / guided decoding** (STRUCT-01) — v2 backlog.
- **Vision on llama.cpp** — Phase 4 skips llava sub-protocol. Vision on Ollama only.
- **`X-Model-Backend` response header** (ROUTE-10) — Phase 8.
- **Server-side rate limit** (ROUTE-11) + **Idempotency-Key** (ROUTE-12) — Phase 8.
- **Postgres `request_log`** — Phase 5.
- **Prometheus `/metrics`** — Phase 5.
- **Image URL fetching SSRF hardening** — Phase 9.
- **`/v1/responses`** (OpenAI new responses endpoint, RESP-01) — v2 backlog.
- **`/v1/chat/completions` accepting Anthropic-shape inputs** — explicit no in Phase 4.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ANTHR-01 | `POST /v1/messages` non-stream + stream | FINDING 1.1, 1.2, 1.3 — exact event order + JSON shapes verified |
| ANTHR-02 | `POST /v1/messages/count_tokens` | FINDING 2.1 (response shape), 2.2 (image formula), 8.1 (tokenizer) |
| ANTHR-03 | Top-level `system` field honored | FINDING 1.4 — system is top-level param, not in messages[] |
| ANTHR-04 | Strict role alternation enforced | FINDING 1.5 — exact error semantics + 400 rejection rule |
| ANTHR-05 | `anthropic-version` header echoed | FINDING 7 — `2023-06-01` is the only supported value in 2026 |
| ANTHR-06 | Typed SSE events in correct order | FINDING 1.1, 1.2 — full event sequence from official docs |
| ANTHR-07 | `input_tokens` on `message_start`, `output_tokens` on `message_delta` (cumulative) | FINDING 1.3 — message_delta usage is cumulative |
| ANTHR-08 | `stop_sequences` ⇄ `stop` mapping | FINDING 3.5 |
| TOOL-01 | OpenAI tool defs → canonical Anthropic blocks | FINDING 3.1, 3.2 — schema mapping + JSON.stringify discipline |
| TOOL-02 | Anthropic tool defs accepted natively | FINDING 3.3 — wire-format shape from official docs |
| TOOL-03 | Parallel tool calls round-trip | FINDING 3.6 — multiple `tool_use` blocks in one assistant message |
| TOOL-04 | `tool_result` with `is_error: true` round-trips | FINDING 3.7 — exact block shape |
| TOOL-05 | Round-trip golden tests in CI | FINDING 10 — validation architecture |
| VISION-01 | Image input URL + base64 in both protocols | FINDING 4.1 (Anthropic), 4.2 (OpenAI), 4.3 (Ollama) |
| VISION-02 | Capability gating returns 400 before backend | Pre-adapter walk in route handler — pure code, no external verify needed |
| VISION-03 | Ollama vision via native `/api/chat`, not OpenAI shim | FINDING 5 — known broken on `/v1/chat/completions` for some vision paths |

</phase_requirements>

## Summary

Phase 4 implements bidirectional Anthropic ↔ canonical ↔ OpenAI translation on top of the Phase 2/3 router. The translation problem is well-understood — Anthropic's wire format is a strict superset of OpenAI's, and a canonical-shape (Anthropic-mirroring) approach with separate inbound/outbound translators is what LiteLLM, Vercel AI SDK, and OpenRouter all converged on. All four of CONTEXT.md's locked architectural decisions (D-A1..D-A4, D-B1..D-B5) match industry consensus.

The single behavioral subtlety not covered by CONTEXT.md is that **Anthropic added `tool_choice: {"type": "none"}` and the `disable_parallel_tool_use` modifier in 2025** ([FINDING 3.4](#finding-34--tool_choice-mapping-table-corrected-for-2026)) — D-D3 / D-D4 should be revised to use these native shapes instead of "strip tools[]" / a custom `_meta` field. The planner can adjust the mapping cleanly without rearchitecting; this is a translator-internal change.

The streaming event sequence is wire-correct as documented in CONTEXT.md `<specifics>` — `message_start` carries `usage.input_tokens` AND `usage.output_tokens: 1` (Anthropic pre-allocates 1 for the role token), `message_delta.usage.output_tokens` is **cumulative** (not a per-chunk delta), and `input_json_delta.partial_json` chunks come in coarse-grained "complete-key-value-at-a-time" form — meaning the translator's job is the inverse: OpenAI streams `delta.tool_calls[].function.arguments` as fine-grained string fragments, and the Anthropic-out translator must accumulate-and-re-emit them as `input_json_delta` events (pass-through works; no buffering required).

Vision routing through Ollama remains broken on `/v1/chat/completions` for some models (FINDING 5) — the native `/api/chat` path with `images: [bare-base64]` is the right choice. The exact Ollama tag `llama3.2-vision:11b-instruct-q4_K_M` is current in the catalog (FINDING 6).

**Primary recommendation:** Implement CONTEXT.md decisions as-written EXCEPT revise D-D3 / D-D4 to use Anthropic's native `tool_choice: {"type": "none"}` and `disable_parallel_tool_use` modifier. The rest of the locked decisions are wire-correct and forward-compatible with future phases.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Request parsing + role-alternation refinement | Router (translators) | — | Translators own protocol-format knowledge; adapters stay protocol-agnostic |
| Canonical request build | Router (translators) | — | One canonical shape, two translators per direction (D-A1, D-A2) |
| Capability gating (vision-to-non-vision-model 400) | Router (route handler) | — | Pre-adapter check on resolved `entry.capabilities`; never hits backend (D-C2) |
| Adapter dispatch by `entry.backend` | Router (factory.makeAdapter) | — | Phase 3 hardened seam — unchanged in Phase 4 |
| Image content split (native vs OpenAI-compat) | Router (Ollama adapter) | — | Adapter-internal seam invisible to routes (D-B3) |
| Image URL fetching | Router (`ollama-native-out` translator) | — | Translators normalize URL + base64 inputs to bare base64 for Ollama (D-C4) |
| Outbound HTTP to local Ollama text/tool | Router (`OllamaOpenAIAdapter` via openai SDK v6) | — | Phase 2 pattern preserved |
| Outbound HTTP to local Ollama vision | Router (`OllamaOpenAIAdapter` via undici/fetch) | — | Native `/api/chat` raw POST; bypasses openai SDK because shape differs |
| Stream re-emission (typed events) | Router (`anthropic-out`) | — | Translates canonical stream union to Anthropic SSE wire format |
| Stream re-emission (OpenAI delta) | Router (`openai-out`) | — | Translates canonical stream union to OpenAI `delta` chunks (preserves Phase 2 wire format) |
| Token counting (count_tokens) | Router (route handler + gpt-tokenizer) | — | Pure CPU; no backend call; no semaphore acquire |
| Error envelope shape (per protocol) | Router (`errors/envelope.ts`) | — | OpenAI envelope for `/v1/chat/completions`; Anthropic envelope for `/v1/messages` (D-F5) |
| Heartbeat (15s) | Router (`sse/heartbeat.ts`) | — | Reused verbatim; messages route uses `event: ping` instead of comment frame |
| Backend liveness probing | Router (`probeLiveness`) | — | Unchanged — Phase 3 contract preserved |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `fastify` | `^5.8.5` (pinned in Phase 2) | HTTP server | Phase 2 baseline; v5 SSE async-iterable API is the workhorse here `[VERIFIED: package.json]` |
| `fastify-sse-v2` | `^4.2.2` (pinned in Phase 2) | SSE plugin with `reply.sse(asyncIterable)` | v4.x supports typed events via `{event, data, id}` yielded objects — exactly what Anthropic SSE needs `[CITED: github.com/mpetrunic/fastify-sse-v2]` |
| `@bram-dc/fastify-type-provider-zod` | `^7.0.1` (pinned in Phase 2) | Zod → Fastify route typing | Phase 2 baseline `[VERIFIED: package.json]` |
| `zod` | `^4.4.3` (pinned in Phase 2) | Validation + canonical schemas | Phase 2 baseline; canonical schemas live here `[VERIFIED: package.json]` |
| `openai` | `^6.37.0` (pinned in Phase 2) | Upstream client for OpenAI-compat backends (Ollama text/tool, llama.cpp) | Phase 2 baseline; ChatCompletion types reused by `openai-out` translator `[VERIFIED: package.json]` |

### Phase 4 additions
| Library | Version | Purpose | Why Recommended |
|---------|---------|---------|-----------------|
| `gpt-tokenizer` | `^3.x` (latest in 2026; v2.x also viable) | cl100k_base tokenizer for `count_tokens` | The fastest pure-JS BPE tokenizer on npm; smallest memory footprint; supports cl100k_base via `gpt-tokenizer/encoding/cl100k_base` import. Loaded once at boot. **No native deps** (avoids node-gyp friction on `node:22-bookworm-slim`). `[CITED: npmjs.com/package/gpt-tokenizer]` |
| `ulid` | `^3.0.2` (latest published ~late 2025; superset of CONTEXT.md's `^2.x` constraint) | `msg_<ulid>` + `toolu_<ulid>` generation | 26-char output (matches Anthropic's `msg_01HXYZ…` pattern); `monotonicFactory()` available for ID monotonicity within a millisecond; zero native deps. `[CITED: npmjs.com/package/ulid]` |
| `@anthropic-ai/sdk` | `^0.95.1` | **TYPES ONLY** — test cross-checks on canonical-out shapes | Used in `router/tests/translation/*.test.ts` to assert canonical-out satisfies `@anthropic-ai/sdk`'s `Message`/`MessageStream` types so we catch drift. **Never imported in `router/src/`** per D-A4. devDep. `[VERIFIED: CONTEXT.md D-A4]` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `gpt-tokenizer` | `@dqbd/tiktoken` (Rust native) | Faster than gpt-tokenizer for very high QPS, but requires WASM or native binding — adds build friction on `node:22-bookworm-slim`. **Not worth it** for a single-user router doing tens of count_tokens/min. |
| `gpt-tokenizer` | `js-tiktoken` | Older pure-JS port; gpt-tokenizer is faster and more actively maintained `[CITED: pkgpulse.com/guides/gpt-tokenizer-vs-js-tiktoken-vs-xenova-transformers-llm-2026]` |
| `ulid@^3` | `nanoid` | Smaller (21-char URL-safe) but NOT monotonic — Anthropic IDs are timestamp-sortable. Skip. |
| `ulid@^3` | `crypto.randomUUID()` | Native, zero-dep, but doesn't match Anthropic's look-and-feel (UUID vs ULID character set) — clients that pattern-match on `msg_01H...` will get confused. Skip. |
| `@anthropic-ai/sdk` for runtime | Hand-rolled types in `canonical.ts` | This IS the canonical-ts choice (D-A1). SDK is types-only in tests. |
| Native `fetch` for Ollama `/api/chat` | `undici` directly | Node 22's built-in `fetch` IS undici. Use the built-in unless keep-alive/timeout tuning needs explicit `Agent`. `[CITED: Node 22 docs]` |

**Installation:**
```bash
cd router
npm install gpt-tokenizer@^3 ulid@^3
npm install --save-dev @anthropic-ai/sdk@^0.95
```

**Version verification command:**
```bash
npm view gpt-tokenizer version       # confirm latest
npm view ulid version                 # confirm latest (3.0.2 as of 2026-05-13)
npm view @anthropic-ai/sdk version    # confirm 0.95.x current
```

## Architecture Patterns

### System Architecture Diagram

```
                ┌─────────── HTTP request (OpenAI or Anthropic) ───────────┐
                │                                                          │
                ▼                                                          ▼
   POST /v1/chat/completions                                    POST /v1/messages
                │                                                          │
                │ [zod parse]                                              │ [zod parse]
                ▼                                                          ▼
   openai-in.openAIRequestToCanonical                anthropic-in.anthropicRequestToCanonical
                │                                                          │
                │   • messages[] → canonical content blocks                │   • role-alternation refinement
                │   • role:"system" → top-level `system`                   │   • tool_use/tool_result pairing
                │   • stop → stop_sequences                                │   • top-level system honored
                │   • tool_choice mapped per D-D3 (+ FINDING 3.4)          │
                │   • tool_calls[].function.arguments JSON.parse           │
                │                                                          │
                └──────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
                            CanonicalRequest
                                   │
                                   │ [capability gating — VISION-02]
                                   │ if any block.type === "image"
                                   │   && !entry.capabilities.includes("vision")
                                   │ → throw CapabilityNotSupportedError → 400
                                   │
                                   │ [semaphore acquire — Phase 3 unchanged]
                                   ▼
                            adapter.chatCompletionsCanonical(canonical, signal)
                                   │
              ┌────────────────────┴────────────────────┐
              │                                         │
              ▼                                         ▼
   OllamaOpenAIAdapter                       LlamacppOpenAIAdapter
              │                                         │
              │ if has image block:                     │ always OpenAI-compat
              │   ollama-native-out → POST              │ (D-B4)
              │   http://ollama:11434/api/chat          │
              │   { messages, images: [bareBase64] }    │
              │                                         │
              │ else: openai SDK → POST                 │ openai SDK → POST
              │   /v1/chat/completions                  │   /v1/chat/completions
              │                                         │
              └────────────────────┬────────────────────┘
                                   │
                                   ▼
                       upstream OpenAI/Ollama response
                                   │
                                   │ [adapter normalizes to CanonicalResponse
                                   │  or AsyncIterable<CanonicalStreamEvent>]
                                   ▼
                            CanonicalResponse / CanonicalStreamEvent[]
                                   │
              ┌────────────────────┴────────────────────┐
              │                                         │
              ▼                                         ▼
   openai-out.canonicalToOpenAIResponse        anthropic-out.canonicalToAnthropicResponse
              │                                         │
              │ (or stream variant — re-emits as        │ (or stream variant — emits typed events:
              │  OpenAI `delta` chunks)                 │  message_start → content_block_* → message_delta → message_stop
              │                                         │  + interleaved `ping`)
              │                                         │
              │ • tool_use.input → JSON.stringify       │ • input_tokens on message_start
              │ • final usage chunk via include_usage   │ • output_tokens (cumulative) on message_delta
              │                                         │ • anthropic-version header echoed
              ▼                                         ▼
   HTTP response (OpenAI wire format)         HTTP response (Anthropic wire format)
```

### Recommended Project Structure (under `router/src/`)
```
src/
├── translation/                # NEW for Phase 4
│   ├── canonical.ts            # Types + zod schemas + refinements (role alternation, tool_use/tool_result pairing)
│   ├── openai-in.ts            # OpenAI body → CanonicalRequest
│   ├── openai-out.ts           # CanonicalResponse / CanonicalStreamEvent → OpenAI ChatCompletion / Chunks
│   ├── anthropic-in.ts         # Anthropic body → CanonicalRequest
│   ├── anthropic-out.ts        # CanonicalResponse / CanonicalStreamEvent → Anthropic Message / typed events
│   └── ollama-native-out.ts    # CanonicalRequest → Ollama /api/chat body shape (used inside OllamaAdapter)
│
├── routes/v1/
│   ├── chat-completions.ts     # REFACTORED — flows through canonical
│   ├── messages.ts             # NEW — POST /v1/messages (stream + non-stream)
│   ├── count-tokens.ts         # NEW — POST /v1/messages/count_tokens
│   └── models.ts               # Emits new model with capabilities; no code change
│
├── backends/
│   ├── adapter.ts              # WIDENED — chatCompletionsCanonical + stream variant; old methods removed
│   ├── ollama-openai.ts        # REWRITTEN — internal vision split (D-B3)
│   ├── llamacpp-openai.ts      # REWRITTEN — canonical method, OpenAI-compat only (D-B4)
│   └── factory.ts              # UNCHANGED
│
└── errors/envelope.ts          # ADDS — CapabilityNotSupportedError + anthropicErrorFrame()
```

### Pattern 1: Canonical streaming event union

```typescript
// router/src/translation/canonical.ts
// Source: https://platform.claude.com/docs/en/api/messages-streaming (FINDING 1.1)

export type CanonicalStreamEvent =
  | { type: 'message_start'; message: CanonicalMessage }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentBlockDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: StopReason | null; stop_sequence: string | null }; usage: { output_tokens: number } }  // CUMULATIVE
  | { type: 'message_stop' }
  | { type: 'ping' };

export type ContentBlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string };

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'model_context_window_exceeded';
```

### Pattern 2: Anthropic-out stream serialization

```typescript
// router/src/translation/anthropic-out.ts
// Source: FINDING 1.1 (event order), CONTEXT.md <specifics> (msg_start payload)

export async function* canonicalToAnthropicSse(
  events: AsyncIterable<CanonicalStreamEvent>,
): AsyncIterable<{ event: string; data: string }> {
  for await (const ev of events) {
    // Anthropic uses BOTH `event:` SSE header AND `"type"` in data — verified from raw cURL response.
    // fastify-sse-v2 emits the `event:` line when `event` is non-empty (FINDING 9).
    switch (ev.type) {
      case 'message_start':
        yield { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: ev.message }) };
        break;
      case 'content_block_start':
        yield { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: ev.index, content_block: ev.content_block }) };
        break;
      case 'content_block_delta':
        yield { event: 'content_block_delta', data: JSON.stringify({ type: 'content_block_delta', index: ev.index, delta: ev.delta }) };
        break;
      case 'content_block_stop':
        yield { event: 'content_block_stop', data: JSON.stringify({ type: 'content_block_stop', index: ev.index }) };
        break;
      case 'message_delta':
        yield { event: 'message_delta', data: JSON.stringify({ type: 'message_delta', delta: ev.delta, usage: ev.usage }) };
        break;
      case 'message_stop':
        yield { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) };
        break;
      case 'ping':
        yield { event: 'ping', data: JSON.stringify({ type: 'ping' }) };
        break;
    }
  }
}
```

### Pattern 3: Ollama-native-out for vision (D-C4)

```typescript
// router/src/translation/ollama-native-out.ts
// Source: docs.ollama.com/api/chat (FINDING 4.3)

export interface OllamaNativeChatRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    images?: string[];  // bare base64, NO "data:image/...;base64," prefix
    tool_calls?: unknown[];
  }>;
  tools?: unknown[];
  stream?: boolean;
  options?: Record<string, unknown>;
}

export async function canonicalToOllamaNativeChat(
  canonical: CanonicalRequest,
): Promise<OllamaNativeChatRequest> {
  // For each canonical message:
  //   - Concatenate text blocks → `content` (string)
  //   - For each `{type:"image", source:{type:"base64",data:"..."}}` → push to images[] verbatim
  //   - For each `{type:"image", source:{type:"url", url:"..."}}` → fetch + base64-encode → push to images[]
  //     (with 10s timeout, 10 MB body cap, http|https only — Claude's discretion in CONTEXT.md)
  // ...
}
```

### Anti-Patterns to Avoid

- **Single-hop OpenAI ↔ Anthropic translation:** Forbidden by D-A3. Always go through canonical.
- **Adapters that JSON.stringify tool args:** Discipline lives in translators (D-D2). Adapters never know about wire format quirks.
- **Vision via Ollama `/v1/chat/completions`:** Even when Ollama's compat layer "works", it silently corrupts on edge cases (FINDING 5). Use `/api/chat` always for image-bearing requests.
- **Pre-allocating `usage.output_tokens` other than 1 on `message_start`:** Anthropic's convention is `output_tokens: 1` (role token). `message_delta.usage.output_tokens` is the cumulative final count, NOT a delta.
- **Emitting compress middleware on `/v1/messages`:** Same anti-pattern as Phase 2/3 for `/v1/chat/completions`. Buffering breaks SSE.
- **Putting Anthropic-version validation logic in zod:** D-E5 says echo whatever the client sent verbatim, no gating. Header-echo is route-level, not validation.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| BPE tokenizer for count_tokens | char/4 heuristic, hand-coded BPE | `gpt-tokenizer` (cl100k_base) | Pure-JS, smallest memory footprint, accurate within ±5% for English/code |
| ULID generation | Date.now() + random hex | `ulid@^3` | Monotonic within ms, 26-char Crockford base32 matches Anthropic look-and-feel |
| SSE plumbing (typed events) | `reply.raw.write()` + manual `event:` lines | `fastify-sse-v2` `reply.sse(asyncIterable)` | Already in Phase 2; v4.x supports `{event, data}` yields — exactly what Anthropic SSE needs |
| Stream cancellation | Manual upstream-socket close | `AbortController.signal` forwarded to openai SDK / `fetch` | Phase 2 pattern; SDK + undici close the upstream TCP socket on `abort()` |
| Heartbeat | `setInterval(write '\n')` | `startHeartbeat()` from `router/src/sse/heartbeat.ts` | Idempotent stop, byte counter, EPIPE-safe — Phase 2 reused verbatim |
| OpenAI tool-args JSON parse | `JSON.parse(args)` with manual error mapping | `JSON.parse` wrapped in try/catch in `openai-in.ts`, mapped to 400 invalid_request | Translator owns this boundary; envelope already exists |
| Anthropic SDK reimplementation | Reinvent `Message`/`ContentBlock` types | `@anthropic-ai/sdk` types in tests only (D-A4) | Catches drift when Anthropic adds new block variants (PDF/thinking — DOCS-01/THINK-01) |
| Image dimension parsing for count_tokens | Decode full JPEG/PNG to get dims | Probe the first ~32 bytes of the base64 (PNG IHDR / JPEG SOFn marker) OR accept the 1568 fallback | Sub-10 LOC; only needed if user wants tighter cost estimates than the fallback |

**Key insight:** Phase 4 is mostly orchestration over Phase 2/3 plumbing. The "hard part" (Anthropic streaming wire format) is fully documented in the official Anthropic docs (FINDING 1.x) — no reverse-engineering needed.

## Common Pitfalls

### Pitfall 1: `output_tokens` on `message_delta` treated as a per-chunk delta

**What goes wrong:** Translator increments a counter on each `content_block_delta` and emits the running total; agent reads it as the final count and bills the wrong amount.

**Why it happens:** OpenAI emits per-chunk deltas; Anthropic emits the cumulative total on `message_delta`. Easy to conflate.

**How to avoid:** `anthropic-out` stream translator pulls the final `output_tokens` ONCE from the canonical stream's terminal `message_delta` (which the adapter constructs from OpenAI's final `chunk.usage.completion_tokens` via `include_usage:true`). Never sum or accumulate.

**Warning signs:** Output token counts in client logs higher than the prompt or unrealistic (e.g., 5000+ for a 10-word answer).

`[CITED: platform.claude.com/docs/en/api/messages-streaming — "The token counts shown in the usage field of the message_delta event are cumulative."]`

### Pitfall 2: `tool_result` blocks placed AFTER text in user-message content array

**What goes wrong:** Anthropic returns 400 `tool_use ids were found without tool_result blocks immediately after`.

**Why it happens:** Anthropic requires tool_result blocks to come FIRST in the user message's content array; any text must come after. OpenAI has no such constraint.

**How to avoid:** `openai-in` translator, when converting OpenAI `tool` role messages to canonical `user` messages with `tool_result` blocks, MUST sort: `tool_result` blocks first, then text/image blocks. Add a fixture in golden tests `03-is-error-tool-result/` to cover this.

**Warning signs:** Multi-turn tool conversations 400 with `tool_use ids were found without tool_result blocks immediately after` from upstream — but our local backends won't return that error because we're translating to OpenAI shape on the way out. The risk is on the inbound `/v1/messages` side: a client sends a malformed request and we forward garbage to the backend. Reject at `anthropic-in` zod refinement.

`[CITED: platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls]`

### Pitfall 3: Empty `message_start.usage` pre-allocation other than `output_tokens: 1`

**What goes wrong:** Anthropic clients (Claude Code, OpenAI Agents SDK in Anthropic mode) parse `message_start.message.usage` expecting `{input_tokens: N, output_tokens: 1}`. Missing `output_tokens` or value other than 1 causes "incomplete message" errors.

**Why it happens:** The router must build `message_start` BEFORE upstream emits its first content chunk — we don't know the output token count yet, so the convention is to pre-allocate `output_tokens: 1` (Anthropic's "role token" allocation) and overwrite via `message_delta.usage.output_tokens` at end of stream.

**How to avoid:** `anthropic-out` always emits `message_start.message.usage = {input_tokens, output_tokens: 1}`. Unit test asserts this exact shape. `[VERIFIED: official wire sample in FINDING 1.1, line "usage": {"input_tokens": 25, "output_tokens": 1}]`

### Pitfall 4: `tool_choice: "none"` mapped to "strip tools[]"

**What goes wrong:** D-D3 says "strip tools[] entirely + don't set tool_choice" for OpenAI `"none"`. But Anthropic NATIVELY supports `tool_choice: {"type": "none"}` in 2026 (FINDING 3.4) — stripping `tools[]` is unnecessary and loses information (the tools were defined; the user opted not to use them this turn).

**Why it happens:** D-D3 was written based on older Anthropic behavior (`"none"` was not native pre-2025).

**How to avoid:** Map OpenAI `"none"` → canonical `{type: "none"}`, preserving `tools[]`. On outbound Anthropic, surface `tool_choice: {type: "none"}`. On outbound OpenAI, emit `tool_choice: "none"` AND keep `tools[]`. Planner should revise D-D3 per FINDING 3.4.

### Pitfall 5: `disable_parallel_tool_use` placed on tool definitions instead of `tool_choice`

**What goes wrong:** Translator puts `disable_parallel_tool_use: true` somewhere on the request (e.g., next to `tools` array), Anthropic ignores it or 400s.

**Why it happens:** The modifier lives on `tool_choice`, not the request body root or the `tools` array. Specifically: `tool_choice: {type: "auto", disable_parallel_tool_use: true}` or `{type: "any", disable_parallel_tool_use: true}` or `{type: "tool", name: "X", disable_parallel_tool_use: true}`.

**How to avoid:** Translator places `disable_parallel_tool_use: true` ON the `tool_choice` object itself when OpenAI's `parallel_tool_calls: false` is set. Unit-test this mapping. `[CITED: platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use]`

### Pitfall 6: `stop_sequences` array with >5 entries silently dropped

**What goes wrong:** Anthropic caps `stop_sequences` at 5. Sending more either errors or silently truncates depending on version.

**How to avoid:** `openai-in` translator validates: if `body.stop` is an array with length >5, throw a 400 `invalid_request: too many stop_sequences (max 5)`. D-D5 already requires this.

### Pitfall 7: Forgetting `event:` SSE header on Anthropic stream

**What goes wrong:** Some agent SDKs only parse SSE messages with named events; an event payload that has `"type": "message_start"` in its `data` but no `event: message_start` header line is silently dropped.

**Why it happens:** Anthropic's spec requires BOTH the `event:` header AND `"type"` in the data JSON — "Each event uses an SSE event name (e.g. `event: message_stop`), and includes the matching event `type` in its data." `[CITED: FINDING 1.1]`

**How to avoid:** `anthropic-out` ALWAYS yields `{event: 'message_start', data: '...'}` (named events), not `{data: '...'}` (data-only). `fastify-sse-v2` emits the `event:` line iff `event` is non-empty (FINDING 9). Heartbeat also uses `event: ping`.

### Pitfall 8: Ollama vision via `/v1/chat/completions` returns text-that-ignores-image

**What goes wrong:** Model "sees" an empty array (Ollama's compat layer didn't translate `image_url` into native `images: [base64]`); response is generic text unrelated to the image.

**Why it happens:** Known broken on some vision tags; CONTEXT.md cites Pitfall 8 and project research has flagged this since Phase 0. Recent Ollama issues confirm it's still rough for Anthropic-shape + cloud vision, and locally for some tags `[CITED: github.com/ollama/ollama/issues/15727 — image content blocks dropped when forwarded to vision-capable cloud models]`.

**How to avoid:** ALWAYS route vision via native `/api/chat` (D-B3). NEVER attempt OpenAI-compat for image-bearing requests on Ollama. Smoke test asserts "vision-with-non-vision-model returns 400" AND "vision-with-vision-model returns a response that mentions the image content".

### Pitfall 9: Image URL fetching from `ollama-native-out` blocked by egress allowlist

**What goes wrong:** The router fetches an arbitrary HTTPS URL for an image; Phase 1 D-A2 egress allowlist might block it; user sees a confusing 500.

**How to avoid:** Planner must either (a) verify Phase 1 allowlist permits arbitrary outbound HTTPS for the router, OR (b) document the restriction in the README and require base64-only image input. CONTEXT.md flags this as Claude's discretion. **Recommendation:** start with base64-only (no URL fetching) and add URL support in a v2 hardening pass with explicit allowlist semantics. This sidesteps SSRF entirely.

### Pitfall 10: `cl100k_base` undercounts CJK script by ~5-15%

**What goes wrong:** Agent budgets 10000 tokens for a Japanese prompt, count_tokens returns 8500, actual Anthropic count is 9800, agent OOM-rejects mid-stream.

**Why it happens:** cl100k_base is OpenAI's tokenizer — it under-represents non-Latin scripts vs Anthropic's BPE.

**How to avoid:** `X-Token-Count-Method: gpt-tokenizer/cl100k_base` response header (D-E2) signals to agents that the count is an OpenAI-flavored estimate, not Anthropic-accurate. Document acceptable error bars in README: ±5% (English/code), ±15% (CJK). No mitigation needed in code — discipline is on the client side.

## Code Examples

### Example A: `message_start` payload (verified wire-correct)

```json
{
  "type": "message_start",
  "message": {
    "id": "msg_01HXYZAB...",
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
Source: `https://platform.claude.com/docs/en/api/messages-streaming` Example response.

### Example B: `tool_use` parallel stream sample (verified wire-correct)

This is verbatim from official Anthropic docs (`stream: true` with `tool_choice: {"type": "any"}`):

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_014p7gG3wDgGV9EUtLvnow3U","type":"message","role":"assistant","model":"claude-opus-4-7","stop_sequence":null,"usage":{"input_tokens":472,"output_tokens":2},"content":[],"stop_reason":null}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Okay"}}

# ... more text_delta events ...

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01T1x1fJ34qAmk2tNTrN7Up6","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}

# ... more input_json_delta events ...

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":89}}

event: message_stop
data: {"type":"message_stop"}
```

Sources: `https://platform.claude.com/docs/en/api/messages-streaming` "Streaming request with tool use" sample.

**Note on parallel:** A SECOND `tool_use` block appears at `index: 2` (after closing `index: 1`), repeating the start → deltas → stop pattern. This is the canonical "parallel tools" sequence — blocks are sequential per-index, not interleaved.

### Example C: Anthropic mid-stream error frame (verified wire-correct)

```
event: error
data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
```

Used by `anthropicErrorFrame(envelope)` helper (D-F5). Note: Anthropic does NOT emit `data: [DONE]` after error — the response just ends.

Source: `https://platform.claude.com/docs/en/api/messages-streaming` "Error events" section.

### Example D: Ollama native `/api/chat` with vision

```bash
curl http://ollama:11434/api/chat -d '{
  "model": "llama3.2-vision:11b-instruct-q4_K_M",
  "messages": [
    {
      "role": "user",
      "content": "what is in this image?",
      "images": ["iVBORw0KGgoAAAANSUhEUgAAA..."]
    }
  ],
  "stream": true,
  "options": {"temperature": 0.7}
}'
```

Notes:
- `images` is on the message object (not the content array).
- Base64 is **bare** — no `data:image/png;base64,` prefix.
- `content` is a STRING in native Ollama format (NOT a content-block array like OpenAI or Anthropic).
- Streaming returns NDJSON, one JSON object per line with `done: false` until terminal `done: true`.

Source: `https://docs.ollama.com/api/chat` (FINDING 4.3).

### Example E: count_tokens via gpt-tokenizer

```typescript
// router/src/routes/v1/count-tokens.ts
import { encode } from 'gpt-tokenizer/encoding/cl100k_base';

const PER_IMAGE_FALLBACK = 1568;

function imageTokens(block: ImageBlock): number {
  // If base64 + we can extract dims (10 LOC of PNG IHDR / JPEG SOFn parsing) → (w*h)/750.
  // Else fallback (URL inputs OR encoder can't read dims) → 1568.
  return PER_IMAGE_FALLBACK;  // simple v0; planner refines
}

export function countTokens(canonical: CanonicalRequest): number {
  let total = 0;
  if (canonical.system) total += encode(canonical.system).length;
  for (const m of canonical.messages) {
    for (const b of m.content) {
      if (b.type === 'text') total += encode(b.text).length;
      else if (b.type === 'image') total += imageTokens(b);
      else if (b.type === 'tool_use') total += encode(JSON.stringify(b.input)).length;
      else if (b.type === 'tool_result') total += encode(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).length;
    }
  }
  // Anthropic adds ~340 tokens of tool-use system prompt overhead when tools present (FINDING 3.8) —
  // emit it for parity with Anthropic's count_tokens behavior.
  if (canonical.tools?.length) total += 340;
  return total;
}
```

Source: `https://www.npmjs.com/package/gpt-tokenizer` for import path; `https://platform.claude.com/docs/en/build-with-claude/token-counting` for tool-prompt overhead (FINDING 3.8).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| OpenAI `tool_choice: "none"` mapped by stripping `tools[]` | Anthropic native `{type:"none"}` supported | 2025 (still current 2026-05-13) | D-D3 should map `"none"` ↔ `{type:"none"}` instead of stripping (FINDING 3.4) |
| `parallel_tool_calls: false` had no Anthropic equivalent (must drop or coerce) | `disable_parallel_tool_use: true` modifier on `tool_choice` | 2025 | D-D4 should use this modifier, not the `_meta` field workaround (FINDING 3.4) |
| Anthropic image input: base64 only | URL source also supported (`{type:"image", source:{type:"url", url:"..."}}`) | 2024+ | Canonical translator handles BOTH source types from BOTH protocols (FINDING 4.1) |
| `model_context_window_exceeded` stop_reason | Available by default in Sonnet 4.5+; beta header for earlier models | 2025 | Translator adds this to `StopReason` union (FINDING 3.9) |
| Anthropic streaming SSE: `data: [DONE]` terminator (legacy) | Named events with no `[DONE]` (since `anthropic-version: 2023-06-01`) | 2023 | Translator does NOT emit `[DONE]` on Anthropic stream end — just stops after `message_stop` (FINDING 7) |

**Deprecated/outdated:**
- `anthropic-version: 2023-01-01` — predecessor format with `data: [DONE]` and non-incremental completions. NOT supported in 2026. (FINDING 7)
- Anthropic `data: [DONE]` after error — never used in current format. Error frame is `event: error\ndata: {"type":"error", ...}` and the stream just ends. (FINDING 1.1)
- Pre-2025 D-D3 mapping (strip `tools[]` for `"none"`) — superseded by native `{type:"none"}` support.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Ollama `/v1/chat/completions` vision is still locally-broken for `llama3.2-vision:11b-instruct-q4_K_M` | Pitfall 8 / FINDING 5 | LOW — even if it now works locally, the native `/api/chat` path is forward-compat with Ollama Cloud (Phase 8, which is documented broken) and the cost of the split is small |
| A2 | gpt-tokenizer's cl100k_base import path `gpt-tokenizer/encoding/cl100k_base` is stable in v3.x | Pattern E / Standard Stack | LOW — confirmed in v2.x and the package follows semver; planner verifies at install |
| A3 | `(W × H) / 750` per-image token formula is still current in 2026 | FINDING 2.2 | LOW — verified against vision docs 2026-05-13 |
| A4 | `ulid` package output format is exactly 26 chars and starts with timestamp segment | FINDING 8.2 | LOW — verified from npmjs.com 2026-05-13 |
| A5 | Phase 1 D-A2 egress allowlist permits arbitrary outbound HTTPS for image-URL fetching | Pitfall 9 | MEDIUM — planner should verify or pick base64-only as v0 (recommended fallback) |
| A6 | All 7 stop_reason values (`end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, `model_context_window_exceeded`) need to be in the canonical `StopReason` union, including those we won't normally see from local backends | FINDING 3.9 | LOW — local backends won't produce `pause_turn`/`refusal`/`model_context_window_exceeded`, but the canonical type should include them so anthropic-out can pass through if a Phase 8 cloud backend ever emits one |

**If this table seems short:** That's because CONTEXT.md is exceptionally thorough — most of the time-sensitive claims were either pre-verified (Anthropic streaming order, tool_choice mapping, msg_start payload structure) or explicitly flagged as Claude's discretion with sane defaults.

## Open Questions (RESOLVED)

1. **Should `output_tokens` from local backends be split between `message_start.usage.output_tokens: 1` (pre-allocated) and `message_delta.usage.output_tokens: total`, OR emitted as `message_delta.usage.output_tokens: (total - 1)` to account for the pre-allocated 1?**
   - What we know: Anthropic's wire format documents `output_tokens: 1` on `message_start` and the cumulative total on `message_delta`. The pre-allocated 1 is the "role token".
   - What's unclear: Do Anthropic clients SUBTRACT the pre-allocated 1 when reading `message_delta.usage.output_tokens`, or do they take it as authoritative?
   - Recommendation: Take Anthropic's literal-wire approach — `message_start.usage.output_tokens: 1`, `message_delta.usage.output_tokens: <actual_total_from_upstream_chunk.usage.completion_tokens>`. The upstream `completion_tokens` from OpenAI/Ollama includes ALL output tokens (the SDK doesn't separate "role token" from "content tokens"), and Anthropic clients should read the message_delta value as authoritative. Unit-test against the Anthropic SDK's MessageStream accumulator to confirm.

2. **What's the correct `stop_reason` mapping when OpenAI returns `finish_reason: "content_filter"` or `"function_call"` (legacy)?**
   - What we know: OpenAI's `finish_reason` enum: `stop`, `length`, `tool_calls`, `content_filter`, `function_call` (legacy).
   - Anthropic's `stop_reason` enum: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, `model_context_window_exceeded`.
   - Mapping table:
     - `stop` → `end_turn`
     - `length` → `max_tokens`
     - `tool_calls` → `tool_use`
     - `content_filter` → `refusal` (closest Anthropic semantic match)
     - `function_call` (legacy) → `tool_use` (legacy mode, single function)
     - `stop_sequence` (canonical only — not in OpenAI; canonical infers when upstream finishes with a matching stop sequence) → `stop_sequence`
   - Recommendation: Implement the table above in `openai-in`/`openai-out`. Add a unit test per mapping pair.

3. **Should `pause_turn` and `model_context_window_exceeded` ever surface from local backends?**
   - What we know: `pause_turn` is Anthropic-server-tool-specific (web_search loop hit iteration cap); local backends have no server tools.
   - `model_context_window_exceeded` requires a beta header on older models.
   - Recommendation: Local backends will produce only `end_turn` / `max_tokens` / `stop_sequence` / `tool_use`. The other three values stay in the canonical `StopReason` union for forward-compat (Phase 8 cloud backends MIGHT emit them). No code needed in Phase 4 beyond the type definition.

4. **Does `count_tokens` need to count system-prompt overhead for tools (~340 tokens per Anthropic's docs)?**
   - What we know: When `tools` are provided, Anthropic adds a special system prompt that costs ~313-346 tokens depending on `tool_choice` (FINDING 3.8). The user is billed for these tokens.
   - Recommendation: count_tokens emits `total + 340` if `canonical.tools?.length`. Document as approximation in README. Planner can refine to per-tool-choice precision (313 / 346) if a user complains.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Router runtime | ✓ | 22.x (Phase 2 verified) | — |
| Docker / Compose | Router service | ✓ | Phase 1 verified | — |
| Ollama (local) | Vision backend | ✓ | 0.5.7 (pinned in Phase 1) | — |
| `llama3.2-vision:11b-instruct-q4_K_M` Ollama tag | Vision testing | ✓ available in registry | 7.8 GB (Q4_K_M, instruct-tuned) | Use the `:latest` tag and document SHA at planning time |
| `gpt-tokenizer` npm | count_tokens encoding | ✓ (npm registry) | latest `^3.x` | `@dqbd/tiktoken` if cold-start is critical |
| `ulid` npm | msg/toolu ID generation | ✓ (npm registry) | latest 3.0.2 | `nanoid` (loses monotonicity), `crypto.randomUUID()` (loses look-and-feel) |
| `@anthropic-ai/sdk` npm | TYPE cross-checks in tests | ✓ (npm registry) | 0.95.1 | hand-rolled type assertions (loses drift detection) |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None blocking — all primary picks available.

**Critical pre-execution step (must be in plan):**
```bash
# After router image is built and stack is up:
docker exec ollama ollama pull llama3.2-vision:11b-instruct-q4_K_M
# Verify VRAM headroom:
docker exec ollama ollama list  # should show llama3.2:3b + llama3.2-vision:11b
nvidia-smi  # both can be loaded concurrently? Or Ollama swaps?
```

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest `^4.1.6` (already pinned) |
| Config file | `router/vitest.config.ts` (Phase 2 baseline) |
| Quick run command | `npm run test:unit` (from `router/`) |
| Full suite command | `npm test` (from `router/`) |
| MSW for upstream stubs | `msw@^2.14.6` already in devDeps |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ANTHR-01 | POST /v1/messages non-stream returns Anthropic-shaped Message | integration | `npx vitest run tests/integration/messages.nonstream.test.ts -x` | ❌ Wave 0 |
| ANTHR-01 | POST /v1/messages stream emits typed events in order | integration | `npx vitest run tests/integration/messages.stream.test.ts -x` | ❌ Wave 0 |
| ANTHR-02 | POST /v1/messages/count_tokens returns `{input_tokens: N}` | integration | `npx vitest run tests/integration/count-tokens.test.ts -x` | ❌ Wave 0 |
| ANTHR-03 | Top-level `system` field honored | unit | `npx vitest run tests/translation/anthropic-in.test.ts -x` | ❌ Wave 0 |
| ANTHR-04 | Role-alternation violation → 400 invalid_request | unit + integration | `npx vitest run tests/translation/anthropic-in.test.ts tests/integration/messages.nonstream.test.ts -x` | ❌ Wave 0 |
| ANTHR-05 | `anthropic-version` request header echoed verbatim | integration | `npx vitest run tests/integration/messages.nonstream.test.ts -x` | ❌ Wave 0 (test case) |
| ANTHR-06 | Typed SSE event order invariant (start → block_start → block_delta → block_stop → message_delta → message_stop) | unit + integration | `npx vitest run tests/translation/anthropic-out.test.ts tests/integration/messages.stream.test.ts -x` | ❌ Wave 0 |
| ANTHR-07 | `input_tokens` on `message_start`, `output_tokens` cumulative on `message_delta` | unit | `npx vitest run tests/translation/anthropic-out.test.ts -x` | ❌ Wave 0 |
| ANTHR-08 | `stop_sequences` ⇄ `stop` mapping (both directions, >5 reject) | unit | `npx vitest run tests/translation/openai-in.test.ts tests/translation/openai-out.test.ts -x` | ❌ Wave 0 |
| TOOL-01 | OpenAI tool def → canonical (JSON.parse arguments) | unit | `npx vitest run tests/translation/openai-in.test.ts -x` | ❌ Wave 0 |
| TOOL-02 | Anthropic tool def native (no translation hop) | unit | `npx vitest run tests/translation/anthropic-in.test.ts -x` | ❌ Wave 0 |
| TOOL-03 | Parallel tool calls round-trip (both directions) | unit (golden) | `npx vitest run tests/translation/golden.test.ts -x` | ❌ Wave 0 |
| TOOL-04 | `tool_result` with `is_error: true` round-trips | unit (golden) | `npx vitest run tests/translation/golden.test.ts -x` | ❌ Wave 0 |
| TOOL-05 | Round-trip golden tests in CI | unit (golden) | `npx vitest run tests/translation/golden.test.ts -x` | ❌ Wave 0 |
| VISION-01 | Image URL + base64 input accepted in both protocols | unit (golden) + integration | `npx vitest run tests/translation/golden.test.ts tests/integration/messages.nonstream.test.ts -x` | ❌ Wave 0 |
| VISION-02 | Vision request to non-vision model returns 400 BEFORE backend | integration | `npx vitest run tests/integration/messages.nonstream.test.ts -x` | ❌ Wave 0 (test case) |
| VISION-03 | Ollama vision routed via native /api/chat (msw asserts URL) | integration | `npx vitest run tests/integration/messages.stream.test.ts -x` | ❌ Wave 0 (test case + msw handler) |

### Sampling Rate (Nyquist Dimension 8)

Boundaries × scenarios that need fixtures (≥ 2× boundary for Nyquist coverage):

| Boundary | Scenarios |
|----------|-----------|
| **Protocol in** | OpenAI request → /v1/chat/completions ; Anthropic request → /v1/messages |
| **Protocol out** | OpenAI Chat Completion ; Anthropic Message |
| **Streaming** | non-stream ; SSE stream |
| **Content shape** | text-only ; single tool_use ; parallel tool_use ; vision-base64 ; vision-URL |
| **Tool flow** | happy ; tool_result with is_error:true ; tool_choice=auto/any/tool/none ; disable_parallel_tool_use |
| **Error path** | role-alternation violation ; capability mismatch ; tool-arg malformed JSON ; max stop_sequences exceeded |

Total representative fixtures: **~22** — covers each boundary at least twice via the golden directory:
```
router/tests/translation/golden/
  01-single-tool/                 (text + tool, both protocols)
  02-parallel-tools/              (parallel tools, both protocols)
  03-is-error-tool-result/        (is_error:true round-trip)
  04-tool-choice-auto/            (default behavior)
  05-tool-choice-required/        (OpenAI required ↔ Anthropic any)
  06-tool-choice-specific/        (forced tool by name)
  07-tool-choice-none/            (Anthropic native {type:none})  ← per FINDING 3.4
  08-disable-parallel/            (parallel_tool_calls:false ↔ disable_parallel_tool_use:true)
  09-vision-base64/               (base64 image, both protocols)
  10-vision-url/                  (URL image, both protocols)
  11-system-field/                (top-level system honored)
  12-stop-sequences/              (string vs array; reject >5)
  13-role-alternation-error/      (consecutive user → 400)
  14-malformed-tool-args/         (invalid JSON string in OpenAI arguments → 400)
  15-multimodal-with-tools/       (image + tool in same request)
```

- **Per task commit:** `npm run test:unit -- tests/translation/` (5-10s)
- **Per wave merge:** `npm test` (full suite, including integration with msw upstream stubs — ~30s)
- **Phase gate:** `npm test && bin/smoke-test-router.sh phase-4` (live Ollama vision smoke + curl checks)

### Wave 0 Gaps

- [ ] `router/tests/translation/canonical.test.ts` — covers role-alternation refinement, tool_use/tool_result pairing validators
- [ ] `router/tests/translation/openai-in.test.ts` — covers TOOL-01, ANTHR-08 (one direction), JSON.parse error mapping
- [ ] `router/tests/translation/openai-out.test.ts` — covers JSON.stringify on tool_use.input, OpenAI-shape `delta` reassembly from canonical stream
- [ ] `router/tests/translation/anthropic-in.test.ts` — covers ANTHR-03, ANTHR-04, TOOL-02
- [ ] `router/tests/translation/anthropic-out.test.ts` — covers ANTHR-06, ANTHR-07, error frame, ping interleave
- [ ] `router/tests/translation/ollama-native-out.test.ts` — covers vision base64 round-trip + URL→base64 fetch (with mocked fetch)
- [ ] `router/tests/translation/golden.test.ts` — fixture-driven round-trip tests for the 15 directories listed above
- [ ] `router/tests/translation/golden/*` — 15 fixture directories (each ~5 JSON files)
- [ ] `router/tests/integration/messages.nonstream.test.ts` — covers ANTHR-01, ANTHR-02, ANTHR-05, VISION-02, capability mismatch 400
- [ ] `router/tests/integration/messages.stream.test.ts` — covers ANTHR-01 (stream), ANTHR-06, ANTHR-07, VISION-03 (msw asserts /api/chat URL), abort propagation
- [ ] `router/tests/integration/count-tokens.test.ts` — covers ANTHR-02 (with `X-Token-Count-Method` header assertion)
- [ ] `router/tests/msw/handlers.ts` — extend with `http://ollama:11434/api/chat` handler (native Ollama vision shape) AND keep existing `/v1/chat/completions` handler

**Framework install:** none — vitest + msw already in `router/package.json`.

## Sources

### Primary (HIGH confidence)
- [Anthropic — Streaming messages](https://platform.claude.com/docs/en/api/messages-streaming) — full event sequence, `input_json_delta` chunking, error frame format, msg_start payload `[VERIFIED 2026-05-13]`
- [Anthropic — Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) — `{input_tokens: N}` response shape, image formula `(w*h)/750`, tool overhead tokens `[VERIFIED 2026-05-13]`
- [Anthropic — Handling stop reasons](https://docs.anthropic.com/en/api/handling-stop-reasons) — full enum: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, `model_context_window_exceeded` `[VERIFIED 2026-05-13]`
- [Anthropic — Define tools (tool_choice)](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) — explicit list of `auto`, `any`, `tool`, `none` `[VERIFIED 2026-05-13]`
- [Anthropic — Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use) — `disable_parallel_tool_use` modifier on `tool_choice` `[VERIFIED 2026-05-13]`
- [Anthropic — Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) — `tool_result` block shape, `is_error: true`, tool_result-before-text ordering rule `[VERIFIED 2026-05-13]`
- [Anthropic — Vision](https://platform.claude.com/docs/en/build-with-claude/vision) — image block shape, URL + base64 sources, `(W × H) / 750` formula, 1568 cap pre-Opus-4.7 `[VERIFIED 2026-05-13]`
- [Anthropic — API versioning](https://platform.claude.com/docs/en/api/versioning) — `2023-06-01` is the only supported value in 2026 `[VERIFIED 2026-05-13]`
- [Ollama — `/api/chat`](https://docs.ollama.com/api/chat) — request/response shape, `images: [bare-base64]` on message `[VERIFIED 2026-05-13]`
- [Ollama — `llama3.2-vision` tags](https://ollama.com/library/llama3.2-vision/tags) — `11b-instruct-q4_K_M` confirmed at 7.8 GB `[VERIFIED 2026-05-13]`
- [npm — gpt-tokenizer](https://www.npmjs.com/package/gpt-tokenizer) — fastest JS BPE tokenizer, supports cl100k_base, no native deps `[VERIFIED 2026-05-13]`
- [npm — ulid](https://www.npmjs.com/package/ulid) — v3.0.2, 26-char Crockford base32, monotonicFactory available `[VERIFIED 2026-05-13]`
- [GitHub — fastify-sse-v2](https://github.com/mpetrunic/fastify-sse-v2) — v4.x supports `{event, data}` async iterable yields `[VERIFIED 2026-05-13]`

### Secondary (MEDIUM confidence)
- [GitHub — ollama/ollama #15727](https://github.com/ollama/ollama/issues/15727) — Anthropic compat drops image blocks on vision-capable cloud models (v0.21.0) — still rough as of 2026
- [GitHub — ollama/ollama #3690](https://github.com/ollama/ollama/issues/3690) — vision model support on OpenAI compat — historical record of fixes and remaining edge cases
- [LiteLLM PR #15315](https://github.com/BerriAI/litellm/pull/15315) — parallel tool calls fix in Anthropic passthrough adapter — confirms LiteLLM uses same canonical-shape approach
- [LiteLLM Anthropic transformation source](https://github.com/BerriAI/litellm/blob/main/litellm/llms/anthropic/experimental_pass_through/adapters/transformation.py) — reference implementation of OpenAI ↔ Anthropic translation

### Tertiary (LOW confidence — kept for context)
- [Project research — PITFALLS.md Pitfall 5](file:///home/luis/proyectos/local-llms/.planning/research/PITFALLS.md) — JSON.stringify discipline, canonical-shape mandate (verified independently against current docs)
- [Project research — PITFALLS.md Pitfall 8](file:///home/luis/proyectos/local-llms/.planning/research/PITFALLS.md) — Ollama OpenAI-compat vision quirks (verified via current GitHub issues)

## Project Constraints (from CLAUDE.md)

| Directive | How Phase 4 honors it |
|-----------|-----------------------|
| **Tech stack — router:** Node + Fastify + TypeScript (decisión cerrada) | Fastify v5, TS 5.6, openai SDK v6, zod v4 — all preserved |
| **API contract:** compatibilidad simultánea con OpenAI y Anthropic | Phase 4 IS this — both surfaces wire-correct |
| **Streaming:** SSE obligatorio desde v1 | Both routes stream; `fastify-sse-v2` named events |
| **Auth:** bearer token único | `/v1/messages*` joins bearer-required surface (D-F2) |
| **`fastify-sse-v2` (primary SSE plugin — async-iterable API)** | All streaming uses `reply.sse(asyncIterable)` |
| **`openai@^6.30.0` and `@anthropic-ai/sdk@^0.95.1` types-only** | D-A4 enforces SDK is types-only; adapters never import |
| **`zod@^4`** | Canonical schemas in zod v4 (already pinned) |
| **Avoid `runtime: nvidia` legacy syntax / `node:22-alpine` / `:latest` tags / Express / `redis:latest` / `traefik:v2.x` / compress middleware on SSE** | Vision model tag is fully specified (`llama3.2-vision:11b-instruct-q4_K_M`); router image is `node:22-bookworm-slim`; no compress middleware on `/v1/messages` |
| **NVIDIA Container Toolkit obligatorio (Linux nativo) / WSL2 driver pass-through** | Inherits Phase 1 infrastructure |
| **GSD Workflow Enforcement: do not bypass GSD for direct edits** | This Phase 4 work goes through `/gsd-execute-phase` after planning |
| **Single user, single host** | No multi-tenant auth, no per-user rate-limit in Phase 4 |
| **16 GB VRAM cap** | New vision model fits at 8 GB (4 + 8 = 12 ≤ 16) |

---

## Detailed Findings (cross-referenced from sections above)

### FINDING 1: Anthropic Messages streaming events

**FINDING 1.1 — Full event sequence (verified wire-correct):**
1. `message_start` (1×) — contains `Message` object with empty `content`, `usage.input_tokens` set, `usage.output_tokens: 1` (pre-allocated role token).
2. For each content block (sequential, not interleaved):
   - `content_block_start` — has `index` and the empty block (e.g. `{type:"text", text:""}` or `{type:"tool_use", id, name, input:{}}`).
   - 1+ `content_block_delta` — `text_delta` for text blocks, `input_json_delta` for tool_use blocks.
   - `content_block_stop` — has same `index`.
3. 1+ `message_delta` — has `delta.stop_reason`, `delta.stop_sequence`, AND `usage.output_tokens` (CUMULATIVE, the final total).
4. `message_stop` (1×) — `{type:"message_stop"}` with no body.
- `ping` events may appear anywhere in the stream.
- Each event uses an SSE `event:` header AND includes `"type"` field in the JSON data — clients can rely on either.

Source: `https://platform.claude.com/docs/en/api/messages-streaming` — full HTTP stream response example. `[VERIFIED 2026-05-13]`

**FINDING 1.2 — `input_json_delta` shape and chunking strategy:**
- Shape: `{"type":"input_json_delta","partial_json":"<string fragment>"}`
- Chunking: "Current models only support emitting one complete key and value property from `input` at a time. As such, when using tools, there may be delays between streaming events while the model is working."
- Final `tool_use.input` is always an object (parsed from the concatenated fragments).
- The translator's job: OpenAI streams `delta.tool_calls[].function.arguments` as fine-grained string fragments; pass them through to `input_json_delta.partial_json` as-is. The accumulation rule in OpenAI is `final[idx].function.arguments += chunk.function.arguments` — identical concept.

`[CITED: platform.claude.com/docs/en/api/messages-streaming "Input JSON delta"]` `[VERIFIED 2026-05-13]`

**FINDING 1.3 — `message_delta.usage.output_tokens` is cumulative:**
Direct quote from official docs: "The token counts shown in the `usage` field of the `message_delta` event are **cumulative**."

This MUST be the final running total when the stream completes, NOT a per-chunk delta. Our `anthropic-out` translator constructs ONE `message_delta` at end of stream, populated from upstream's final `chunk.usage.completion_tokens`.

`[VERIFIED 2026-05-13]`

**FINDING 1.4 — `system` is top-level, not in messages[]:**
Anthropic's `messages.create` takes a top-level `system: string | content_block[]` parameter. `system` does NOT appear in `messages[]` with `role: "system"` like OpenAI. The `anthropic-in` translator pulls `body.system` into `canonical.system`. The `openai-in` translator extracts the FIRST `messages[]` entry with `role: "system"` and lifts it to `canonical.system` (subsequent system messages, if any, are folded into the system string with newline separators).

`[CITED: official docs across multiple pages — count_tokens example, vision example, tool use example]` `[VERIFIED 2026-05-13]`

**FINDING 1.5 — Role alternation rule:**
- Messages MUST alternate `user`/`assistant`.
- First message MUST be `user`.
- The role for `tool_result` blocks is `user` (not `tool` — that's OpenAI's convention).
- Tool results MUST come FIRST in the user message's content array; text after.
- Violation returns 400.

The 400 error response shape (Anthropic-style envelope):
```json
{"type": "error", "error": {"type": "invalid_request_error", "message": "messages: roles must alternate user/assistant"}}
```

Our `anthropic-in` translator implements a zod refinement that rejects with this exact envelope BEFORE the request reaches any backend. `[CITED: handle-tool-calls docs]` `[VERIFIED 2026-05-13]`

### FINDING 2: count_tokens

**FINDING 2.1 — Response shape:**
```json
{"input_tokens": 14}
```

Single field. No `output_tokens` projection (despite some 3rd-party docs claiming one). No PDF-specific or image-specific field — everything aggregates into `input_tokens`. `[VERIFIED 2026-05-13 against official cURL example]`

**FINDING 2.2 — Per-image token formula:**
- Standard formula: `width × height / 750` tokens.
- Native resolution cap: 1568 tokens (1568 px long edge) for Claude Sonnet/Haiku.
- Higher cap for Claude Opus 4.7: 4784 tokens (2576 px long edge).
- If dimensions can't be determined (URL input we don't fetch, or unmeasurable base64): use the 1568 cap as fallback.
- Image is auto-resized server-side if larger than the native res; tokens still capped accordingly.

`[CITED: platform.claude.com/docs/en/build-with-claude/vision "Evaluate image size" — direct quote: "An image uses approximately `width * height / 750` tokens"]` `[VERIFIED 2026-05-13]`

For local cl100k_base estimation, we use the 1568 fallback (Sonnet-tier cap) because (a) we're not Anthropic Opus, (b) the user's vision model is llama3.2-vision which doesn't have an Opus-class higher-res native resolution, and (c) the formula is "approximate" by Anthropic's own admission — clients tolerate ±5-15%.

**FINDING 2.3 — Tool prompt overhead:**
When `tools` are provided, Anthropic prepends a special system prompt:
- `auto` / `none` tool_choice: 346 tokens (Claude 4 family)
- `any` / `tool` tool_choice: 313 tokens (Claude 4 family)

The user is BILLED for these tokens — count_tokens should account for them. A simple `total += 340` when `tools.length > 0` is within ±10 of either case and matches our `gpt-tokenizer/cl100k_base` accuracy floor.

`[CITED: platform.claude.com/docs/en/docs/build-with-claude/tool-use — pricing table]` `[VERIFIED 2026-05-13]`

### FINDING 3: Tool calling

**FINDING 3.1 — Schema mapping:**
| OpenAI | Canonical (Anthropic-shape) |
|---|---|
| `{type:"function", function:{name, description, parameters}}` | `{name, description, input_schema}` |
| Tool def | Tool def |
| `tool_calls[].id` | `tool_use.id` (prefixed `toolu_`) |
| `tool_calls[].function.name` | `tool_use.name` |
| `tool_calls[].function.arguments` (string-encoded JSON) | `tool_use.input` (parsed object) |
| `tool` role message with `tool_call_id` + `content` (string) | `user` role with `{type:"tool_result", tool_use_id, content}` block |

`[VERIFIED 2026-05-13 across handle-tool-calls + define-tools docs]`

**FINDING 3.2 — JSON.stringify discipline (Pitfall 5 mitigation):**
- `openai-in`: `JSON.parse(tool_calls[i].function.arguments)` → `tool_use.input`. On parse error → throw a typed error → 400 with `code: "tool_call_arguments_invalid_json"`.
- `openai-out`: `JSON.stringify(tool_use.input)` → `tool_calls[i].function.arguments`.
- `anthropic-in` / `anthropic-out`: pass-through (both sides have parsed objects).
- Adapters NEVER stringify/parse tool args.

This boundary discipline is critical because OpenAI streams `arguments` as fine-grained string fragments and Anthropic streams `input` as `input_json_delta.partial_json` fragments — at the streaming layer the two formats are byte-identical (both are JSON string fragments). At the non-stream layer the types diverge.

**FINDING 3.3 — Anthropic tool definition (native shape):**
```json
{
  "name": "get_weather",
  "description": "Get the current weather in a given location",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": {"type": "string", "description": "The city and state, e.g. San Francisco, CA"}
    },
    "required": ["location"]
  }
}
```

Note: `input_schema`, not `parameters`. No `function` wrapper. `[VERIFIED 2026-05-13]`

**FINDING 3.4 — tool_choice mapping table (CORRECTED FOR 2026):**

| OpenAI | Canonical (Anthropic) | Status |
|---|---|---|
| `"auto"` (default with tools) | `{type:"auto"}` | ✅ matches D-D3 |
| `"required"` | `{type:"any"}` | ✅ matches D-D3 |
| `{type:"function", function:{name:"X"}}` | `{type:"tool", name:"X"}` | ✅ matches D-D3 |
| **`"none"`** | **`{type:"none"}`** | ⚠️ **D-D3 says "strip tools[]" — needs revision per 2026 Anthropic** |
| `parallel_tool_calls: false` | **`tool_choice: {type:<chosen>, disable_parallel_tool_use: true}`** | ⚠️ **D-D4's `_meta.disable_parallel_tools` is a workaround — use native modifier** |

Source: `https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools` — direct quote: "`none` prevents Claude from using any tools. This is the default value when no `tools` are provided." `[VERIFIED 2026-05-13]`

Source for `disable_parallel_tool_use`: `https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use` — "Setting `disable_parallel_tool_use=true` when tool_choice type is `auto`, which ensures that Claude uses at most one tool. Setting `disable_parallel_tool_use=true` when tool_choice type is `any` or `tool`, which ensures that Claude uses exactly one tool." `[VERIFIED 2026-05-13]`

**Planner action:** Revise D-D3 and D-D4 in CONTEXT.md errata (or carry the revision in PLAN.md). The change is purely translator-internal, doesn't affect adapters, and is forward-compatible.

**FINDING 3.5 — `stop_sequences` mapping:**
- OpenAI `stop: string` → canonical `stop_sequences: [string]`
- OpenAI `stop: string[]` → canonical `stop_sequences: string[]` (reject if >5)
- Canonical → OpenAI: always emit as array (OpenAI accepts both string and array form)
- Anthropic cap: 5 entries documented `[VERIFIED 2026-05-13]`

**FINDING 3.6 — Parallel `tool_use` blocks:**
Multiple `tool_use` content blocks in ONE assistant message — official sample shows index 0 (text) then index 1 (tool_use) sequentially in the stream. The pattern extends: index 0 (tool_use A), index 1 (tool_use B), each opened/streamed/closed sequentially before the next index opens. `[VERIFIED 2026-05-13]`

User's tool_result reply: ALL tool_result blocks must be in ONE user message's content array (not separate messages — separate messages teach Claude to stop using parallel tools).

**FINDING 3.7 — `tool_result` with `is_error: true`:**
```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": "ConnectionError: weather service unavailable",
      "is_error": true
    }
  ]
}
```

Round-trip from OpenAI: OpenAI doesn't have `is_error` natively — the convention is to put error info in `content` (string). When `is_error: true` round-trips OpenAI ↔ Anthropic, the recommended convention is to wrap as JSON: `content: '{"is_error": true, "result": "..."}'`. Document this in the golden fixture `03-is-error-tool-result/`. `[VERIFIED 2026-05-13]`

**FINDING 3.8 — Tool system-prompt token overhead:**
See FINDING 2.3 above. ~340 tokens added when tools are provided.

**FINDING 3.9 — Full `stop_reason` enum (2026):**
- `end_turn` — natural completion
- `max_tokens` — hit `max_tokens` limit
- `stop_sequence` — hit a custom stop string
- `tool_use` — model wants to call a tool
- `pause_turn` — server-tool sampling loop hit iteration cap (won't apply to local backends)
- `refusal` — safety classifier intervened (mostly Sonnet 4.5+ behavior; might surface from local fine-tunes)
- `model_context_window_exceeded` — context window full (Sonnet 4.5+ default; beta header on earlier; won't apply to local backends unless we add the beta header surface)

`[VERIFIED 2026-05-13 — handling-stop-reasons docs]`

Canonical `StopReason` type union includes all 7 for forward-compat. Local backends will produce only the first 4.

### FINDING 4: Vision

**FINDING 4.1 — Anthropic image block shape:**
- Base64 source: `{"type":"image", "source": {"type":"base64", "media_type":"image/jpeg", "data":"<base64>"}}`
- URL source: `{"type":"image", "source": {"type":"url", "url":"https://..."}}`
- Files API source: `{"type":"image", "source": {"type":"file", "file_id":"file_..."}}`
- Supported formats: JPEG, PNG, GIF, WebP. Animations unsupported (first frame only).
- Multiple images per request: up to 100 for 200k-token-context models, 600 otherwise (subject to 32 MB request size cap).
- Max dimensions: 8000×8000 px (2000×2000 if >20 images).

`[VERIFIED 2026-05-13 — vision docs]`

**FINDING 4.2 — OpenAI image block shape:**
- `{"type":"image_url", "image_url": {"url":"data:image/jpeg;base64,<base64>"}}` — data URL form
- `{"type":"image_url", "image_url": {"url":"https://..."}}` — URL form

Translator: extract media_type + base64 from data URL via regex; extract base64 from Anthropic source verbatim; produce canonical form `{type:"image", source:{type:"base64"|"url", media_type, data|url}}`.

**FINDING 4.3 — Ollama native `/api/chat` image shape:**
```json
{
  "model": "...",
  "messages": [
    {
      "role": "user",
      "content": "what is in this image?",
      "images": ["<bare-base64-no-data-url-prefix>"]
    }
  ],
  "stream": true,
  "options": {...}
}
```

- `images` is on the MESSAGE object, not in a content-block array.
- `content` is a STRING (not a content-block array).
- Base64 is bare — no `data:image/...;base64,` prefix.
- Streaming returns NDJSON (one JSON per line) with `done: false` until terminal `done: true`.

`[VERIFIED 2026-05-13 — docs.ollama.com/api/chat]`

### FINDING 5: Ollama vision via `/v1/chat/completions` still has issues

Sources verified 2026-05-13:
- `https://github.com/ollama/ollama/issues/15727` — Anthropic compatibility: image content blocks dropped when forwarded to vision-capable cloud models (v0.21.0)
- `https://github.com/ollama/ollama/issues/3690` — long-running thread on OpenAI compat vision support; partial fixes throughout 2025-2026
- `https://github.com/NousResearch/hermes-agent/issues/14592` — Ollama Cloud vision returns 500 on `/v1/chat/completions`; native `/api/chat` works

Bottom line: even when `/v1/chat/completions` "works" for local llama3.2-vision, the native `/api/chat` path is the right choice for forward-compat (Phase 8 cloud vision needs it) and avoids the silent-text-no-image-context failure mode.

### FINDING 6: `llama3.2-vision:11b-instruct-q4_K_M` Ollama tag

Confirmed at `https://ollama.com/library/llama3.2-vision/tags` as of 2026-05-13:
- Tag exists: ✓
- Size: 7.8 GB
- Last updated: 11 months ago
- 128K context window
- Supports text + image input

VRAM budget of 8 GB in CONTEXT.md is correct (some Q4_K_M models run slightly over budget — pin verifiable via `docker exec ollama ollama list` after pull).

### FINDING 7: `anthropic-version` header

Source: `https://platform.claude.com/docs/en/api/versioning` `[VERIFIED 2026-05-13]`

- ONE supported value in 2026: **`2023-06-01`**
- Legacy `2023-01-01` is deprecated and may be unavailable to new users.
- Header is REQUIRED — clients must send it.
- The official docs do not document the server echoing the value, but our spec (D-E5) requires us to echo verbatim. This is a router-side convention that mimics expected agent behavior; the canonical Anthropic SDK doesn't depend on the echo.

### FINDING 8: Package pins

**FINDING 8.1 — gpt-tokenizer:**
- Latest: published Nov 7, 2025 (specific patch version moves; `^3.x` constraint stable)
- Supports cl100k_base via `import { encode, decode } from 'gpt-tokenizer/encoding/cl100k_base'`
- Sub-package import means only cl100k_base BPE table loaded into memory (smaller than the all-encodings import)
- Pure JS — no native deps
- Synchronous — module-level cache acceptable

`[CITED: npmjs.com/package/gpt-tokenizer]`

**FINDING 8.2 — ulid:**
- Latest: 3.0.2 (published ~late 2025)
- 26-char Crockford base32 output
- `monotonicFactory()` API for monotonic IDs within same millisecond
- Pure JS — no native deps

```typescript
import { ulid, monotonicFactory } from 'ulid';

const factory = monotonicFactory();
const msgId = `msg_${factory()}`;       // e.g., "msg_01HXYZAB1234567890ABCDEFGH"
const toolId = `toolu_${factory()}`;
```

`[CITED: npmjs.com/package/ulid]`

### FINDING 9: fastify-sse-v2 typed events

- Latest: `4.2.2` (already pinned in Phase 2)
- `reply.sse(asyncIterable)` accepts an async generator yielding `{event?, data, id?, retry?}` objects.
- When `event` is non-empty, the plugin emits `event: <name>\n` line BEFORE `data: <payload>\n`.
- When `event` is empty or absent, only `data:` is emitted.
- This is EXACTLY what Anthropic SSE needs: `event: message_start\ndata: {"type":"message_start", ...}`.

`[VERIFIED: github.com/mpetrunic/fastify-sse-v2 README]`

### FINDING 10: Validation Architecture details

See `## Validation Architecture` section above. Total: ~22 fixtures × 5 JSON files each ≈ 110 JSON files in `router/tests/translation/golden/` — but vitest snapshot-style assertions consolidate to ~15 test cases via fixture-driven `.test.ts`.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all pins verified against npm registry 2026-05-13
- Architecture: HIGH — matches CONTEXT.md locked decisions; LiteLLM/Vercel/OpenRouter follow same canonical-shape pattern
- Pitfalls: HIGH — Anthropic wire format pitfalls verified directly against official docs; Ollama vision pitfalls verified against current GitHub issues
- Tool calling (D-D3 revision): HIGH — `{type:"none"}` and `disable_parallel_tool_use` modifier verified against current Anthropic docs

**Overall confidence:** HIGH.

**Research date:** 2026-05-13
**Valid until:** 2026-06-13 (30 days; Anthropic wire format historically stable, but tool_choice subspace can shift)

---

*Phase: 4-Anthropic Surface — `/v1/messages`, Tool Calling, Vision*
*Research completed: 2026-05-13*
