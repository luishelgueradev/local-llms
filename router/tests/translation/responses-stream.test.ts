/**
 * responses-stream.test.ts — Phase 16 Wave 0 (Plan 16-01) scaffold.
 *
 * Test cases stubbed as `it.todo` per 16-RESEARCH.md §"Recommended Test Matrix".
 * Plan 16-02 lands the translator + flips every it.todo to a real test.
 *
 * NOTE: the canonicalToResponsesSse import below WILL fail with "module not found"
 * until Plan 16-02 creates router/src/translation/responses-stream.ts. That failure
 * is the intended Wave-0 signal that the scaffold is wired correctly.
 */
import { describe, it } from 'vitest';
import {
  canonicalToResponsesSse,
  type CanonicalToResponsesSseOpts,
} from '../../src/translation/responses-stream.js';
import type { CanonicalStreamEvent } from '../../src/translation/canonical.js';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) out.push(item);
  return out;
}

// Reference imported symbols once so TypeScript does not flag them as unused while
// Plan 16-02's test bodies remain stubbed. Plan 16-02 deletes these void/type
// references when the real test bodies land.
void canonicalToResponsesSse;
void collect;
type _RefOpts = CanonicalToResponsesSseOpts;
type _RefEvent = CanonicalStreamEvent;

describe('canonicalToResponsesSse — text-only sequence (RESS-01)', () => {
  it.todo('emits the 9-event canonical text sequence in order');
  it.todo('single text block — 9 events end-to-end (created..completed)');
  it.todo('multi-delta text — 13 events (9 base + 4 extra deltas)');
  it.todo('sequence_number is exactly [0, 1, 2, ..., N-1] for happy path');
  it.todo('usage in response.completed reflects message_start input_tokens + message_delta output_tokens');
  it.todo('honors opts.displayModel — every response.*.response.model matches override');
  it.todo('honors opts.idOverride — every response.*.response.id matches override');
  it.todo('echo fields populate response.completed (instructions, temperature, max_output_tokens, tools, tool_choice)');
  it.todo('ping is swallowed — translator yields nothing for canonical ping event');
  it.todo('message_delta WITHOUT message_stop — no response.completed emitted; onCleanup still called with captured tokens');
});

describe('canonicalToResponsesSse — tool-call sequence (RESS-03)', () => {
  it.todo('single function_call — emits response.completed.status=incomplete + incomplete_details.reason=tool_calls');
});

describe('canonicalToResponsesSse — mixed text + tool (FSM correctness, P3-02)', () => {
  it.todo('text then tool_use — two output items, full 16-event interleaved sequence');
  it.todo('FSM violation: text_delta during function_call — swallowed + warn');
  it.todo('FSM violation: input_json_delta during text — swallowed + warn');
});

describe('canonicalToResponsesSse — error + abort paths (P3-03)', () => {
  it.todo('upstream error mid-stream (signal NOT aborted) — emits response.failed as final event');
  it.todo('abort signal during stream — translator yields nothing after abort, onCleanup error: undefined');
  it.todo('only message_start (broken upstream) — emits response.created + response.in_progress, no terminator (FSM violation logged)');
});

describe('canonicalToResponsesSse — sequence_number invariant (RESS-02)', () => {
  it.todo('sequence_number is exactly [0, 1, 2, ..., N-1] for happy path');
  it.todo('heartbeats do not increment sequence_number — translator never sees them');
});

describe('OutputItemStateMachine — transition table (P3-02)', () => {
  it.todo('idle → message_start → idle: emits response.created + response.in_progress');
  it.todo('idle → content_block_start(text) → text: emits response.output_item.added(message) + response.content_part.added(output_text)');
  it.todo('idle → content_block_start(tool_use) → function_call: emits response.output_item.added(function_call) with call_id from canonical tool_use.id');
  it.todo('text → content_block_delta(text_delta) → text: emits response.output_text.delta + accumulates text');
  it.todo('function_call → content_block_delta(input_json_delta) → function_call: emits response.function_call_arguments.delta + accumulates args');
  it.todo('text → content_block_stop → idle: emits response.output_text.done + response.content_part.done + response.output_item.done');
  it.todo('function_call → content_block_stop → idle: emits response.function_call_arguments.done + response.output_item.done');
});
