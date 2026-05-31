/**
 * Phase 15 Plan 12 (v0.11.0 — MCPS-01..06 / P1-03 drift gate) —
 * Golden snapshot drift test for the 5-tool MCP manifest.
 *
 * Purpose:
 *   The `inputSchema` of each MCP tool is derived from the live route Zod
 *   schema (ChatCompletionRequestSchema / ResponsesRequestSchema /
 *   EmbeddingsRequestSchema / RerankRequestSchema). The MCP SDK serializes
 *   those Zod schemas to JSON Schema 2020-12 when emitting `tools/list`.
 *   Any change to the route schemas — intentional or accidental — flows
 *   through to the MCP wire surface.
 *
 *   This test pins the EXACT current `tools/list` response shape (all 5
 *   tools, their names, descriptions, titles, and inputSchema JSON Schemas)
 *   into `router/tests/golden/mcp-tools-manifest.json`. On every CI run, we
 *   build a fresh McpServer, register all 5 tools via the same path the
 *   plugin uses (`buildServerForRequest`), invoke the SDK's internal
 *   `tools/list` handler, and assert deep equality with the golden file.
 *
 *   A divergence means the route schema changed (D-01 passthrough propagates
 *   that change to MCP). If the change was intentional, the operator must
 *   regenerate the golden file via:
 *
 *       UPDATE_GOLDEN=1 npm test -- tests/unit/mcp/host/tools-manifest.test.ts
 *
 *   then commit the updated `mcp-tools-manifest.json` alongside the route
 *   change. If the change was NOT intentional, this test surfaces the
 *   drift in CI before the schema mismatch reaches operators / agents.
 *
 * Mitigates: P1-03 (manual-schema-drift between MCP tool inputSchema and the
 * HTTP route schema). See 15-RESEARCH.md §Pitfall 3.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyRequest } from 'fastify';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerChatCompletionTool } from '../../../../src/mcp/host/tools/chat-completion.js';
import { registerCreateEmbeddingTool } from '../../../../src/mcp/host/tools/create-embedding.js';
import { registerCreateResponseTool } from '../../../../src/mcp/host/tools/create-response.js';
import { registerListModelsTool } from '../../../../src/mcp/host/tools/list-models.js';
import { registerRerankTool } from '../../../../src/mcp/host/tools/rerank.js';
import type { McpHostOpts } from '../../../../src/mcp/host/plugin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Golden snapshot path. Co-located with the rest of the project's golden
 * fixtures (currently the only one — see the new `router/tests/golden/`
 * directory created by Plan 15-12). The file is checked in to git; CI
 * fails on any drift.
 */
const GOLDEN_PATH = resolve(__dirname, '../../../golden/mcp-tools-manifest.json');

/**
 * Minimal McpHostOpts stub. The register* helpers close over `opts` for
 * their adapter + metrics deps, but tools/list serialization is computed
 * at registration time from the title/description/inputSchema config —
 * none of the runtime deps participate. We supply just enough of the
 * shape to satisfy the type-checker.
 */
function makeStubOpts(): McpHostOpts {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies registerTool typing only
    registry: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies registerTool typing only
    makeAdapter: (() => ({})) as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies registerTool typing only
    bufferedWriter: { push: () => {}, drain: async () => {}, size: 0 } as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies registerTool typing only
    metrics: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub satisfies registerTool typing only
    breaker: {} as any,
    env: { MCP_ENABLED: true, MCP_SESSION_TTL_SEC: 3600, MCP_GC_INTERVAL_MS: 1_800_000 },
  };
}

/**
 * Minimal FastifyRequest stub. Tools never look at capturedReq during
 * registration; they only read it during handler execution. We pass a
 * skeleton that satisfies the param type.
 */
function makeStubCapturedReq(): FastifyRequest {
  return {
    id: 'test-req',
    tenantId: null,
    projectId: null,
    agentId: null,
    workloadClass: null,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    },
  } as unknown as FastifyRequest;
}

/**
 * Build a fresh McpServer, register all 5 tools (matching the order in
 * `buildServerForRequest` in plugin.ts), then invoke the SDK's internal
 * `tools/list` handler via the underlying Server's `_requestHandlers` map.
 *
 * The SDK's mcp.js:67-99 declares the handler with `setRequestHandler(
 * ListToolsRequestSchema, ...)`; calling that handler directly returns the
 * serialized `{ tools: [...] }` shape that would otherwise reach the wire.
 *
 * We then SORT the result by tool name (alphabetical) so the manifest is
 * stable regardless of registration order — buildServerForRequest already
 * registers alphabetically, but the sort guards against future re-orderings.
 */
async function buildManifest(): Promise<{ tools: Array<Record<string, unknown>> }> {
  const server = new McpServer(
    { name: 'local-llms-router', version: '0.11.0' },
    { capabilities: { tools: {} } },
  );
  const opts = makeStubOpts();
  const capturedReq = makeStubCapturedReq();

  // SAME 5 registration calls as buildServerForRequest in plugin.ts
  // (alphabetical by tool name — P1-05 hard-coded allowlist).
  registerChatCompletionTool(server, opts, capturedReq);
  registerCreateEmbeddingTool(server, opts, capturedReq);
  registerCreateResponseTool(server, opts, capturedReq);
  registerListModelsTool(server, opts, capturedReq);
  registerRerankTool(server, opts, capturedReq);

  // The McpServer instance's underlying `.server` field is the lower-level
  // protocol Server (mcp.js exports `Server` from server/index.js); its
  // `_requestHandlers` map exposes the registered handlers.
  // biome-ignore lint/suspicious/noExplicitAny: reaching into SDK internals
  const underlying = (server as any).server;
  // biome-ignore lint/suspicious/noExplicitAny: handler map is private SDK state
  const handlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> =
    underlying._requestHandlers;
  const listHandler = handlers.get('tools/list');
  if (!listHandler) {
    throw new Error('tools/list handler not registered on McpServer');
  }

  const result = (await listHandler(
    { method: 'tools/list', params: {} },
    { signal: new AbortController().signal },
  )) as { tools: Array<Record<string, unknown>> };

  // Sort alphabetically by name for stable serialization. The current SDK
  // emits in registration order; we sort here so the golden file is
  // independent of that ordering and any future SDK version that changes
  // emission order does NOT trigger a false drift.
  const sorted = [...result.tools].sort((a, b) => {
    const an = (a.name as string) ?? '';
    const bn = (b.name as string) ?? '';
    return an.localeCompare(bn);
  });

  return { tools: sorted };
}

describe('Phase 15 Plan 12 — MCP tools manifest drift gate (P1-03)', () => {
  it('the 5 registered MCP tools match the golden snapshot byte-for-byte', async () => {
    const manifest = await buildManifest();

    // UPDATE_GOLDEN escape hatch: when set, write the manifest to disk and
    // skip the assertion. Operators use this AFTER intentionally changing
    // a route schema (and re-running the relevant route tests) to publish
    // the new shape into the golden file. The new file then gets committed
    // alongside the route change.
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, JSON.stringify(manifest, null, 2) + '\n');
      // Re-read to verify the file is well-formed and parseable.
      const reread = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
      expect(reread.tools).toHaveLength(5);
      return;
    }

    // Drift assertion: file must exist + deep-equal the live manifest.
    if (!existsSync(GOLDEN_PATH)) {
      throw new Error(
        `Golden snapshot missing at ${GOLDEN_PATH}. ` +
          `Run: UPDATE_GOLDEN=1 npm test -- tests/unit/mcp/host/tools-manifest.test.ts`,
      );
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    expect(golden).toHaveProperty('tools');
    expect(Array.isArray(golden.tools)).toBe(true);

    // Deep equality. Any difference — added/removed/renamed property, type
    // change, nested enum change — fails the test with a precise diff.
    expect(manifest).toEqual(golden);
  });

  it('manifest has exactly 5 tools (P1-05 allowlist enforcement)', async () => {
    const manifest = await buildManifest();
    expect(manifest.tools).toHaveLength(5);
    const names = manifest.tools.map((t) => t.name as string).sort();
    expect(names).toEqual([
      'chat_completion',
      'create_embedding',
      'create_response',
      'list_models',
      'rerank',
    ]);
  });

  it('every tool has name + description + inputSchema (shape invariant)', async () => {
    const manifest = await buildManifest();
    for (const tool of manifest.tools) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeDefined();
      // inputSchema is always an object — either populated JSON Schema (4 tools)
      // or `{ type:'object', properties:{}, additionalProperties:false }` for list_models.
      expect(typeof tool.inputSchema).toBe('object');
    }
  });
});
