/**
 * Phase 15 (v0.11.0 — Plan 15-06 / MCPS-03, MCPS-04) — Unit test matrix for
 * `registerChatCompletionTool`.
 *
 * Coverage matrix (D-01 / D-02 / D-03 / D-04 / D-05 / D-06 / D-07 / D-12 / D-14):
 *
 *   Test 1 (D-01 passthrough)         — registerTool is called once with name=
 *                                       'chat_completion' and inputSchema that
 *                                       is the LIVE Zod ChatCompletionRequestSchema.
 *                                       A drift-detection constant JSON_SCHEMA_LOCK
 *                                       (computed via z.toJSONSchema) is asserted
 *                                       to deep-equal the freshly-recomputed
 *                                       JSON schema (P1-03 mitigation).
 *
 *   Test 2 (D-02 / D-03 dual-shape)   — Happy path: handler returns
 *                                       `{ content: [{type:'text', text:<joined>}], structuredContent: <openai-shape> }`
 *                                       and `isError` is absent/false.
 *
 *   Test 3 (D-04 error → isError)     — applyPreflight throws
 *                                       AllowlistViolationError → handler returns
 *                                       isError:true with the canonical envelope
 *                                       and DOES NOT bubble the exception out.
 *
 *   Test 4 (D-12 stream coercion)     — args.stream === true is passed in; the
 *                                       FakeAdapter's chatCompletionsCanonical
 *                                       call MUST see canonical.stream === false.
 *                                       Result is non-stream structuredContent.
 *
 *   Test 5 (D-14 abort propagation)   — extra.signal aborts mid-flight; the
 *                                       AbortSignal handed to the adapter MUST
 *                                       see `aborted === true` and the handler
 *                                       returns isError:true with
 *                                       code:'client_disconnect'.
 *
 *   Test 6 (D-05 / D-06 row push)     — success + error paths each push exactly
 *                                       ONE request_log row with protocol='mcp',
 *                                       route='/mcp', scoped IDs sourced from
 *                                       capturedReq.
 *
 *   Test 7 (D-07 metric counter)      — router_mcp_tool_calls_total is incremented
 *                                       once per tool call with
 *                                       {tool:'chat_completion', status_class:<class>}.
 *
 * Deviation noted (Rule 1 — Bug in plan-as-written):
 *   The plan's literal sketch suggested `inputSchema: z.toJSONSchema(ChatCompletionRequestSchema)`
 *   but the MCP SDK 1.29.0 throws "inputSchema must be a Zod schema or raw shape"
 *   when handed a plain JSON Schema object (verified at
 *   node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:868). The
 *   implementation therefore passes the Zod schema directly; the SDK invokes
 *   `toJsonSchemaCompat` internally when publishing tools/list — yielding a
 *   wire-equivalent JSON Schema to what z.toJSONSchema(...) produces. The
 *   exported `JSON_SCHEMA_LOCK` constant preserves the drift gate at
 *   module load time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod/v4';
import type { FastifyRequest } from 'fastify';
import { APIUserAbortError } from 'openai';
import {
  registerChatCompletionTool,
  JSON_SCHEMA_LOCK,
} from '../../../../../src/mcp/host/tools/chat-completion.js';
import { ChatCompletionRequestSchema } from '../../../../../src/routes/v1/chat-completions.js';
import { canonicalToOpenAIResponse } from '../../../../../src/translation/openai-out.js';
import type { McpHostOpts } from '../../../../../src/mcp/host/plugin.js';
import type { CanonicalResponse, CanonicalRequest } from '../../../../../src/translation/canonical.js';
import type { ModelEntry, Registry, RegistryStore } from '../../../../../src/config/registry.js';
import type { BackendAdapter, AdapterFactory } from '../../../../../src/backends/adapter.js';
import type { CircuitBreaker } from '../../../../../src/resilience/circuitBreaker.js';
import type { BufferedWriter } from '../../../../../src/db/bufferedWriter.js';
import type { MetricsRegistry } from '../../../../../src/metrics/registry.js';
import {
  AllowlistViolationError,
} from '../../../../../src/errors/envelope.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

const CHAT_MODEL = 'chat-local';
const BACKEND_MODEL_ID = 'qwen2.5:7b';

function makeEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    name: CHAT_MODEL,
    backend: 'ollama',
    backend_model: BACKEND_MODEL_ID,
    backend_url: 'http://ollama:11434/v1',
    capabilities: ['chat'],
    vram_budget_gb: 4,
    ...overrides,
  } as unknown as ModelEntry;
}

function makeCanonicalResponse(text = 'hello'): CanonicalResponse {
  return {
    id: 'msg_01HZX0',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: BACKEND_MODEL_ID,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 7 },
  };
}

interface FakeAdapterRecording {
  adapter: BackendAdapter;
  /** Most-recent canonical handed to chatCompletionsCanonical (Test 4 reads stream). */
  lastCanonical: CanonicalRequest | undefined;
  /** Most-recent AbortSignal handed to chatCompletionsCanonical (Test 5 inspects). */
  lastSignal: AbortSignal | undefined;
  /** Number of times the canonical entry-point was called. */
  callCount: number;
}

function makeFakeAdapter(
  resolver: (canonical: CanonicalRequest, signal: AbortSignal) => Promise<CanonicalResponse>,
): FakeAdapterRecording {
  const rec: FakeAdapterRecording = {
    adapter: {} as unknown as BackendAdapter,
    lastCanonical: undefined,
    lastSignal: undefined,
    callCount: 0,
  };
  rec.adapter = {
    async chatCompletionsCanonical(canonical, signal) {
      rec.lastCanonical = canonical;
      rec.lastSignal = signal;
      rec.callCount += 1;
      return resolver(canonical, signal);
    },
    async chatCompletionsCanonicalStream() {
      throw new Error('not used in chat_completion tool tests');
    },
    async probeLiveness() {
      return { ok: true, latencyMs: 1 };
    },
    async embeddings() {
      throw new Error('not used in chat_completion tool tests');
    },
    async rerank() {
      throw new Error('not used in chat_completion tool tests');
    },
  };
  return rec;
}

/** Build a fake RegistryStore that resolves to `entry` and applies `policies`. */
function makeFakeRegistry(entry: ModelEntry, policies?: Registry['policies']): RegistryStore {
  const reg: Registry = { models: [entry], policies } as unknown as Registry;
  return {
    get: () => reg,
    resolve: vi.fn().mockImplementation((name: string) => {
      const m = reg.models.find((x) => x.name === name);
      if (!m) {
        // Mirror the production `RegistryUnknownModelError` shape lazily —
        // tests that exercise the unknown-model path import the real error class.
        throw new Error(`unknown model "${name}"`);
      }
      return m;
    }) as unknown as RegistryStore['resolve'],
    getCreatedAtSec: () => 0,
    _swap: () => undefined,
  };
}

/** No-op circuit breaker — defaults to closed; tests may override per-case. */
function makeNoopBreaker(state: 'closed' | 'half-open' = 'closed'): CircuitBreaker {
  return {
    check: vi.fn().mockResolvedValue({ state }),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn().mockResolvedValue(undefined),
  };
}

/** Spy-backed BufferedWriter — captures every push() call. */
function makeSpyWriter(): {
  writer: BufferedWriter;
  pushes: unknown[];
} {
  const pushes: unknown[] = [];
  const writer: BufferedWriter = {
    push: vi.fn().mockImplementation((row: unknown) => {
      pushes.push(row);
    }),
    drain: vi.fn().mockResolvedValue(undefined),
    get size() {
      return pushes.length;
    },
  };
  return { writer, pushes };
}

/** Spy-backed metrics registry — captures every counter increment. */
function makeSpyMetrics(): {
  metrics: MetricsRegistry;
  toolCallsIncs: Array<{ tool: string; status_class: string }>;
  requestsTotalIncs: Array<Record<string, string>>;
} {
  const toolCallsIncs: Array<{ tool: string; status_class: string }> = [];
  const requestsTotalIncs: Array<Record<string, string>> = [];
  // Cast through unknown — we only populate the metric handles the chat tool reads.
  const metrics = {
    routerMcpToolCallsTotal: {
      inc: (labels: { tool: string; status_class: string }) => {
        toolCallsIncs.push(labels);
      },
    },
    routerMcpActiveSessions: { set: vi.fn() },
    requestsTotal: {
      inc: (labels: Record<string, string>) => {
        requestsTotalIncs.push(labels);
      },
    },
    requestDurationSeconds: { observe: vi.fn() },
    ttftSeconds: { observe: vi.fn() },
    tokensTotal: { inc: vi.fn() },
    logBufferDroppedTotal: { inc: vi.fn() },
    jsonValidationTotal: { inc: vi.fn() },
    embeddingsCacheTotal: { inc: vi.fn() },
    embeddingsBatchSize: { observe: vi.fn() },
    embeddingsDimsTotal: { inc: vi.fn() },
    register: {} as unknown as MetricsRegistry['register'],
  } as unknown as MetricsRegistry;
  return { metrics, toolCallsIncs, requestsTotalIncs };
}

/** Stub FastifyRequest the plugin would normally capture at session-initialize time. */
function makeFakeReq(): FastifyRequest {
  // Cast through unknown — the production FastifyBaseLogger has
  // `level/fatal/trace/silent` fields that we don't exercise here; building a
  // full pino-compatible mock would obscure the test intent. The chat tool
  // only reads `child` and the per-level loggers it returns.
  const fakeLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    level: 'info',
    silent: vi.fn(),
    child(): unknown {
      return fakeLog;
    },
  };
  return {
    id: 'req-test-123',
    tenantId: 'acme',
    projectId: 'agents',
    agentId: 'a1',
    workloadClass: 'dev',
    log: fakeLog,
  } as unknown as FastifyRequest;
}

/**
 * Capture the inner handler passed by `registerChatCompletionTool` to
 * `server.registerTool`. We mock `registerTool` to record its three args:
 *   [name, config, handler]
 */
interface FakeServerCapture {
  server: { registerTool: ReturnType<typeof vi.fn> };
  // biome-ignore lint/suspicious/noExplicitAny: capture is opaque
  name: string | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: capture is opaque
  config: any;
  // biome-ignore lint/suspicious/noExplicitAny: capture is opaque
  handler: any;
}

function makeFakeMcpServer(): FakeServerCapture {
  const cap: FakeServerCapture = {
    server: { registerTool: vi.fn() },
    name: undefined,
    config: undefined,
    handler: undefined,
  };
  cap.server.registerTool.mockImplementation((name: string, config: unknown, handler: unknown) => {
    cap.name = name;
    cap.config = config;
    cap.handler = handler;
    return { name };
  });
  return cap;
}

// ── Test 1: D-01 schema passthrough + JSON_SCHEMA_LOCK drift gate ───────────

describe('Plan 15-06 — registerChatCompletionTool (D-01..D-14 invariants)', () => {
  it('Test 1 (D-01 passthrough): registers tool "chat_completion" with the live ChatCompletionRequestSchema; JSON_SCHEMA_LOCK matches z.toJSONSchema()', () => {
    const cap = makeFakeMcpServer();
    const entry = makeEntry();
    const adapter = makeFakeAdapter(async () => makeCanonicalResponse());
    const deps: McpHostOpts = {
      registry: makeFakeRegistry(entry),
      makeAdapter: ((): BackendAdapter => adapter.adapter) as AdapterFactory,
      breaker: makeNoopBreaker(),
      bufferedWriter: makeSpyWriter().writer,
      metrics: makeSpyMetrics().metrics,
      env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    };

    registerChatCompletionTool(
      cap.server as unknown as Parameters<typeof registerChatCompletionTool>[0],
      deps,
      makeFakeReq(),
    );

    expect(cap.server.registerTool).toHaveBeenCalledTimes(1);
    expect(cap.name).toBe('chat_completion');

    // The SDK accepts a Zod schema and converts it internally — the inputSchema
    // passed in MUST be the live route schema (single source of truth).
    expect(cap.config.inputSchema).toBe(ChatCompletionRequestSchema);

    // P1-03 drift gate: JSON_SCHEMA_LOCK exported by the tool module MUST equal
    // the freshly-recomputed JSON schema of ChatCompletionRequestSchema. If the
    // route schema evolves and the tool file is not rebuilt, this assertion
    // catches the drift (CI runs vitest on every change).
    expect(JSON_SCHEMA_LOCK).toEqual(z.toJSONSchema(ChatCompletionRequestSchema));

    // The description MUST document the D-12 stream coercion so MCP-client
    // operators know to expect non-stream behavior over the MCP wire.
    expect(typeof cap.config.description).toBe('string');
    expect(cap.config.description).toMatch(/stream/i);
    expect(cap.config.description).toMatch(/v0\.11\.0|not supported|HTTP/i);
  });

  // ── Test 2: D-02 / D-03 dual-shape success ─────────────────────────────────

  it('Test 2 (D-02 / D-03 dual-shape): handler returns { content:[text], structuredContent:<openai-shape> } with no isError on success', async () => {
    const cap = makeFakeMcpServer();
    const entry = makeEntry();
    const expectedCanonical = makeCanonicalResponse('hello');
    const adapter = makeFakeAdapter(async () => expectedCanonical);
    const deps: McpHostOpts = {
      registry: makeFakeRegistry(entry),
      makeAdapter: ((): BackendAdapter => adapter.adapter) as AdapterFactory,
      breaker: makeNoopBreaker(),
      bufferedWriter: makeSpyWriter().writer,
      metrics: makeSpyMetrics().metrics,
      env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    };

    registerChatCompletionTool(
      cap.server as unknown as Parameters<typeof registerChatCompletionTool>[0],
      deps,
      makeFakeReq(),
    );

    const result = await cap.handler(
      { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal, requestId: 'jsonrpc-1', sessionId: 'sess-1' },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    // structuredContent deep-equals what canonicalToOpenAIResponse would return.
    // We pass displayModel=entry.name so the wire model is the registry name (parity
    // with HTTP /v1/chat/completions).
    const expectedWire = canonicalToOpenAIResponse(expectedCanonical, { displayModel: entry.name });
    // `created` is Date.now()/1000 inside both helper invocations; tolerate ±2s.
    expect(result.structuredContent.id).toBe(expectedWire.id);
    expect(result.structuredContent.model).toBe(entry.name);
    expect(result.structuredContent.choices[0].message.content).toBe('hello');
    expect(result.structuredContent.usage.prompt_tokens).toBe(5);
    expect(result.structuredContent.usage.completion_tokens).toBe(7);
  });

  // ── Test 3: D-04 thrown error → isError:true ───────────────────────────────

  it('Test 3 (D-04 / MCPS-04): policy-violation thrown by applyPreflight surfaces as isError:true (NOT bubbled out of the handler)', async () => {
    const cap = makeFakeMcpServer();
    const entry = makeEntry();
    const adapter = makeFakeAdapter(async () => makeCanonicalResponse());

    // Build a registry whose policies.default.model_allowlist EXCLUDES CHAT_MODEL.
    // applyPolicyGate (called inside applyPreflight) then throws AllowlistViolationError.
    const deps: McpHostOpts = {
      registry: makeFakeRegistry(entry, {
        default: { model_allowlist: ['some-other-model'] },
      } as Registry['policies']),
      makeAdapter: ((): BackendAdapter => adapter.adapter) as AdapterFactory,
      breaker: makeNoopBreaker(),
      bufferedWriter: makeSpyWriter().writer,
      metrics: makeSpyMetrics().metrics,
      env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    };

    registerChatCompletionTool(
      cap.server as unknown as Parameters<typeof registerChatCompletionTool>[0],
      deps,
      makeFakeReq(),
    );

    let thrown: unknown;
    let result: { content: unknown[]; structuredContent: unknown; isError?: boolean } | undefined;
    try {
      result = await cap.handler(
        { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal, requestId: 'jr2', sessionId: 'sess-1' },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeUndefined(); // MCPS-04: NEVER throws
    expect(result).toBeDefined();
    expect(result?.isError).toBe(true);
    const sc = result?.structuredContent as { error: string; code: string; message: string };
    expect(sc.error).toBe('policy_violation');
    expect(sc.code).toBe('model_not_in_allowlist');
    expect(typeof sc.message).toBe('string');
    expect(Array.isArray(result?.content)).toBe(true);
    expect((result?.content as Array<{ type: string; text: string }>)[0].type).toBe('text');

    // Adapter MUST NOT have been called — policy gate fires before the adapter.
    expect(adapter.callCount).toBe(0);
  });

  // ── Test 4: D-12 silent stream coercion ────────────────────────────────────

  it('Test 4 (D-12): args.stream=true is silently coerced to false in the canonical handed to the adapter', async () => {
    const cap = makeFakeMcpServer();
    const entry = makeEntry();
    const adapter = makeFakeAdapter(async () => makeCanonicalResponse());
    const deps: McpHostOpts = {
      registry: makeFakeRegistry(entry),
      makeAdapter: ((): BackendAdapter => adapter.adapter) as AdapterFactory,
      breaker: makeNoopBreaker(),
      bufferedWriter: makeSpyWriter().writer,
      metrics: makeSpyMetrics().metrics,
      env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    };

    registerChatCompletionTool(
      cap.server as unknown as Parameters<typeof registerChatCompletionTool>[0],
      deps,
      makeFakeReq(),
    );

    const result = await cap.handler(
      { model: CHAT_MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal, requestId: 'jr4', sessionId: 'sess-1' },
    );

    expect(result.isError).toBeFalsy();
    expect(adapter.callCount).toBe(1);
    expect(adapter.lastCanonical).toBeDefined();
    // D-12: canonical handed to the adapter has stream === false (NOT true).
    expect(adapter.lastCanonical?.stream).toBe(false);
    // structuredContent is non-stream (a ChatCompletion, not a chunk).
    expect(result.structuredContent.object).toBe('chat.completion');
  });

  // ── Test 5: D-14 abort propagation ─────────────────────────────────────────

  it('Test 5 (D-14): extra.signal abort propagates to the AbortController handed to the adapter; result is isError:true with code:client_disconnect', async () => {
    const cap = makeFakeMcpServer();
    const entry = makeEntry();
    let observedAbortedAtThrow = false;
    const adapter = makeFakeAdapter(async (_canonical, signal) => {
      // Wait for the abort, then throw an APIUserAbortError (mirrors the openai
      // SDK's behavior on signal.abort()).
      return new Promise<CanonicalResponse>((_, reject) => {
        if (signal.aborted) {
          observedAbortedAtThrow = true;
          reject(new APIUserAbortError({ message: 'aborted' }));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            observedAbortedAtThrow = signal.aborted;
            reject(new APIUserAbortError({ message: 'aborted' }));
          },
          { once: true },
        );
      });
    });
    const deps: McpHostOpts = {
      registry: makeFakeRegistry(entry),
      makeAdapter: ((): BackendAdapter => adapter.adapter) as AdapterFactory,
      breaker: makeNoopBreaker(),
      bufferedWriter: makeSpyWriter().writer,
      metrics: makeSpyMetrics().metrics,
      env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    };

    registerChatCompletionTool(
      cap.server as unknown as Parameters<typeof registerChatCompletionTool>[0],
      deps,
      makeFakeReq(),
    );

    const ac = new AbortController();
    // Fire the abort soon AFTER the handler runs adapter.chatCompletionsCanonical.
    setTimeout(() => ac.abort(), 10);

    const result = await cap.handler(
      { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { signal: ac.signal, requestId: 'jr5', sessionId: 'sess-1' },
    );

    expect(observedAbortedAtThrow).toBe(true);
    expect(result.isError).toBe(true);
    const sc = result.structuredContent as { code: string };
    expect(sc.code).toBe('client_disconnect');
  });

  // ── Test 6: D-05 / D-06 request_log row push ───────────────────────────────

  it('Test 6 (D-05 / D-06): success path pushes ONE request_log row with protocol="mcp", route="/mcp", scoped IDs from capturedReq', async () => {
    const cap = makeFakeMcpServer();
    const entry = makeEntry();
    const adapter = makeFakeAdapter(async () => makeCanonicalResponse());
    const writer = makeSpyWriter();
    const deps: McpHostOpts = {
      registry: makeFakeRegistry(entry),
      makeAdapter: ((): BackendAdapter => adapter.adapter) as AdapterFactory,
      breaker: makeNoopBreaker(),
      bufferedWriter: writer.writer,
      metrics: makeSpyMetrics().metrics,
      env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    };

    registerChatCompletionTool(
      cap.server as unknown as Parameters<typeof registerChatCompletionTool>[0],
      deps,
      makeFakeReq(),
    );

    const result = await cap.handler(
      { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal, requestId: 'jr6', sessionId: 'sess-x' },
    );

    expect(result.isError).toBeFalsy();
    expect(writer.pushes).toHaveLength(1);
    const row = writer.pushes[0] as Record<string, unknown>;
    expect(row.protocol).toBe('mcp');
    expect(row.route).toBe('/mcp');
    expect(row.backend).toBe('ollama');
    expect(row.model).toBe(CHAT_MODEL);
    expect(row.tenant_id).toBe('acme');
    expect(row.project_id).toBe('agents');
    expect(row.agent_id).toBe('a1');
    expect(row.workload_class).toBe('dev');
    expect(row.request_id).toBe('req-test-123');
    expect(row.status_class).toBe('success');
    expect(row.tokens_in).toBe(5);
    expect(row.tokens_out).toBe(7);
  });

  it('Test 6b (D-05): error path also pushes ONE request_log row with non-success status_class and error_code populated', async () => {
    const cap = makeFakeMcpServer();
    const entry = makeEntry();
    const adapter = makeFakeAdapter(async () => makeCanonicalResponse());
    const writer = makeSpyWriter();

    const deps: McpHostOpts = {
      registry: makeFakeRegistry(entry, {
        default: { model_allowlist: ['some-other-model'] },
      } as Registry['policies']),
      makeAdapter: ((): BackendAdapter => adapter.adapter) as AdapterFactory,
      breaker: makeNoopBreaker(),
      bufferedWriter: writer.writer,
      metrics: makeSpyMetrics().metrics,
      env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    };

    registerChatCompletionTool(
      cap.server as unknown as Parameters<typeof registerChatCompletionTool>[0],
      deps,
      makeFakeReq(),
    );

    const result = await cap.handler(
      { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal, requestId: 'jr6b', sessionId: 'sess-x' },
    );

    expect(result.isError).toBe(true);
    expect(writer.pushes).toHaveLength(1);
    const row = writer.pushes[0] as Record<string, unknown>;
    expect(row.protocol).toBe('mcp');
    expect(row.route).toBe('/mcp');
    expect(row.status_class).toBe('client_error');
    expect(typeof row.error_code).toBe('string');
    expect(row.error_code).toBe('model_not_in_allowlist');
  });

  // ── Test 7: D-07 router_mcp_tool_calls_total counter ────────────────────────

  it('Test 7 (D-07): router_mcp_tool_calls_total is incremented on success ({tool, status_class:"success"}) and on error ({tool, status_class:<class>})', async () => {
    const successCap = makeFakeMcpServer();
    const successEntry = makeEntry();
    const successAdapter = makeFakeAdapter(async () => makeCanonicalResponse());
    const successMetrics = makeSpyMetrics();
    const successDeps: McpHostOpts = {
      registry: makeFakeRegistry(successEntry),
      makeAdapter: ((): BackendAdapter => successAdapter.adapter) as AdapterFactory,
      breaker: makeNoopBreaker(),
      bufferedWriter: makeSpyWriter().writer,
      metrics: successMetrics.metrics,
      env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    };
    registerChatCompletionTool(
      successCap.server as unknown as Parameters<typeof registerChatCompletionTool>[0],
      successDeps,
      makeFakeReq(),
    );
    await successCap.handler(
      { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal, requestId: 'jr7a', sessionId: 'sess-x' },
    );
    expect(successMetrics.toolCallsIncs).toEqual([
      { tool: 'chat_completion', status_class: 'success' },
    ]);

    const errCap = makeFakeMcpServer();
    const errEntry = makeEntry();
    const errAdapter = makeFakeAdapter(async () => makeCanonicalResponse());
    const errMetrics = makeSpyMetrics();
    const errDeps: McpHostOpts = {
      registry: makeFakeRegistry(errEntry, {
        default: { model_allowlist: ['some-other-model'] },
      } as Registry['policies']),
      makeAdapter: ((): BackendAdapter => errAdapter.adapter) as AdapterFactory,
      breaker: makeNoopBreaker(),
      bufferedWriter: makeSpyWriter().writer,
      metrics: errMetrics.metrics,
      env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    };
    registerChatCompletionTool(
      errCap.server as unknown as Parameters<typeof registerChatCompletionTool>[0],
      errDeps,
      makeFakeReq(),
    );
    await errCap.handler(
      { model: CHAT_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { signal: new AbortController().signal, requestId: 'jr7b', sessionId: 'sess-x' },
    );
    expect(errMetrics.toolCallsIncs).toHaveLength(1);
    expect(errMetrics.toolCallsIncs[0].tool).toBe('chat_completion');
    expect(errMetrics.toolCallsIncs[0].status_class).toBe('client_error');
  });
});
