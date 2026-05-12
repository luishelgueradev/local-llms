import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { startHeartbeat, type SocketLike } from '../../../src/sse/heartbeat.js';

function makeFakeSocket(): SocketLike & { writes: string[]; close: () => void } {
  const writes: string[] = [];
  let ended = false;
  return {
    write(chunk: string | Buffer): boolean {
      if (ended) throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' });
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
    get writableEnded(): boolean { return ended; },
    close(): void { ended = true; },
    writes,
  };
}

describe('SSE heartbeat helper (ROUTE-08, RESEARCH Pitfall 3)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes ": keep-alive\\n\\n" every intervalMs', () => {
    const sock = makeFakeSocket();
    const hb = startHeartbeat(sock, 1_000);
    expect(sock.writes).toHaveLength(0);  // not yet
    vi.advanceTimersByTime(1_000);
    expect(sock.writes).toEqual([': keep-alive\n\n']);
    vi.advanceTimersByTime(2_000);
    expect(sock.writes).toHaveLength(3);
    hb.stop();
  });

  it('default intervalMs is 15000 when no arg passed', () => {
    const sock = makeFakeSocket();
    const hb = startHeartbeat(sock);
    vi.advanceTimersByTime(14_000);
    expect(sock.writes).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(sock.writes).toHaveLength(1);
    hb.stop();
  });

  it('.stop() clears the interval', () => {
    const sock = makeFakeSocket();
    const hb = startHeartbeat(sock, 100);
    vi.advanceTimersByTime(150);
    expect(sock.writes).toHaveLength(1);
    hb.stop();
    vi.advanceTimersByTime(1_000);
    expect(sock.writes).toHaveLength(1);  // no more after stop
  });

  it('.stop() is idempotent', () => {
    const sock = makeFakeSocket();
    const hb = startHeartbeat(sock, 100);
    hb.stop();
    expect(() => hb.stop()).not.toThrow();
  });

  it('.bytesSinceStart counts bytes written', () => {
    const sock = makeFakeSocket();
    const hb = startHeartbeat(sock, 100);
    expect(hb.bytesSinceStart).toBe(0);
    vi.advanceTimersByTime(300);
    expect(hb.bytesSinceStart).toBeGreaterThan(0);
    hb.stop();
  });

  it('.msSinceStart returns elapsed ms', () => {
    const sock = makeFakeSocket();
    const hb = startHeartbeat(sock);
    vi.advanceTimersByTime(5_000);
    expect(hb.msSinceStart).toBeGreaterThanOrEqual(5_000);
    hb.stop();
  });

  it('does not throw EPIPE if the underlying socket is closed', () => {
    const sock = makeFakeSocket();
    const hb = startHeartbeat(sock, 100);
    sock.close();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    hb.stop();
  });
});
