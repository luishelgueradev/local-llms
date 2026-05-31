/**
 * Phase 15 Plan 09 (v0.11.0 — MCPS-03 / MCPS-04 / 15-CONTEXT D-01..D-14) —
 * Unit-test matrix for `registerRerankTool`.
 *
 * Covers:
 *  - Test 1 (D-01 passthrough): inputSchema deep-equals
 *    z.toJSONSchema(RerankRequestSchema).
 *  - Test 2 (D-03 stamp + structuredContent): content[0].text matches the
 *    canonical "reranked N docs vs query, model=M" format and
 *    structuredContent carries the full rerank response (results array with
 *    {index, relevance_score} + usage). The per-doc scores ride in
 *    structuredContent only — NOT in content.
 *  - Test 3 (D-04 policy violation → isError:true): AllowlistViolationError
 *    surfaces as the structured `isError` envelope (NO thrown JSON-RPC error).
 *  - Test 4 (D-14 abort propagation): extra.signal abort → adapter sees
 *    controller.signal.aborted === true.
 *  - Test 5 (D-05/D-06): bufferedWriter row pushed with protocol='mcp' +
 *    scoped IDs closed-over from capturedReq.
 *  - Test 6 (D-07): router_mcp_tool_calls_total counter increments with the
 *    expected {tool:'rerank', status_class:'success'} labels.
 *  - Test 7 (input shape passthrough): args.documents reaches adapter.rerank
 *    intact (length + order preserved); args.query reaches adapter as
 *    positional arg 0.
 *
 * Mirrors Plan 08's create-embedding test layout. Fakes are inline.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import type { FastifyRequest } from 'fastify';

import { registerRerankTool } from '../../../../../src/mcp/host/tools/rerank.js';
import { RerankRequestSchema } from '../../../../../src/routes/v1/rerank.js';
import { AllowlistViolationError } from '../../../../../src/errors/envelope.js';
import type { ModelEntry } from '../../../../../src/config/registry.js';

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

// Rerank model entry (local-style — no pricing).
const RERANK_ENTRY: ModelEntry = {
  name: 'rerank-local',
  backend: 'ollama',
  backend_url: 'http://ollama:11434/v1',
  backend_model: 'bge-reranker-v2-m3',
  capabilities: ['rerank'],
  vram_budget_gb: 1,
};

function makeRerankResponse(n: number, model: string) {
  return {
    model,
    // Descending score per index for stable assertions.
    results: Array.from({ length: n }).map((_, i) => ({
      index: i,
      relevance_score: 0.9 - i * 0.1,
    })),
    usage: { total_tokens: 50 },
  };
}

function makeFakes(opts: {
  resolve?: (model: string) => ModelEntry;
  rerankImpl?: (
    query: string,
    documents: string[],
    model: string,
    signal: AbortSignal,
  ) => Promise<ReturnType<typeof makeRerankResponse>>;
} = {}) {
  const resolveFn = opts.resolve ?? ((_: string) => RERANK_ENTRY);
  const registry = {
    get: () => ({ models: [RERANK_ENTRY], policies: undefined }),
    resolve: vi.fn(resolveFn),
    getCreatedAtSec: () => 0,
    _swap: vi.fn(),
  };

  const rerank = vi.fn(opts.rerankImpl ?? (async (_query, documents, _model, _signal) => {
    return makeRerankResponse(documents.length, RERANK_ENTRY.backend_model);
  }));
  const adapter = {
    rerank,
    chatCompletionsCanonical: vi.fn(async () => { throw new Error('not used in rerank tests'); }),
    chatCompletionsCanonicalStream: vi.fn(async () => { throw new Error('not used in rerank tests'); }),
    embeddings: vi.fn(async () => { throw new Error('not used in rerank tests'); }),
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

  return { registry, adapter, rerank, breaker, bufferedWriter, metrics, log, capturedReq, deps };
}

function registerAndGet(
  deps: ReturnType<typeof makeFakes>['deps'],
  capturedReq: FastifyRequest,
): CapturedRegistration {
  const { server, captured } = makeFakeServer();
  // biome-ignore lint/suspicious/noExplicitAny: server is the McpServer surface we mock
  registerRerankTool(server as any, deps, capturedReq);
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe('Phase 15 Plan 09 — registerRerankTool', () => {
  it('Test 1 (D-01 passthrough): inputSchema deep-equals z.toJSONSchema(RerankRequestSchema)', () => {
    const { deps, capturedReq } = makeFakes();
    const reg = registerAndGet(deps, capturedReq);
    expect(reg.name).toBe('rerank');
    expect(reg.config.inputSchema).toEqual(z.toJSONSchema(RerankRequestSchema));
  });

  it('Test 2 (D-03 stamp + structuredContent payload): success returns the canonical stamp and full rerank response', async () => {
    const { deps, capturedReq } = makeFakes({
      rerankImpl: async (_q, _docs, _model, _signal) => ({
        model: 'rerank-local',
        results: [
          { index: 0, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.1 },
        ],
        usage: { total_tokens: 50 },
      }),
    });
    const reg = registerAndGet(deps, capturedReq);
    const result = await reg.handler(
      { model: 'rerank-local', query: 'what is mcp?', documents: ['a', 'b'] },
      { signal: new AbortController().signal },
    );

    expect(result.isError).toBeFalsy();
    // D-03: text content is the one-line stamp, NOT the per-doc score payload.
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
    expect(result.content[0]!.text).toBe('reranked 2 docs vs query, model=rerank-local');
    expect(result.content[0]!.text).toMatch(/^reranked \d+ docs vs query, model=.+$/);

    // structuredContent carries the full rerank response with per-doc scores.
    expect(result.structuredContent).toBeDefined();
    const sc = result.structuredContent as {
      model: string;
      results: Array<{ index: number; relevance_score: number }>;
      usage: { total_tokens: number };
    };
    expect(sc.model).toBe('rerank-local');
    expect(sc.results).toHaveLength(2);
    expect(sc.results[0]!.index).toBe(0);
    expect(sc.results[0]!.relevance_score).toBe(0.9);
    expect(sc.results[1]!.index).toBe(1);
    expect(sc.results[1]!.relevance_score).toBe(0.1);
    expect(sc.usage.total_tokens).toBe(50);

    // T-15-09-PAYLOAD: the score payload MUST NOT appear in content[].text.
    expect(result.content[0]!.text).not.toContain('relevance_score');
    expect(result.content[0]!.text).not.toMatch(/0\.9/);
  });

  it('Test 3 (D-04 policy violation → isError:true): AllowlistViolationError surfaces as structured isError', async () => {
    const { deps, capturedReq, registry } = makeFakes();
    registry.resolve.mockImplementation((name: string) => {
      throw new AllowlistViolationError(name);
    });
    const reg = registerAndGet(deps, capturedReq);
    const result = await reg.handler(
      { model: 'forbidden-model', query: 'q', documents: ['a'] },
      { signal: new AbortController().signal },
    );
    expect(result.isError).toBe(true);
    const sc = result.structuredContent as { error: string; code: string; message: string };
    expect(sc.code).toBe('model_not_in_allowlist');
    expect(sc.error).toBe('policy_violation');
    // The error message surfaces the policy violation reason.
    expect(result.content[0]!.text).toContain('model_allowlist');
  });

  it('Test 4 (D-14 abort propagation): extra.signal abort → adapter saw signal.aborted=true', async () => {
    let observedAborted = false;
    const { deps, capturedReq, adapter } = makeFakes({
      rerankImpl: async (_q, _docs, _model, signal) => {
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
        return {
          model: 'rerank-local',
          results: [{ index: 0, relevance_score: 0.5 }],
          usage: { total_tokens: 1 },
        };
      },
    });
    const reg = registerAndGet(deps, capturedReq);
    const outer = new AbortController();
    const p = reg.handler(
      { model: 'rerank-local', query: 'q', documents: ['a'] },
      { signal: outer.signal },
    );
    // Abort the outer signal — handler propagates to internal controller → adapter signal.
    setTimeout(() => outer.abort(), 5);
    await p;
    expect(observedAborted).toBe(true);
    expect(adapter.rerank).toHaveBeenCalledTimes(1);
  });

  it('Test 5 (D-05/D-06): bufferedWriter pushed one row with protocol="mcp" + scoped IDs from capturedReq', async () => {
    const { deps, capturedReq, bufferedWriter } = makeFakes();
    const reg = registerAndGet(deps, capturedReq);
    await reg.handler(
      { model: 'rerank-local', query: 'q', documents: ['a', 'b'] },
      { signal: new AbortController().signal },
    );
    expect(bufferedWriter.push).toHaveBeenCalledTimes(1);
    const row = bufferedWriter.push.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.protocol).toBe('mcp');
    expect(row.route).toBe('/mcp');
    expect(row.backend).toBe('ollama');
    expect(row.model).toBe('rerank-local');
    expect(row.tenant_id).toBe('acme');
    expect(row.project_id).toBe('agents');
    expect(row.agent_id).toBe('a1');
    expect(row.workload_class).toBe('dev');
    expect(row.request_id).toBe('req-test');
    expect(row.status_class).toBe('success');
  });

  it('Test 6 (D-07): router_mcp_tool_calls_total counter increments with {tool:"rerank", status_class:"success"}', async () => {
    const { deps, capturedReq, metrics } = makeFakes();
    const reg = registerAndGet(deps, capturedReq);
    await reg.handler(
      { model: 'rerank-local', query: 'q', documents: ['a'] },
      { signal: new AbortController().signal },
    );
    expect(metrics.routerMcpToolCallsTotal.inc).toHaveBeenCalledTimes(1);
    expect(metrics.routerMcpToolCallsTotal.inc).toHaveBeenCalledWith({
      tool: 'rerank',
      status_class: 'success',
    });
  });

  it('Test 7 (input shape passthrough): args.query + args.documents reach adapter.rerank intact (positional args 0, 1)', async () => {
    const { deps, capturedReq, rerank } = makeFakes();
    const reg = registerAndGet(deps, capturedReq);
    const query = 'find the relevant docs';
    const documents = ['alpha', 'bravo', 'charlie'];
    await reg.handler(
      { model: 'rerank-local', query, documents },
      { signal: new AbortController().signal },
    );
    expect(rerank).toHaveBeenCalledTimes(1);
    // adapter.rerank(query, documents, backend_model, signal, opts?) — verify
    // query (arg 0), documents (arg 1), backend_model (arg 2) order + values.
    const callArgs = rerank.mock.calls[0]!;
    expect(callArgs[0]).toBe(query);
    expect(callArgs[1]).toEqual(documents);
    expect(callArgs[2]).toBe(RERANK_ENTRY.backend_model);
  });
});
