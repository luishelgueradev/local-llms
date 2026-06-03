/**
 * Phase 21 / HYG-01 — regression gate for the undici Agent timeout floor.
 *
 * `src/backends/http-dispatcher.ts` was raised from 45_000 to 180_000 after
 * the post-Phase-20 audit found that Ollama cold-loads of qwen2.5:7b on
 * WSL2 + shared GPU take ~50–55s and were getting clipped at 45s into a
 * 504 `upstream_timeout`. The c-ares lookup (also in that file) is the real
 * fix for the DNS-threadpool starvation the 45s was originally guarding —
 * see the header comment in http-dispatcher.ts for the full context.
 *
 * This test pins a 120_000 ms floor: future tuning may go higher, never
 * lower without justifying why the cold-load regression no longer applies.
 * 120_000 leaves a 2× margin over real cold-load latency; 45_000 (the old
 * value) is barely 80% of the observed cold-load — exactly the failure mode
 * the audit caught.
 */
import { describe, expect, it } from 'vitest';

import { BODY_TIMEOUT_MS, HEADERS_TIMEOUT_MS } from '../../src/backends/http-dispatcher.js';

describe('http-dispatcher timeout floor (HYG-01 regression gate)', () => {
  it('HEADERS_TIMEOUT_MS stays ≥ 120_000 (2× cold-load margin)', () => {
    expect(HEADERS_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  it('BODY_TIMEOUT_MS stays ≥ 120_000 (2× cold-load margin)', () => {
    expect(BODY_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  it('both timeouts stay under the SDK-side ceiling of 300_000', () => {
    // ROUTER_BACKEND_TIMEOUT_MS (factory-timeout.test.ts) defaults to 300_000;
    // the undici headers/body timeout must finish first so a 504 surfaces from
    // the dispatcher rather than the SDK aborting on its own deadline.
    expect(HEADERS_TIMEOUT_MS).toBeLessThan(300_000);
    expect(BODY_TIMEOUT_MS).toBeLessThan(300_000);
  });
});
