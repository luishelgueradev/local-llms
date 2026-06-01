/**
 * Phase 17 / v0.11.0 — SESS-05 / SESS-06 / SC-1..5 + Pitfall 17-D/E/F.
 * Wave 0 scaffold (Plan 17-01).
 *
 * Wire-level behavior of the X-Session-ID multi-turn attach pipeline across the
 * three HTTP routes that participate in session attach:
 *   /v1/chat/completions  (OpenAI surface)
 *   /v1/messages          (Anthropic surface)
 *   /v1/responses         (Responses surface)
 *
 * Pattern source: `tests/routes/idempotency-integration.test.ts` (the canonical
 * three-route shared-buildApp fixture from Phase 8 — PATTERNS lines 594-621).
 *
 * Wave 0 = it.todo only. Plans 17-05 / 17-06 flip these to real `it(...)` with
 * full buildApp + fake provider wiring once the production code lands.
 *
 * Coverage matrix (RESEARCH §Phase Requirements → Test Map, lines 1499-1503):
 *   SC-1: same X-Session-ID twice → second response sees history (3 routes)
 *   SC-2: cross-agent leak prevention (chat-completions)
 *   SC-3: long session + ctx_size=4096 → ContextProvider trims (chat-completions)
 *   SC-4: stateless mode no DB writes (3 routes)
 *   SC-5: NoopSummaryProvider never calls model
 *   SESS-05: X-Session-ID response header set on stream + non-stream
 *   Pitfall 17-D: header stamp BEFORE reply.sse / reply.send
 *   Pitfall 17-E: appendTurn timeout 1s → counter increments, response succeeds
 *   Pitfall 17-F: stream-path appendTurn fire-and-forget (never blocks SSE close)
 *   Q5: idempotency leader/follower — follower never mutates conversation_turns
 *
 * Wave-0 import gate: the fake imports below fail until Task 3 of this plan
 * extends `tests/fakes.ts`, AND the route-level wiring needs Plan 17-05/06 —
 * which is why every test ships as it.todo here.
 */
import { describe, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import {
  makeFakeBufferedWriter,
  makeFakeMetrics,
  makeFakeSessionStore,
  makeFakeContextProvider,
  makeFakeSummaryProvider,
} from '../fakes.js';

// Wave-0 sentinel: keep buildApp + fakes references live so the fakes import
// fails noisily until Task 3 of this plan ships the three new fake builders.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _waveZero = {
  buildApp,
  makeFakeBufferedWriter,
  makeFakeMetrics,
  makeFakeSessionStore,
  makeFakeContextProvider,
  makeFakeSummaryProvider,
};

describe('POST /v1/chat/completions — session attach', () => {
  it.todo('SC-1: same X-Session-ID twice → second response history was injected (assistant tokens_in delta > 0)');
  it.todo('SC-2: second request with different X-Agent-ID returns empty history (no leakage)');
  it.todo('SC-4: no X-Session-ID → zero sessions / conversation_turns rows written + response byte-identical to fake-adapter baseline');
  it.todo('SC-5: NoopSummaryProvider — fake adapter assertion that summarizer is never called');
  it.todo('SESS-05 stream-path / Pitfall 17-D: X-Session-ID response header present on SSE response headers');
  it.todo('SESS-05 non-stream: X-Session-ID response header present');
  it.todo('SC-3: long session + ctx_size=4096 — ContextProvider trims; backend NEVER receives over-budget canonical (asserted on fake-adapter input)');
  it.todo('Pitfall 17-E: appendTurn timeout (1s) — response succeeds + router_session_append_failed_total{reason="timeout"} increments + persisted:false flag logged');
  it.todo('Pitfall 17-F: stream-path appendTurn is fire-and-forget — SSE close not blocked by Postgres latency');
});

describe('POST /v1/messages — session attach', () => {
  it.todo('SC-1 (Anthropic surface): same X-Session-ID twice → second request history injected with top-level system merge');
  it.todo('SESS-05: X-Session-ID response header set');
  it.todo('SC-4: stateless mode no DB writes');
});

describe('POST /v1/responses — session attach', () => {
  it.todo('SC-1 (Responses surface): same X-Session-ID twice → second request input merged with history');
  it.todo('SESS-05 stream + non-stream X-Session-ID header set');
  it.todo('SC-4: stateless mode no DB writes');
});

describe('Cross-route invariants', () => {
  it.todo('Invalid X-Session-ID (regex fail) → 400 invalid_session_id envelope on ALL three routes');
  it.todo('Idempotency leader+follower (Q5) — follower replay does NOT mutate conversation_turns');
});
