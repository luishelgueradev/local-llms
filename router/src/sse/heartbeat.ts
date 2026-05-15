/**
 * SSE heartbeat helpers (ROUTE-08 + RESEARCH §Pattern 3 + Pitfall 3).
 *
 * Two variants share one internal machinery (`makeHeartbeat`):
 *
 *   - `startHeartbeat` (Phase 2): writes the SSE comment line `: keep-alive\n\n`
 *     every `intervalMs`. Used by `/v1/chat/completions` (OpenAI surface — clients
 *     ignore comment lines, so the keep-alive is invisible to the protocol).
 *
 *   - `startAnthropicHeartbeat` (Plan 04-03, ANTHR-06): writes a typed SSE event
 *     `event: ping\ndata: {"type":"ping"}\n\n` every `intervalMs`. Used by
 *     `/v1/messages` (Anthropic surface — the wire format expects a typed `ping`
 *     event, not a comment line; the SDK's stream parser surfaces it as a `MessageStreamPingEvent`).
 *
 * Both return the same `HeartbeatHandle` shape with idempotent `.stop()`, byte counter,
 * and elapsed-ms accessors. Both unref the underlying timer so graceful shutdown isn't
 * blocked on a 15s tick.
 *
 * Cleanup discipline: the route handler MUST call `.stop()` from BOTH the close handler
 * AND the iterator's `finally` (belt-and-suspenders against EPIPE + open-handle leaks).
 */

export interface HeartbeatHandle {
  stop(): void;
  readonly bytesSinceStart: number;
  readonly msSinceStart: number;
}

/**
 * Minimal interface accepted by the heartbeat helpers — ServerResponse + the few
 * methods we need. Allows unit tests to inject a fake without bringing in
 * `http.ServerResponse`.
 */
export interface SocketLike {
  write(chunk: string | Buffer): boolean;
  writableEnded?: boolean;
}

// ── OpenAI-surface heartbeat payload (Phase 2) ────────────────────────────────
// ': keep-alive\n\n' is 14 bytes UTF-8 (':' + ' ' + 'keep-alive' + '\n' + '\n').
const OPENAI_HEARTBEAT_PAYLOAD = ': keep-alive\n\n';
const OPENAI_HEARTBEAT_PAYLOAD_BYTES = Buffer.byteLength(OPENAI_HEARTBEAT_PAYLOAD, 'utf8');

// ── Anthropic-surface heartbeat payload (Plan 04-03) ──────────────────────────
// Typed SSE `ping` event — NOT a comment. Anthropic's stream-parser SDK lifts this
// to a discrete `MessageStreamPingEvent` for the consumer; the OpenAI heartbeat's
// comment line wouldn't be surfaced through the same parser.
const ANTHROPIC_HEARTBEAT_PAYLOAD = 'event: ping\ndata: {"type":"ping"}\n\n';
const ANTHROPIC_HEARTBEAT_PAYLOAD_BYTES = Buffer.byteLength(ANTHROPIC_HEARTBEAT_PAYLOAD, 'utf8');

/**
 * Internal machinery shared by both `startHeartbeat` and `startAnthropicHeartbeat`.
 * Writes `payload` to `socket` every `intervalMs`; tracks bytes; idempotent `.stop()`.
 *
 * Pre-computing `payloadBytes` at module scope keeps the per-beat counter accurate
 * without re-measuring on every tick (WR-01 fix preserved).
 */
function makeHeartbeat(
  socket: SocketLike,
  intervalMs: number,
  payload: string,
  payloadBytes: number,
): HeartbeatHandle {
  const startedAt = Date.now();
  let bytes = 0;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(id);
  };

  const beat = (): void => {
    if (stopped || socket.writableEnded) return;
    try {
      socket.write(payload);
      bytes += payloadBytes;
    } catch {
      // EPIPE on a closed socket — clean up silently (Pitfall 3).
      stop();
    }
  };

  const id = setInterval(beat, intervalMs);
  // Don't keep the event loop alive just for the heartbeat — graceful shutdown should
  // not block on a 15s timer.
  // Node 22 Timeout always has unref() — optional chain was unnecessary (IN-04).
  id.unref();

  return {
    stop,
    get bytesSinceStart() {
      return bytes;
    },
    get msSinceStart() {
      return Date.now() - startedAt;
    },
  };
}

/**
 * Start the OpenAI-surface heartbeat — writes `: keep-alive\n\n` every `intervalMs`.
 * Phase 2 contract preserved byte-for-byte (tests in heartbeat.test.ts gate this).
 */
export function startHeartbeat(socket: SocketLike, intervalMs = 15_000): HeartbeatHandle {
  return makeHeartbeat(socket, intervalMs, OPENAI_HEARTBEAT_PAYLOAD, OPENAI_HEARTBEAT_PAYLOAD_BYTES);
}

/**
 * Plan 04-03 (ANTHR-06) — Anthropic-surface heartbeat. Writes a typed `event: ping`
 * frame every `intervalMs` so the SSE consumer sees the wire-correct `ping` event
 * (NOT the OpenAI `: keep-alive` comment line).
 */
export function startAnthropicHeartbeat(
  socket: SocketLike,
  intervalMs = 15_000,
): HeartbeatHandle {
  return makeHeartbeat(
    socket,
    intervalMs,
    ANTHROPIC_HEARTBEAT_PAYLOAD,
    ANTHROPIC_HEARTBEAT_PAYLOAD_BYTES,
  );
}
