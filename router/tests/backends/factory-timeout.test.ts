/**
 * Phase 15.1 housekeeping — verify that ROUTER_BACKEND_TIMEOUT_MS flows from
 * MakeAdapterDeps into the underlying OpenAI SDK client for each local
 * backend (ollama, llamacpp, vllm, vllm-embed) and defaults to 300_000 ms
 * when the dep is omitted.
 *
 * Why a unit test (not an integration test):
 *   The cold-load flake the knob mitigates is a production-runtime + smoke-
 *   harness concern; the integration suite mocks the SDK so it can't observe
 *   the actual timeout value. This test reaches into the constructed adapter,
 *   inspects the OpenAI client's `timeout` field, and asserts the wiring is
 *   intact end-to-end (factory → ctor opts → SDK config). If a future refactor
 *   accidentally hard-codes 60_000 again, this test fails immediately.
 */
import { describe, expect, it } from 'vitest';

import { makeAdapter } from '../../src/backends/factory.js';
import type { ModelEntry } from '../../src/config/registry.js';

function localEntry(backend: ModelEntry['backend'], backendUrl = 'http://x/v1'): ModelEntry {
  return {
    name: 'm',
    backend,
    backend_url: backendUrl,
    backend_model: 'mm',
    capabilities: ['chat'],
    vram_gb: 0,
    description: '',
    pricing: null,
  } as unknown as ModelEntry;
}

function timeoutOf(adapter: unknown): number | undefined {
  // The OpenAI SDK exposes `timeout` on the client; adapters store the client
  // on a private field named `client`. Cast to a shape that lets us read it
  // without violating the class invariants.
  const a = adapter as { client?: { timeout?: number } };
  return a.client?.timeout;
}

describe('makeAdapter — ROUTER_BACKEND_TIMEOUT_MS threading (Phase 15.1)', () => {
  it('ollama: defaults to 300_000 ms when backendTimeoutMs is omitted', () => {
    const adapter = makeAdapter(localEntry('ollama'));
    expect(timeoutOf(adapter)).toBe(300_000);
  });

  it('llamacpp: defaults to 300_000 ms when backendTimeoutMs is omitted', () => {
    const adapter = makeAdapter(localEntry('llamacpp'));
    expect(timeoutOf(adapter)).toBe(300_000);
  });

  it('vllm: defaults to 300_000 ms when backendTimeoutMs is omitted', () => {
    const adapter = makeAdapter(localEntry('vllm'));
    expect(timeoutOf(adapter)).toBe(300_000);
  });

  it('vllm-embed: defaults to 300_000 ms when backendTimeoutMs is omitted', () => {
    const adapter = makeAdapter(localEntry('vllm-embed'));
    expect(timeoutOf(adapter)).toBe(300_000);
  });

  it('ollama: honors backendTimeoutMs from deps', () => {
    const adapter = makeAdapter(localEntry('ollama'), { backendTimeoutMs: 90_000 });
    expect(timeoutOf(adapter)).toBe(90_000);
  });

  it('llamacpp: honors backendTimeoutMs from deps', () => {
    const adapter = makeAdapter(localEntry('llamacpp'), { backendTimeoutMs: 90_000 });
    expect(timeoutOf(adapter)).toBe(90_000);
  });

  it('vllm: honors backendTimeoutMs from deps', () => {
    const adapter = makeAdapter(localEntry('vllm'), { backendTimeoutMs: 90_000 });
    expect(timeoutOf(adapter)).toBe(90_000);
  });

  it('vllm-embed: honors backendTimeoutMs from deps', () => {
    const adapter = makeAdapter(localEntry('vllm-embed'), { backendTimeoutMs: 90_000 });
    expect(timeoutOf(adapter)).toBe(90_000);
  });

  it('regression guard: the legacy 60_000 ms ceiling is no longer the default', () => {
    // If a future refactor reintroduces `timeout: 60_000` hardcoded in any
    // local adapter, this assertion catches it across all 4 backends.
    for (const backend of ['ollama', 'llamacpp', 'vllm', 'vllm-embed'] as const) {
      const adapter = makeAdapter(localEntry(backend));
      expect(timeoutOf(adapter)).not.toBe(60_000);
    }
  });
});
