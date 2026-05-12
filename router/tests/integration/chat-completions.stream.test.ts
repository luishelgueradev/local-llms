import { describe, it } from 'vitest';

describe('POST /v1/chat/completions stream=true (SC1, SC3 mocked, OAI-04, OAI-05) — implemented in plan 02-04', () => {
  it.todo('forwards each upstream chunk verbatim');
  it.todo('wire format snapshot: data lines + blank line between events');
  it.todo('synthesizes data: [DONE] terminator');
  it.todo('final non-[DONE] chunk has usage.{prompt_tokens,completion_tokens,total_tokens} populated');
  it.todo('aborts upstream on client disconnect within 50ms (SC3 mocked path — RESEARCH Pitfall 2)');
  it.todo('does NOT emit error frame on client-side abort (RESEARCH Pitfall 8)');
});
