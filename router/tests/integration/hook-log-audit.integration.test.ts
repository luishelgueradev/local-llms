/**
 * Phase 18 / v0.11.0 — RETR-04 (hook_log JSONB audit trail).
 * Plan 18-08 (final phase): 10 it.todo flipped to real it().
 *
 * Audit-trail integration tests for the `request_log.hook_log` JSONB column
 * added by migration 0007. These tests use a CAPTURING fake `BufferedWriter`
 * (the production buffered writer's push() is shimmed to collect rows in
 * memory) rather than gating on `PG_TESTS=1`. This is structurally
 * equivalent because:
 *
 *   - The buffered writer's contract is to push `RequestLogInsert` rows
 *     whose shape matches the Drizzle schema (`hook_log: jsonb('hook_log')`).
 *   - `recordOutcome` is the single producer of those rows.
 *   - JSONB serialization (Drizzle / pg) is downstream of recordOutcome and
 *     covered by `tests/integration/migrations/0007-hook-log.test.ts`
 *     (PG-gated `INSERT/SELECT` round-trip).
 *
 * Privacy invariant (P5-05): `hook_log[].chars_retrieved` records the
 * truncated-content length, but the FULL retrieved text is NEVER persisted.
 * `error_message` is bounded to 500 chars and redacts bearer-shaped strings
 * (handled by `redactBearer` inside runHookChain).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  makeFakeMetrics,
  makeFakeRetrieverProvider,
} from '../fakes.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';
import type {
  BackendAdapter,
  AdapterFactory,
} from '../../src/backends/adapter.js';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from '../../src/translation/canonical.js';
import type { PreCompletionHook } from '../../src/hooks/pre-completion.js';
import type { BufferedWriter } from '../../src/db/bufferedWriter.js';
import type { RequestLogInsert } from '../../src/db/schema/index.js';

const TOKEN = 'local-llms_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHAT_MODEL = 'qwen2.5:7b';
const YAML = `
models:
  - name: ${CHAT_MODEL}
    backend: ollama
    backend_url: http://upstream-mock:11434/v1
    backend_model: ${CHAT_MODEL}
    capabilities: [chat]
    vram_budget_gb: 4
backends:
  ollama:
    concurrency: 5
    queue_max_wait_ms: 30000
`;

function makeCapturingBufferedWriter(): {
  writer: BufferedWriter;
  rows: RequestLogInsert[];
} {
  const rows: RequestLogInsert[] = [];
  const writer: BufferedWriter = {
    push: (row) => {
      rows.push(row);
    },
    drain: async () => {},
    get size() {
      return rows.length;
    },
  };
  return { writer, rows };
}

function makeNoopAdapterFactory(): AdapterFactory {
  return () => {
    const adapter: BackendAdapter = {
      async chatCompletionsCanonical(
        canonical: CanonicalRequest,
      ): Promise<CanonicalResponse> {
        return {
          id: 'msg_audit',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: canonical.model,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 5 },
        };
      },
      async chatCompletionsCanonicalStream(): Promise<
        AsyncIterable<CanonicalStreamEvent>
      > {
        throw new Error('not used');
      },
      async probeLiveness() {
        return { ok: true, latencyMs: 0 };
      },
      async embeddings() {
        throw new Error('not used');
      },
      async rerank() {
        throw new Error('not used');
      },
    };
    return adapter;
  };
}

async function buildAppForAudit(
  bufferedWriter: BufferedWriter,
  hooks: PreCompletionHook[],
): Promise<FastifyInstance> {
  const registry = makeRegistryStore(loadRegistryFromString(YAML));
  const preHooks = new Map<string, PreCompletionHook[]>();
  if (hooks.length > 0) preHooks.set('/v1/chat/completions', hooks);
  return buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: makeNoopAdapterFactory(),
    semaphores: {
      get: () =>
        ({
          acquire: async () => () => {},
          stats: () => ({ inFlight: 0, queued: 0 }),
        }) as never,
    },
    bufferedWriter,
    metrics: makeFakeMetrics(),
    preCompletionHooks: preHooks,
  });
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
  };
}

let app: FastifyInstance | undefined;

beforeEach(() => {});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  vi.restoreAllMocks();
});

interface HookLogEntryRow {
  hook_name: string;
  context_hash: string;
  latency_ms: number;
  chars_retrieved: number;
  status: string;
  error_message?: string;
}

function pickHookLog(row: RequestLogInsert): HookLogEntryRow[] | null {
  return row.hook_log as HookLogEntryRow[] | null;
}

describe('RETR-04: hook_log JSONB audit trail', () => {
  it('request_log row has hook_log JSONB column populated when hook ran', async () => {
    const { writer, rows } = makeCapturingBufferedWriter();
    const hook: PreCompletionHook = {
      name: 'doc-hook',
      retriever: makeFakeRetrieverProvider({
        documents: [{ content: 'doc-content' }],
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    app = await buildAppForAudit(writer, [hook]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(rows.length).toBe(1);
    const hookLog = pickHookLog(rows[0]);
    expect(hookLog).not.toBeNull();
    expect(hookLog!.length).toBe(1);
    expect(hookLog![0].hook_name).toBe('doc-hook');
  });

  it('hook_log row contains hook_name, context_hash (SHA256), latency_ms, chars_retrieved, status', async () => {
    const { writer, rows } = makeCapturingBufferedWriter();
    const hook: PreCompletionHook = {
      name: 'shape-hook',
      retriever: makeFakeRetrieverProvider({
        documents: [{ content: 'some content' }],
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    app = await buildAppForAudit(writer, [hook]);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    const entry = pickHookLog(rows[0])![0];
    expect(entry.hook_name).toBe('shape-hook');
    expect(entry.context_hash).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex
    expect(typeof entry.latency_ms).toBe('number');
    expect(entry.latency_ms).toBeGreaterThanOrEqual(0);
    expect(typeof entry.chars_retrieved).toBe('number');
    expect(entry.chars_retrieved).toBeGreaterThan(0);
    expect(entry.status).toBe('ok');
  });

  it('hook_log NEVER contains full retrieved content (privacy + P5-05)', async () => {
    const { writer, rows } = makeCapturingBufferedWriter();
    const SECRET_CONTENT = 'TOP_SECRET_BLAH_BLAH_xyzzy_42';
    const hook: PreCompletionHook = {
      name: 'privacy-hook',
      retriever: makeFakeRetrieverProvider({
        documents: [{ content: SECRET_CONTENT }],
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    app = await buildAppForAudit(writer, [hook]);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    const hookLogJson = JSON.stringify(pickHookLog(rows[0]));
    // The full retrieved content MUST NOT appear in the audit row.
    expect(hookLogJson).not.toContain(SECRET_CONTENT);
    // Only the SHA256 hash should be present.
    expect(hookLogJson).toMatch(/"context_hash":"[a-f0-9]{64}"/);
  });

  it('hook_log status:"ok" on happy path', async () => {
    const { writer, rows } = makeCapturingBufferedWriter();
    const hook: PreCompletionHook = {
      name: 'happy',
      retriever: makeFakeRetrieverProvider({
        documents: [{ content: 'ok' }],
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    app = await buildAppForAudit(writer, [hook]);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    expect(pickHookLog(rows[0])![0].status).toBe('ok');
  });

  it('hook_log status:"truncated" when retrieved content > max_chars', async () => {
    const { writer, rows } = makeCapturingBufferedWriter();
    // Generate content larger than max_chars cap.
    const big = 'X'.repeat(10_000);
    const hook: PreCompletionHook = {
      name: 'trunc',
      retriever: makeFakeRetrieverProvider({
        documents: [{ content: big }],
      }),
      timeout_ms: 5000,
      max_chars: 1000, // forces truncation
      on_timeout: 'fail-open',
    };
    app = await buildAppForAudit(writer, [hook]);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    const entry = pickHookLog(rows[0])![0];
    expect(entry.status).toBe('truncated');
    // chars_retrieved reflects the POST-truncate length.
    expect(entry.chars_retrieved).toBeLessThanOrEqual(1000);
  });

  it('hook_log status:"timeout" on Promise.race timeout', async () => {
    const { writer, rows } = makeCapturingBufferedWriter();
    const hook: PreCompletionHook = {
      name: 'timeout-h',
      retriever: makeFakeRetrieverProvider({ shouldTimeout: true }),
      timeout_ms: 50,
      max_chars: 4000,
      on_timeout: 'fail-open', // fail-open so audit lands + request succeeds
    };
    app = await buildAppForAudit(writer, [hook]);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    expect(pickHookLog(rows[0])![0].status).toBe('timeout');
  });

  it('hook_log status:"error" on retriever throw', async () => {
    const { writer, rows } = makeCapturingBufferedWriter();
    const hook: PreCompletionHook = {
      name: 'err-h',
      retriever: makeFakeRetrieverProvider({
        shouldThrow: new Error('retriever boom'),
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    app = await buildAppForAudit(writer, [hook]);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    expect(pickHookLog(rows[0])![0].status).toBe('error');
  });

  it('hook_log error_message redacts bearer-shaped strings (no Bearer xxxxxxxx leakage)', async () => {
    const { writer, rows } = makeCapturingBufferedWriter();
    const LEAKY_ERR = new Error(
      'upstream 401: Authorization: Bearer abcdef1234567890ABCDEFGHIJ secret-leak',
    );
    const hook: PreCompletionHook = {
      name: 'leaky',
      retriever: makeFakeRetrieverProvider({ shouldThrow: LEAKY_ERR }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    app = await buildAppForAudit(writer, [hook]);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    const entry = pickHookLog(rows[0])![0];
    expect(entry.error_message).toBeDefined();
    // Bearer token portion redacted; literal raw token must NOT survive.
    expect(entry.error_message).not.toContain('abcdef1234567890ABCDEFGHIJ');
    expect(entry.error_message).toContain('[REDACTED]');
  });

  it('no hooks ran: hook_log column is NULL (not empty array)', async () => {
    const { writer, rows } = makeCapturingBufferedWriter();
    // No hooks registered — Frame-01 production composition.
    app = await buildAppForAudit(writer, []);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    expect(rows.length).toBe(1);
    // ctx.hookLog is undefined → row.hook_log = null (distinct from [] empty array).
    expect(pickHookLog(rows[0])).toBeNull();
  });

  it('two hooks in chain: hook_log has 2 entries in declaration order (RESOLVED #3)', async () => {
    const { writer, rows } = makeCapturingBufferedWriter();
    const hookA: PreCompletionHook = {
      name: 'hook-A-first',
      retriever: makeFakeRetrieverProvider({
        documents: [{ content: 'A-content' }],
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    const hookB: PreCompletionHook = {
      name: 'hook-B-second',
      retriever: makeFakeRetrieverProvider({
        documents: [{ content: 'B-content' }],
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    app = await buildAppForAudit(writer, [hookA, hookB]);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    const log = pickHookLog(rows[0])!;
    expect(log.length).toBe(2);
    expect(log[0].hook_name).toBe('hook-A-first');
    expect(log[1].hook_name).toBe('hook-B-second');
  });
});
