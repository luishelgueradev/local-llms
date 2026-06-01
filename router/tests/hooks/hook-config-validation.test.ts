/**
 * Phase 18 / v0.11.0 — RETR-03 / P5-01 BLOCK (on_timeout mandatory).
 * Plan 18-08 (final phase): 6 it.todo flipped to real it() — covers the
 * runtime boot validator in `router/src/app.ts:340-369` that throws
 * `HookConfigError` synchronously when a registered hook is missing or
 * has an invalid `on_timeout` / `timeout_ms` / `max_chars`.
 *
 * Configuration-validation tests for `PreCompletionHook` entries passed
 * through `buildApp({ preCompletionHooks })`. The P5-01 BLOCK invariant is:
 * a hook without an explicit `on_timeout` value MUST throw `HookConfigError`
 * at boot — the type union `'fail-open' | 'fail-closed'` deliberately
 * excludes `undefined` so a misconfigured registry never silently
 * fail-closes on the first request.
 *
 * The envelope-mapping assertion (HookConfigError.code === 'hook_config_error')
 * mirrors the Phase 17 SessionStore error-class convention from
 * `tests/providers/session-store.interface.test.ts:88-145`.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { HookConfigError } from '../../src/errors/envelope.js';
import type { PreCompletionHook } from '../../src/hooks/pre-completion.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';
import {
  makeFakeBufferedWriter,
  makeFakeMetrics,
  makeFakeRetrieverProvider,
} from '../fakes.js';
import type { AdapterFactory } from '../../src/backends/adapter.js';

const TOKEN = 'local-llms_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const YAML = `
models:
  - name: qwen2.5:7b
    backend: ollama
    backend_url: http://upstream-mock:11434/v1
    backend_model: qwen2.5:7b
    capabilities: [chat]
    vram_budget_gb: 4
backends:
  ollama:
    concurrency: 5
    queue_max_wait_ms: 30000
`;

function makeMinimalAdapterFactory(): AdapterFactory {
  return () =>
    ({
      async chatCompletionsCanonical() {
        throw new Error('not used in config-validation tests');
      },
      async chatCompletionsCanonicalStream() {
        throw new Error('not used in config-validation tests');
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
    } as never);
}

async function tryBuildApp(
  preCompletionHooks: Map<string, PreCompletionHook[]>,
): Promise<{ ok: true } | { ok: false; err: unknown }> {
  try {
    const registry = makeRegistryStore(loadRegistryFromString(YAML));
    const app = await buildApp({
      registry,
      bearerToken: TOKEN,
      loggerOpts: false as never,
      makeAdapter: makeMinimalAdapterFactory(),
      semaphores: {
        get: () =>
          ({
            acquire: async () => () => {},
            stats: () => ({ inFlight: 0, queued: 0 }),
          }) as never,
      },
      bufferedWriter: makeFakeBufferedWriter(),
      metrics: makeFakeMetrics(),
      preCompletionHooks,
    });
    await app.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

describe('Hook configuration validation — RETR-03 / P5-01 BLOCK', () => {
  it('runtime sentinel: src/hooks/pre-completion.js (HookConfigError export) resolves', async () => {
    // Module-load sentinel — keeps Wave-0 contract that the file exists at runtime.
    await import('../../src/hooks/pre-completion.js');
    expect(HookConfigError).toBeDefined();
  });

  it('buildApp with hook missing on_timeout throws HookConfigError at boot', async () => {
    const hook = {
      name: 'no-on-timeout',
      retriever: makeFakeRetrieverProvider(),
      timeout_ms: 2000,
      max_chars: 4000,
      // on_timeout deliberately missing — dynamic construction the TS checker never saw.
    } as unknown as PreCompletionHook;
    const hooks = new Map<string, PreCompletionHook[]>([
      ['/v1/chat/completions', [hook]],
    ]);
    const result = await tryBuildApp(hooks);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err).toBeInstanceOf(HookConfigError);
      expect((result.err as HookConfigError).message).toMatch(/on_timeout/i);
    }
  });

  it('buildApp with hook on_timeout = undefined throws HookConfigError', async () => {
    const hook = {
      name: 'undefined-on-timeout',
      retriever: makeFakeRetrieverProvider(),
      timeout_ms: 2000,
      max_chars: 4000,
      on_timeout: undefined,
    } as unknown as PreCompletionHook;
    const hooks = new Map<string, PreCompletionHook[]>([
      ['/v1/messages', [hook]],
    ]);
    const result = await tryBuildApp(hooks);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err).toBeInstanceOf(HookConfigError);
      expect((result.err as HookConfigError).hookName).toBe(
        'undefined-on-timeout',
      );
    }
  });

  it('buildApp with valid on_timeout: "fail-open" boots successfully', async () => {
    const hook: PreCompletionHook = {
      name: 'happy-fail-open',
      retriever: makeFakeRetrieverProvider(),
      timeout_ms: 2000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    const hooks = new Map<string, PreCompletionHook[]>([
      ['/v1/chat/completions', [hook]],
    ]);
    const result = await tryBuildApp(hooks);
    expect(result.ok).toBe(true);
  });

  it('buildApp with valid on_timeout: "fail-closed" boots successfully', async () => {
    const hook: PreCompletionHook = {
      name: 'happy-fail-closed',
      retriever: makeFakeRetrieverProvider(),
      timeout_ms: 2000,
      max_chars: 4000,
      on_timeout: 'fail-closed',
    };
    const hooks = new Map<string, PreCompletionHook[]>([
      ['/v1/responses', [hook]],
    ]);
    const result = await tryBuildApp(hooks);
    expect(result.ok).toBe(true);
  });

  it('HookConfigError.code === "hook_config_error" (envelope mapping)', () => {
    const err = new HookConfigError('any-hook', 'any reason');
    expect(err.code).toBe('hook_config_error');
    expect(err.hookName).toBe('any-hook');
    expect(err.reason).toBe('any reason');
    expect(err).toBeInstanceOf(Error);
  });

  it('multiple hooks: validation enforces on_timeout on EVERY hook, not just first', async () => {
    const goodHook: PreCompletionHook = {
      name: 'good-hook',
      retriever: makeFakeRetrieverProvider(),
      timeout_ms: 2000,
      max_chars: 4000,
      on_timeout: 'fail-open',
    };
    const badHook = {
      name: 'bad-hook',
      retriever: makeFakeRetrieverProvider(),
      timeout_ms: 2000,
      max_chars: 4000,
      // on_timeout missing — only second hook is invalid.
    } as unknown as PreCompletionHook;
    const hooks = new Map<string, PreCompletionHook[]>([
      ['/v1/chat/completions', [goodHook, badHook]],
    ]);
    const result = await tryBuildApp(hooks);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err).toBeInstanceOf(HookConfigError);
      // The second hook's name surfaces — proves both were validated.
      expect((result.err as HookConfigError).hookName).toBe('bad-hook');
    }
  });
});
