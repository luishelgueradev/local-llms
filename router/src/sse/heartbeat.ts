/**
 * SSE heartbeat helper. Writes ": keep-alive\n\n" (a comment line; SSE spec — pings
 * without payload) every `intervalMs` to keep proxies + clients from hanging up
 * on long quiet periods. ROUTE-08 + RESEARCH §Pattern 3 + Pitfall 3.
 *
 * Returns a handle with `.stop()` (idempotent), `.bytesSinceStart`, `.msSinceStart`.
 * The route handler MUST call `.stop()` from BOTH the close handler AND the
 * iterator's `finally` (belt-and-suspenders against EPIPE + open-handle leaks).
 */

export interface HeartbeatHandle {
  stop(): void;
  readonly bytesSinceStart: number;
  readonly msSinceStart: number;
}

/**
 * Minimal interface accepted by startHeartbeat — ServerResponse + the few methods
 * we need. Allows unit tests to inject a fake without bringing in `http.ServerResponse`.
 */
export interface SocketLike {
  write(chunk: string | Buffer): boolean;
  writableEnded?: boolean;
}

// ': keep-alive\n\n' is 14 bytes UTF-8 (':' + ' ' + 'keep-alive' + '\n' + '\n').
// Compute once at module load so the per-beat counter never drifts (WR-01 fix).
const HEARTBEAT_PAYLOAD = ': keep-alive\n\n';
const HEARTBEAT_PAYLOAD_BYTES = Buffer.byteLength(HEARTBEAT_PAYLOAD, 'utf8');

export function startHeartbeat(socket: SocketLike, intervalMs = 15_000): HeartbeatHandle {
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
      socket.write(HEARTBEAT_PAYLOAD);
      bytes += HEARTBEAT_PAYLOAD_BYTES;
    } catch {
      // EPIPE on a closed socket — clean up silently (Pitfall 3).
      stop();
    }
  };

  const id = setInterval(beat, intervalMs);
  // Don't keep the event loop alive just for the heartbeat — graceful shutdown should
  // not block on a 15s timer.
  id.unref?.();

  return {
    stop,
    get bytesSinceStart() { return bytes; },
    get msSinceStart() { return Date.now() - startedAt; },
  };
}
