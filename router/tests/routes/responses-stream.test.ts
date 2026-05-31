/**
 * responses-stream.test.ts — Phase 16 Wave 0 (Plan 16-01) scaffold.
 *
 * R1..R15 integration cases stubbed as `it.todo` per 16-RESEARCH §"Recommended
 * Test Matrix (Route Integration Tests)". Plan 16-03 lands the streaming branch
 * in router/src/routes/v1/responses.ts and flips every it.todo to a real test.
 */
import { describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';
import type { ModelEntry } from '../../src/config/registry.js';
import type { BackendAdapter } from '../../src/backends/adapter.js';
import { makeMetricsRegistry } from '../../src/metrics/registry.js';
import type { RequestLogInsert } from '../../src/db/schema/index.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
const LOCAL_CHAT = 'qwen2.5-local';

// Reference imported symbols once so TypeScript does not flag them as unused while
// Plan 16-03's test bodies remain stubbed. Plan 16-03 deletes these void/type
// references when the real beforeEach + integration assertions land.
void buildApp;
void loadRegistryFromString;
void makeRegistryStore;
void makeMetricsRegistry;
void TOKEN;
void LOCAL_CHAT;
type _RefApp = FastifyInstance;
type _RefEntry = ModelEntry;
type _RefAdapter = BackendAdapter;
type _RefRow = RequestLogInsert;

describe('POST /v1/responses — streaming happy path (RESS-01, RESS-02)', () => {
  it.todo('R1: stream:true model:chat-local input:"hi" → 200 + text/event-stream + 9-event canonical sequence in order');
  it.todo('R2: every event has integer sequence_number; last event is response.completed; sequence numbers form [0..N-1]');
  it.todo('R7: response.completed is the LAST non-comment event (P3-03)');
});

describe('POST /v1/responses — streaming tool-calls (RESS-03)', () => {
  it.todo('R3: model emits tool_use → stream surfaces function_call_arguments.delta + .done + completed.status=incomplete + incomplete_details.reason=tool_calls');
});

describe('POST /v1/responses — streaming reuse path (RESS-05)', () => {
  it.todo('R4: heartbeat present mid-stream (comment line ": keep-alive") — slow adapter test');
  it.todo('R5: client disconnect during stream → AbortController fires; request_log row has status_class="disconnect" + error_code="client_disconnect"');
  it.todo('R6: idempotency leader/follower — two concurrent requests with same Idempotency-Key produce byte-identical SSE output + matching upstream_message_id');
  it.todo('R10: pre-stream adapter error → 4xx JSON envelope (not SSE); request_log row populated');
  it.todo('R11: mid-stream upstream error (after headers) → response.failed SSE event; reply.statusCode stays 200; request_log row reflects error_code + status_class');
  it.todo('R12: X-Cost-Cents header on non-stream cloud model still works (existing behavior — guards P9-02)');
});

describe('POST /v1/responses — streaming gates (P3-04, P9-02)', () => {
  it.todo('R8: NO data: event contains the string "heartbeat" (P3-04 grep gate)');
  it.todo('R9: non-streaming branch (existing v0.10.0) wire body matches golden fixture byte-for-byte (P9-02)');
  it.todo('R13: policy gate fires before stream branch — model_allowlist violation → 403 before any SSE frame');
  it.todo('R14: bearer auth missing → 401 before stream branch');
  it.todo('R15: unknown model → 404 before stream branch');
});
