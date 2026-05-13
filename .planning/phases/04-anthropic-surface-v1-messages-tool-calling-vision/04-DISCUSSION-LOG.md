# Phase 4: Anthropic Surface — `/v1/messages`, Tool Calling, Vision - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-13
**Phase:** 4-Anthropic Surface — `/v1/messages`, Tool Calling, Vision
**Areas discussed:** Canonical shape & translator location, Ollama vision routing strategy, Vision-capable model + tool-call test scope, count_tokens strategy + Anthropic event-id generation

---

## Area Selection

| Option | Description | Selected |
|--------|-------------|----------|
| Canonical shape & translator location | Internal data structure + where translation code lives | ✓ |
| Ollama vision routing strategy (VISION-03) | How to honor Pitfall 8 — native /api/chat for Ollama vision | ✓ |
| Vision-capable model + tool-call test scope | Which vision model + which tool tests pass in Phase 4 | ✓ |
| count_tokens strategy + Anthropic event-id generation | Accuracy floor for count_tokens + how message_start id is generated | ✓ |

**User's choice:** All four areas selected — phase is research-flagged as the hardest item, every gray area matters.

---

## Canonical shape & translator location

### Sub-question 1: How exact is the canonical shape to Anthropic's wire format?

| Option | Description | Selected |
|--------|-------------|----------|
| Verbatim Anthropic types from @anthropic-ai/sdk | Reuse SDK's MessageParam/ContentBlock/ToolUseBlock/etc. as canonical type. Zero divergence drift, but pulls SDK deep into adapters. | |
| Internal canonical mirroring Anthropic shape | Hand-rolled types in router/src/translation/canonical.ts that mirror Anthropic 1:1. Same shape, our zod schemas + types. | ✓ |
| Slightly normalized canonical with metadata | Anthropic-shape blocks + _meta per block (came-from, original_id). Helps debugging; schema non-standard. | |
| Defer exact shape to researcher | Mark as research-question; pick at planning time. | |

**User's choice:** Internal canonical mirroring Anthropic shape.

**Notes:** Hand-rolled types live in `router/src/translation/canonical.ts`. Adapters never import from `@anthropic-ai/sdk`; the SDK is used in tests only for type cross-checks. PDF blocks + thinking blocks are in v2 backlog — when those land, extend the canonical `ContentBlock` union.

### Sub-question 2: Where does the translation code live?

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated translator module per direction | router/src/translation/{openai-in.ts, openai-out.ts, anthropic-in.ts, anthropic-out.ts, ollama-native-out.ts}. Shared canonical types. Easy to test in isolation. | ✓ |
| Centralized Translator service injected via app | Single Translator class with .toCanonical/.fromCanonical, Fastify decorator. Uniform API but coarser tests. | |
| Adapters own outbound translation; routes own inbound | BackendAdapter.messagesStream(canonical) translates internally. Couples backend to canonical. | |
| Inline in route handlers | Translation in /v1/messages and /v1/chat/completions directly. Simple to start, hard to test. | |

**User's choice:** Dedicated translator module per direction.

**Notes:** Five translator files + one shared canonical file. Each direction has its own test file under `router/tests/translation/`. Golden fixtures (single tool / parallel / is_error / tool_choice / vision URL / vision base64) live as JSON files in `router/tests/translation/golden/`. Round-trip tests run a request through inbound translator → canonical → outbound translator and assert against the golden.

### Sub-question 3: Does /v1/chat/completions also go through canonical?

| Option | Description | Selected |
|--------|-------------|----------|
| Migrate /v1/chat/completions to canonical too | Every route flows through canonical. Round-trip golden tests free. Adds 2 translation hops + Phase 2 refactor. | ✓ |
| Keep direct path for /v1/chat/completions | Text-only stays on direct chatCompletions; canonical only for /v1/messages + vision. Two parallel paths. | |
| Hybrid: canonical only when image/tools present | Three paths in route, two in adapter. Most complex; minimizes regression. | |
| Defer to planner | Decide at planning time based on round-trip-test ergonomics. | |

**User's choice:** Migrate /v1/chat/completions to canonical too.

**Notes:** Uniform path means the adapter has ONE entry point (`chatCompletionsCanonical`), not three. Phase 2's direct `chatCompletions` / `chatCompletionsStream` are removed from `BackendAdapter`. Round-trip golden tests become identity tests against the live routes. Refactor scope: rewrite the middle of `chat-completions.ts` between zod validation and `reply.send` — semaphore/heartbeat/abort wiring stays untouched.

---

## Ollama vision routing strategy (VISION-03)

| Option | Description | Selected |
|--------|-------------|----------|
| Method on BackendAdapter: chatCompletionsCanonical(canonical) | Adapter inspects content; image-bearing → native /api/chat; else /v1/chat/completions. Hidden behind seam. | ✓ |
| Separate OllamaNativeAdapter class, factory chooses | Factory picks by entry.backend + request capability hint. Needs request context. | |
| Always use native /api/chat for Ollama | Replace OllamaOpenAIAdapter entirely. Rewrites Phase 2's working integration. | |
| Route-level branching | Routes call OllamaNativeClient directly when image present. Breaks the Phase 3 seam. | |

**User's choice:** Method on BackendAdapter: chatCompletionsCanonical (adapter-internal split).

**Notes:** `OllamaOpenAIAdapter.chatCompletionsCanonical()` inspects `canonical.messages[*].content` for `type: "image"` blocks. If found → raw fetch to `http://ollama:11434/api/chat` with the `images: [base64]` body shape (via the `ollama-native-out` translator). Else → existing `client.chat.completions.create` path. Routes see ONE entry point. Future Phase 8 `OllamaCloudAdapter` mirrors the same pattern (cloud has the same broken `/v1/chat/completions` for vision per Pitfall 8).

---

## Vision-capable model + tool-call test scope

### Sub-question 1: Vision model

| Option | Description | Selected |
|--------|-------------|----------|
| Llama 3.2-Vision 11B via Ollama (Q4_K_M ~7–8 GB) | Add ollama tag llama3.2-vision:11b-instruct-q4_K_M. Native /api/chat with images. Same backend as Phase 1 text Llama. Tested vision model. | ✓ |
| MiniCPM-V 2.6 7B via Ollama (Q4 ~5 GB) | Smaller, faster vision model. Reuses Ollama backend. Less famous. | |
| Add Qwen2-VL-7B-Instruct GGUF to llama.cpp backend | Exercises llama.cpp llava protocol. More fragile. Phase 7 would re-do with vLLM AWQ. | |
| No vision model — test only the gating 400 path | models.yaml unchanged. Only VISION-02 tested. VISION-01/03 deferred. | |

**User's choice:** Llama 3.2-Vision 11B via Ollama (Q4_K_M ~7–8 GB).

**Notes:** Adds a third entry to `models.yaml` under `backend: ollama` with `capabilities: [chat, vision]` and `vram_budget_gb: 8`. Ollama backend VRAM sum 4 + 8 = 12 GB ≤ 16 envelope. README adds the one-time `ollama pull llama3.2-vision:11b-instruct-q4_K_M`. Llama 3.2 is well-tested vision in Ollama 2026. Compose profile `ollama` covers both the 3B text model and the 11B vision model; Ollama swaps between them.

### Sub-question 2: Tool-call golden test scope

| Option | Description | Selected |
|--------|-------------|----------|
| Full golden suite: serial + parallel + is_error + tool_choice | Round-trip fixtures for single + parallel + is_error + tool_choice mapping. Covers TOOL-01..05 explicitly. | ✓ |
| Core golden suite: single + parallel + is_error | Skip tool_choice fixtures; still implement translation. Covers TOOL-01..04. | |
| Minimal: single tool call round-trip | One fixture. Parallel + is_error become Phase 5 backfill. Risks silent corruption. | |
| Defer scope to researcher | Researcher reports edge cases; planner decides. | |

**User's choice:** Full golden suite: serial + parallel + is_error + tool_choice.

**Notes:** Locks Pitfall 5 down hard. Seven golden fixtures: single tool, parallel tools, is_error on tool_result, tool_choice=required/any, tool_choice=specific, vision base64, vision URL. Each fixture has `input-openai.json`, `input-anthropic.json`, `canonical.json`, `output-openai.json`, `output-anthropic.json`. Tests run inputs through translators and assert against goldens.

---

## count_tokens strategy + Anthropic event-id generation

### Sub-question 1: count_tokens accuracy floor

| Option | Description | Selected |
|--------|-------------|----------|
| gpt-tokenizer (cl100k_base) server-side | Pure-JS tokenizer (~250KB). ~Claude-equivalent for English/code; ~5% over on Asian scripts. Zero backend round-trips. | ✓ |
| Per-backend tokenize proxy | Forward to Ollama /api/tokenize / llama.cpp /tokenize. Most accurate. Slower, fragile. | |
| chars/4 heuristic + log a warning | Math.ceil(json_stringify.length/4). Fast, zero deps, intentionally rough. | |
| tiktoken-rs native binding | @dqbd/tiktoken Rust native. Faster than gpt-tokenizer. Native binding compatibility risk. | |

**User's choice:** gpt-tokenizer (cl100k_base) server-side.

**Notes:** Add `gpt-tokenizer@^2.x` to router deps. Encoder loaded once at boot. Per-image overhead via Anthropic's documented formula (`(W × H) / 750` tokens, fallback 1568 if dimensions not measurable). Response includes header `X-Token-Count-Method: gpt-tokenizer/cl100k_base` so agents know the accuracy floor.

### Sub-question 2: Anthropic message_start id generation

| Option | Description | Selected |
|--------|-------------|----------|
| msg_<ulid> generated per request | Anthropic's real wire-format look. Sortable, monotonic, 26 chars. Adds ulid dep. | ✓ |
| msg_<nanoid> | Tiny dep, 21-char URL-safe. Not ULID-monotonic. | |
| Reuse Fastify req.id | Zero new deps. Default Fastify req.id is short incrementing int — looks wrong to clients. | |
| uuid v4 with msg_ prefix | crypto.randomUUID() native. Doesn't match Anthropic look-and-feel. | |

**User's choice:** msg_<ulid> generated per request.

**Notes:** Add `ulid@^2.x` to router deps. `tool_use` content blocks get `toolu_<ulid>` ids (Anthropic's prefix convention). Both prefixes documented in pino logs alongside `req.id` for join queries in Phase 5's Postgres.

---

## Claude's Discretion

Captured under `<decisions>` "Claude's Discretion" in CONTEXT.md. Summary:
- Exact module/file names under `router/src/translation/` (suggested layout pinned, planner can refine if friction).
- Exact zod schema for canonical types.
- Specific ULID/tokenizer package pin.
- Image URL fetching policy (timeout, max size, scheme allowlist).
- Per-image token-overhead formula verification against current Anthropic docs.
- pino log shape for translation events (debug level only).
- Vitest test layout under `router/tests/translation/`.
- Whether to add integration tests for `/v1/messages` (recommended yes).

## Deferred Ideas

Captured under `<deferred>` in CONTEXT.md. Highlights:
- PDF document blocks + extended-thinking blocks (v2: DOCS-01, THINK-01).
- `cache_control` passthrough (Phase 8 — cloud only).
- Structured outputs / guided decoding (v2: STRUCT-01).
- Vision on llama.cpp (Phase 7 — Qwen2-VL on vLLM).
- `X-Model-Backend` header + Idempotency-Key + rate-limit (Phase 8).
- Postgres logging + Prometheus metrics (Phase 5).
- Whether `/v1/chat/completions` accepts Anthropic-shape inputs (explicit no in Phase 4 — re-evaluate if agents request).
- `tool_choice: "none"` cleaner mapping if Anthropic adds native support.
- SSRF / image URL fetching policy hardening (Phase 9).
