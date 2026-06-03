/**
 * Phase 20 / CAT-02 (v0.12.0 — D-04 LOCKED) — backend-probe unit tests.
 *
 * Exercises the 8 contract points enumerated in Plan 20-02 Task 1:
 *   1. ollama 200 → 'ok' + latency_ms present
 *   2. llamacpp fetch rejection (ENOTFOUND) → 'down'
 *   3. vllm 503 → 'degraded'
 *   4. vllm-embed timeout (AbortController fires) → 'down'
 *   5. ollama-cloud → 'unknown' AND no fetch call
 *   6. unknown backend 'sglang' → 'unknown', no fetch call, no throw
 *   7. URL derivation: ollama input `.../v1` → fetch called with `.../`
 *   8. URL derivation: llamacpp input `.../v1` → fetch called with `.../health`
 */
import { describe, it, expect, vi } from 'vitest';
import { probeBackend, PROBE_ENDPOINTS } from '../backend-probe.js';

describe('probeBackend', () => {
  it('1. ollama 200 → status:ok with latency_ms', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('Ollama is running', { status: 200 }));
    const res = await probeBackend('ollama', 'http://ollama:11434/v1', { fetchImpl });
    expect(res.status).toBe('ok');
    expect(res.backend).toBe('ollama');
    expect(typeof res.latency_ms).toBe('number');
    expect(typeof res.checked_at).toBe('string');
    expect(new Date(res.checked_at).toString()).not.toBe('Invalid Date');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('2. llamacpp fetch rejection (ENOTFOUND) → status:down', async () => {
    const err = new Error('getaddrinfo ENOTFOUND llamacpp');
    (err as NodeJS.ErrnoException).code = 'ENOTFOUND';
    const fetchImpl = vi.fn().mockRejectedValue(err);
    const res = await probeBackend('llamacpp', 'http://llamacpp:8080/v1', { fetchImpl });
    expect(res.status).toBe('down');
    expect(res.backend).toBe('llamacpp');
  });

  it('3. vllm 503 → status:degraded', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    const res = await probeBackend('vllm', 'http://vllm:8000/v1', { fetchImpl });
    expect(res.status).toBe('degraded');
    expect(res.backend).toBe('vllm');
    expect(typeof res.latency_ms).toBe('number');
  });

  it('4. vllm-embed timeout (AbortController fires) → status:down', async () => {
    // Mock fetch that respects the AbortSignal: rejects with an abort error when
    // the controller fires. We make it pend indefinitely and only resolve via abort.
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            const abortErr = new Error('The operation was aborted');
            (abortErr as Error & { name: string }).name = 'AbortError';
            reject(abortErr);
          });
        }
      });
    });
    const res = await probeBackend('vllm-embed', 'http://vllm-embed:8000/v1', {
      fetchImpl,
      timeoutMs: 50, // small so the test runs fast
    });
    expect(res.status).toBe('down');
    expect(res.backend).toBe('vllm-embed');
  });

  it('5. ollama-cloud → status:unknown AND no fetch call', async () => {
    const fetchImpl = vi.fn();
    const res = await probeBackend('ollama-cloud', 'https://ollama.com/v1', { fetchImpl });
    expect(res.status).toBe('unknown');
    expect(res.backend).toBe('ollama-cloud');
    expect(res.latency_ms).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('6. unknown backend name "sglang" → status:unknown, no throw, no fetch call', async () => {
    const fetchImpl = vi.fn();
    const res = await probeBackend('sglang', 'http://sglang:8000/v1', { fetchImpl });
    expect(res.status).toBe('unknown');
    expect(res.backend).toBe('sglang');
    expect(fetchImpl).not.toHaveBeenCalled();
    // Defensive: PROBE_ENDPOINTS should NOT silently grow if we ever add sglang
    expect(PROBE_ENDPOINTS['sglang']).toBeUndefined();
  });

  it('7. URL derivation: ollama input http://ollama:11434/v1 → fetch called with http://ollama:11434/', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await probeBackend('ollama', 'http://ollama:11434/v1', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchImpl.mock.calls[0]!;
    expect(calledUrl).toBe('http://ollama:11434/');
  });

  it('8. URL derivation: llamacpp input http://llamacpp:8080/v1 → fetch called with http://llamacpp:8080/health', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await probeBackend('llamacpp', 'http://llamacpp:8080/v1', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchImpl.mock.calls[0]!;
    expect(calledUrl).toBe('http://llamacpp:8080/health');
  });
});
