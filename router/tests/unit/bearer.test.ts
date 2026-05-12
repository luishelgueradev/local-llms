import { describe, it } from 'vitest';

describe('bearer auth preHandler (ROUTE-03, SC4 auth half)', () => {
  it.todo('returns 401 when Authorization header is missing');
  it.todo('returns 401 when Authorization header is malformed');
  it.todo('returns 401 when bearer token is wrong (constant-time false)');
  it.todo('returns 401 when bearer token has different length (length-padding branch)');
  it.todo('passes through when bearer token matches (constant-time true)');
  it.todo('skips auth on /healthz (PUBLIC_PATHS)');
});
