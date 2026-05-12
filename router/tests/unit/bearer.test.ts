import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { makeBearerHook } from '../../src/auth/bearer.js';
import { NO_ENVELOPE, mapToHttpStatus, toOpenAIErrorEnvelope } from '../../src/errors/envelope.js';

const TOKEN = 'local-llms_a1b2c3d4e5f6abcdefabcdefabcdefab';

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Production wires the hook on 'onRequest' (app.ts:46) so auth gates run before
  // body parsing — IN-04 alignment. Match that here so the unit test exercises the
  // same hook phase as production.
  app.addHook('onRequest', makeBearerHook(TOKEN));
  // WR-06: makeBearerHook now throws BearerAuthError instead of inlining the
  // 401 envelope. Register the same setErrorHandler as buildApp() so the throw
  // flows through the D-C1 path and the response shape matches integration.
  app.setErrorHandler((err, _req, reply) => {
    const env = toOpenAIErrorEnvelope(err);
    if (env === NO_ENVELOPE) return;
    reply.code(mapToHttpStatus(err)).send(env);
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.post('/v1/chat/completions', async () => ({ ok: true }));
  return app;
}

describe('bearer auth preHandler (ROUTE-03, SC4 auth half)', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { message: 'Missing or malformed Authorization header', type: 'authentication_error', code: 'unauthorized', param: null },
    });
  });

  it('returns 401 when Authorization header is malformed (no Bearer prefix)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: TOKEN } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when bearer token is wrong (constant-time false)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('returns 401 when bearer token has different length (length-padding branch)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: 'Bearer short' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('passes through when bearer token matches (constant-time true)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('skips auth on /healthz (PUBLIC_PATHS)', async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('skips auth on /healthz even with a wrong token', async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: 'GET', url: '/healthz',
      headers: { authorization: 'Bearer totally-wrong' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('NEVER logs the supplied bearer value (SC5 baseline)', async () => {
    const lines: string[] = [];
    const app = Fastify({ logger: { level: 'warn', stream: { write: (m: string) => lines.push(m) } } as never });
    app.addHook('onRequest', makeBearerHook(TOKEN));
    // Same setErrorHandler as production so the BearerAuthError throw (WR-06)
    // flows through `req.log.warn` exactly once via D-C1.
    app.setErrorHandler((err, req, reply) => {
      const env = toOpenAIErrorEnvelope(err);
      if (env === NO_ENVELOPE) return;
      req.log.warn({ err, url: req.url }, 'route error -> envelope');
      reply.code(mapToHttpStatus(err)).send(env);
    });
    app.post('/v1/anything', async () => ({}));

    const leakValue = 'leakvalueXYZ';
    await app.inject({
      method: 'POST', url: '/v1/anything',
      headers: { authorization: `Bearer ${leakValue}` },
    });
    const all = lines.join('\n');
    expect(all).not.toContain(leakValue);
  });
});
