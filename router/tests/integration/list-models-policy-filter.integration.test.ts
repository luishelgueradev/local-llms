/**
 * Phase 15 Plan 15-11 (v0.11.0 — MCPS-03 / MCPS-04 / 15-CONTEXT D-10 + D-11) —
 * Dual-surface parity integration tests for the policy-filtered model list.
 *
 * The MCP `list_models` tool (Plan 15-10) and the HTTP `GET /v1/models`
 * (Plan 15-11) MUST return the same filtered set with the same `policy`
 * annotation. This file exercises both surfaces end-to-end through the same
 * Fastify app so the lens stays consistent across protocols.
 *
 * Test matrix:
 *   1. Allowlist filter parity (non-empty allowlist) — both surfaces return
 *      exactly the allowlisted set.
 *   2. Allow-all default (empty/absent allowlist) — both surfaces return all
 *      models in the registry.
 *   3. cloud_allowed annotation — entries with explicit policy carry the
 *      value through; entries without policy default to true.
 *   4. GET /v1/models/:id allowlist semantics — allowlist-excluded entries
 *      return 404 + model_not_found (single lens with the list endpoint).
 *   5. T-3-A2 anti-leak — neither surface exposes backend / backend_url /
 *      backend_model / vram_budget_gb.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';

const TOKEN = 'local-llms_15_11_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';

/** Three-entry registry covering: local chat, local embeddings, cloud-denied chat. */
const THREE_ENTRY_YAML_ALLOW_ALL = `
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.1:8b
    capabilities: [chat]
    vram_budget_gb: 5

  - name: embed-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: nomic-embed-text
    capabilities: [embeddings]
    vram_budget_gb: 1
    dims: 768

  - name: chat-cloud
    backend: ollama-cloud
    backend_url: https://ollama.com/v1
    backend_model: gpt-oss:120b-cloud
    capabilities: [chat]
    vram_budget_gb: 0
    policy:
      cloud_allowed: false
`;

/** Same three entries, but with an allowlist restricting visibility to chat-local. */
const THREE_ENTRY_YAML_ALLOWLIST = `${THREE_ENTRY_YAML_ALLOW_ALL}
policies:
  default:
    model_allowlist: [chat-local]
`;

const ACCEPT_BOTH = 'application/json, text/event-stream';

const INITIALIZE_BODY = {
  jsonrpc: '2.0' as const,
  id: 0,
  method: 'initialize' as const,
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '0.0.0' },
  },
};

function extractFirstJsonRpcFrame(body: string): {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: unknown;
} {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }
  const dataLine = trimmed.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) {
    throw new Error(`unexpected MCP response body: ${body.slice(0, 200)}`);
  }
  return JSON.parse(dataLine.slice(5).trim());
}

/**
 * Inert adapter for list-models tests — never called on the happy path
 * (list_models is a pure registry projection), but still required because
 * the liveness scheduler tries to construct adapters for every backend at
 * boot. Without this override, the cloud entry triggers the
 * "requires cloudApiKey" guard in `factory.ts` from the background probe
 * task, polluting test output with unhandled rejections. The list-models
 * surfaces themselves never touch the adapter.
 */
const inertAdapter = {
  // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
  chatCompletionsCanonical: async (): Promise<any> => {
    throw new Error('not used in list-models tests');
  },
  // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
  chatCompletionsCanonicalStream: async (): Promise<any> => {
    throw new Error('not used in list-models tests');
  },
  // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
  embeddings: async (): Promise<any> => {
    throw new Error('not used in list-models tests');
  },
  // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
  rerank: async (): Promise<any> => {
    throw new Error('not used in list-models tests');
  },
  probeLiveness: async (): Promise<{ ok: boolean; latencyMs: number }> => ({
    ok: true,
    latencyMs: 1,
  }),
};

/**
 * Build a Fastify app from a models.yaml string. Uses fake bufferedWriter +
 * metrics so the app stays in-process. The makeAdapter override returns the
 * inertAdapter for every entry — list_models is a pure projection so the
 * adapter is never invoked on the happy path.
 */
async function buildAppWithPolicy(yaml: string): Promise<FastifyInstance> {
  const registry = makeRegistryStore(loadRegistryFromString(yaml));
  return buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
    // biome-ignore lint/suspicious/noExplicitAny: BackendAdapter narrowing
    makeAdapter: (() => inertAdapter) as any,
  });
}

/**
 * Fetch the MCP `list_models` tool result via initialize → ack → tools/call.
 * Returns the structuredContent.data array (the projected entries).
 */
async function callMcpListModels(
  app: FastifyInstance,
): Promise<Array<Record<string, unknown>>> {
  // 1) initialize
  const initRes = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: ACCEPT_BOTH,
    },
    payload: INITIALIZE_BODY,
  });
  expect(initRes.statusCode).toBe(200);
  const sid = initRes.headers['mcp-session-id'] as string;
  expect(sid).toBeTruthy();

  // 2) notifications/initialized
  const ackRes = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: ACCEPT_BOTH,
      'mcp-session-id': sid,
    },
    payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  expect([200, 202]).toContain(ackRes.statusCode);

  // 3) tools/call list_models
  const callRes = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: ACCEPT_BOTH,
      'mcp-session-id': sid,
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_models', arguments: {} },
    },
  });
  expect(callRes.statusCode).toBe(200);
  const frame = extractFirstJsonRpcFrame(callRes.body);
  expect(frame.result).toBeDefined();
  const r = frame.result as {
    isError?: boolean;
    structuredContent: { object: string; data: Array<Record<string, unknown>> };
  };
  expect(r.isError).toBeFalsy();
  return r.structuredContent.data;
}

/** Fetch the HTTP GET /v1/models data array. */
async function callHttpListModels(
  app: FastifyInstance,
): Promise<Array<Record<string, unknown>>> {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json<{
    object: string;
    data: Array<Record<string, unknown>>;
  }>();
  expect(body.object).toBe('list');
  return body.data;
}

describe('Phase 15 Plan 15-11 — list_models policy-filter dual-surface parity', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('Test 1 (D-10/D-11 allowlist filter parity): both surfaces return only allowlisted entries with matching projection', async () => {
    app = await buildAppWithPolicy(THREE_ENTRY_YAML_ALLOWLIST);

    const httpData = await callHttpListModels(app);
    const mcpData = await callMcpListModels(app);

    // Filter is non-empty (['chat-local']): both surfaces emit exactly 1 entry.
    expect(httpData).toHaveLength(1);
    expect(mcpData).toHaveLength(1);

    // Both entries point to the same model.
    expect(httpData[0]!.id).toBe('chat-local');
    expect(mcpData[0]!.id).toBe('chat-local');

    // Shape parity: id, object, created, owned_by, capabilities, policy.cloud_allowed.
    const httpEntry = httpData[0]! as {
      id: string;
      object: string;
      created: number;
      owned_by: string;
      capabilities: string[];
      policy: { cloud_allowed: boolean };
    };
    const mcpEntry = mcpData[0]! as typeof httpEntry;

    expect(httpEntry.id).toBe(mcpEntry.id);
    expect(httpEntry.object).toBe('model');
    expect(mcpEntry.object).toBe('model');
    expect(httpEntry.owned_by).toBe('local-llms');
    expect(mcpEntry.owned_by).toBe('local-llms');
    expect(httpEntry.capabilities).toEqual(mcpEntry.capabilities);
    expect(httpEntry.capabilities).toEqual(['chat']);
    expect(typeof httpEntry.created).toBe('number');
    expect(typeof mcpEntry.created).toBe('number');
    // Both surfaces project the same registry snapshot timestamp.
    expect(httpEntry.created).toBe(mcpEntry.created);

    // chat-local has no policy block → default true on both surfaces.
    expect(httpEntry.policy).toEqual({ cloud_allowed: true });
    expect(mcpEntry.policy).toEqual({ cloud_allowed: true });
  });

  it('Test 2 (allow-all default): empty/absent allowlist returns all 3 entries on both surfaces', async () => {
    app = await buildAppWithPolicy(THREE_ENTRY_YAML_ALLOW_ALL);

    const httpData = await callHttpListModels(app);
    const mcpData = await callMcpListModels(app);

    expect(httpData).toHaveLength(3);
    expect(mcpData).toHaveLength(3);

    const httpIds = httpData.map((e) => e.id as string).sort();
    const mcpIds = mcpData.map((e) => e.id as string).sort();
    expect(httpIds).toEqual(mcpIds);
    expect(httpIds).toEqual(['chat-cloud', 'chat-local', 'embed-local']);
  });

  it('Test 3 (D-11 cloud_allowed annotation parity): explicit false carries through; missing defaults to true', async () => {
    app = await buildAppWithPolicy(THREE_ENTRY_YAML_ALLOW_ALL);

    const httpData = await callHttpListModels(app);
    const mcpData = await callMcpListModels(app);

    const httpById = Object.fromEntries(httpData.map((e) => [e.id as string, e]));
    const mcpById = Object.fromEntries(mcpData.map((e) => [e.id as string, e]));

    // chat-local has no policy block → cloud_allowed defaults to true.
    expect(httpById['chat-local']!.policy).toEqual({ cloud_allowed: true });
    expect(mcpById['chat-local']!.policy).toEqual({ cloud_allowed: true });

    // embed-local has no policy block → same default.
    expect(httpById['embed-local']!.policy).toEqual({ cloud_allowed: true });
    expect(mcpById['embed-local']!.policy).toEqual({ cloud_allowed: true });

    // chat-cloud explicitly sets cloud_allowed: false — both surfaces carry it.
    expect(httpById['chat-cloud']!.policy).toEqual({ cloud_allowed: false });
    expect(mcpById['chat-cloud']!.policy).toEqual({ cloud_allowed: false });
  });

  it('Test 4 (GET /v1/models/:id allowlist semantics): allowlist-excluded model returns 404 + model_not_found', async () => {
    app = await buildAppWithPolicy(THREE_ENTRY_YAML_ALLOWLIST);

    // embed-local exists in the registry but is NOT in the allowlist
    // (['chat-local']) — single-lens: invisible to /v1/models means
    // invisible to /v1/models/:id too.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/embed-local',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<{
      error: { message: string; type: string; code: string; param: null };
    }>();
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.param).toBeNull();
    expect(body.error.message).toContain('embed-local');

    // Sanity: the allowlisted id IS retrievable.
    const okRes = await app.inject({
      method: 'GET',
      url: '/v1/models/chat-local',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(okRes.statusCode).toBe(200);
    const okBody = okRes.json<{
      id: string;
      policy: { cloud_allowed: boolean };
    }>();
    expect(okBody.id).toBe('chat-local');
    expect(okBody.policy).toEqual({ cloud_allowed: true });
  });

  it('Test 5 (T-3-A2 anti-leak): neither surface exposes backend / backend_url / backend_model / vram_budget_gb', async () => {
    app = await buildAppWithPolicy(THREE_ENTRY_YAML_ALLOW_ALL);

    const httpData = await callHttpListModels(app);
    const mcpData = await callMcpListModels(app);

    const forbidden = ['backend', 'backend_url', 'backend_model', 'vram_budget_gb'];
    for (const entry of httpData) {
      const keys = Object.keys(entry);
      for (const f of forbidden) {
        expect(keys).not.toContain(f);
      }
    }
    for (const entry of mcpData) {
      const keys = Object.keys(entry);
      for (const f of forbidden) {
        expect(keys).not.toContain(f);
      }
    }

    // Also verify the /v1/models/:id retrieve route — same anti-leak.
    const retrieveRes = await app.inject({
      method: 'GET',
      url: '/v1/models/chat-cloud',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(retrieveRes.statusCode).toBe(200);
    const retrieveBody = retrieveRes.json<Record<string, unknown>>();
    const retrieveKeys = Object.keys(retrieveBody);
    for (const f of forbidden) {
      expect(retrieveKeys).not.toContain(f);
    }
  });
});
