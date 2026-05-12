import { describe, it } from 'vitest';

describe('SSE stream generator (ROUTE-08, OAI-04) — implemented in plan 02-04', () => {
  it.todo('wraps async iterable into { data: JSON } events');
  it.todo('synthesizes terminal { data: "[DONE]" } even if upstream did not');
  it.todo('emits D-C2 mid-stream error frame (event: error + data + [DONE]) — byte-exact');
  it.todo('does NOT emit error frame when controller.signal.aborted is true (RESEARCH Pitfall 8)');
});
