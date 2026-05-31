/**
 * Phase 15 (v0.11.0 — MCPS-01..06 / 15-CONTEXT D-15 / 15-RESEARCH §Pattern 1):
 * MCP host Fastify plugin — multi-method `/mcp` route + in-process session map
 * + idle GC + 5s SIGTERM race shutdown.
 *
 * Surface:
 *   - POST /mcp   — primary JSON-RPC path (initialize, tools/list, tools/call, …)
 *   - GET  /mcp   — long-lived SSE pull for server-initiated notifications
 *                   (no notifications emitted in v0.11.0; SDK transport still
 *                   handles the GET so conformant clients can complete handshake)
 *   - DELETE /mcp — explicit session termination
 *
 * Architecture (§Pattern 1):
 *   - Single `app.route({ method: ['POST','GET','DELETE'], url: '/mcp', ... })`
 *     registration site — inherits root-scoped bearer onRequest hook +
 *     scopedIds / agentId preHandlers per Fastify v5 hook propagation
 *     (verified at app.ts:268-311).
 *   - In-process `Map<sessionId, SessionEntry>` keyed by the `Mcp-Session-Id`
 *     header. New sessions are created on `isInitializeRequest(req.body)`;
 *     existing sessions reuse their transport + server.
 *   - Per-request transport handoff via raw `req.raw` / `reply.raw` per the
 *     SDK's `transport.handleRequest(req, res, parsedBody)` contract — NO
 *     community Fastify plugin (rejected per RESEARCH §STACK).
 *   - `buildServerForRequest(capturedReq, opts)` builds a fresh `McpServer` and
 *     captures the originating request in closure. Wave 4 plans (15-06..15-10)
 *     fill in `registerXxxTool(server, opts, capturedReq)` calls inside this
 *     helper — for Wave 3 (this plan) it leaves the tool list intentionally
 *     empty so the `tools/list` JSON-RPC method returns `{ tools: [] }`.
 *
 * BLOCK pitfall mitigations:
 *   - P1-01 (wrong transport): only `StreamableHTTPServerTransport` is
 *     constructed; the stdio transport (Stdio-Server-Transport, dashes added
 *     so this comment cannot trip the grep gate) is NEVER imported.
 *     Grep gate enforced in tests/unit/mcp/host/plugin.test.ts + the plan's
 *     verification stanza (must return zero matches in router/src/).
 *   - P1-02 (auth bypass): the plugin registers at root scope, so the
 *     existing root-scoped bearer `onRequest` hook (app.ts:275) fires on
 *     /mcp BEFORE this handler runs. PUBLIC_PATHS in auth/bearer.ts does
 *     NOT include /mcp — confirmed at audit time.
 *   - P1-04 (session leakage): `startSessionGc` runs an idle sweep every
 *     `MCP_GC_INTERVAL_MS`, and the `onClose` hook closes every remaining
 *     session through `shutdownSessions` (5s Promise.race ceiling).
 *   - P1-05 (internal endpoint exposure): only the five MCP tools listed
 *     in the locked-in spec (chat_completion, create_response,
 *     create_embedding, rerank, list_models) will be registered by Wave 4 —
 *     `buildServerForRequest` is the SOLE registration site, by design.
 *
 * Disabled-mode behavior (D-15): when `opts.env.MCP_ENABLED === false`, the
 * plugin returns early WITHOUT registering the `/mcp` route. Requests to
 * `/mcp` then 404 via Fastify's default not-found handler — verified by
 * tests/integration/mcp-disabled.integration.test.ts.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory } from '../../backends/adapter.js';
import type { BufferedWriter } from '../../db/bufferedWriter.js';
import type { CircuitBreaker } from '../../resilience/circuitBreaker.js';
import type { MetricsRegistry } from '../../metrics/registry.js';
import type { Env } from '../../config/env.js';
import { startSessionGc, shutdownSessions, type SessionEntry } from './session-gc.js';
// Wave 4 tool registrations (Plans 15-06..15-10). Each tool's `register*Tool`
// helper closes over `opts` + the captured originating request and registers
// itself onto the per-session McpServer. Plan 15-10 (this plan) is the SOLE
// site that wires the 5 calls — siblings 15-06..15-09 only shipped the tool
// files, not the wiring, to avoid Wave-4 file-overlap conflicts on plugin.ts.
import { registerChatCompletionTool } from './tools/chat-completion.js';
import { registerCreateEmbeddingTool } from './tools/create-embedding.js';
import { registerCreateResponseTool } from './tools/create-response.js';
import { registerListModelsTool } from './tools/list-models.js';
import { registerRerankTool } from './tools/rerank.js';

/**
 * Opts contract — provided by `app.ts` at registration time.
 * Mirrors the existing plugin / route registration shape (registry +
 * makeAdapter + bufferedWriter + metrics + breaker). Wave 4 tool handlers
 * close over these deps just like HTTP route handlers do.
 */
export interface McpHostOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  bufferedWriter: BufferedWriter;
  metrics: MetricsRegistry;
  breaker: CircuitBreaker;
  env: Pick<Env, 'MCP_ENABLED' | 'MCP_SESSION_TTL_SEC' | 'MCP_GC_INTERVAL_MS'>;
}

/**
 * Builds a fresh `McpServer` instance for a newly-initialized session.
 *
 * Wave 3 (this plan) registers ZERO tools — `tools/list` returns `{ tools: [] }`.
 * Wave 4 plans (15-06..15-10) replace the TODO comments below with
 * `registerChatCompletionTool(server, deps, capturedReq)`,
 * `registerCreateResponseTool(server, deps, capturedReq)`,
 * `registerCreateEmbeddingTool(server, deps, capturedReq)`,
 * `registerRerankTool(server, deps, capturedReq)`,
 * `registerListModelsTool(server, deps, capturedReq)`.
 *
 * `capturedReq` is the originating Fastify request from the initialize call;
 * tool handlers close over it to read tenant_id / project_id / agent_id /
 * workload_class / request_id (D-06 inheritance). Bearer + scopedIds +
 * agentId preHandlers have all fired before initialize hits this code, so
 * `capturedReq` is fully populated.
 *
 * Exported only for unit-test introspection; not part of the plugin's
 * external API surface.
 */
export function buildServerForRequest(
  capturedReq: FastifyRequest,
  opts: McpHostOpts,
): McpServer {
  const server = new McpServer(
    { name: 'local-llms-router', version: '0.11.0' },
    { capabilities: { tools: {} } },
  );

  // P1-05 mitigation: hard-coded explicit allowlist of the 5 MCP tools served
  // by the router. NO `for (const ...)` loop; NO dynamic discovery. Adding a
  // 6th tool requires a code change AND a passing tools/list assertion in the
  // integration test (mcp-host.integration.test.ts Test 3) — both surface in
  // code review. Alphabetical-by-tool-name order to keep the integration
  // assertion sort-stable.
  registerChatCompletionTool(server, opts, capturedReq);   // 15-06 → chat_completion
  registerCreateEmbeddingTool(server, opts, capturedReq);  // 15-08 → create_embedding
  registerCreateResponseTool(server, opts, capturedReq);   // 15-07 → create_response
  registerListModelsTool(server, opts, capturedReq);       // 15-10 → list_models
  registerRerankTool(server, opts, capturedReq);           // 15-09 → rerank

  return server;
}

/**
 * Reads the `mcp-session-id` header from a Fastify request, normalizing
 * the `string | string[] | undefined` shape into `string | undefined`.
 * Header names are lower-cased by Fastify before this read.
 */
function readSessionIdHeader(req: FastifyRequest): string | undefined {
  const raw = req.headers['mcp-session-id'];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

export const mcpHostPlugin: FastifyPluginAsync<McpHostOpts> = async (app, opts) => {
  // D-15: disabled-mode short-circuit. /mcp will 404 via Fastify's default
  // not-found handler when the plugin returns without registering the route.
  if (!opts.env.MCP_ENABLED) {
    app.log.info('MCP_ENABLED=false — skipping /mcp registration');
    return;
  }

  /**
   * In-process session map. Key = `Mcp-Session-Id` (generated by the SDK
   * transport via `randomUUID()`); value = the bookkeeping entry defined in
   * session-gc.ts. NOT shared across processes — single-host constraint
   * (DESIGN: `StreamableHTTPServerTransport` instances are not serializable).
   */
  const sessionMap = new Map<string, SessionEntry>();

  // Single multi-method registration site. Bearer + scopedIds + agentId
  // hooks at root scope fire on /mcp automatically (verified at app.ts:268-311).
  // Pitfall 5 mitigation: ONE registration site, NOT a for-loop over methods.
  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      const sid = readSessionIdHeader(req);
      let entry: SessionEntry | undefined = sid ? sessionMap.get(sid) : undefined;

      if (entry) {
        // Existing session — bump activity timestamp + delegate to the
        // transport. The transport handles routing of the JSON-RPC body to
        // the registered tools/list / tools/call / DELETE-session handlers.
        entry.lastActivityAt = Date.now();
      } else if (req.method === 'POST' && isInitializeRequest(req.body)) {
        // New initialization — construct a transport + a fresh McpServer
        // bound to this originating request. `onsessioninitialized` fires
        // synchronously once the SDK assigns the session id; we use the
        // callback to register the entry in our session map so subsequent
        // requests on the same session id can find it.
        const capturedReq = req;
        const server = buildServerForRequest(capturedReq, opts);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSid: string) => {
            const newEntry: SessionEntry = {
              transport,
              server,
              lastActivityAt: Date.now(),
              capturedReq,
            };
            sessionMap.set(newSid, newEntry);
            opts.metrics.routerMcpActiveSessions.set(sessionMap.size);
            capturedReq.log.info({ mcp_session_id: newSid }, 'mcp session initialized');
          },
          onsessionclosed: (closedSid: string) => {
            // DELETE /mcp path — SDK invokes this when the client terminates
            // the session explicitly. Clean up the map and update the gauge.
            sessionMap.delete(closedSid);
            opts.metrics.routerMcpActiveSessions.set(sessionMap.size);
            capturedReq.log.info({ mcp_session_id: closedSid }, 'mcp session closed by client');
          },
        });
        await server.connect(transport);

        // Use the locally-built transport for THIS request, since the
        // onsessioninitialized callback that adds the entry to sessionMap
        // fires asynchronously through the SDK's handleRequest path.
        entry = {
          transport,
          server,
          lastActivityAt: Date.now(),
          capturedReq,
        };
      } else {
        // No session id + not an initialize request → JSON-RPC -32600.
        // Returning here uses Fastify's reply path; the SDK transport has
        // not been engaged yet so reply.raw has not been touched.
        void reply.code(400).send({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: 'Invalid Request: missing Mcp-Session-Id and not an initialize request',
          },
          id: null,
        });
        return;
      }

      // Delegate to the SDK transport — handleRequest writes to reply.raw
      // directly (status code, headers, body). After this returns, Fastify
      // should NOT additionally send a body, so we do not call reply.send.
      try {
        await entry.transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (err) {
        req.log.error({ err, mcp_session_id: sid }, 'mcp transport.handleRequest threw');
        // Defense-in-depth: if the synchronous setup path threw before the
        // SDK transport claimed reply.raw, emit a JSON-RPC -32603 error
        // frame. If headers are already sent, there is nothing we can do
        // (the SDK has already written the response).
        if (!reply.raw.headersSent) {
          void reply.code(500).send({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'internal mcp transport error' },
            id: null,
          });
        }
      }
    },
  });

  // Start the idle-session GC sweep. Returns a timer that is .unref()-ed
  // inside startSessionGc — does not pin the event loop.
  const gcTimer = startSessionGc({
    sessionMap,
    ttlSec: opts.env.MCP_SESSION_TTL_SEC,
    intervalMs: opts.env.MCP_GC_INTERVAL_MS,
    metrics: opts.metrics,
    // Same cast pattern app.ts uses for Logger interop (app.log is the
    // FastifyBaseLogger surface; the underlying instance is pino).
    log: app.log as Logger,
  });

  // onClose teardown — runs after the main app.ts onClose body (Fastify v5
  // fires onClose hooks in registration order; `mcpHostPlugin` registers
  // this hook AFTER buildApp's main onClose registration at app.ts:648-661).
  // This ordering is intentional: main hook handles Valkey + bufferedWriter
  // first; the MCP plugin then closes any remaining sessions with a 5s
  // hard ceiling.
  app.addHook('onClose', async () => {
    clearInterval(gcTimer);
    await shutdownSessions(sessionMap, app.log as Logger);
    opts.metrics.routerMcpActiveSessions.set(0);
  });

  app.log.info(
    {
      mcp_enabled: true,
      mcp_session_ttl_sec: opts.env.MCP_SESSION_TTL_SEC,
      mcp_gc_interval_ms: opts.env.MCP_GC_INTERVAL_MS,
    },
    'mcp host plugin registered (POST/GET/DELETE /mcp)',
  );
};
