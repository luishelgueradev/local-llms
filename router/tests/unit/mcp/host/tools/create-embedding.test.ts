/**
 * Phase 15 Plan 08 (v0.11.0 — MCPS-03 / MCPS-04 / 15-CONTEXT D-01..D-14) —
 * Unit-test matrix for `registerCreateEmbeddingTool`.
 *
 * Covers:
 *  - Test 1 (D-01 passthrough): inputSchema deep-equals z.toJSONSchema(EmbeddingsRequestSchema).
 *  - Test 2 (D-03 stamp + structuredContent): content[0].text matches the
 *    canonical "embedded N inputs, dims=D, model=M" format and structuredContent
 *    carries the full embeddings response (data array with vectors + usage).
 *    Vectors live in structuredContent only — NOT in content (T-15-08-PAYLOAD).
 *  - Test 3 (D-04 policy violation → isError:true): AllowlistViolationError
 *    surfaces as the structured `isError` envelope (NO thrown JSON-RPC error).
 *  - Test 4 (D-14 abort propagation): extra.signal abort → adapter sees
 *    controller.signal.aborted === true.
 *  - Test 5 (D-05/D-06): bufferedWriter row pushed with protocol='mcp' + scoped
 *    IDs closed-over from capturedReq.
 *  - Test 6 (D-07): router_mcp_tool_calls_total counter increments with the
 *    expected {tool, status_class} labels.
 *  - Test 7 (input shape passthrough): the input array reaches adapter
 *    .embeddings() intact (length + order preserved).
 *
 * Mirrors Plan 06's chat-completion test layout. FakeAdapter/FakeRegistry/
 * FakeBreaker/FakeBufferedWriter/FakeMetrics/fakeReq fixtures are inline.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import type { FastifyRequest } from 'fastify';

import { registerCreateEmbeddingTool } from '../../../../src/mcp/host/tools/create-embedding.js';
import { EmbeddingsRequestSchema } from '../../../../src/routes/v1/embeddings.js';
import { AllowlistViolationError } from '../../../../src/errors/envelope.js';
import type { ModelEntry } from '../../../../src/config/registry.js';

/**
 * Capture the (config, handler) pair given to server.registerTool so tests
 * can invoke the handler directly with synthetic args/extra.
 */
type ToolHandler = (
  args: Record<string, unknown>,
  extra: { signal: AbortSignal; sessionId?: string; requestId?: string | number | null },
) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

interface CapturedRegistration {
  name: string;
  config: { title?: string; description?: string; inputSchema?: unknown };
  handler: ToolHandler;
}

function makeFakeServer(): { server: { registerTool: ReturnType<typeof vi.fn> }; captured: CapturedRegistration[] } {
  const captured: CapturedRegistration[] = [];
  const registerTool = vi.fn(
    (name: string, config: CapturedRegistration['config'], handler: ToolHandler) => {
      captured.push({ name, config, handler });
      return { /* RegisteredTool stub */ };
    },
  );
  return { server: { registerTool }, captured };
}

// Embedding model with declared `dims` + pricing-less (local-style entry).
const EMBED_ENTRY: ModelEntry = {
  name: 'embed-local',
  backend: 'ollama',
  backend_url: 'http://ollama:11434/v1',
  backend_model: 'nomic-embed-text',
  capabilities: ['embeddings'],
  vram_budget_gb: 1,
  dims: 8,
};

function makeEmbedResponse(n: number, dims: number, model: string) {
  return {
    object: 'list' as const,
    data: Array.from({ length: n }).map((_, i) => ({
      object: 'embedding' as const,
      index: i,
      // Distinct vectors so order checks are meaningful in Test 7.
      embedding: Array.from({ length: dims }).map((_, j) => (i + 1) * 0.1 + j * 0.01),
    })),
    model,
    usage: { prompt_tokens: 5, total_tokens: 5 },
  };
}

function makeFakes(opts: {
  resolve?: (model: string) => ModelEntry;
  embeddingsImpl?: (
    input: string | string[],
    model: string,
    signal: AbortSignal,
  ) => Promise<ReturnType<typeof makeEmbedResponse>>;
} = {}) {
  const resolveFn = opts.resolve ?? ((_: string) => EMBED_ENTRY);
  const registry = {
    get: () => ({ models: [EMBED_ENTRY], policies: undefined }),
    resolve: vi.fn(resolveFn),
    getCreatedAtSec: () => 0,
    _swap: vi.fn(),
  };

  const embeddings = vi.fn(opts.embeddingsImpl ?? (async (input, model, _signal) => {
    const n = Array.isArray(input) ? input.length : 1;
    return makeEmbedResponse(n, EMBED_ENTRY.dims ?? 8, EMBED_ENTRY.backend_model);
  }));
  const adapter = {
    embeddings,
    chatCompletionsCanonical: vi.fn(async () => { throw new Error('not used in embedding tests'); }),
    chatCompletionsCanonicalStream: vi.fn(async () => { throw new Error('not used in embedding tests'); }),
    rerank: vi.fn(async () => { throw new Error('not used in embedding tests'); }),
    probeLiveness: vi.fn(async () => ({ ok: true, latencyMs: 0 })),
  };

  const breaker = {
    check: vi.fn(async (_backend: string) => ({ state: 'closed' as const })),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  };

  const bufferedWriter = {
    push: vi.fn(),
    drain: vi.fn(async () => {}),
    get size() { return 0; },
  };

  const metrics = {
    requestsTotal: { inc: vi.fn() },
    requestDurationSeconds: { observe: vi.fn() },
    ttftSeconds: { observe: vi.fn() },
    tokensTotal: { inc: vi.fn() },
    routerMcpToolCallsTotal: { inc: vi.fn() },
    routerMcpActiveSessions: { set: vi.fn() },
  };

  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  // child returns the same shape so `.child(...).info(...)` chains work.
  log.child.mockReturnValue(log as unknown as ReturnType<typeof log.child>);

  const capturedReq = {
    id: 'req-test',
    tenantId: 'acme',
    projectId: 'agents',
    agentId: 'a1',
    workloadClass: 'dev',
    log,
  } as unknown as FastifyRequest;

  const deps = {
    registry,
    makeAdapter: vi.fn(() => adapter),
    bufferedWriter,
    metrics,
    breaker,
    env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    // biome-ignore lint/suspicious/noExplicitAny: McpHostOpts is fine for these fakes
  } as any;

  return { registry, adapter, embeddings, breaker, bufferedWriter, metrics, log, capturedReq, deps };
}

function registerAndGet(deps: ReturnType<typeof makeFakes>['deps'], capturedReq: FastifyRequest): CapturedRegistration {
  const { server, captured } = makeFakeServer();
  // biome-ignore lint/suspicious/noExplicitAny: server is the McpServer surface we mock
  registerCreateEmbeddingTool(server as any, deps, capturedReq);
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe('Phase 15 Plan 08 — registerCreateEmbeddingTool', () => {
  it('Test 1 (D-01 passthrough): inputSchema deep-equals z.toJSONSchema(EmbeddingsRequestSchema)', () => {
    const { deps, capturedReq } = makeFakes();
    const reg = registerAndGet(deps, capturedReq);
    expect(reg.name).toBe('create_embedding');
    expect(reg.config.inputSchema).toEqual(z.toJSONSchema(EmbeddingsRequestSchema));
  });

  it('Test 2 (D-03 stamp + structuredContent vector payload): success returns the canonical stamp and full embeddings response', async () => {
    const { deps, capturedReq } = makeFakes({
      embeddingsImpl: async (_input, _model, _signal) => makeEmbedResponse(3, 8, 'embed-local'),
    });
    const reg = registerAndGet(deps, capturedReq);
    const result = await reg.handler(
      { model: 'embed-local', input: ['a', 'b', 'c'] },
      { signal: new AbortController().signal },
    );

    expect(result.isError).toBeFalsy();
    // D-03: text content is the one-line stamp, NOT the vector payload.
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toBe('embedded 3 inputs, dims=8, model=embed-local');
    expect(result.content[0]!.text).toMatch(/^embedded \d+ inputs, dims=\d+, model=.+$/);

    // structuredContent carries the full embeddings response with vectors.
    expect(result.structuredContent).toBeDefined();
    const sc = result.structuredContent as { object: string; data: Array<{ embedding: number[] | string }>; model: string; usage: { prompt_tokens: number; total_tokens: number } };
    expect(sc.object).toBe('list');
    expect(sc.model).toBe('embed-local');
    expect(sc.data).toHaveLength(3);
    expect(Array.isArray(sc.data[0]!.embedding)).toBe(true);
    expect((sc.data[0]!.embedding as number[]).length).toBe(8);
    expect(sc.usage.prompt_tokens).toBe(5);

    // T-15-08-PAYLOAD: the vector payload MUST NOT appear in content[].text.
    expect(result.content[0]!.text).not.toContain('embedding');
    expect(result.content[0]!.text).not.toMatch(/\[\s*\d/);
  });

  it('Test 3 (D-04 policy violation → isError:true): AllowlistViolationError surfaces as structured isError', async () => {
    const { deps, capturedReq, registry } = makeFakes();
    registry.resolve.mockImplementation((name: string) => {
      throw new AllowlistViolationError(name);
    });
    const reg = registerAndGet(deps, capturedReq);
    const result = await reg.handler(
      { model: 'forbidden-model', input: ['hello'] },
      { signal: new AbortController().signal },
    );
    expect(result.isError).toBe(true);
    const sc = result.structuredContent as { error: string; code: string; message: string };
    expect(sc.code).toBe('model_not_in_allowlist');
    expect(sc.error).toBe('policy_violation');
    // No vector data should be present on the error branch.
    expect(result.content[0]!.text).toContain('model_allowlist');
  });

  it('Test 4 (D-14 abort propagation): extra.signal abort → adapter saw signal.aborted=true', async () => {
    let observedAborted = false;
    const { deps, capturedReq, adapter } = makeFakes({
      embeddingsImpl: async (_input, _model, signal) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            observedAborted = true;
            resolve();
            return;
          }
          signal.addEventListener('abort', () => {
            observedAborted = signal.aborted;
            resolve();
          });
        });
        // After abort observed, return as if the cancelled call partially succeeded.
        return makeEmbedResponse(1, 8, 'embed-local');
      },
    });
    const reg = registerAndGet(deps, capturedReq);
    const outer = new AbortController();
    const p = reg.handler({ model: 'embed-local', input: 'hi' }, { signal: outer.signal });
    // Abort the outer signal — handler propagates to internal controller → adapter signal.
    setTimeout(() => outer.abort(), 5);
    await p;
    expect(observedAborted).toBe(true);
    expect(adapter.embeddings).toHaveBeenCalledTimes(1);
  });

  it('Test 5 (D-05/D-06): bufferedWriter pushed one row with protocol="mcp" + scoped IDs from capturedReq', async () => {
    const { deps, capturedReq, bufferedWriter } = makeFakes();
    const reg = registerAndGet(deps, capturedReq);
    await reg.handler({ model: 'embed-local', input: ['hi'] }, { signal: new AbortController().signal });
    expect(bufferedWriter.push).toHaveBeenCalledTimes(1);
    const row = bufferedWriter.push.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.protocol).toBe('mcp');
    expect(row.route).toBe('/mcp');
    expect(row.backend).toBe('ollama');
    expect(row.model).toBe('embed-local');
    expect(row.tenant_id).toBe('acme');
    expect(row.project_id).toBe('agents');
    expect(row.agent_id).toBe('a1');
    expect(row.workload_class).toBe('dev');
    expect(row.request_id).toBe('req-test');
    expect(row.status_class).toBe('success');
  });

  it('Test 6 (D-07): router_mcp_tool_calls_total counter increments with {tool:"create_embedding", status_class:"success"}', async () => {
    const { deps, capturedReq, metrics } = makeFakes();
    const reg = registerAndGet(deps, capturedReq);
    await reg.handler({ model: 'embed-local', input: ['hi'] }, { signal: new AbortController().signal });
    expect(metrics.routerMcpToolCallsTotal.inc).toHaveBeenCalledTimes(1);
    expect(metrics.routerMcpToolCallsTotal.inc).toHaveBeenCalledWith({
      tool: 'create_embedding',
      status_class: 'success',
    });
  });

  it('Test 7 (input shape passthrough): args input array reaches adapter.embeddings intact', async () => {
    const { deps, capturedReq, embeddings } = makeFakes();
    const reg = registerAndGet(deps, capturedReq);
    const inputs = ['alpha', 'bravo', 'charlie'];
    await reg.handler({ model: 'embed-local', input: inputs }, { signal: new AbortController().signal });
    expect(embeddings).toHaveBeenCalledTimes(1);
    // adapter.embeddings(input, backend_model, signal, opts?) — verify input is the
    // exact array we sent (order preserved, length preserved).
    const calledInput = embeddings.mock.calls[0]![0];
    expect(calledInput).toEqual(inputs);
    expect(embeddings.mock.calls[0]![1]).toBe(EMBED_ENTRY.backend_model);
  });
});
