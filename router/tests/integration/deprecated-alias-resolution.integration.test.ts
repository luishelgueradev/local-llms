/**
 * Phase 20 / CAT-04 (v0.12.0 — D-03 LOCKED) — end-to-end integration tests for
 * the deprecation alias surface.
 *
 * Coverage (6 cases):
 *   1. Happy path — POST /v1/chat/completions with a deprecated alias resolves
 *      to the canonical target, returns 200, ships X-Deprecated-Alias header,
 *      logs structured warn event, increments
 *      router_deprecated_alias_used_total{old_name, new_name}=1.
 *   2. Pass-through — canonical alias dispatch behaves identically to v0.11.x:
 *      NO X-Deprecated-Alias header, NO counter increment.
 *   3. Unknown-alias 404 preserved — totally-bogus alias still yields
 *      model_not_found (deprecation layer does NOT mask the unknown path).
 *   4. /v1/models surface invariant — deprecated key (a Wave 0 disabled entry)
 *      DOES NOT appear in /v1/models, AND the canonical target's projected
 *      entry carries the informational `deprecated_aliases` metadata.
 *   5. POL-06 cardinality — scrape /metrics, find the
 *      router_deprecated_alias_used_total HELP/TYPE block, assert NO label key
 *      ends in `_id` (preserves Phase 14 invariant).
 *   6. Structured log shape — the warn log emitted by the route carries the
 *      JSON event shape resolved in Open Q2 (matches router/src/logger.ts
 *      structured-pino conventions).
 *
 * Strategy: fake adapter returns a synthetic non-stream chat-completion
 * response. No live ollama dependency. Custom log destination captures pino
 * output for shape assertions. fresh MetricsRegistry per test so counter
 * baselines are clean.
 */
import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter } from '../fakes.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
import { loadRegistryFromString, makeRegistryStore } from '../../src/config/registry.js';
import type { BackendAdapter } from '../../src/backends/adapter.js';

const TOKEN = 'local-llms_20_04_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';

/** Fixture YAML — chat-local canonical + qwen2.5-7b-instruct-q4km deprecated → chat-local. */
const DEPRECATION_YAML = `
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4

  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5-7b-q4km.gguf
    capabilities: [chat]
    vram_budget_gb: 4
    disabled: true

deprecated_aliases:
  qwen2.5-7b-instruct-q4km:
    target: chat-local
    deprecated_since: v0.12.0
    removal_target: v0.13.0
`;

/**
 * Build an adapter that returns a synthetic canonical chat-completion response.
 * The route's non-stream branch consumes this; we never hit a real backend.
 * Canonical shape is Anthropic Message (see translation/canonical.ts).
 */
const FAKE_CANONICAL_RESPONSE = {
  id: 'dep-alias-test-id',
  type: 'message' as const,
  role: 'assistant' as const,
  model: 'qwen2.5:7b-instruct-q4_K_M',
  content: [{ type: 'text' as const, text: 'pong' }],
  stop_reason: 'end_turn' as const,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

function makeFakeAdapter(): BackendAdapter {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub for non-stream path
    chatCompletionsCanonical: async (): Promise<any> => FAKE_CANONICAL_RESPONSE,
    // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
    chatCompletionsCanonicalStream: async (): Promise<any> => {
      throw new Error('stream path not exercised');
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
    embeddings: async (): Promise<any> => {
      throw new Error('embeddings not exercised');
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal adapter stub
    rerank: async (): Promise<any> => {
      throw new Error('rerank not exercised');
    },
    probeLiveness: async (): Promise<{ ok: boolean; latencyMs: number }> => ({
      ok: true,
      latencyMs: 1,
    }),
  } as unknown as BackendAdapter;
}

/**
 * Capture pino log lines via a Writable destination. The line format is JSON;
 * we parse each line for shape assertions in Test 6.
 */
function mkLogSink(): { lines: Array<Record<string, unknown>>; stream: Writable } {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // pino may emit non-JSON in some configurations; ignore.
        }
      }
      cb();
    },
  });
  return { lines, stream };
}

async function buildTestApp(opts?: {
  yaml?: string;
  logSink?: Writable;
}): Promise<{ app: FastifyInstance; metrics: ReturnType<typeof makeMetricsRegistry> }> {
  const yaml = opts?.yaml ?? DEPRECATION_YAML;
  const registry = makeRegistryStore(loadRegistryFromString(yaml));
  const metrics = makeMetricsRegistry();
  const app = await buildApp({
    registry,
    bearerToken: TOKEN,
    // Route the pino logger to the test sink when provided; otherwise silent.
    loggerOpts: opts?.logSink
      ? ({ level: 'warn', stream: opts.logSink } as never)
      : (false as never),
    bufferedWriter: makeFakeBufferedWriter(),
    metrics,
    // biome-ignore lint/suspicious/noExplicitAny: BackendAdapter narrowing for stub
    makeAdapter: (() => makeFakeAdapter()) as any,
    cloudApiKey: 'test-cloud-key',
  });
  await app.ready();
  return { app, metrics };
}

describe('Phase 20 / CAT-04 — deprecation alias resolution (integration)', () => {
  it('1. happy path — deprecated alias resolves to canonical, ships header + counter increments', async () => {
    const { app, metrics } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'qwen2.5-7b-instruct-q4km',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-deprecated-alias']).toBe('chat-local');

      // Counter incremented exactly once with the right labels.
      const scraped = await metrics.register.metrics();
      expect(scraped).toMatch(
        /router_deprecated_alias_used_total\{old_name="qwen2\.5-7b-instruct-q4km",new_name="chat-local"\} 1/,
      );
    } finally {
      await app.close();
    }
  });

  it('2. pass-through — canonical alias produces NO X-Deprecated-Alias header and NO counter increment', async () => {
    const { app, metrics } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'chat-local',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-deprecated-alias']).toBeUndefined();

      // Counter not incremented at all. With prom-client, an un-incremented
      // counter only appears in /metrics if .labels(...).inc(0) was called.
      // We never pre-warm this counter, so a fresh registry's scrape should
      // contain only the HELP/TYPE lines (no series row).
      const scraped = await metrics.register.metrics();
      expect(scraped).not.toMatch(
        /router_deprecated_alias_used_total\{.*\} [1-9]/,
      );
    } finally {
      await app.close();
    }
  });

  it('3. unknown alias 404 preserved — deprecation layer does NOT mask model_not_found', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'totally-bogus',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
        },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe('model_not_found');
      // No deprecation header on the 404 either.
      expect(res.headers['x-deprecated-alias']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('4. /v1/models invariant — deprecated key absent, canonical carries deprecated_aliases metadata', async () => {
    const { app } = await buildTestApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        data: Array<{
          id: string;
          deprecated_aliases?: Array<{ old_name: string; deprecated_since: string; removal_target: string }>;
        }>;
      };
      // Wave 0 invariant: disabled entries are invisible.
      const ids = body.data.map((e) => e.id);
      expect(ids).not.toContain('qwen2.5-7b-instruct-q4km');
      expect(ids).toContain('chat-local');

      // Canonical entry carries informational deprecation metadata.
      const chatLocal = body.data.find((e) => e.id === 'chat-local');
      expect(chatLocal?.deprecated_aliases).toEqual([
        {
          old_name: 'qwen2.5-7b-instruct-q4km',
          deprecated_since: 'v0.12.0',
          removal_target: 'v0.13.0',
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it('5. POL-06 cardinality — new metric uses old_name + new_name, NO label ends in _id', async () => {
    const { app, metrics } = await buildTestApp();
    try {
      // Trigger one increment so the series materializes in /metrics.
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'qwen2.5-7b-instruct-q4km',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
        },
      });
      const scraped = await metrics.register.metrics();

      // Find the line for the new counter and parse the label set.
      const seriesLine = scraped
        .split('\n')
        .find((l) => l.startsWith('router_deprecated_alias_used_total{'));
      expect(seriesLine).toBeDefined();

      const labelBlock = seriesLine!.slice(
        seriesLine!.indexOf('{') + 1,
        seriesLine!.indexOf('}'),
      );
      const labelNames = labelBlock
        .split(',')
        .map((kv) => kv.split('=')[0]!.trim());
      // POL-06 invariant: no label name may end in '_id'.
      for (const name of labelNames) {
        expect(name).not.toMatch(/_id$/);
      }
      // And the two specific labels are present.
      expect(labelNames).toEqual(expect.arrayContaining(['old_name', 'new_name']));
    } finally {
      await app.close();
    }
  });

  it('6. structured log shape — warn event carries the JSON shape resolved by Open Q2', async () => {
    const sink = mkLogSink();
    const { app } = await buildTestApp({ logSink: sink.stream });
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'qwen2.5-7b-instruct-q4km',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 4,
        },
      });

      // The route emits exactly one warn line with event='deprecated_alias_used'.
      const depEvents = sink.lines.filter(
        (l) => l['event'] === 'deprecated_alias_used',
      );
      expect(depEvents).toHaveLength(1);
      const event = depEvents[0]!;
      // pino warn level is numeric (40 by default).
      expect(event['level']).toBe(40);
      expect(event['old_name']).toBe('qwen2.5-7b-instruct-q4km');
      expect(event['new_name']).toBe('chat-local');
      expect(event['deprecated_since']).toBe('v0.12.0');
      expect(event['removal_target']).toBe('v0.13.0');
      expect(event['msg']).toBe('deprecated alias resolved to canonical target');
    } finally {
      await app.close();
    }
  });
});
