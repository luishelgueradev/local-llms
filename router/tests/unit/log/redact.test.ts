import { describe, expect, it } from 'vitest';
// pino is a transitive dep of fastify; resolve via the package the project actually uses.
import pino from 'pino';
import { makeLoggerOptions } from '../../../src/log/logger.js';

function captureLog(record: unknown): string {
  const opts = makeLoggerOptions({ isDev: false });
  // makeLoggerOptions returns a Fastify-compatible options object; for pino direct,
  // we extract the redact + base + level fields. transport: undefined in prod mode.
  const lines: string[] = [];
  const dest = { write: (chunk: string) => { lines.push(chunk); return true; } };
  const logger = pino({
    level: 'info',
    base: (opts as Record<string, unknown>)['base'] as Record<string, unknown>,
    redact: (opts as Record<string, unknown>)['redact'] as pino.redactOptions,
  }, dest as unknown as pino.DestinationStream);
  logger.info(record as Record<string, unknown>, 'test');
  return lines.join('');
}

describe('pino redact (ROUTE-05, SC5)', () => {
  it('redacts req.headers.authorization to [REDACTED]', () => {
    const out = captureLog({ req: { headers: { authorization: 'Bearer local-llms_secretXYZ' } } });
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('local-llms_secretXYZ');
    expect(out).not.toContain('Bearer local-llms_secretXYZ');
  });

  it('redacts req.headers.cookie to [REDACTED]', () => {
    const out = captureLog({ req: { headers: { cookie: 'sid=hunter2' } } });
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('hunter2');
  });

  it('redacts top-level headers.authorization (when an err carries root headers)', () => {
    const out = captureLog({ headers: { authorization: 'Bearer leakvalue' } });
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('leakvalue');
  });

  it('redacts *.apiKey and *.api_key wildcards', () => {
    const out = captureLog({ config: { apiKey: 'sk-leak1' }, payload: { api_key: 'sk-leak2' } });
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-leak1');
    expect(out).not.toContain('sk-leak2');
  });

  it('output JSON does NOT contain the literal bearer value (SC5 baseline)', () => {
    const tok = 'local-llms_a1b2c3d4e5f6';
    const out = captureLog({ req: { headers: { authorization: `Bearer ${tok}` } } });
    expect(out.match(/local-llms_[a-z0-9]+/i)).toBeNull();
  });
});
