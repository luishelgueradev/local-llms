# Phase 4: Anthropic Surface — `/v1/messages`, Tool Calling, Vision - Pattern Map

**Mapped:** 2026-05-13
**Files analyzed:** 28 (8 new translator/route source files, 7 modified source files, 9 new test files, 4 config/doc files)
**Analogs found:** 28 / 28 (every Phase 4 file has at least one strong analog in the existing router codebase)

This document is the contract between `gsd-phase-researcher`/CONTEXT.md and `gsd-planner`. Every PATTERNS row points to an existing file in `router/` that the executor will *read first* before writing the new file. Excerpts are 5–20 LOC, taken verbatim with line numbers so the planner can reference them in PLAN action bullets.

---

## File Classification

| Phase 4 File (new or modified) | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `router/src/translation/canonical.ts` (NEW) | model + utility (types + zod schemas) | transform (data-shape definition) | `router/src/config/registry.ts` (zod schema + types + `superRefine` invariants) | role-match (both: hand-rolled TS types + zod runtime schema + refinement) |
| `router/src/translation/openai-in.ts` (NEW) | translator (input → canonical) | transform | `router/src/routes/v1/chat-completions.ts` lines 21–35 (zod parse) + `router/src/config/registry.ts` lines 70–75 (parse + validate) | role-match (zod-validated input → typed domain object) |
| `router/src/translation/openai-out.ts` (NEW) | translator (canonical → OpenAI shape + SSE stream) | streaming transform | `router/src/sse/stream.ts` (chunkToSseEvents async generator) + `router/src/backends/ollama-openai.ts` lines 33–46 (stream consumption) | exact (async generator that reshapes a stream into another wire format) |
| `router/src/translation/anthropic-in.ts` (NEW) | translator (input → canonical) + validator | transform | `router/src/config/registry.ts` lines 43–64 (`superRefine` cross-field validation) | exact (role-alternation refinement is structurally identical to VRAM-sum refinement) |
| `router/src/translation/anthropic-out.ts` (NEW) | translator (canonical → Anthropic shape + typed SSE stream) | streaming transform | `router/src/sse/stream.ts` (async generator emitting `{event, data}` pairs) + 04-RESEARCH.md Pattern 2 (lines 316–346) | exact (the research already shows the target shape; analog file shows the async-generator wiring) |
| `router/src/translation/ollama-native-out.ts` (NEW) | translator (canonical → Ollama native `/api/chat` shape) | request transform + side-effect (URL fetch) | `router/src/translation/openai-out.ts` (sibling, for shape transform) + 04-RESEARCH.md Pattern 3 (lines 351–377) | role-match (no existing native-Ollama translator — partial via openai-out sibling) |
| `router/src/routes/v1/messages.ts` (NEW) | controller (HTTP route) | request-response + streaming (SSE) | `router/src/routes/v1/chat-completions.ts` (full file — try/finally, onClose, safeRelease, heartbeat, sseCleanup) | exact (same shape; differs only in translator pipeline + SSE event helper) |
| `router/src/backends/adapter.ts` (MODIFIED) | interface | contract definition | self (Phase 3 already widened once with `probeLiveness`) | exact (re-applying the same widening pattern) |
| `router/src/backends/ollama-openai.ts` (MODIFIED) | service (adapter) | request-response + streaming + internal protocol split | self (Phase 2 impl) + 04-RESEARCH.md Pattern 3 (vision branch) | exact for the OpenAI-compat path; partial for the new native `/api/chat` branch |
| `router/src/backends/llamacpp-openai.ts` (MODIFIED) | service (adapter) | request-response + streaming | self + sibling `ollama-openai.ts` (mirror impl) | exact (Phase 3 already proved llamacpp is a near-clone of ollama-openai) |
| `router/src/routes/v1/chat-completions.ts` (MODIFIED) | controller (HTTP route) | request-response + streaming | self (only the 3-line translator-pipeline middle changes — see D-F3) | exact (this file IS its own analog — the surrounding semaphore/heartbeat/abort plumbing stays byte-identical) |
| `router/src/errors/envelope.ts` (MODIFIED) | utility (error types + serializers) | data-shape | self (existing typed error classes + frame helpers) | exact (`CapabilityNotSupportedError` mirrors `RegistryUnknownModelError`; `anthropicErrorFrame` mirrors `midStreamErrorFrameLines`) |
| `router/src/app.ts` (MODIFIED) | config (Fastify app wiring) | request-response routing setup | self (existing `registerChatCompletionsRoute` call) | exact (add two more `register*Route` calls next to the existing one) |
| `router/models.yaml` (MODIFIED) | config | declarative registry | self (existing two model entries) | exact (third entry follows the same shape) |
| `router/package.json` (MODIFIED) | config (npm manifest) | dependency declaration | self | exact |
| `bin/smoke-test-router.sh` (MODIFIED) | test (live integration script) | request-response | self (existing Phase 2/3 sections — SC1/SC2/SC3 + auth half) | exact (append new sections) |
| `README.md` (MODIFIED) | docs | docs | self (existing sections) | exact (append Phase 4 operational section) |
| `router/tests/translation/openai-in.test.ts` (NEW) | test (unit) | data transform validation | `router/tests/unit/envelope.test.ts` (table-driven `describe`+`it` for transformers) | exact |
| `router/tests/translation/openai-out.test.ts` (NEW) | test (unit) | data transform validation | `router/tests/unit/envelope.test.ts` | exact |
| `router/tests/translation/anthropic-in.test.ts` (NEW) | test (unit) | data transform validation | `router/tests/unit/envelope.test.ts` | exact |
| `router/tests/translation/anthropic-out.test.ts` (NEW) | test (unit) + stream-event ordering | streaming transform validation | `router/tests/unit/sse/` (look for existing sse unit tests) + `router/tests/unit/envelope.test.ts` | role-match (no existing async-iterable unit test; envelope test gives the table-driven shape) |
| `router/tests/translation/ollama-native-out.test.ts` (NEW) | test (unit) | data transform validation | `router/tests/unit/envelope.test.ts` | exact |
| `router/tests/translation/golden.test.ts` (NEW) | test (integration of translator stack) + fixture-driven | round-trip transform validation | `router/tests/integration/chat-completions.nonstream.test.ts` (fixture-style YAML + msw handler) | role-match (golden-file pattern is new but fixture-loading style is established) |
| `router/tests/translation/golden/<NN-scenario>/{input-openai,input-anthropic,canonical,output-openai,output-anthropic}.json` (NEW) | test (fixture data) | data | (no analog — first fixture tree in the repo) | NO ANALOG — see "No Analog Found" section |
| `router/tests/integration/messages.nonstream.test.ts` (NEW) | test (integration, route + adapter + msw) | request-response | `router/tests/integration/chat-completions.nonstream.test.ts` | exact |
| `router/tests/integration/messages.stream.test.ts` (NEW) | test (integration, SSE) | streaming | `router/tests/integration/chat-completions.stream.test.ts` | exact |
| `router/tests/integration/messages.count-tokens.test.ts` (NEW) | test (integration, pure-CPU endpoint) | request-response | `router/tests/integration/chat-completions.nonstream.test.ts` (no-upstream variant — strip msw, no semaphore) | role-match (analog has msw + semaphore wiring this test does NOT need) |

---

## Pattern Assignments

### `router/src/translation/canonical.ts` (NEW — model + utility, transform)

**Analog:** `router/src/config/registry.ts`

**Why this analog:** Both define hand-rolled TS types backed by zod runtime schemas, both expose `.parse()` entry points, both use `superRefine` for cross-field invariants. `canonical.ts` mirrors Anthropic's wire shape; `registry.ts` mirrors the models.yaml shape. Same idiom.

**Imports pattern** (registry.ts lines 1–6):
```typescript
import { readFileSync, watch as fsWatch, watchFile as fsWatchFile, unwatchFile as fsUnwatchFile } from 'node:fs';
import type { FSWatcher, Stats } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod/v4';
import { RegistryUnknownModelError } from '../errors/envelope.js';
```
For canonical.ts, drop the fs+yaml imports and keep `import { z } from 'zod/v4';` plus `import type { ... } from '@anthropic-ai/sdk/resources/messages.js'` for test-only type cross-checks (D-A4 — runtime code does NOT import the SDK).

**Schema + type pattern** (registry.ts lines 12–27):
```typescript
export const LocalBackendEnum = z.enum(['ollama', 'llamacpp']);

export const ModelEntrySchema = z.object({
  name: z.string().min(1),
  backend: LocalBackendEnum,
  backend_url: z.string().url(),
  backend_model: z.string().min(1),
  capabilities: z.array(z.enum(['chat', 'embeddings', 'vision', 'tools'])).min(1),
  vram_budget_gb: z.number().positive(),
  concurrency: z.number().int().positive().optional(),
  max_model_len: z.number().int().positive().optional(),
  profile: z.string().optional(),
});

export type ModelEntry = z.infer<typeof ModelEntrySchema>;
```
Canonical equivalents: `TextBlockSchema`, `ImageBlockSchema`, `ToolUseBlockSchema`, `ToolResultBlockSchema`, then `ContentBlockSchema = z.discriminatedUnion('type', [...])`, then `CanonicalMessageSchema`, then `CanonicalRequestSchema`. Each block emits a `z.infer<>` type alias just like `ModelEntry`.

**Stream event union pattern** (04-RESEARCH.md Pattern 1, lines 287–308 — research-supplied, no router-codebase analog):
```typescript
export type CanonicalStreamEvent =
  | { type: 'message_start'; message: CanonicalMessage }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentBlockDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: StopReason | null; stop_sequence: string | null }; usage: { output_tokens: number } }
  | { type: 'message_stop' }
  | { type: 'ping' };
```

**Re-export pattern** (registry.ts line 123):
```typescript
export { RegistryUnknownModelError } from '../errors/envelope.js';
```
Canonical.ts may re-export `CapabilityNotSupportedError` from `../errors/envelope.js` so consumers import a single module.

---

### `router/src/translation/openai-in.ts` (NEW — translator, transform)

**Analog:** `router/src/routes/v1/chat-completions.ts` lines 21–35 (zod parse) + the same file's lines 67–74 (model lookup + body remap).

**Why this analog:** Phase 4 promotes the inbound shape-coercion that currently lives inline at the route's top into a dedicated translator. The existing `.passthrough()`+`as unknown as ChatCompletionCreateParams` cast is the *exact* idiom we are now extracting.

**Zod parse pattern** (chat-completions.ts lines 21–35):
```typescript
const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.unknown())]), // string OR array of content blocks (vision in Phase 4)
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
}).passthrough();

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
}).passthrough();
```
openai-in.ts takes the validated OpenAI body and rewrites it block-by-block into canonical. Key translations to spell out in the new file:
- First `role: "system"` message → top-level `system: string` (D-A2 bullet).
- `tool_calls[i].function.arguments` (string) → `JSON.parse` → `tool_use.input` (object). Catch `SyntaxError` → throw a zod-shaped error (`message: 'tool_call arguments not valid JSON'`) so the centralized error handler maps it to 400 (D-D2).
- `stop` (string OR string[]) → `stop_sequences: string[]` (D-D5); reject `>5` with structured 400 error.
- `tool_choice` mapping per D-D3 table.

**Error-throw pattern** (registry.ts lines 56–62 — for the "too many stop_sequences" gate):
```typescript
ctx.addIssue({
  code: 'custom',
  path: ['models'],
  message: `Config error: backend "${name}" declared models sum to ${sum} GB, exceeds VRAM_ENVELOPE_GB=${envelope}. Reduce vram_budget_gb on one or more entries.`,
});
```
Use the same `superRefine` idiom inside the OpenAI request schema if the planner decides to gate length in zod. Else throw a `z.ZodError` manually from the translator (centralized error handler maps `ZodError` → 400 — envelope.ts lines 60–69).

---

### `router/src/translation/openai-out.ts` (NEW — translator, streaming transform)

**Analog:** `router/src/sse/stream.ts` (full file — `chunkToSseEvents` async generator)

**Why this analog:** openai-out is structurally identical: take `AsyncIterable<CanonicalStreamEvent>` and yield `AsyncIterable<ChatCompletionChunk>` (or `AsyncIterable<{event, data}>` SSE pairs for the stream variant). The `chunkToSseEvents` shape — `try {...for await...} catch {...} finally { opts.onCleanup?.() }` — is the template.

**Async-generator pattern** (sse/stream.ts lines 20–67):
```typescript
export async function* chunkToSseEvents(
  upstream: AsyncIterable<ChatCompletionChunk>,
  opts: ChunkToSseOpts = {},
): AsyncGenerator<{ event?: string; data: string }, void, void> {
  try {
    for await (const chunk of upstream) {
      yield { data: JSON.stringify(chunk) };
    }
    yield { data: '[DONE]' };
  } catch (err) {
    if (opts.signal?.aborted) {
      return;
    }
    const env = toOpenAIErrorEnvelope(err);
    if (env === NO_ENVELOPE) {
      yield { event: '', data: '[DONE]' };
      return;
    }
    const lines = midStreamErrorFrameLines(env);
    for (const line of lines) {
      yield line;
    }
  } finally {
    opts.onCleanup?.();
  }
}
```
openai-out.ts's stream variant takes `AsyncIterable<CanonicalStreamEvent>` and yields `AsyncIterable<{ event?: string; data: string }>` containing OpenAI-shape delta JSON. The reassembly logic is:
- `content_block_delta { type: 'text_delta' }` → emit OpenAI `delta: { content: text }` chunk.
- `content_block_start { content_block: tool_use }` → emit OpenAI `delta: { tool_calls: [{ index, id, type:'function', function:{name} }] }`.
- `content_block_delta { type: 'input_json_delta' }` → emit OpenAI `delta: { tool_calls: [{ index, function:{arguments: partial_json} }] }` (stringified — D-D2 reverse direction).
- `message_delta { usage }` → emit final chunk with `choices: []` + `usage: { prompt_tokens, completion_tokens, total_tokens }` (matches Phase 2 stream shape — see `tests/msw/handlers.ts` lines 84–96).
- After `message_stop` → yield `{ data: '[DONE]' }`.

**Non-stream variant pattern** (no router analog; build from the stream variant by reducing events into a single ChatCompletion object — researcher's role).

---

### `router/src/translation/anthropic-in.ts` (NEW — translator, transform + validator)

**Analog:** `router/src/config/registry.ts` lines 43–64 (`RegistrySchema.superRefine` for cross-field invariants)

**Why this analog:** Role-alternation validation is structurally identical to VRAM-sum cross-field validation. Both walk an array, accumulate state, and emit `ctx.addIssue` on violation.

**superRefine cross-field validation pattern** (registry.ts lines 43–64):
```typescript
export const RegistrySchema = z.object({
  models: z.array(ModelEntrySchema).min(1, 'models.yaml must declare at least one model'),
  backends: BackendsSection,
}).superRefine((reg, ctx) => {
  const envelope = Number(process.env['VRAM_ENVELOPE_GB'] ?? 16);
  const sums = new Map<string, number>();
  for (const m of reg.models) {
    sums.set(m.backend, (sums.get(m.backend) ?? 0) + m.vram_budget_gb);
  }
  for (const [name, sum] of sums) {
    if (sum > envelope) {
      ctx.addIssue({
        code: 'custom',
        path: ['models'],
        message: `Config error: backend "${name}" declared models sum to ${sum} GB, exceeds VRAM_ENVELOPE_GB=${envelope}. Reduce vram_budget_gb on one or more entries.`,
      });
    }
  }
});
```
For anthropic-in.ts the equivalent refinement walks `body.messages` and asserts:
1. Roles strictly alternate `user → assistant → user → ...`. On violation: `ctx.addIssue({ code: 'custom', path: ['messages', i, 'role'], message: 'roles must strictly alternate user/assistant; ...' })`.
2. No `role: "system"` in the array (Anthropic puts system at top level — top-level `system` is OK).
3. Within a user message's content array: `tool_result` blocks appear BEFORE text blocks (research Pitfall 2, RESEARCH.md lines 418–428).

ZodError thrown by `.parse()` is automatically mapped to 400 + `invalid_request_error` by the centralized handler (envelope.ts lines 60–69).

---

### `router/src/translation/anthropic-out.ts` (NEW — translator, streaming transform)

**Analog:** `router/src/sse/stream.ts` (async-generator shape) + 04-RESEARCH.md Pattern 2 (lines 316–346, switch-on-event-type).

**Why this analog:** Same async-iterable transform shape as openai-out. Differs only in the per-event serialization (researcher already published the exact switch — file just needs to be created with the cleanup + abort discipline that stream.ts uses).

**The verbatim transform** (04-RESEARCH.md lines 316–346):
```typescript
export async function* canonicalToAnthropicSse(
  events: AsyncIterable<CanonicalStreamEvent>,
): AsyncIterable<{ event: string; data: string }> {
  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start':
        yield { event: 'message_start', data: JSON.stringify({ type: 'message_start', message: ev.message }) };
        break;
      case 'content_block_start':
        yield { event: 'content_block_start', data: JSON.stringify({ type: 'content_block_start', index: ev.index, content_block: ev.content_block }) };
        break;
      // ...
    }
  }
}
```

**Cleanup + abort discipline to graft on top** (sse/stream.ts lines 24–66):
```typescript
try {
  for await (const ev of events) { /* switch as above */ }
} catch (err) {
  if (opts.signal?.aborted) return;  // client disconnected — Pitfall 8
  // Anthropic mid-stream error frame (D-F5) — different shape from OpenAI's [DONE]
  yield { event: 'error', data: JSON.stringify(anthropicErrorFrame(err)) };
} finally {
  opts.onCleanup?.();
}
```
Note: Anthropic streams do NOT emit `[DONE]` — `message_stop` is the terminator. The error frame is `event: error` with the Anthropic-shape body (`{ "type": "error", "error": {...} }` per CONTEXT.md `<specifics>` lines 308–312). See `anthropicErrorFrame` in the envelope.ts modification below.

**Invariant tests to write** (D-F4): `message_start` precedes any `content_block_*`; every opened block closes with `content_block_stop`; `message_delta` precedes `message_stop`.

---

### `router/src/translation/ollama-native-out.ts` (NEW — translator, request transform + side-effect)

**Analog:** Sibling `router/src/translation/openai-out.ts` (when it lands) + 04-RESEARCH.md Pattern 3 (lines 351–377).

**Why this analog (partial):** No existing router file calls `fetch` to a downstream service or base64-encodes a remote resource. The closest structural analog is registry.ts's `readFileSync` (file → bytes → parse), but for HTTP-fetch + image-decode the planner builds from scratch with the researcher's pattern.

**Target shape** (04-RESEARCH.md lines 355–366):
```typescript
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
```

**URL fetch policy (Claude's Discretion bullet — CONTEXT.md line 135):** timeout 10s, max body size 10 MB, allowed schemes http|https only. Throw a translator-typed error on violation that maps to 400 (mirroring how `RegistryUnknownModelError` is typed in envelope.ts lines 24–33):
```typescript
export class ImageFetchError extends Error {
  readonly code = 'image_fetch_failed';
  constructor(message: string, public readonly url: string) {
    super(message);
    this.name = 'ImageFetchError';
  }
}
```
Planner adds an entry in envelope.ts `mapToHttpStatus` + `toOpenAIErrorEnvelope` (lines 36–51 + 54–106 pattern) so this maps cleanly to a 400 / `invalid_request_error` envelope.

**Internal native /api/chat fetch wiring** (no analog in router — but the constructor pattern from ollama-openai.ts lines 12–19 shows how to encode `baseURL`):
```typescript
this.client = new OpenAI({ baseURL, apiKey: 'ollama', timeout: 60_000 });
```
For native /api/chat the adapter (NOT this translator) will use raw `fetch` against `${baseURL.replace('/v1', '')}/api/chat`. See `ollama-openai.ts` modification section below.

---

### `router/src/routes/v1/messages.ts` (NEW — controller, request-response + streaming)

**Analog:** `router/src/routes/v1/chat-completions.ts` (full file)

**Why this analog:** D-F3 + CONTEXT.md `<code_context>` line 223 explicitly call this out: "the route shape (try/finally, onClose, safeRelease, heartbeat) is the template for `/v1/messages`. Phase 4 lifts ~70% of this file into a shared route-helper or duplicates with discipline." The plumbing — semaphore acquire → controller + onClose → heartbeat → sseCleanup → safeRelease in finally — is reused verbatim. The middle 3 lines (translator pipeline) differ.

**Imports + opts pattern** (chat-completions.ts lines 1–11 + 37–42):
```typescript
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { ChatCompletionChunk, ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory, BackendAdapter } from '../../backends/adapter.js';
import type { BackendSemaphore } from '../../concurrency/semaphore.js';
import { BackendSaturatedError } from '../../concurrency/semaphore.js';
import { startHeartbeat } from '../../sse/heartbeat.js';
import { chunkToSseEvents } from '../../sse/stream.js';
import { NO_ENVELOPE, mapToHttpStatus, toOpenAIErrorEnvelope } from '../../errors/envelope.js';
```
messages.ts swaps `chunkToSseEvents` → `canonicalToAnthropicSse` (from anthropic-out.ts) and adds `import { anthropicRequestToCanonical } from '../../translation/anthropic-in.js';`. Opts type adds nothing new.

**AbortController + onClose pattern** (chat-completions.ts lines 79–114):
```typescript
const controller = new AbortController();
let stopHeartbeat: (() => void) | null = null;

// IMPORTANT: Use req.raw.socket.once('close') NOT req.raw.once('close').
// IncomingMessage 'close' fires when the HTTP message body is fully consumed
// ...
const onClose = (): void => {
  controller.abort(new Error('client-disconnect'));
  stopHeartbeat?.();
};
const sock = req.raw.socket;
if (sock) {
  sock.once('close', onClose);
} else {
  req.log.warn(
    { url: req.url },
    'stream: req.raw.socket undefined — abort propagation may not fire (HTTP/2 or inject?)',
  );
}
```
**Replicate verbatim.** This is the WR-05 fix and is load-bearing for SC3.

**Semaphore acquire + safeRelease pattern** (chat-completions.ts lines 136–151):
```typescript
let released = false;
let release: () => void = () => {};
const safeRelease = (): void => {
  if (released) return;
  released = true;
  release();
};

try {
  const semaphore = opts.semaphores.get(entry.backend);
  release = await semaphore.acquire(controller.signal);
  released = false;
  // ...
```
**Replicate verbatim.**

**Stream branch pattern with sseCleanup** (chat-completions.ts lines 152–214):
```typescript
if (body.stream === true) {
  let upstream: AsyncIterable<ChatCompletionChunk>;
  try {
    upstream = await adapter.chatCompletionsStream(upstreamParams, controller.signal);
  } catch (err) {
    req.raw.socket?.off('close', onClose);
    const env = toOpenAIErrorEnvelope(err);
    const status = mapToHttpStatus(err);
    if (env === NO_ENVELOPE) return;
    return reply.code(status).send(env);
  }

  const heartbeat = startHeartbeat(reply.raw);
  stopHeartbeat = () => heartbeat.stop();

  const sseCleanup = (): void => {
    heartbeat.stop();
    req.raw.socket?.off('close', onClose);
    safeRelease();
  };

  try {
    await reply.sse(chunkToSseEvents(upstream, {
      signal: controller.signal,
      onCleanup: sseCleanup,
    }));
  } finally {
    heartbeat.stop();
  }
  // ...
}
```
**Replicate structure.** Replace:
- `adapter.chatCompletionsStream(upstreamParams, ...)` → `adapter.chatCompletionsCanonicalStream(canonical, ...)`.
- `chunkToSseEvents(upstream, ...)` → `canonicalToAnthropicSse(upstream, { signal, onCleanup: sseCleanup })`.

**Anthropic ping heartbeat (D-B5):** The Phase 2 `startHeartbeat` writes `: keep-alive\n\n` (heartbeat.ts line 28). For `/v1/messages`, per D-B5, emit `event: ping\ndata: {"type":"ping"}` instead. Two options for the planner:
- (a) parameterize `startHeartbeat` to accept a custom payload string,
- (b) add a sibling `startAnthropicHeartbeat` in `router/src/sse/heartbeat.ts` that writes `event: ping\ndata: {"type":"ping"}\n\n`.
Either way, the bytes-counted + idempotent-stop + `id.unref?.()` machinery (heartbeat.ts lines 31–63) is reused.

**Capability gating (D-C2) — new step before semaphore acquire:**
```typescript
// AFTER registry.resolve(body.model), BEFORE adapter call
const canonical = anthropicRequestToCanonical(body);
const hasImage = canonical.messages.some((m) =>
  Array.isArray(m.content) && m.content.some((b) => b.type === 'image'),
);
if (hasImage && !entry.capabilities.includes('vision')) {
  throw new CapabilityNotSupportedError(entry.name, 'vision');
}
```
The centralized error handler (app.ts lines 84–93) maps this to 400 via the new envelope entries (see envelope.ts modification below).

**Count-tokens sibling route** (small — no semaphore, no streaming, no abort wiring):
```typescript
export function registerCountTokensRoute(app: FastifyInstance, opts: { registry: RegistryStore }): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post('/v1/messages/count_tokens', { schema: { body: AnthropicCountTokensRequestSchema } }, async (req, reply) => {
    const body = req.body;
    opts.registry.resolve(body.model);  // 404 on unknown model — same pattern as chat-completions
    const canonical = anthropicRequestToCanonical(body);
    const input_tokens = countTokens(canonical);  // gpt-tokenizer, cl100k_base
    void reply.header('X-Token-Count-Method', 'gpt-tokenizer/cl100k_base');  // D-E2
    return { input_tokens };
  });
}
```
This is a 15-line route — no analog needed beyond the shape of `registerModelsRoute` (models.ts lines 13–33).

---

### `router/src/backends/adapter.ts` (MODIFIED — interface)

**Analog:** self (the file's own Phase 3 widening — adding `probeLiveness` — proved the pattern).

**Existing interface** (adapter.ts lines 14–41) — the section to be replaced:
```typescript
export interface BackendAdapter {
  chatCompletions(
    req: ChatCompletionCreateParams,
    signal: AbortSignal,
  ): Promise<ChatCompletion>;

  chatCompletionsStream(
    req: ChatCompletionCreateParams,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ChatCompletionChunk>>;

  probeLiveness(signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}
```

**Phase 4 replacement** (per D-B1 + D-B2):
```typescript
import type { CanonicalRequest, CanonicalResponse, CanonicalStreamEvent } from '../translation/canonical.js';

export interface BackendAdapter {
  chatCompletionsCanonical(
    canonical: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<CanonicalResponse>;

  chatCompletionsCanonicalStream(
    canonical: CanonicalRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<CanonicalStreamEvent>>;

  probeLiveness(signal: AbortSignal): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}
```
The `import type { ChatCompletion, ChatCompletionChunk, ChatCompletionCreateParams }` at the top (lines 1–5) is removed — adapters no longer surface OpenAI types. `AdapterFactory` (lines 48–49) is unchanged.

---

### `router/src/backends/ollama-openai.ts` (MODIFIED — service / adapter)

**Analog:** self (Phase 2 OpenAI-compat path is kept internally) + 04-RESEARCH.md Pattern 3 (vision branch).

**Phase 2 method to be replaced** (ollama-openai.ts lines 21–46):
```typescript
async chatCompletions(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<ChatCompletion> {
  const params: ChatCompletionCreateParamsNonStreaming = {
    ...req,
    stream: false,
    stream_options: { include_usage: true },
  };
  return this.client.chat.completions.create(params, { signal });
}

async chatCompletionsStream(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<AsyncIterable<ChatCompletionChunk>> {
  const params: ChatCompletionCreateParamsStreaming = {
    ...req,
    stream: true,
    stream_options: { include_usage: true },
  };
  return this.client.chat.completions.create(params, { signal });
}
```

**Phase 4 shape (per D-B3):**
```typescript
async chatCompletionsCanonical(canonical: CanonicalRequest, signal: AbortSignal): Promise<CanonicalResponse> {
  const hasImage = canonical.messages.some(/* image-block scan as in routes/v1/messages.ts */);
  if (hasImage) {
    // VISION-03: native /api/chat via raw fetch — Pitfall 8 mitigation
    const nativeReq = await canonicalToOllamaNativeChat(canonical);
    const baseUrlNoV1 = this.client.baseURL.replace(/\/v1\/?$/, '');
    const res = await fetch(`${baseUrlNoV1}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...nativeReq, stream: false }),
      signal,
    });
    // ... parse native response, build CanonicalResponse via ollama-native-in helper (planner adds if needed)
    return /* CanonicalResponse */;
  }
  // Else: OpenAI-compat path — translate canonical → OpenAI body, call SDK, translate response back
  const openaiReq = canonicalToOpenAIChatCompletion(canonical);  // from openai-out.ts (or sibling internal helper)
  const result = await this.client.chat.completions.create({ ...openaiReq, stream: false, stream_options: { include_usage: true } }, { signal });
  return openAIChatCompletionToCanonical(result);  // from openai-in.ts response-side or new helper
}
```
**Constructor + probeLiveness unchanged** (ollama-openai.ts lines 14–19 + 52–61) — Phase 3 already locked these.

**Key constraint:** raw `fetch` for native `/api/chat` MUST forward the `signal` to keep SC3 abort propagation intact. This matches the SDK's behavior (ollama-openai.ts line 30 comment: "The SDK forwards `signal` to undici, which closes the upstream socket on abort.").

---

### `router/src/backends/llamacpp-openai.ts` (MODIFIED — service / adapter)

**Analog:** self + sibling `ollama-openai.ts` (Phase 3 already proved llamacpp mirrors ollama-openai modulo apiKey + baseURL).

**Phase 4 shape (D-B4):** identical to ollama-openai's OpenAI-compat branch — NO vision branch. The two `chatCompletionsCanonical*` methods translate canonical → OpenAI → call SDK → translate response → canonical. Constructor (llamacpp-openai.ts lines 25–30) + probeLiveness (lines 63–72) unchanged.

The drift-prevention discipline (D-B3 of Phase 3) — keep `stream_options: { include_usage: true }` unconditional — is preserved:

**Reference excerpt** (llamacpp-openai.ts lines 32–42):
```typescript
async chatCompletions(req: ChatCompletionCreateParams, signal: AbortSignal): Promise<ChatCompletion> {
  const params: ChatCompletionCreateParamsNonStreaming = {
    ...req,
    stream: false,
    stream_options: { include_usage: true },
  };
  return this.client.chat.completions.create(params, { signal });
}
```
becomes:
```typescript
async chatCompletionsCanonical(canonical: CanonicalRequest, signal: AbortSignal): Promise<CanonicalResponse> {
  const openaiReq = canonicalToOpenAIChatCompletion(canonical);
  const result = await this.client.chat.completions.create(
    { ...openaiReq, stream: false, stream_options: { include_usage: true } },
    { signal },
  );
  return openAIChatCompletionToCanonical(result);
}
```

---

### `router/src/routes/v1/chat-completions.ts` (MODIFIED — controller)

**Analog:** self (D-F3 explicitly: "the route file's overall shape is untouched — only the middle three lines change").

**Lines to replace** (chat-completions.ts lines 153–215, the stream branch + the non-stream call at line 218):

Before:
```typescript
upstream = await adapter.chatCompletionsStream(upstreamParams, controller.signal);
// ...
await reply.sse(chunkToSseEvents(upstream, { signal: controller.signal, onCleanup: sseCleanup }));
// ...
const result = await adapter.chatCompletions(upstreamParams, controller.signal);
return reply.send(result);
```

After (D-A3 canonical pipeline):
```typescript
const canonical = openAIRequestToCanonical(body);
const canonicalUpstream = await adapter.chatCompletionsCanonicalStream(canonical, controller.signal);
// Reassemble canonical events into OpenAI delta chunks then SSE-frame them
await reply.sse(canonicalToOpenAISse(canonicalUpstream, { signal: controller.signal, onCleanup: sseCleanup }));
// non-stream:
const canonicalResult = await adapter.chatCompletionsCanonical(canonical, controller.signal);
return reply.send(canonicalToOpenAIResponse(canonicalResult));
```
**Everything else stays byte-identical:** zod schema (lines 21–35), AbortController + onClose (lines 79–114), safeRelease (lines 136–142), semaphore acquire (lines 144–151), try/catch/finally (lines 144–239), Retry-After header for BackendSaturatedError (lines 229–231). The `upstreamParams` cast at line 74 is removed (no longer needed — canonical objects are the wire).

---

### `router/src/errors/envelope.ts` (MODIFIED — utility)

**Analog:** self (existing typed errors).

**Pattern to mirror — `RegistryUnknownModelError`** (envelope.ts lines 24–33):
```typescript
export class RegistryUnknownModelError extends Error {
  readonly code = 'model_not_found';
  constructor(
    public readonly modelName: string,
    public readonly knownNames: string[],
  ) {
    super(`Unknown model "${modelName}"; registered: ${knownNames.join(', ')}`);
    this.name = 'RegistryUnknownModelError';
  }
}
```

**New addition — `CapabilityNotSupportedError`:**
```typescript
export class CapabilityNotSupportedError extends Error {
  readonly code = 'model_capability_mismatch';
  constructor(
    public readonly modelName: string,
    public readonly missingCapability: 'vision' | 'tools',
  ) {
    super(`Model "${modelName}" does not support capability "${missingCapability}". Pick a model with "${missingCapability}" in its capabilities list.`);
    this.name = 'CapabilityNotSupportedError';
  }
}
```

**Pattern to mirror — `mapToHttpStatus` row** (envelope.ts lines 36–51):
```typescript
if (err instanceof RegistryUnknownModelError) return 404;
```
Add: `if (err instanceof CapabilityNotSupportedError) return 400;`

**Pattern to mirror — `toOpenAIErrorEnvelope` row** (envelope.ts lines 84–86):
```typescript
if (err instanceof RegistryUnknownModelError) {
  return { error: { message: err.message, type: 'not_found_error', code: 'model_not_found', param: 'model' } };
}
```
Add:
```typescript
if (err instanceof CapabilityNotSupportedError) {
  return { error: { message: err.message, type: 'invalid_request_error', code: 'model_capability_mismatch', param: 'model' } };
}
```

**Pattern to mirror — `midStreamErrorFrameLines`** (envelope.ts lines 110–115):
```typescript
export function midStreamErrorFrameLines(envelope: OpenAIErrorEnvelope): { event: string; data: string }[] {
  return [
    { event: 'error', data: JSON.stringify(envelope) },
    { event: '', data: '[DONE]' },
  ];
}
```

**New addition — `anthropicErrorFrame`** (per D-F5; CONTEXT.md `<specifics>` line 312):
```typescript
export type AnthropicErrorEnvelope = {
  type: 'error';
  error: { type: string; message: string };
};

export function toAnthropicErrorEnvelope(err: unknown): AnthropicErrorEnvelope | typeof NO_ENVELOPE {
  const oai = toOpenAIErrorEnvelope(err);
  if (oai === NO_ENVELOPE) return NO_ENVELOPE;
  return {
    type: 'error',
    error: {
      // Map OpenAI -> Anthropic error types: invalid_request_error stays;
      // authentication_error -> authentication_error; rate_limit_error -> rate_limit_error;
      // upstream_error/timeout_error/internal_error -> api_error
      type: mapOpenAITypeToAnthropic(oai.error.type),
      message: oai.error.message,
    },
  };
}

export function anthropicErrorFrame(envelope: AnthropicErrorEnvelope): { event: string; data: string } {
  // Single frame — Anthropic streams do NOT terminate with [DONE]. message_stop is the terminator.
  return { event: 'error', data: JSON.stringify(envelope) };
}
```
Centralized error handler in `app.ts` (lines 84–93) is unchanged for `/v1/chat/completions`; the `messages.ts` route picks `anthropicErrorFrame` for mid-stream Anthropic errors and lets the centralized handler emit the JSON body for pre-stream / non-stream errors (D-F5 — "the stream branch in `messages.ts` picks the right frame helper based on protocol").

---

### `router/src/app.ts` (MODIFIED — config / wiring)

**Analog:** self.

**Pattern to mirror — existing route registration** (app.ts lines 184–203):
```typescript
registerHealthz(app, opts.registry);
registerReadyz(app, opts.registry, liveness);
registerChatCompletionsRoute(app, {
  registry: opts.registry,
  makeAdapter: opts.makeAdapter ?? defaultMakeAdapter,
  semaphores,
});
registerModelsRoute(app, opts.registry);
```

**Phase 4 additions** (per D-F1) — appended after `registerChatCompletionsRoute(...)`:
```typescript
// Phase 4: Anthropic surface (D-F1).
registerMessagesRoute(app, {
  registry: opts.registry,
  makeAdapter: opts.makeAdapter ?? defaultMakeAdapter,
  semaphores,
});
registerCountTokensRoute(app, { registry: opts.registry });
```
Imports at top (app.ts lines 11–17 area) gain:
```typescript
import { registerMessagesRoute, registerCountTokensRoute } from './routes/v1/messages.js';
```
No other change. `bodyLimit: 8 * 1024 * 1024` (app.ts line 64) is already correct for vision (comment line 64: "Phase 4 vision blows past 1 MB easily").

---

### `router/models.yaml` (MODIFIED — config)

**Analog:** self.

**Existing entry pattern** (models.yaml lines 11–20):
```yaml
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
    concurrency: 2
    max_model_len: 8192
    profile: ollama
```

**Phase 4 new entry** (CONTEXT.md D-C1 lines 67–77):
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
**Invariant:** Ollama backend VRAM sum becomes 4 + 8 = 12 GB ≤ 16 GB envelope. `RegistrySchema.superRefine` (registry.ts lines 47–63) enforces this at startup. **Planner verifies the exact tag is current** (CONTEXT.md line 78 + `<specifics>` line 257).

---

### `router/package.json` (MODIFIED — config)

**Analog:** self.

**Existing dependencies block** (package.json lines 18–25):
```json
"dependencies": {
  "fastify": "^5.8.5",
  "fastify-sse-v2": "^4.2.2",
  "@bram-dc/fastify-type-provider-zod": "^7.0.1",
  "zod": "^4.4.3",
  "openai": "^6.37.0",
  "js-yaml": "^4.1.1"
}
```

**Phase 4 additions** (CONTEXT.md `<canonical_refs>` § "New router npm deps", lines 205–209):
- `dependencies`: `gpt-tokenizer@^3` (CONTEXT.md D-E1 says `^2.x`; researcher verified `^3.x` is current — planner picks the exact pin), `ulid@^3.0.2`.
- `devDependencies`: `@anthropic-ai/sdk@^0.95.1` (TYPES ONLY — D-A4).
- (Possibly) `dependencies`: `undici@^7.x` if direct `fetch` to `/api/chat` needs keep-alive tuning (CONTEXT.md line 209 — "Planner evaluates; default Node 22 fetch may suffice"). Default Node 22 `fetch` is the path of least resistance — only add `undici` direct if a benchmark demands it.

---

### `bin/smoke-test-router.sh` (MODIFIED — test, live)

**Analog:** self (Phase 2 SC1/SC2/SC3 sections + Phase 3 multi-backend sections).

**Existing section pattern** (smoke-test-router.sh lines 144–179 — non-stream test):
```bash
# SC2: non-stream chat completion with usage
echo ""
echo "[smoke-test-router] SC2: POST /v1/chat/completions stream=false ..."
REQUEST_BODY=$(_SMOKE_MODEL="${MODEL}" _SMOKE_PROMPT="${PROMPT_NONSTREAM}" python3 -c '
import json, os
print(json.dumps({
  "model": os.environ.get("_SMOKE_MODEL", ""),
  "messages": [{"role": "user", "content": os.environ.get("_SMOKE_PROMPT", "")}],
  "stream": False,
}))
')
NONSTREAM_RESP=$(curl -fsS -X POST "${ROUTER_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${ROUTER_BEARER_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d "${REQUEST_BODY}" 2>/dev/null || true)
```

**Phase 4 new sections** (appended before the final FAILURES summary):
- `SC-P4-A: POST /v1/messages stream=false ...` — mirror of SC2, body uses Anthropic shape, asserts response has `id` starting with `msg_`, `type: "message"`, `usage.input_tokens > 0`, `usage.output_tokens > 0`.
- `SC-P4-B: POST /v1/messages stream=true ...` — mirror of SC1, asserts the SSE bytes contain `event: message_start`, `event: content_block_delta`, `event: message_delta`, `event: message_stop` (and that `[DONE]` is ABSENT — `message_stop` is the Anthropic terminator).
- `SC-P4-C: POST /v1/messages/count_tokens ...` — pure JSON request, asserts `input_tokens` is a positive integer and the response header `X-Token-Count-Method` equals `gpt-tokenizer/cl100k_base` (D-E2).
- `SC-P4-D: POST /v1/messages vision happy-path against llama3.2-vision:11b-instruct-q4_K_M` — base64-encoded tiny PNG inline; assert response content mentions visual semantics (loose check — `length > 50`). Pre-flight: `docker compose exec -T ollama ollama list | grep llama3.2-vision` to confirm the model is loaded.
- `SC-P4-E: POST /v1/messages with vision content but text-only model returns 400` — capability gate fires before the adapter call (D-C2). Assert `status == 400`, body's `error.type == "invalid_request_error"`, `error.code == "model_capability_mismatch"`.

The `FAILURES=$((FAILURES + 1))` + `pass`/`fail` helper functions (lines 92–95) are reused verbatim.

---

### `README.md` (MODIFIED — docs)

**Analog:** self.

**Add a "Phase 4: Anthropic surface" operational section.** Pattern (from CONTEXT.md `<specifics>` lines 313–330):
1. One-time setup: `docker compose exec -T ollama ollama pull llama3.2-vision:11b-instruct-q4_K_M`.
2. Curl sample for `/v1/messages` non-stream (text-only).
3. Curl sample for `/v1/messages` stream=true (text-only, shows expected typed SSE events).
4. Curl sample for `/v1/messages` with base64 vision input.
5. Curl sample for `/v1/messages/count_tokens`.
6. Curl sample for a tool-calling request (OpenAI tool defs on `/v1/chat/completions` AND Anthropic tool defs on `/v1/messages` — proves bidirectional translation).
7. Brief note on Anthropic mid-stream error frame shape (D-F5 — `event: error`, NO `[DONE]`).
8. Note on `X-Token-Count-Method` response header for count_tokens (D-E2 — accuracy disclaimer).

No code analog needed beyond the existing README style.

---

### `router/tests/translation/openai-in.test.ts` (NEW — test, unit)

**Analog:** `router/tests/unit/envelope.test.ts`

**Why this analog:** Table-driven `describe`/`it` per input shape, asserting on output structure. Both test pure transformer functions (no I/O, no fastify).

**Pattern** (envelope.test.ts lines 14–46):
```typescript
describe('toOpenAIErrorEnvelope (D-C1, D-C3)', () => {
  it('BearerAuthError -> 401 / authentication_error / unauthorized', () => {
    const env = toOpenAIErrorEnvelope(new BearerAuthError('nope'));
    expect(env).not.toBe(NO_ENVELOPE);
    expect(env).toEqual({ error: { message: 'nope', type: 'authentication_error', code: 'unauthorized', param: null } });
    expect(mapToHttpStatus(new BearerAuthError())).toBe(401);
  });

  it('ZodError -> 400 / invalid_request_error / invalid_request', () => {
    const result = z.object({ x: z.string() }).safeParse({ x: 1 });
    expect(result.success).toBe(false);
    if (result.success) return;
    const env = toOpenAIErrorEnvelope(result.error);
    // ...
```
openai-in tests follow the same `describe(transformer-name) → it(input-shape-name) → assert on output` shape. Coverage targets (per D-D2 / D-D5):
- Single text message → canonical `messages[0].content[0] = {type:'text', text:...}`.
- System message extraction (first `role: 'system'` → top-level `system`).
- `tool_calls[].function.arguments` parses → `tool_use.input` object.
- `tool_calls[].function.arguments` malformed JSON → throws ZodError-shaped error.
- `stop: 'string'` → `stop_sequences: ['string']`.
- `stop: ['a','b','c','d','e','f']` (>5) → throws `too many stop_sequences`.
- `tool_choice: 'auto'/'required'/{type:'function',...}/'none'` → canonical per D-D3 table.
- `parallel_tool_calls: false` → canonical `_meta.disable_parallel_tools: true`.
- OpenAI image_url content block → canonical `image` block with `source: {type:'url', url:'...'}`.

---

### `router/tests/translation/openai-out.test.ts` (NEW — test, unit)

**Analog:** `router/tests/unit/envelope.test.ts` (table-driven shape) + the stream tests' SSE-parsing helper.

**SSE-parsing helper pattern** (chat-completions.stream.test.ts lines 47–62):
```typescript
function parseSse(raw: string): Array<{ event?: string; data: string }> {
  const events: Array<{ event?: string; data: string }> = [];
  const blocks = raw.split('\n\n').filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    const lines = block.split('\n');
    let event: string | undefined;
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data = (data ? data + '\n' : '') + line.slice('data:'.length).trim();
    }
    events.push(event !== undefined ? { event, data } : { data });
  }
  return events;
}
```
**Copy verbatim** into `tests/translation/helpers.ts` (or inline per-test). openai-out's stream tests assert: canonical `content_block_delta { text_delta }` events accumulate into OpenAI `delta.content` chunks; final `message_delta { usage }` becomes a chunk with `choices: []` + `usage`; terminator is `data: [DONE]`.

---

### `router/tests/translation/anthropic-in.test.ts` (NEW — test, unit)

**Analog:** `router/tests/unit/envelope.test.ts` + `router/tests/unit/registry.test.ts` (lines 37–40 — schema-rejection assertions).

**Schema-rejection pattern** (registry.test.ts lines 37–40):
```typescript
describe('models.yaml registry — zod schema (ROUTE-02 startup half)', () => {
  it('accepts the Phase 3 minimum (capabilities + vram_budget_gb required)', () => {
    expect(() => loadRegistryFromString(MIN_YAML)).not.toThrow();
  });
```
Mirror for anthropic-in: `it('rejects messages with consecutive same role', () => { expect(() => anthropicRequestToCanonical(BAD_BODY)).toThrow(z.ZodError); });`. Coverage:
- Role alternation enforced (rejects `user, user`; rejects `assistant, assistant`).
- `role: 'system'` in messages[] rejected (top-level `system` is OK).
- `tool_result` blocks before text blocks in user content — accepted (Pitfall 2 mitigation).
- `tool_result` blocks after text blocks — rejected with helpful message.
- Top-level `system: string` propagates to canonical `system`.
- `stop_sequences` array > 5 entries — rejected.
- Anthropic `tool_choice: {type:'auto'/'any'/'tool'}` maps to canonical (D-D3 reverse).

---

### `router/tests/translation/anthropic-out.test.ts` (NEW — test, unit, async-iterable)

**Analog:** `router/tests/integration/chat-completions.stream.test.ts` lines 47–87 (parseSse + event-sequence assertions).

**Why this analog:** anthropic-out emits typed SSE event sequences; the chat-completions.stream test already shows how to assert on event ordering and content via `parseSse`.

**Event-order assertion pattern** (chat-completions.stream.test.ts lines 80–87):
```typescript
expect(res.statusCode).toBe(200);
expect(res.headers['content-type']).toContain('text/event-stream');
const events = parseSse(res.payload);
const dataEvents = events.filter((e) => e.data && e.data !== '[DONE]');
const doneEvents = events.filter((e) => e.data === '[DONE]');
expect(dataEvents.length).toBeGreaterThanOrEqual(4);
expect(doneEvents.length).toBeGreaterThanOrEqual(1);
```
For anthropic-out unit tests, feed a canned `AsyncIterable<CanonicalStreamEvent>` directly (no Fastify, no msw) and assert on `[event.type for event in collected]` matches:
- `['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']`.
- Every `content_block_start` is followed (eventually) by a `content_block_stop` with the same `index`.
- `message_delta` precedes `message_stop`.
- No `[DONE]` in the output (Anthropic terminator is `message_stop`).
- On thrown error mid-stream: yields single `{event:'error', data: '{"type":"error",...}'}`, NO `[DONE]` after.
- On `signal.aborted`: yields nothing (Pitfall 8 — client gone).

These are the D-F4 invariants that CONTEXT.md says "are unit-tested at the translator level".

---

### `router/tests/translation/ollama-native-out.test.ts` (NEW — test, unit)

**Analog:** `router/tests/unit/envelope.test.ts` (table-driven).

Coverage (D-C4):
- Single text block → `messages[0].content = "..."`, no `images`.
- Single base64 image + text → `messages[0].images = ["<base64>"]`, `messages[0].content = "<text>"`. The `data:image/...;base64,` prefix is stripped if present.
- URL image — mocked via msw — fetched, base64-encoded, pushed to `images`. msw handler pattern from `router/tests/msw/handlers.ts` lines 1–35 shows how to register a `http.get(...)` handler.
- URL image > 10 MB → throws `ImageFetchError`.
- URL image with `ftp://` scheme → throws.
- URL image fetch timeout (planner picks 10s default) → throws (test via fake timers or msw delay).
- Multiple images in one message → `images[]` has multiple entries.

---

### `router/tests/translation/golden.test.ts` + `router/tests/translation/golden/<NN-scenario>/*.json` (NEW — test, integration of translator stack)

**Analog (partial):** `router/tests/integration/chat-completions.nonstream.test.ts` (the fixture-loading shape — loading JSON/YAML at test start, asserting deep-equal). The directory-tree fixture pattern (one folder per scenario, 5 JSON files inside) is NEW — see "No Analog Found" below.

**Fixture-load + assert pattern** (chat-completions.nonstream.test.ts lines 28–40):
```typescript
beforeEach(async () => {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({ registry, bearerToken: TOKEN, /* ... */ });
});
```
The golden tests load fixtures and run translators directly (no Fastify). Per CONTEXT.md `<specifics>` lines 260–280 the layout is:
```
router/tests/translation/golden/
  01-single-tool/
    input-openai.json
    input-anthropic.json
    canonical.json
    output-openai.json
    output-anthropic.json
  02-parallel-tools/
  03-is-error-tool-result/
  04-tool-choice-required/
  05-tool-choice-specific/
  06-vision-base64/
  07-vision-url/
```

**Round-trip assertion shape** (TOOL-05 — CONTEXT.md `<domain>` line 16):
```typescript
// For each scenario directory:
const inputOA = readJson('input-openai.json');
const inputAN = readJson('input-anthropic.json');
const expectedCanonical = readJson('canonical.json');
const expectedOpenAI = readJson('output-openai.json');
const expectedAnthropic = readJson('output-anthropic.json');

// OpenAI in -> canonical -> Anthropic out
const canonicalFromOA = openAIRequestToCanonical(inputOA);
expect(canonicalFromOA).toEqual(expectedCanonical);
expect(canonicalToAnthropicResponse(canonicalFromOA)).toEqual(expectedAnthropic);

// Anthropic in -> canonical -> OpenAI out
const canonicalFromAN = anthropicRequestToCanonical(inputAN);
expect(canonicalFromAN).toEqual(expectedCanonical);
expect(canonicalToOpenAIResponse(canonicalFromAN)).toEqual(expectedOpenAI);
```

---

### `router/tests/integration/messages.nonstream.test.ts` (NEW — test, integration)

**Analog:** `router/tests/integration/chat-completions.nonstream.test.ts` (full file — Phase 4 mirrors this 1:1).

**Setup pattern** (chat-completions.nonstream.test.ts lines 11–44):
```typescript
const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const MODEL_NAME = 'llama3.2:3b-instruct-q4_K_M';
const UPSTREAM_BASE = 'http://upstream-mock:11434/v1';
const YAML = `
models:
  - name: ${MODEL_NAME}
    backend: ollama
    backend_url: ${UPSTREAM_BASE}
    backend_model: ${MODEL_NAME}
    capabilities: [chat]
    vram_budget_gb: 4
`;

let app: FastifyInstance;

beforeEach(async () => {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: (entry: ModelEntry) => new OllamaOpenAIAdapter(entry.backend_url),
    semaphores: {
      get: () => ({ acquire: async () => () => {}, stats: () => ({ inFlight: 0, queued: 0 }) }) as never,
    },
  });
});
afterEach(async () => {
  await app.close();
});
```
**Copy verbatim.** Only the test bodies change: POST to `/v1/messages`, payload uses Anthropic body shape (`{model, max_tokens, messages: [{role:'user', content:'...'}]}`), assertions target the Anthropic response shape (`{id: /^msg_/, type:'message', role:'assistant', content: [{type:'text', text:...}], stop_reason: 'end_turn', usage: {input_tokens, output_tokens}}`).

**Coverage** (mirror chat-completions.nonstream.test.ts):
- Happy path (200 + correct shape).
- Unknown model → 404 with Anthropic error body shape.
- Upstream unreachable → 502 with Anthropic error body shape.
- Missing required field → 400.
- Add: vision capability gate (request has image, model lacks `vision` capability) → 400 / `model_capability_mismatch`.
- Add: bidirectional tool-call (Anthropic in → Ollama → Anthropic out — round-trip a `tool_use` block via msw stub).
- Add: `anthropic-version` header echo (request sends `anthropic-version: 2023-06-01` → response header echoes verbatim).

---

### `router/tests/integration/messages.stream.test.ts` (NEW — test, integration, SSE)

**Analog:** `router/tests/integration/chat-completions.stream.test.ts` (full file).

**parseSse helper** — copy verbatim from chat-completions.stream.test.ts lines 47–62 (or factor into a shared `tests/sse-helpers.ts`).

**Event-sequence assertion pattern** (chat-completions.stream.test.ts lines 79–87):
```typescript
expect(res.statusCode).toBe(200);
expect(res.headers['content-type']).toContain('text/event-stream');
const events = parseSse(res.payload);
const dataEvents = events.filter((e) => e.data && e.data !== '[DONE]');
```
Replace OpenAI-shape assertions with Anthropic-shape:
- `events[0].event === 'message_start'` AND `JSON.parse(events[0].data).message.usage.input_tokens > 0`.
- At least one `events[i].event === 'content_block_delta'` with `JSON.parse(events[i].data).delta.type === 'text_delta'`.
- `events.some((e) => e.event === 'message_delta')` AND that event's `JSON.parse(e.data).usage.output_tokens > 0`.
- `events.at(-1).event === 'message_stop'` (NOT `[DONE]` — Anthropic terminator is `message_stop`).

**Add:** mid-stream Anthropic error frame test — upstream errors → emit `event: error\ndata: {"type":"error",...}`, NO `[DONE]` after. Use the same msw "force-close mid-stream" trick from chat-completions.stream.test.ts lines 223–253:
```typescript
server.use(http.post(`${UPSTREAM_BASE}/chat/completions`, () => {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const chunk = { id: 'x', /* ... */, choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.error(new Error('upstream connection reset'));
    },
  });
  return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}));
```

---

### `router/tests/integration/messages.count-tokens.test.ts` (NEW — test, integration)

**Analog:** `router/tests/integration/chat-completions.nonstream.test.ts` (setup + auth + bad-body) MINUS the msw upstream + semaphore (count_tokens does NOT call any backend — D-F1).

**Build pattern** (strip down chat-completions.nonstream.test.ts lines 11–44): the `YAML` + `makeRegistryStore` + `bearerToken` + `app.inject` shape stays. The `server.use(ollamaNonStreamHandler(...))` lines (line 48) are dropped. The `semaphores` opt may stay as the same no-op fake.

**Coverage:**
- POST text-only → `{input_tokens: N}` with `N > 0`.
- POST text + base64-image → `input_tokens` includes the per-image overhead (researcher confirms the exact value).
- POST text + URL image → `input_tokens` falls back to the 1568 constant (URLs not fetched in count_tokens — CONTEXT.md `<specifics>` line 258 explicit).
- Response header `X-Token-Count-Method: gpt-tokenizer/cl100k_base` is set (D-E2).
- Unknown model → 404.
- Missing required field → 400.
- Empty messages array → 400.

---

## Shared Patterns

### Pattern S1 — Async-generator transform with cleanup + abort

**Source:** `router/src/sse/stream.ts` (full file, 20–67)
**Apply to:** `openai-out.ts` (stream variant), `anthropic-out.ts` (stream variant)

```typescript
export async function* transformerName(
  upstream: AsyncIterable<InputEvent>,
  opts: { signal?: AbortSignal; onCleanup?: () => void } = {},
): AsyncGenerator<OutputEvent, void, void> {
  try {
    for await (const ev of upstream) {
      yield /* transformed */;
    }
  } catch (err) {
    if (opts.signal?.aborted) return;  // client gone — Pitfall 8
    // emit protocol-appropriate error frame
  } finally {
    opts.onCleanup?.();
  }
}
```
Three rules: (1) check `signal.aborted` before emitting any error frame (client-disconnect = no frame); (2) always wrap the consume-loop in try/finally so cleanup runs; (3) caller passes `onCleanup` to release semaphore slot + stop heartbeat.

---

### Pattern S2 — Typed error class + status mapping

**Source:** `router/src/errors/envelope.ts` lines 16–106 (BearerAuthError, RegistryUnknownModelError, BackendSaturatedError pattern)
**Apply to:** `CapabilityNotSupportedError` (Phase 4 add), `ImageFetchError` (Phase 4 add, if planner adopts).

Per-error: (1) `extends Error` with readonly `code: string` constant, (2) row in `mapToHttpStatus`, (3) row in `toOpenAIErrorEnvelope` returning the envelope shape, (4) (optional) row in `toAnthropicErrorEnvelope` if the error can fire on `/v1/messages`. Unit-test coverage mirrors envelope.test.ts lines 14–46 — one `it()` per error class + status mapping.

---

### Pattern S3 — Route handler shape (semaphore + abort + heartbeat + cleanup)

**Source:** `router/src/routes/v1/chat-completions.ts` lines 54–242 (the full handler)
**Apply to:** `router/src/routes/v1/messages.ts` (POST /v1/messages — same shape; differs only in translator pipeline + SSE frame helper)

Five rules:
1. **AbortController + socket-close listener** (lines 79–114) — load-bearing for SC3. Use `req.raw.socket.once('close', ...)` NOT `req.raw.once('close', ...)`. Log a warn if `req.raw.socket` is undefined (HTTP/2 or inject path).
2. **Semaphore acquire INSIDE the try block** (lines 144–150) — so `BackendSaturatedError` is caught and `Retry-After` header is set before re-throw.
3. **safeRelease + release closure** (lines 136–142) — idempotent; called from both `finally` and `sseCleanup`.
4. **Heartbeat + sseCleanup** (lines 174–204) — heartbeat starts AFTER upstream resolves; sseCleanup stops heartbeat + removes onClose listener + calls safeRelease. Wrap `reply.sse(...)` in try/finally with `heartbeat.stop()` in finally (WR-04 fix).
5. **Error path** (lines 221–233) — set Retry-After for BackendSaturatedError BEFORE re-throw to centralized handler.

Anthropic messages route differs from this template only in:
- the translator pipeline (`anthropicRequestToCanonical` instead of inline zod-passthrough cast),
- the SSE event helper (`canonicalToAnthropicSse` instead of `chunkToSseEvents`),
- the heartbeat payload (Anthropic typed `ping` event instead of `: keep-alive` comment),
- the mid-stream error frame helper (`anthropicErrorFrame` instead of `midStreamErrorFrameLines`),
- the `anthropic-version` request header echo (D-E5).

---

### Pattern S4 — Adapter widening (preserve constructor + probeLiveness)

**Source:** `router/src/backends/ollama-openai.ts` + `llamacpp-openai.ts` (Phase 3 pattern — both adapters got `probeLiveness` added without disturbing constructor or method shape).
**Apply to:** Phase 4 widening of `chatCompletionsCanonical` + stream onto both adapters.

Discipline:
- Constructor unchanged (apiKey placeholder, baseURL, timeout — ollama-openai.ts lines 14–19 / llamacpp-openai.ts lines 25–30).
- `probeLiveness` unchanged (both files' identical bodies — ollama-openai.ts lines 52–61 / llamacpp-openai.ts lines 63–72).
- `stream_options: { include_usage: true }` kept unconditional on the OpenAI-compat path (Phase 3 D-B3 — drift prevention).
- Both adapters get the SAME `chatCompletionsCanonical` signature; only the internal vision-split is Ollama-specific (D-B4 — llamacpp has no vision branch).
- `signal` MUST be forwarded to every upstream call (SDK call AND raw `fetch` to `/api/chat`).

---

### Pattern S5 — msw upstream stub for integration tests

**Source:** `router/tests/msw/handlers.ts` (full file — `ollamaNonStreamHandler`, `ollamaStreamHandler`, `llamacppNonStreamHandler`, `llamacppStreamHandler`).
**Apply to:** Phase 4 may add `ollamaNativeChatStreamHandler` (for the native `/api/chat` vision path) — same factory style:

```typescript
export function ollamaNativeChatStreamHandler(opts: {
  url?: string;        // e.g. http://upstream-mock:11434/api/chat (NO /v1)
  model?: string;
  tokens?: string[];
  promptEvalCount?: number;
  evalCount?: number;
} = {}) { /* ... */ }
```
Native `/api/chat` SSE shape is line-delimited JSON (one event per line, NOT `data: ` prefixed). Researcher verifies the exact wire shape; handler mirrors the existing `ollamaStreamHandler` (handlers.ts lines 54–106) modulo the framing.

---

### Pattern S6 — Test fixture YAML for route integration tests

**Source:** `router/tests/integration/chat-completions.nonstream.test.ts` lines 14–23 (inline YAML literal at top of test).
**Apply to:** `messages.nonstream.test.ts`, `messages.stream.test.ts`, `messages.count-tokens.test.ts`.

Add the Phase 4 vision model entry to test YAML when exercising vision capability gate:
```typescript
const YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: ${UPSTREAM_BASE}
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
  - name: llama3.2-vision:11b-instruct-q4_K_M
    backend: ollama
    backend_url: ${UPSTREAM_BASE}
    backend_model: llama3.2-vision:11b-instruct-q4_K_M
    capabilities: [chat, vision]
    vram_budget_gb: 8
`;
```
Sum 4 + 8 = 12 ≤ 16 GB envelope — passes `RegistrySchema.superRefine`.

---

### Pattern S7 — JSON.stringify discipline at the translator boundary

**Source:** No existing analog (D-D2 introduces this rule in Phase 4).
**Apply to:** `openai-in.ts`, `openai-out.ts` (tool-call arguments translation).

Rule:
- `openai-in.ts`: parse `tool_calls[i].function.arguments` (string) with `JSON.parse` → canonical `tool_use.input` (object). Catch `SyntaxError` → throw a zod-shaped error mapped to 400.
- `openai-out.ts`: `JSON.stringify(tool_use.input)` → OpenAI `tool_calls[i].function.arguments` (string).
- `anthropic-in.ts` + `anthropic-out.ts`: object on both sides — pass through, NEVER stringify.
- **Adapters NEVER stringify/parse tool args** (D-D2 explicit). This boundary lives ONLY in the translators.

Grep-verifiable in code review: `JSON.parse` / `JSON.stringify` of tool-call arguments must appear ONLY in `router/src/translation/openai-{in,out}.ts`.

---

### Pattern S8 — ULID-prefixed id generation

**Source:** No existing analog (D-E3 + D-E4 introduce this in Phase 4).
**Apply to:** Canonical `Message` builder (`msg_<ulid>`) and tool_use block builder (`toolu_<ulid>`).

```typescript
import { ulid } from 'ulid';

export function newMessageId(): string {
  return `msg_${ulid()}`;
}
export function newToolUseId(): string {
  return `toolu_${ulid()}`;
}
```
Generated ONCE per request (in the canonical Message builder, called from anthropic-in.ts response-side OR adapter-internal canonical response builder). Reused across `message_start.id` and the non-stream response body. Logged via pino at info level alongside `req.id` (D-E3 — so `request_id ↔ message_id` join queries are trivial in Phase 5's Postgres).

---

## No Analog Found

| File | Role | Data Flow | Reason | Planner Action |
|---|---|---|---|---|
| `router/tests/translation/golden/<NN-scenario>/{input-openai,input-anthropic,canonical,output-openai,output-anthropic}.json` (NEW — 7 scenarios × 5 files = 35 fixture files) | test fixture | data | First fixture-tree in the repo; existing tests use inline YAML/JSON literals at the top of `.test.ts` files (e.g., chat-completions.nonstream.test.ts lines 15–23). | Define a small helper `tests/translation/load-golden.ts` that reads `tests/translation/golden/<dir>/<file>.json` and returns the parsed object. The shape comes from CONTEXT.md `<specifics>` lines 260–280 (researcher already published the fixture-tree layout). Fixture contents (the actual JSON bodies for each scenario) need to be hand-authored against Anthropic and OpenAI API references — RESEARCH.md FINDING 1.1 + FINDING 3 are the wire-shape sources. |
| `router/src/translation/ollama-native-out.ts` — URL fetch + base64 encoding logic | translator (side-effect: HTTP fetch) | request transform + I/O | No router file currently fetches an arbitrary HTTP URL with size/timeout/scheme gates. The closest analog is the `node-fetch`-style call inside `ollama-openai.ts`'s SDK, but that hits a single known URL via the SDK. | Use Node 22 native `fetch` with `AbortSignal.timeout(10_000)` and a streaming-read loop that aborts at 10 MB. Allowed schemes `['http:', 'https:']`. Researcher's 04-RESEARCH.md Pattern 3 (lines 351–377) is the entry-point shape. Throw `ImageFetchError` (new typed error per Pattern S2) on any violation. Document the egress requirement in README.md (CONTEXT.md `<canonical_refs>` line 92 — Phase 1 D-A2's egress allowlist may need updating). |
| `router/src/translation/canonical.ts` — `count_tokens` helper using `gpt-tokenizer` | utility | pure-CPU transform | No existing module loads a tokenizer or does token-counting. | Per D-E1, load the cl100k_base encoder ONCE at module-load (not per-request): `const enc = encoding_for_model('gpt-4');` (or `gpt-tokenizer`'s equivalent). Per-image overhead `(width × height) / 750` with 1568 fallback for URL images (CONTEXT.md `<specifics>` line 258 — count_tokens NEVER fetches URLs). Researcher RESEARCH.md FINDING 2 confirms the exact formula. |
| Anthropic `ping` heartbeat payload variant | utility (SSE) | streaming | Existing `startHeartbeat` (sse/heartbeat.ts) hardcodes the `: keep-alive\n\n` comment payload (line 28). Anthropic's `/v1/messages` needs `event: ping\ndata: {"type":"ping"}\n\n` instead (D-B5). | Planner picks (a) parameterize `startHeartbeat(socket, intervalMs, payload?)`, or (b) add a sibling `startAnthropicHeartbeat`. Either way the bytes-counted + idempotent-stop + `id.unref?.()` machinery (heartbeat.ts lines 31–63) is reused. |

---

## Metadata

**Analog search scope:**
- `router/src/` (all subdirectories — backends, routes, sse, errors, config, auth, concurrency, log)
- `router/tests/` (unit + integration + msw)
- `bin/`
- Phase 2 / Phase 3 / Phase 4 CONTEXT.md
- Phase 4 RESEARCH.md (Patterns 1–3, sections 281–378)

**Files scanned:** 19 router source files + 8 router test files + 1 bin script + 4 planning docs.

**Files read in full or near-full:**
- `router/src/backends/adapter.ts` (50 lines)
- `router/src/backends/ollama-openai.ts` (69 lines)
- `router/src/backends/llamacpp-openai.ts` (80 lines)
- `router/src/backends/factory.ts` (29 lines)
- `router/src/routes/v1/chat-completions.ts` (242 lines)
- `router/src/routes/v1/models.ts` (33 lines)
- `router/src/sse/heartbeat.ts` (63 lines)
- `router/src/sse/stream.ts` (67 lines)
- `router/src/errors/envelope.ts` (115 lines)
- `router/src/auth/bearer.ts` (60 lines)
- `router/src/config/registry.ts` (203 lines)
- `router/src/app.ts` (206 lines)
- `router/models.yaml` (30 lines)
- `router/package.json` (37 lines)
- `router/vitest.config.ts` (11 lines)
- `router/tests/integration/chat-completions.nonstream.test.ts` (138 lines)
- `router/tests/integration/chat-completions.stream.test.ts` (283 lines)
- `router/tests/msw/handlers.ts` (227 lines)
- `router/tests/unit/envelope.test.ts` (121 lines)
- `bin/smoke-test-router.sh` lines 1–250 (relevant section pattern)
- `.planning/phases/04-anthropic-surface-v1-messages-tool-calling-vision/04-CONTEXT.md` (full)
- `.planning/phases/04-anthropic-surface-v1-messages-tool-calling-vision/04-RESEARCH.md` lines 281–378 (Patterns 1–3)

**Pattern extraction date:** 2026-05-13.

**Downstream contract:** Each row in §"Pattern Assignments" is self-contained — the executor reading a single row knows (a) which existing file to read first, (b) which lines are the template, (c) which lines are the new-file's specific concern. The planner can lift any row directly into a PLAN action bullet.
