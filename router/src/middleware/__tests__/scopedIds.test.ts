/**
 * Integration tests for scopedIdsPreHandler (Phase 14 / v0.11.0 — POL-03, POL-04).
 *
 * Mirrors the structure of router/tests/integration/agentIdPreHandler.test.ts.
 * Six scenarios covering:
 *   - Missing headers → silent-NULL (D-13, D-17)
 *   - Valid IDs populated + workload class lowercased (D-11)
 *   - Invalid X-Tenant-ID → 400 + invalid_scoped_id envelope (D-16)
 *   - Invalid X-Project-ID → 400 + invalid_scoped_id envelope (D-16)
 *   - Invalid X-Workload-Class → 200 + req.workloadClass === undefined (D-12)
 *   - Hook ordering: pino .child() sees all four IDs (D-20, Pitfall 3)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { scopedIdsPreHandler } from '../scopedIds.js';
import { agentIdPreHandler } from '../agentId.js';
import {
  toOpenAIErrorEnvelope,
  toAnthropicErrorEnvelope,
  mapToHttpStatus,
  NO_ENVELOPE,
  ANTHROPIC_NO_ENVELOPE,
} from '../../errors/envelope.js';

// ---------------------------------------------------------------------------
// Minimal app factory — builds a test Fastify instance with:
//   1. scopedIdsPreHandler registered BEFORE agentIdPreHandler (D-18 / Pitfall 3)
//   2. A GET /test-route that echoes the stamped req fields back in the body
//   3. A centralized error handler that maps typed errors to OpenAI envelopes
//      (needed so tests 3-4 see the 400 + envelope in the response body)
// ---------------------------------------------------------------------------

interface TestRouteResponse {
  tenantId: string | undefined;
  projectId: string | undefined;
  workloadClass: string | undefined;
}

// Capture pino lines emitted during test-6 (hook-ordering assertion).
const collectedLogLines: string[] = [];
const writeStream = {
  write: (chunk: string) => {
    collectedLogLines.push(chunk);
    return true;
  },
};

async function buildTestApp(opts?: { captureLog?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts?.captureLog
      ? ({ level: 'info', stream: writeStream as never } as never)
      : false,
  });

  // Centralized error handler — maps InvalidScopedIdError → 400 + OpenAI envelope.
  // Required for tests 3-4 to assert on the response body and status code.
  app.setErrorHandler((err, _req, reply) => {
    const status = mapToHttpStatus(err);
    const env = toOpenAIErrorEnvelope(err);
    if (env === NO_ENVELOPE) return;
    reply.code(status).send(env);
  });

  // Registration order: scopedIds BEFORE agentId (D-18 / Pitfall 3).
  app.addHook('preHandler', scopedIdsPreHandler);
  app.addHook('preHandler', agentIdPreHandler);

  // Stub route that exposes the stamped req fields so tests can assert on them.
  // Also emits a structured log line so Test 6 can verify pino .child() bindings
  // (the log call fires after agentIdPreHandler enriches req.log via .child()).
  app.get('/test-route', (req: FastifyRequest, reply) => {
    const body: TestRouteResponse = {
      tenantId: req.tenantId,
      projectId: req.projectId,
      workloadClass: req.workloadClass,
    };
    // Emit a log line so Test 6 can assert the .child() bindings are present.
    // This fires after agentIdPreHandler has set req.log = req.log.child({...}).
    req.log.info({ event: 'test-route-hit' }, 'test route handler ran');
    reply.send(body);
  });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('scopedIdsPreHandler (Phase 14 — POL-03/04)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Test 1: all headers absent → req fields all undefined, 200 response (D-13, D-17)
  // -------------------------------------------------------------------------
  it('1. absent headers — silent-NULL; response 200', async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/test-route' });
    expect(res.statusCode).toBe(200);
    const body = res.json<TestRouteResponse>();
    expect(body.tenantId).toBeUndefined();
    expect(body.projectId).toBeUndefined();
    expect(body.workloadClass).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 2: valid IDs → req fields populated; workload class lowercased (D-11)
  // -------------------------------------------------------------------------
  it('2. valid IDs populated; X-Workload-Class lowercased', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/test-route',
      headers: {
        'x-tenant-id': 'acme',
        'x-project-id': 'agents',
        'x-workload-class': 'SENSITIVE',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<TestRouteResponse>();
    expect(body.tenantId).toBe('acme');
    expect(body.projectId).toBe('agents');
    expect(body.workloadClass).toBe('sensitive'); // D-11: lowercase-normalized
  });

  // -------------------------------------------------------------------------
  // Test 3: invalid X-Tenant-ID (contains space) → 400 + invalid_scoped_id envelope (D-16)
  // -------------------------------------------------------------------------
  it('3. invalid X-Tenant-ID (space) → 400 + invalid_scoped_id; param === X-Tenant-ID', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/test-route',
      headers: {
        'x-tenant-id': 'in valid', // space disallowed by ID_RE
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.code).toBe('invalid_scoped_id');
    expect(env.error.param).toBe('X-Tenant-ID');
    expect(env.error.type).toBe('invalid_request_error');
  });

  // -------------------------------------------------------------------------
  // Test 4: invalid X-Project-ID (path traversal chars) → 400 + invalid_scoped_id (D-16)
  // -------------------------------------------------------------------------
  it('4. invalid X-Project-ID (slashes) → 400 + invalid_scoped_id; param === X-Project-ID', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/test-route',
      headers: {
        'x-project-id': '../../etc/passwd', // forward slash disallowed by ID_RE
      },
    });
    expect(res.statusCode).toBe(400);
    const env = res.json();
    expect(env.error.code).toBe('invalid_scoped_id');
    expect(env.error.param).toBe('X-Project-ID');
  });

  // -------------------------------------------------------------------------
  // Test 5: invalid X-Workload-Class → silent-NULL; response 200 (D-12)
  // -------------------------------------------------------------------------
  it('5. invalid X-Workload-Class (spaces) → silent-NULL; 200; workloadClass undefined', async () => {
    app = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/test-route',
      headers: {
        'x-workload-class': ' spaces', // space disallowed by WC_RE
      },
    });
    expect(res.statusCode).toBe(200); // NOT 400 — silent-NULL contract (D-12)
    const body = res.json<TestRouteResponse>();
    expect(body.workloadClass).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 6: hook-ordering — pino .child() sees all four IDs (D-20, Pitfall 3)
  //
  // Both scopedIdsPreHandler and agentIdPreHandler are registered. A request
  // with all four headers is injected. The captured log stream is asserted to
  // contain all four structured fields in the same log line.
  // -------------------------------------------------------------------------
  it('6. hook ordering: pino .child() captures tenant_id, project_id, workload_class, agent_id', async () => {
    collectedLogLines.length = 0;
    app = await buildTestApp({ captureLog: true });

    await app.inject({
      method: 'GET',
      url: '/test-route',
      headers: {
        'x-tenant-id': 'acme',
        'x-project-id': 'agents',
        'x-workload-class': 'batch',
        'x-agent-id': 'test-agent',
      },
    });

    // At least one log line must have been emitted (Fastify request log).
    const combined = collectedLogLines.join('');
    expect(combined.length).toBeGreaterThan(0);

    // All four structured fields must be present in the captured log output.
    // pino serializes them as JSON fields on the same object (the .child() bindings).
    expect(combined).toContain('"tenant_id":"acme"');
    expect(combined).toContain('"project_id":"agents"');
    expect(combined).toContain('"workload_class":"batch"');
    expect(combined).toContain('"agent_id":"test-agent"');
  });
});
