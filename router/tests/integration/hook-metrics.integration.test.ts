/**
 * Phase 18 / v0.11.0 — P5-02 (router_hook_duration_ms histogram).
 * Plan 18-08 (final phase): 5 it.todo flipped to real it().
 *
 * Integration tests for the per-hook Prometheus histogram metric. The
 * cardinality discipline (POL-06) restricts labels to `{hook_name, status}`
 * only — never including `agent_id` / `tenant_id` / `session_id` (those
 * would blow up cardinality by user count). The bucket layout
 * `[10, 50, 100, 250, 500, 1000, 2000, 5000]` ms matches the RESEARCH
 * §"Pattern 8 — Metrics" spec.
 *
 * Status values exercised:
 *   - "ok"      → happy-path retriever returned within timeout.
 *   - "timeout" → Promise.race timeout arm won (P5-02).
 *   - "error"   → retriever threw (network, schema, etc).
 *
 * Truncation (P5-03 BLOCK fence cap) is reflected in `hook_log` status
 * but does NOT spawn a separate metric series (truncation is a content-
 * shape adjustment, not a hook-level failure mode).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  makeFakeBufferedWriter,
  makeFakeMetrics,
  makeFakeRetrieverProvider,
} from '../fakes.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
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
import type { MetricsRegistry } from '../../src/metrics/registry.js';

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

function makeNoopAdapterFactory(): AdapterFactory {
  return () => {
    const adapter: BackendAdapter = {
      async chatCompletionsCanonical(
        canonical: CanonicalRequest,
      ): Promise<CanonicalResponse> {
        return {
          id: 'msg_metrics',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: canonical.model,
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
      async chatCompletionsCanonicalStream(): Promise<
        AsyncIterable<CanonicalStreamEvent>
      > {
        throw new Error('not used in metrics tests');
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

async function buildAppWithHookAndMetrics(
  metrics: MetricsRegistry,
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
    bufferedWriter: makeFakeBufferedWriter(),
    metrics,
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
let metrics: MetricsRegistry;

beforeEach(() => {
  metrics = makeMetricsRegistry();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  vi.restoreAllMocks();
});

describe('P5-02: router_hook_duration_ms histogram', () => {
  it('series router_hook_duration_ms{hook_name, status="ok"} present after happy-path hook', async () => {
    const hook: PreCompletionHook = {
      name: 'ok-hook',
      retriever: makeFakeRetrieverProvider({
        documents: [{ content: 'ok' }],
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    app = await buildAppWithHookAndMetrics(metrics, [hook]);
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
    // Series present in registry — prom-client format text scrape.
    const scrape = await metrics.register.metrics();
    expect(scrape).toMatch(/router_hook_duration_ms_bucket\{[^}]*hook_name="ok-hook"[^}]*status="ok"/);
  });

  it('series router_hook_duration_ms{hook_name, status="timeout"} present after timeout', async () => {
    const hook: PreCompletionHook = {
      name: 'timeout-hook',
      retriever: makeFakeRetrieverProvider({ shouldTimeout: true }),
      timeout_ms: 50, // fast timeout
      max_chars: 4000,
      on_timeout: 'fail-open', // continue on timeout to assert metric
    };
    app = await buildAppWithHookAndMetrics(metrics, [hook]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    expect(res.statusCode).toBe(200); // fail-open => still 200
    const scrape = await metrics.register.metrics();
    expect(scrape).toMatch(
      /router_hook_duration_ms_bucket\{[^}]*hook_name="timeout-hook"[^}]*status="timeout"/,
    );
  });

  it('series router_hook_duration_ms{hook_name, status="error"} present after retriever throw', async () => {
    const hook: PreCompletionHook = {
      name: 'error-hook',
      retriever: makeFakeRetrieverProvider({
        shouldThrow: new Error('retriever boom'),
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open', // fail-open observes error
    };
    app = await buildAppWithHookAndMetrics(metrics, [hook]);
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
    const scrape = await metrics.register.metrics();
    expect(scrape).toMatch(
      /router_hook_duration_ms_bucket\{[^}]*hook_name="error-hook"[^}]*status="error"/,
    );
  });

  it('histogram buckets match RESEARCH spec: [10, 50, 100, 250, 500, 1000, 2000, 5000]', () => {
    // Inspect the histogram's `buckets` directly via prom-client introspection.
    // The configured buckets are exposed via the underlying Histogram instance.
    const hist = metrics.routerHookDurationMs as unknown as {
      buckets?: number[];
      hashMap?: unknown;
    };
    // prom-client v15+ exposes buckets via private field after first observe;
    // also exposed at registration time via the Histogram options. We assert
    // by observing the scrape output bucket labels.
    metrics.routerHookDurationMs
      .labels({ hook_name: 'probe', status: 'ok' })
      .observe(1);
    // The scrape output will list every bucket boundary.
    return metrics.register.metrics().then((scrape: string) => {
      // Expected buckets — assert each is present in the scrape.
      for (const le of [10, 50, 100, 250, 500, 1000, 2000, 5000]) {
        expect(scrape).toMatch(
          new RegExp(`router_hook_duration_ms_bucket\\{[^}]*le="${le}"`),
        );
      }
      // Hist usage of var to satisfy linter.
      void hist;
    });
  });

  it('label names: only hook_name + status (POL-06 cardinality — no _id)', async () => {
    const hook: PreCompletionHook = {
      name: 'cardinality-probe',
      retriever: makeFakeRetrieverProvider({
        documents: [{ content: 'ok' }],
      }),
      timeout_ms: 5000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    app = await buildAppWithHookAndMetrics(metrics, [hook]);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: {
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: 'q' }],
      },
    });
    const scrape = await metrics.register.metrics();
    // Pull the lines for router_hook_duration_ms (bucket / sum / count).
    const lines = scrape
      .split('\n')
      .filter((l) => l.startsWith('router_hook_duration_ms'));
    // Every label set must include ONLY hook_name + status + (for bucket) le.
    // No agent_id / tenant_id / session_id / *_id labels should appear.
    for (const line of lines) {
      expect(line).not.toMatch(/_id="/);
      // Allowed label names within braces.
      const labelsMatch = line.match(/\{([^}]*)\}/);
      if (labelsMatch) {
        const labels = labelsMatch[1].split(',').map((kv) => kv.split('=')[0]);
        for (const name of labels) {
          expect(['hook_name', 'status', 'le']).toContain(name);
        }
      }
    }
  });
});
