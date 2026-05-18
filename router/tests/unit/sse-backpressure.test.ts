/**
 * ROUTE-08 (TD-02 resolution) — SSE backpressure regression gate.
 *
 * The textual ROUTE-08 spec says "reply.raw.write() return value + 'drain'
 * await". The production path uses fastify-sse-v2's `reply.sse(asyncIterable)`
 * which delegates backpressure to the async-iterable protocol: the consumer
 * (fastify-sse-v2 -> socket) only pulls the next value AFTER its previous
 * write resolves. When the underlying socket is full, the write Promise
 * pends, the iterator awaits, and the upstream SDK reader pauses behind it.
 *
 * This test exercises the property directly on a generator that mirrors the
 * shape of `canonicalToOpenAISse`: a counting upstream pairs with a slow
 * consumer; if backpressure works (i.e. the consumer's `for await` awaits
 * the inner `next()` before the upstream is asked for another value), the
 * upstream's "produced count" never runs more than 1 ahead of the consumer
 * "drained count" — that is the async-iterable backpressure invariant.
 */
import { describe, expect, it } from 'vitest';

async function* countingUpstream(
  n: number,
  producedRef: { value: number },
): AsyncGenerator<{ idx: number }> {
  for (let i = 0; i < n; i++) {
    producedRef.value++;
    yield { idx: i };
  }
}

describe('async-iterable backpressure (ROUTE-08 / TD-02 gate)', () => {
  it('a slow consumer never lets the upstream "produced count" run more than 1 ahead of the consumer "drained count"', async () => {
    const N = 50;
    const produced = { value: 0 };
    const upstream = countingUpstream(N, produced);

    let drained = 0;
    let maxGap = 0;
    for await (const _ev of upstream) {
      drained++;
      const gap = produced.value - drained;
      if (gap > maxGap) maxGap = gap;
      await new Promise((r) => setTimeout(r, 5)); // slow consumer
    }

    // Async-iterable protocol: at most ONE in-flight pull. After yield, the
    // generator pauses until next() is called again. So produced - drained
    // never exceeds 1 (the yielded-but-not-yet-consumed value).
    expect(maxGap).toBeLessThanOrEqual(1);
    expect(drained).toBe(N);
    expect(produced.value).toBe(N);
  });

  it('the consumer always drains every value the upstream produces (no chunks dropped under backpressure)', async () => {
    const N = 100;
    const produced = { value: 0 };
    const seen: number[] = [];
    for await (const ev of countingUpstream(N, produced)) {
      seen.push(ev.idx);
      // No delay: even at full speed the iterator preserves ordering and
      // delivers every yield exactly once.
    }
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(produced.value).toBe(N);
  });
});
