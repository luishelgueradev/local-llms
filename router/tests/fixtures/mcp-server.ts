/**
 * Phase 18 / v0.11.0 — MSW MCP Streamable HTTP fixture (Frame-02 BLOCK — no
 * in-process MemoryRetriever). Build greenfield per RESEARCH lines 86-100.
 * See router/tests/msw/handlers.ts for prior MSW handlers.
 *
 * This is the ONLY greenfield Phase 18 test pattern (PATTERNS.md "No Analog
 * Found" line 922). It establishes the outbound-MCP test boundary so the
 * downstream Plans 18-04..18-07 can exercise the lazy `Client` connect path
 * against a controlled JSON-RPC peer without spinning up a real MCP server
 * process.
 *
 * Wire shape: minimal subset of the MCP Streamable-HTTP transport — three
 * JSON-RPC methods over a single `POST <base>/` endpoint (`base` defaults
 * to `MCP_FIXTURE_BASE_URL`). The fixture responds with `application/json`
 * (not SSE) because the `@modelcontextprotocol/sdk` Streamable HTTP client
 * accepts either shape and the JSON branch keeps the fixture compact.
 *
 * Methods handled:
 *   - `initialize`  → returns server protocolVersion + tools capability.
 *   - `tools/list`  → returns the `opts.tools` array (defaults to a single
 *                     `search` tool).
 *   - `tools/call`  → returns `{ content: [{ type: 'text', text: ... }] }`
 *                     where `text` is `JSON.stringify(opts.callResult ?? { ok: true })`.
 *
 * Authentication assertion: when `opts.bearerAssertion` is provided, it is
 * called with `request.headers.get('authorization')` on every request — the
 * test asserts that the per-server `Bearer <auth_value>` is forwarded AND
 * that the INBOUND router bearer is NOT (P2-04 BLOCK auth isolation).
 *
 * The fixture is a pure module — it must NOT contain `describe`/`it` blocks.
 * It is imported by integration tests that own their own vitest scaffolding.
 */
import { http, HttpResponse } from 'msw';
import { setupServer, type SetupServer } from 'msw/node';

// ─────────────────────────────────────────────────────────────────────────────
// Public constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical base URL for the MSW MCP fixture. Downstream tests use this
 * value when constructing `McpServerConfig.url`. The path-suffix on the
 * actual handler is `/mcp` (Streamable-HTTP convention) — assembled into
 * the URL below.
 */
export const MCP_FIXTURE_BASE_URL = 'http://mcp-fixture.test/mcp';

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC shapes (minimal — only the fields the SDK reads)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MCP Tool shape — duck-typed against `@modelcontextprotocol/sdk/types`'s
 * `Tool` (the SDK's `tools/list` response shape). We don't import the SDK
 * type here because this fixture must be SDK-version-resilient.
 */
export interface FixtureTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** Default tool surfaced by `tools/list` when caller omits `opts.tools`. */
const DEFAULT_TOOLS: FixtureTool[] = [
  {
    name: 'search',
    description: 'Search docs',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface SetupMcpMswServerOpts {
  /** Tools array returned by `tools/list`. Defaults to a single `search` tool. */
  tools?: FixtureTool[];
  /**
   * Result returned by `tools/call`. The fixture serializes this as
   * `JSON.stringify(callResult)` inside a single-text-block `content` array.
   * Defaults to `{ ok: true }`.
   */
  callResult?: unknown;
  /**
   * Invoked with the inbound `Authorization` header on every request.
   * Use this to assert P2-04: per-server bearer forwarded; router-inbound
   * bearer NOT leaked. Receives `null` when the header is absent.
   */
  bearerAssertion?: (authorizationHeader: string | null) => void;
  /**
   * Override the base URL. Defaults to `MCP_FIXTURE_BASE_URL`. Useful when
   * a single test needs two fixtures distinguishable by alias (prefix
   * collision tests).
   */
  baseUrl?: string;
}

/**
 * Build a one-off MSW `setupServer` instance pre-wired to serve the MCP
 * Streamable HTTP method set. The returned instance is NOT started — the
 * caller is expected to invoke `.listen({ onUnhandledRequest: 'error' })`
 * in a `beforeAll` and `.close()` in `afterAll`.
 *
 * Why a *fresh* `setupServer` per call instead of `server.use(...)` against
 * the shared `tests/setup.ts` instance: an MCP-only fixture must NOT mix
 * with the global Ollama/llama.cpp handlers — the SDK's `Client` issues
 * additional GET / DELETE requests for SSE-stream open / session-delete
 * that we want to scope to this fixture's listener only.
 */
export function setupMcpMswServer(opts: SetupMcpMswServerOpts = {}): SetupServer {
  const baseUrl = opts.baseUrl ?? MCP_FIXTURE_BASE_URL;
  const tools = opts.tools ?? DEFAULT_TOOLS;
  const callResultText = JSON.stringify(opts.callResult ?? { ok: true });

  const handler = http.post(baseUrl, async ({ request }) => {
    // P2-04 BLOCK probe: caller may assert that the inbound bearer is the
    // per-server `auth_value`, not the router-inbound token.
    if (opts.bearerAssertion) {
      opts.bearerAssertion(request.headers.get('authorization'));
    }

    // The SDK may send a single JSON-RPC request OR a JSON-RPC batch array.
    // We accept both and respond in matching shape.
    let body: JsonRpcRequest | JsonRpcRequest[];
    try {
      body = (await request.json()) as JsonRpcRequest | JsonRpcRequest[];
    } catch {
      return HttpResponse.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        { status: 400 },
      );
    }

    const replyTo = (req: JsonRpcRequest): unknown => {
      switch (req.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              // Use the most recent MCP protocol revision the SDK negotiates
              // against. The SDK downshifts to whatever the server returns,
              // so this is the "ceiling" value.
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'test-fixture', version: '0.0.0' },
            },
          };
        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: { tools },
          };
        case 'tools/call':
          return {
            jsonrpc: '2.0',
            id: req.id,
            result: {
              content: [{ type: 'text', text: callResultText }],
              isError: false,
            },
          };
        case 'notifications/initialized':
        case 'ping':
          // No-result acknowledgements — the SDK sends `notifications/*` as
          // JSON-RPC notifications (no `id`). Reply with `null` and the
          // caller-side will filter notifications out before serializing.
          return null;
        default:
          return {
            jsonrpc: '2.0',
            id: req.id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
      }
    };

    if (Array.isArray(body)) {
      const responses = body
        .map((req) => replyTo(req))
        .filter((r): r is NonNullable<typeof r> => r !== null);
      return HttpResponse.json(responses);
    }

    const single = replyTo(body);
    if (single === null) {
      // Notification — MCP transport returns 202 Accepted with no body.
      return new HttpResponse(null, { status: 202 });
    }
    return HttpResponse.json(single);
  });

  return setupServer(handler);
}
