import { describe, it } from 'vitest';

describe('SSE heartbeat helper (ROUTE-08) — implemented in plan 02-04', () => {
  it.todo('writes ": keep-alive\\n\\n" every 15000ms (default)');
  it.todo('.stop() clears the interval');
  it.todo('.bytesSinceStart counts bytes written');
  it.todo('.msSinceStart returns elapsed ms');
  it.todo('does not throw EPIPE if the underlying socket is closed');
});
