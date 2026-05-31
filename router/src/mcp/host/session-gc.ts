/**
 * Phase 15 (v0.11.0 — MCPS-05 / 15-CONTEXT D-15): MCP session GC + SIGTERM-race utility.
 *
 * Responsibilities:
 *   - startSessionGc({ sessionMap, ttlSec, intervalMs, metrics, log }): NodeJS.Timeout
 *     Drives a setInterval sweep that closes any session whose `lastActivityAt`
 *     is older than `ttlSec * 1000` ms. Calls `transport.close()` fire-and-forget
 *     (swallowing the rejection via .catch so a wedged close does not crash the
 *     timer). After a sweep that removed entries, updates the
 *     `routerMcpActiveSessions` gauge and emits an info log with swept_count +
 *     remaining size. Returns the timer; the timer is `.unref()`ed so it does
 *     not pin the event loop (mirrors the bufferedWriter pattern at
 *     router/src/db/bufferedWriter.ts:140-144).
 *
 *   - shutdownSessions(sessionMap, log): Promise<void>
 *     Implements the MCPS-05 P1-04 SIGTERM race — `Promise.race` between
 *     `Promise.allSettled(transport.close)` and a 5-second hard ceiling. After
 *     the race settles (regardless of winner), `sessionMap.clear()` so the
 *     gauge update in the caller (plugin onClose) reflects zero.
 *
 * Why a 5-second hard ceiling? Compose's default `stop_grace_period` is 10s.
 * Reserving 5s for MCP teardown leaves room for the existing
 * `bufferedWriter.drain(3_000)` after the MCP onClose hook completes (Fastify
 * v5 fires onClose hooks in registration order; the MCP plugin's hook is
 * registered AFTER the main app.ts onClose body — see app.ts:648-661).
 *
 * BLOCK pitfall mitigations referenced:
 *   - P1-04 (session leakage): startSessionGc closes idle sessions on every sweep.
 *   - P1-04 (wedged shutdown): shutdownSessions caps teardown at 5s via Promise.race.
 *
 * The shape mirrors bufferedWriter.ts almost exactly (setInterval + unref +
 * Promise.race-against-setTimeout) — this is the canonical timer/drain pattern
 * in the router and is deliberately preserved for operator pattern recognition.
 */
import type { Logger } from 'pino';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyRequest } from 'fastify';
import type { MetricsRegistry } from '../../metrics/registry.js';

/**
 * Per-session bookkeeping kept in the plugin's in-process `Map<string, SessionEntry>`.
 *
 * - `transport`: the SDK's `StreamableHTTPServerTransport` bound to this session id.
 * - `server`: the `McpServer` instance built at initialize time (closes over `capturedReq`).
 * - `lastActivityAt`: epoch-ms timestamp updated on every POST/GET/DELETE for the session;
 *   the GC sweep uses `now - lastActivityAt > ttlSec*1000` to identify idle sessions.
 * - `capturedReq`: the originating Fastify request from the initialize call. Wave 4 tool
 *   handlers close over this to read tenant_id / project_id / agent_id / workload_class
 *   / request_id (per CONTEXT D-06: "all tool calls within a session share the
 *   originating request's scoped identity"). Stored on the entry so Wave 4 tool
 *   registrations have an obvious hook point.
 */
export interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivityAt: number;
  capturedReq: FastifyRequest;
}

export interface SessionGcOpts {
  sessionMap: Map<string, SessionEntry>;
  /**
   * Idle session TTL in seconds. Sessions whose `lastActivityAt` is older
   * than `now - ttlSec*1000` are closed on the next sweep.
   */
  ttlSec: number;
  /**
   * Sweep cadence in milliseconds (`setInterval` argument).
   */
  intervalMs: number;
  metrics: MetricsRegistry;
  log: Logger;
}

/**
 * Starts the idle-session GC sweep. Returns the timer so the caller can
 * `clearInterval(timer)` from its onClose hook.
 *
 * The timer is `.unref()`-ed: it does NOT keep the Node event loop alive
 * (mirrors the bufferedWriter pattern; otherwise a long sweep interval
 * with no MCP traffic would block process exit beyond Compose's
 * stop_grace_period).
 */
export function startSessionGc(opts: SessionGcOpts): NodeJS.Timeout {
  const timer: NodeJS.Timeout = setInterval(() => {
    const now = Date.now();
    const ttlMs = opts.ttlSec * 1000;
    const stale: string[] = [];
    for (const [sid, entry] of opts.sessionMap) {
      if (now - entry.lastActivityAt > ttlMs) stale.push(sid);
    }
    for (const sid of stale) {
      const entry = opts.sessionMap.get(sid);
      if (entry) {
        // Fire-and-forget close. The GC sweep MUST NOT crash on a wedged
        // transport — log the rejection if any and continue. `void` prefix
        // tells TS we knowingly ignore the returned Promise.
        void entry.transport.close().catch((err) => {
          opts.log.warn({ err, mcp_session_id: sid }, 'mcp gc: transport.close() rejected');
        });
        opts.sessionMap.delete(sid);
      }
    }
    if (stale.length > 0) {
      opts.metrics.routerMcpActiveSessions.set(opts.sessionMap.size);
      opts.log.info(
        { swept_count: stale.length, remaining: opts.sessionMap.size },
        'mcp session gc swept idle sessions',
      );
    }
  }, opts.intervalMs);
  // Don't keep the event loop alive solely for the GC sweep — same pattern as
  // bufferedWriter timer (db/bufferedWriter.ts:144). `.unref?.()` because the
  // Node typings on setInterval's NodeJS.Timeout consistently expose `unref`
  // but the optional-chain guards against any future Timer subclass that
  // omits it (e.g. unref() in test fakes).
  timer.unref?.();
  return timer;
}

/**
 * Closes every active session with a 5-second hard ceiling.
 *
 * Race semantics:
 *   - Winner A (happy path): `Promise.allSettled(transport.close())` resolves
 *     before 5s — all sessions closed cleanly. The timeout setTimeout is left
 *     to fire later; the `resolve()` call inside the setTimeout body still
 *     runs but the awaited Promise.race has already settled.
 *   - Winner B (wedged transport): the 5s setTimeout fires first, the warn
 *     log is emitted, the unsettled close()s are abandoned. The process is
 *     about to exit anyway.
 *
 * After the race settles, `sessionMap.clear()` so the caller's
 * `routerMcpActiveSessions.set(0)` reflects an empty map.
 *
 * Returns early (no-op) when the map is empty — avoids spurious "closing 0
 * sessions" logs in tests that never opened a session.
 */
export async function shutdownSessions(
  sessionMap: Map<string, SessionEntry>,
  log: Logger,
): Promise<void> {
  const sessions = Array.from(sessionMap.values());
  if (sessions.length === 0) return;
  log.info({ count: sessions.length }, 'mcp shutdown: closing active sessions');
  await Promise.race([
    Promise.allSettled(sessions.map((s) => s.transport.close())),
    new Promise<void>((resolve) => {
      // 5s hard ceiling — see header comment for rationale (Compose grace 10s
      // minus bufferedWriter.drain 3s leaves ~7s; 5s is comfortable).
      setTimeout(() => {
        log.warn(
          { count: sessions.length },
          'mcp shutdown: 5s timeout — abandoning unresponsive sessions',
        );
        resolve();
      }, 5_000);
    }),
  ]);
  sessionMap.clear();
}
