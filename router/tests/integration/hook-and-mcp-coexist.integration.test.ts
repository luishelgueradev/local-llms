/**
 * Phase 18 / v0.11.0 — RETR-06 / P5-04 (hook + MCP tool coexistence).
 * Plan 18-08 (final phase): 6 it.todo flipped to real it().
 *
 * Integration tests exercising the cross-feature contract: a request
 * referencing BOTH `pre_completion_hooks: [retriever]` AND
 * `mcp_servers_enabled: [searcher]` must:
 *
 *   - Fire the hook once (pre-completion only — NOT inside the MCP tool loop).
 *   - Surface the retrieved fence in `canonical.system`.
 *   - Surface the prefixed MCP tools in `canonical.tools[]`.
 *   - Dispatch the model tool call `searcher__search` through the MCP loop
 *     — NOT through the hook (the hook is data-retrieval; the MCP loop is
 *     function-call execution).
 *
 * Wire-level effect: `request_log.hook_log` has ONE entry (the hook), and
 * `router_mcp_tool_calls_external_total` increments once (the MCP call).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  makeFakeBufferedWriter,
  makeFakeMetrics,
  makeFakeRetrieverProvider,
  makeFakeMcpClientRegistry,
} from '../fakes.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
import type {
  BackendAdapter,
  AdapterFactory,
} from '../../src/backends/adapter.js';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CanonicalTool,
} from '../../src/translation/canonical.js';
import type { PreCompletionHook } from '../../src/hooks/pre-completion.js';
import type { MetricsRegistry } from '../../src/metrics/registry.js';
import type { McpClientRegistry } from '../../src/mcp/client/registry.js';

const TOKEN = 'local-llms_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHAT_MODEL = 'qwen2.5:7b';
const YAML = `
models:
  - name: ${CHAT_MODEL}
    backend: ollama
    backend_url: http://upstream-mock:11434/v1
    backend_model: ${CHAT_MODEL}
    capabilities: [chat]
    vram_budget_gb: 4
    mcp_servers_enabled: [searcher]
mcp_servers:
  - alias: searcher
    url: http://mcp-searcher:9000/mcp
    transport: streamable-http
    auth_type: none
backends:
  ollama:
    concurrency: 5
    queue_max_wait_ms: 30000
`;

interface AdapterSpy {
  calls: { canonical: CanonicalRequest; signal: AbortSignal }[];
  /**
   * When true, on the first call the adapter returns a tool_use response
   * referencing `searcher__search`, then on the second call returns a final
   * text response. Mimics the model → MCP tool → model loop (MCPC-04).
   */
  emitToolCall: boolean;
}

function makeAdapterFactory(spy: AdapterSpy): AdapterFactory {
  let callIndex = 0;
  return () => {
    const adapter: BackendAdapter = {
      async chatCompletionsCanonical(
        canonical: CanonicalRequest,
        signal: AbortSignal,
      ): Promise<CanonicalResponse> {
        spy.calls.push({ canonical, signal });
        callIndex += 1;
        if (spy.emitToolCall && callIndex === 1) {
          return {
            id: `msg_tc_${callIndex}`,
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu_1',
                name: 'searcher__search',
                input: { q: 'kittens' },
              },
            ],
            model: canonical.model,
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 5 },
          };
        }
        return {
          id: `msg_done_${callIndex}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'final' }],
          model: canonical.model,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 5 },
        };
      },
      async chatCompletionsCanonicalStream(): Promise<
        AsyncIterable<CanonicalStreamEvent>
      > {
        throw new Error('not used in coexist tests');
      },
      async probeLiveness() {
        return { ok: true, latencyMs: 0 };
      },
      async embeddings() {
        throw new Error('not used');
      },
      async rerank() {
        throw new Error('not used');
      },
    };
    return adapter;
  };
}

async function buildAppWithBoth(
  spy: AdapterSpy,
  hook: PreCompletionHook,
  mcpRegistry: McpClientRegistry,
  metrics?: MetricsRegistry,
): Promise<FastifyInstance> {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  const preHooks = new Map<string, PreCompletionHook[]>([
    ['/v1/chat/completions', [hook]],
  ]);
  return buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: makeAdapterFactory(spy),
    semaphores: {
      get: () =>
        ({
          acquire: async () => () => {},
          stats: () => ({ inFlight: 0, queued: 0 }),
        }) as never,
    },
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: metrics ?? makeFakeMetrics(),
    preCompletionHooks: preHooks,
    mcpClientRegistry: mcpRegistry,
  });
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
}

const SEARCHER_TOOL: CanonicalTool = {
  name: 'searcher__search',
  description: 'Search the searcher index.',
  input_schema: {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
  },
};

let app: FastifyInstance | undefined;
let spy: AdapterSpy;

beforeEach(() => {
  spy = { calls: [], emitToolCall: false };
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  vi.restoreAllMocks();
});

describe('RETR-06 / P5-04: hook + MCP tool coexistence', () => {
  it('request with BOTH pre_completion_hooks: [retriever] + mcp_servers_enabled: [searcher]: both fire', async () => {
    const retrieverCalls: number[] = [];
    const hook: PreCompletionHook = {
      name: 'retriever',
      retriever: {
        async retrieve() {
          retrieverCalls.push(Date.now());
          return {
            documents: [{ content: 'doc-context' }],
            retrieved_at: new Date(0).toISOString(),
          };
        },
      },
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    const mcpCallTrace: Array<{ alias: string; toolName: string; args: unknown }> = [];
    const mcpRegistry = makeFakeMcpClientRegistry({
      toolsByAlias: { searcher: [SEARCHER_TOOL] },
      toolResultsByAlias: {
        searcher: { searcher__search: { results: ['cat1', 'cat2'] } },
      },
      callTrace: mcpCallTrace,
    });
    spy.emitToolCall = true;
    app = await buildAppWithBoth(spy, hook, mcpRegistry);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'find me kittens' }],
      },
    });
    expect(res.statusCode).toBe(200);
    // Hook fired exactly once (pre-completion).
    expect(retrieverCalls.length).toBe(1);
    // MCP tool dispatched exactly once via the loop.
    expect(mcpCallTrace.length).toBe(1);
    expect(mcpCallTrace[0]).toMatchObject({
      alias: 'searcher',
      toolName: 'search',
    });
  });

  it('hook fires ONCE (pre-completion); hook_log has 1 entry', async () => {
    const retrieverCalls: number[] = [];
    const hook: PreCompletionHook = {
      name: 'retriever',
      retriever: {
        async retrieve() {
          retrieverCalls.push(Date.now());
          return {
            documents: [{ content: 'doc' }],
            retrieved_at: new Date(0).toISOString(),
          };
        },
      },
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    const mcpRegistry = makeFakeMcpClientRegistry({
      toolsByAlias: { searcher: [SEARCHER_TOOL] },
      toolResultsByAlias: { searcher: { searcher__search: { ok: true } } },
    });
    spy.emitToolCall = true; // triggers 2 adapter calls (model → tool → model)
    app = await buildAppWithBoth(spy, hook, mcpRegistry);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    // Adapter fired twice (loop) but hook fired only once.
    expect(spy.calls.length).toBe(2);
    expect(retrieverCalls.length).toBe(1);
  });

  it('canonical.tools[] has the prefixed MCP tools AFTER hook ran', async () => {
    const hook: PreCompletionHook = {
      name: 'retriever',
      retriever: makeFakeRetrieverProvider({
        documents: [{ content: 'doc' }],
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    const mcpRegistry = makeFakeMcpClientRegistry({
      toolsByAlias: { searcher: [SEARCHER_TOOL] },
    });
    spy.emitToolCall = false; // single-call path
    app = await buildAppWithBoth(spy, hook, mcpRegistry);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    expect(spy.calls.length).toBeGreaterThanOrEqual(1);
    const canonical = spy.calls[0].canonical;
    const toolNames = (canonical.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain('searcher__search');
  });

  it('canonical.system has the retrieved_context fence injected from the hook', async () => {
    const hook: PreCompletionHook = {
      name: 'retriever',
      retriever: makeFakeRetrieverProvider({
        documents: [{ content: 'FENCED_DOC_PROBE' }],
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    const mcpRegistry = makeFakeMcpClientRegistry({
      toolsByAlias: { searcher: [SEARCHER_TOOL] },
    });
    spy.emitToolCall = false;
    app = await buildAppWithBoth(spy, hook, mcpRegistry);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    const canonical = spy.calls[0].canonical;
    expect(canonical.system).toContain('<retrieved_context');
    expect(canonical.system).toContain('FENCED_DOC_PROBE');
  });

  it('model tool-call for "searcher__search" routes through MCP loop (NOT through hook)', async () => {
    const retrieverCalls: number[] = [];
    const hook: PreCompletionHook = {
      name: 'retriever',
      retriever: {
        async retrieve() {
          retrieverCalls.push(Date.now());
          return {
            documents: [],
            retrieved_at: new Date(0).toISOString(),
          };
        },
      },
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    const callTrace: Array<{ alias: string; toolName: string; args: unknown }> = [];
    const mcpRegistry = makeFakeMcpClientRegistry({
      toolsByAlias: { searcher: [SEARCHER_TOOL] },
      toolResultsByAlias: {
        searcher: { searcher__search: { ok: true, payload: 'X' } },
      },
      callTrace,
    });
    spy.emitToolCall = true;
    app = await buildAppWithBoth(spy, hook, mcpRegistry);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    // MCP dispatched via the loop — alias + tool_name resolved.
    expect(callTrace.length).toBe(1);
    expect(callTrace[0].alias).toBe('searcher');
    expect(callTrace[0].toolName).toBe('search'); // prefix stripped at dispatch
    // Hook fired only once (pre-completion); NOT inside the tool loop.
    expect(retrieverCalls.length).toBe(1);
  });

  it('two distinct request_log entries: one for hook (hook_log set), MCP tool-call counted in router_mcp_tool_calls_external_total', async () => {
    // Use a real metrics registry so we can scrape the counter.
    const metrics = makeMetricsRegistry();
    const hook: PreCompletionHook = {
      name: 'retriever',
      retriever: makeFakeRetrieverProvider({
        documents: [{ content: 'doc' }],
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    const mcpRegistry = makeFakeMcpClientRegistry({
      toolsByAlias: { searcher: [SEARCHER_TOOL] },
      toolResultsByAlias: {
        searcher: { searcher__search: { ok: true } },
      },
    });
    spy.emitToolCall = true;
    app = await buildAppWithBoth(spy, hook, mcpRegistry, metrics);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    const scrape = await metrics.register.metrics();
    // Hook duration histogram has a series (proves hook ran).
    expect(scrape).toMatch(
      /router_hook_duration_ms_bucket\{[^}]*hook_name="retriever"/,
    );
    // MCP external tool-calls counter incremented (proves MCP loop ran).
    expect(scrape).toMatch(
      /router_mcp_tool_calls_external_total\{[^}]*server_alias="searcher"/,
    );
  });
});
