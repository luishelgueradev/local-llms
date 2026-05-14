/**
 * heartbeat.anthropic.test.ts — Unit tests for startAnthropicHeartbeat (Plan 04-03).
 *
 * Sibling to heartbeat.test.ts. The Anthropic heartbeat emits a typed SSE event
 * (`event: ping\ndata: {"type":"ping"}\n\n`) at each interval — NOT the `: keep-alive`
 * comment line used by the OpenAI heartbeat. Both helpers share the internal
 * `makeHeartbeat(socket, intervalMs, payload, payloadBytes)` machinery so the
 * idempotent-stop + EPIPE-safe + id.unref?.() behavior is identical.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { startAnthropicHeartbeat, type SocketLike } from '../../../src/sse/heartbeat.js';

function makeFakeSocket(): SocketLike & { writes: string[]; close: () => void } {
  const writes: string[] = [];
  let ended = false;
  return {
    write(chunk: string | Buffer): boolean {
      if (ended) throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
    get writableEnded(): boolean {
      return ended;
    },
    close(): void {
      ended = true;
    },
    writes,
  };
}

const ANTHROPIC_PING_PAYLOAD = 'event: ping\ndata: {"type":"ping"}\n\n';

describe('startAnthropicHeartbeat (Plan 04-03 — ANTHR-06 ping payload)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes Anthropic ping payload at each interval', () => {
    const sock = makeFakeSocket();
    const hb = startAnthropicHeartbeat(sock, 1_000);
    expect(sock.writes).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(sock.writes).toEqual([ANTHROPIC_PING_PAYLOAD]);
    vi.advanceTimersByTime(2_000);
    expect(sock.writes).toHaveLength(3);
    hb.stop();
  });

  it('default intervalMs is 15000 when no arg passed', () => {
    const sock = makeFakeSocket();
    const hb = startAnthropicHeartbeat(sock);
    vi.advanceTimersByTime(14_000);
    expect(sock.writes).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(sock.writes).toHaveLength(1);
    expect(sock.writes[0]).toBe(ANTHROPIC_PING_PAYLOAD);
    hb.stop();
  });

  it('.stop() clears the interval', () => {
    const sock = makeFakeSocket();
    const hb = startAnthropicHeartbeat(sock, 100);
    vi.advanceTimersByTime(150);
    expect(sock.writes).toHaveLength(1);
    hb.stop();
    vi.advanceTimersByTime(1_000);
    expect(sock.writes).toHaveLength(1);
  });

  it('.stop() is idempotent', () => {
    const sock = makeFakeSocket();
    const hb = startAnthropicHeartbeat(sock, 100);
    hb.stop();
    expect(() => hb.stop()).not.toThrow();
  });

  it('.bytesSinceStart counts ping bytes', () => {
    const sock = makeFakeSocket();
    const hb = startAnthropicHeartbeat(sock, 100);
    expect(hb.bytesSinceStart).toBe(0);
    vi.advanceTimersByTime(100);
    expect(hb.bytesSinceStart).toBe(Buffer.byteLength(ANTHROPIC_PING_PAYLOAD, 'utf8'));
    vi.advanceTimersByTime(100);
    expect(hb.bytesSinceStart).toBe(2 * Buffer.byteLength(ANTHROPIC_PING_PAYLOAD, 'utf8'));
    hb.stop();
  });

  it('.msSinceStart returns elapsed ms', () => {
    const sock = makeFakeSocket();
    const hb = startAnthropicHeartbeat(sock);
    vi.advanceTimersByTime(5_000);
    expect(hb.msSinceStart).toBeGreaterThanOrEqual(5_000);
    hb.stop();
  });

  it('does not throw EPIPE if the underlying socket is closed', () => {
    const sock = makeFakeSocket();
    const hb = startAnthropicHeartbeat(sock, 100);
    sock.close();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    hb.stop();
  });
});
