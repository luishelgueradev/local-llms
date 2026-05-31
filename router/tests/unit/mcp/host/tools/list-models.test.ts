/**
 * Phase 15 Plan 10 (v0.11.0 — MCPS-03 / MCPS-04 / 15-CONTEXT D-10) —
 * Unit-test matrix for `registerListModelsTool`.
 *
 * The list_models MCP tool is a read-only registry projection that:
 *   1. Filters by `policies.default.model_allowlist` when non-empty (D-10).
 *   2. Projects each entry to a sanitized public shape (NO backend / backend_url
 *      / backend_model — T-3-A2 anti-leak from Phase 3 preserved).
 *   3. Annotates each entry with `policy: { cloud_allowed }` (default true) so
 *      consumers know operational constraints up front (avoids "discover then
 *      fail").
 *   4. Returns the D-03 stamp `"N models available"` + the full projection in
 *      structuredContent.
 *
 * Unlike the other 4 MCP tools, this one:
 *   - Has an EMPTY inputSchema (no input params in v0.11.0 — pagination /
 *     filter args are MCPS-FUT-02, deferred).
 *   - Does NOT push a request_log row (read-only registry projection; no
 *     backend touched). The mcp tool-call counter still increments for
 *     observability (D-07).
 *
 * Covers:
 *   - Test 1 (D-01): empty inputSchema
 *   - Test 2 (allow-all default): allowlist empty/unset → all models appear
 *   - Test 3 (D-10 filter): allowlist non-empty → only allowlisted models
 *   - Test 4 (T-3-A2 anti-leak): each data entry has EXACTLY {id, object,
 *     created, owned_by, capabilities, policy} — no backend leakage.
 *   - Test 5 (policy.cloud_allowed annotation): cloud_allowed:false carries
 *     through; missing policy defaults to true.
 *   - Test 6 (D-07): metrics counter increments once per call.
 *   - Test 7 (no bufferedWriter row): read-only path does NOT push to
 *     request_log.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

import { registerListModelsTool } from '../../../../../src/mcp/host/tools/list-models.js';
import type { ModelEntry, Registry } from '../../../../../src/config/registry.js';

/**
 * Capture the (config, handler) pair given to server.registerTool so tests
 * can invoke the handler directly with synthetic args/extra. Mirrors the
 * pattern used in rerank.test.ts / create-embedding.test.ts.
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

function makeFakeServer(): {
  server: { registerTool: ReturnType<typeof vi.fn> };
  captured: CapturedRegistration[];
} {
  const captured: CapturedRegistration[] = [];
  const registerTool = vi.fn(
    (name: string, config: CapturedRegistration['config'], handler: ToolHandler) => {
      captured.push({ name, config, handler });
      return { /* RegisteredTool stub */ };
    },
  );
  return { server: { registerTool }, captured };
}

const CHAT_LOCAL: ModelEntry = {
  name: 'chat-local',
  backend: 'ollama',
  backend_url: 'http://ollama:11434/v1',
  backend_model: 'llama3.1:8b',
  capabilities: ['chat'],
  vram_budget_gb: 5,
  // policy omitted on purpose — Test 5 asserts default cloud_allowed: true
};

const EMBED_LOCAL: ModelEntry = {
  name: 'embed-local',
  backend: 'ollama',
  backend_url: 'http://ollama:11434/v1',
  backend_model: 'nomic-embed-text',
  capabilities: ['embeddings'],
  vram_budget_gb: 1,
  dims: 768,
};

const CLOUD_DENIED: ModelEntry = {
  name: 'gpt-oss:120b-cloud',
  backend: 'ollama-cloud',
  backend_url: 'https://ollama.com/v1',
  backend_model: 'gpt-oss:120b-cloud',
  capabilities: ['chat'],
  vram_budget_gb: 0,
  policy: { cloud_allowed: false },
};

function makeFakes(opts: {
  models?: ModelEntry[];
  allowlist?: string[];
} = {}) {
  const models = opts.models ?? [CHAT_LOCAL, EMBED_LOCAL];
  const policies: Registry['policies'] =
    opts.allowlist !== undefined
      ? { default: { model_allowlist: opts.allowlist } }
      : undefined;

  const registry = {
    get: vi.fn(() => ({ models, policies } as Registry)),
    resolve: vi.fn(),
    getCreatedAtSec: vi.fn(() => 1717000000),
    _swap: vi.fn(),
  };

  const bufferedWriter = {
    push: vi.fn(),
    drain: vi.fn(async () => {}),
    get size() {
      return 0;
    },
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
    makeAdapter: vi.fn(),
    bufferedWriter,
    metrics,
    breaker: { check: vi.fn(), recordSuccess: vi.fn(), recordFailure: vi.fn() },
    env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
    // biome-ignore lint/suspicious/noExplicitAny: McpHostOpts surface for fakes
  } as any;

  return { registry, bufferedWriter, metrics, log, capturedReq, deps };
}

function registerAndGet(
  deps: ReturnType<typeof makeFakes>['deps'],
  capturedReq: FastifyRequest,
): CapturedRegistration {
  const { server, captured } = makeFakeServer();
  // biome-ignore lint/suspicious/noExplicitAny: server is the McpServer surface we mock
  registerListModelsTool(server as any, deps, capturedReq);
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe('Phase 15 Plan 10 — registerListModelsTool', () => {
  it('Test 1 (D-01 empty inputSchema): list_models has no input params in v0.11.0', () => {
    const { deps, capturedReq } = makeFakes();
    const reg = registerAndGet(deps, capturedReq);
    expect(reg.name).toBe('list_models');
    // Empty JSON Schema object — no properties, no required.
    expect(reg.config.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('Test 2 (allow-all default): empty/unset allowlist returns ALL registered models', async () => {
    const { deps, capturedReq } = makeFakes({ models: [CHAT_LOCAL, EMBED_LOCAL] }); // policies undefined
    const reg = registerAndGet(deps, capturedReq);
    const result = await reg.handler({}, { signal: new AbortController().signal });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe('2 models available');

    const sc = result.structuredContent as {
      object: string;
      data: Array<{ id: string }>;
    };
    expect(sc.object).toBe('list');
    expect(sc.data).toHaveLength(2);
    expect(sc.data.map((m) => m.id).sort()).toEqual(['chat-local', 'embed-local']);
  });

  it('Test 3 (D-10 filter): non-empty allowlist filters out non-allowed models', async () => {
    const { deps, capturedReq } = makeFakes({
      models: [CHAT_LOCAL, EMBED_LOCAL],
      allowlist: ['chat-local'],
    });
    const reg = registerAndGet(deps, capturedReq);
    const result = await reg.handler({}, { signal: new AbortController().signal });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe('1 models available');

    const sc = result.structuredContent as {
      object: string;
      data: Array<{ id: string }>;
    };
    expect(sc.data).toHaveLength(1);
    expect(sc.data[0]!.id).toBe('chat-local');
    // Confirm embed-local was filtered out.
    expect(sc.data.find((m) => m.id === 'embed-local')).toBeUndefined();
  });

  it('Test 4 (T-3-A2 anti-leak): projection exposes EXACTLY {id, object, created, owned_by, capabilities, policy} — no backend leak', async () => {
    const { deps, capturedReq } = makeFakes({ models: [CHAT_LOCAL] });
    const reg = registerAndGet(deps, capturedReq);
    const result = await reg.handler({}, { signal: new AbortController().signal });

    const sc = result.structuredContent as { data: Array<Record<string, unknown>> };
    const entry = sc.data[0]!;
    const fieldNames = Object.keys(entry).sort();
    expect(fieldNames).toEqual(
      ['capabilities', 'created', 'id', 'object', 'owned_by', 'policy'].sort(),
    );
    // Hard anti-leak checks — every forbidden field MUST be absent.
    expect(entry.backend).toBeUndefined();
    expect(entry.backend_url).toBeUndefined();
    expect(entry.backend_model).toBeUndefined();
    expect(entry.vram_budget_gb).toBeUndefined();
  });

  it('Test 5 (policy.cloud_allowed annotation): explicit false carries through; missing defaults to true', async () => {
    const { deps, capturedReq } = makeFakes({
      models: [CHAT_LOCAL, CLOUD_DENIED], // CHAT_LOCAL has no policy; CLOUD_DENIED has cloud_allowed:false
    });
    const reg = registerAndGet(deps, capturedReq);
    const result = await reg.handler({}, { signal: new AbortController().signal });

    const sc = result.structuredContent as {
      data: Array<{ id: string; policy: { cloud_allowed: boolean } }>;
    };
    const byId = Object.fromEntries(sc.data.map((m) => [m.id, m]));
    expect(byId['chat-local']!.policy).toEqual({ cloud_allowed: true });
    expect(byId['gpt-oss:120b-cloud']!.policy).toEqual({ cloud_allowed: false });
  });

  it('Test 6 (D-07): router_mcp_tool_calls_total counter increments with {tool:"list_models", status_class:"success"}', async () => {
    const { deps, capturedReq, metrics } = makeFakes();
    const reg = registerAndGet(deps, capturedReq);
    await reg.handler({}, { signal: new AbortController().signal });

    expect(metrics.routerMcpToolCallsTotal.inc).toHaveBeenCalledTimes(1);
    expect(metrics.routerMcpToolCallsTotal.inc).toHaveBeenCalledWith({
      tool: 'list_models',
      status_class: 'success',
    });
  });

  it('Test 7 (no bufferedWriter row): list_models is read-only — bufferedWriter.push is NOT called', async () => {
    const { deps, capturedReq, bufferedWriter } = makeFakes();
    const reg = registerAndGet(deps, capturedReq);
    await reg.handler({}, { signal: new AbortController().signal });

    // Read-only registry projection — no backend touched, no request_log row.
    expect(bufferedWriter.push).not.toHaveBeenCalled();
  });
});
