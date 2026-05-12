import { describe, it } from 'vitest';

describe('POST /v1/chat/completions stream=false (SC2, OAI-05) — implemented in plan 02-03', () => {
  it.todo('returns full ChatCompletion with usage.{prompt_tokens,completion_tokens,total_tokens}');
  it.todo('returns 404 with OpenAI envelope when model is not in registry');
  it.todo('returns 502 with OpenAI envelope when upstream is unreachable');
});
