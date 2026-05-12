import { describe, it } from 'vitest';

describe('pino redact (ROUTE-05, SC5)', () => {
  it.todo('redacts req.headers.authorization to [REDACTED]');
  it.todo('redacts req.headers.cookie to [REDACTED]');
  it.todo('redacts *.apiKey and *.api_key to [REDACTED]');
  it.todo('redacts top-level headers.authorization (when err object has root headers)');
  it.todo('output JSON does NOT contain the literal bearer value');
});
