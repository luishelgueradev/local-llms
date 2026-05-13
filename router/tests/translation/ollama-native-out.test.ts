/**
 * ollama-native-out.test.ts — Unit tests for the canonical → Ollama native translator
 * (Plan 04-01 scaffold; full vision + URL-fetch coverage lands in Plan 05).
 */
import { describe, expect, it } from 'vitest';
import { canonicalToOllamaNativeChat } from '../../src/translation/ollama-native-out.js';

describe('canonicalToOllamaNativeChat — text-only stub (Plan 04-01 Task 2)', () => {
  it('emits content string for text-only canonical; no images field', () => {
    const native = canonicalToOllamaNativeChat({
      model: 'llama3.2:3b-instruct-q4_K_M',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(native.model).toBe('llama3.2:3b-instruct-q4_K_M');
    expect(native.messages).toHaveLength(1);
    expect(native.messages[0].content).toBe('hi');
    expect(native.messages[0].images).toBeUndefined();
  });

  it('prepends a system role message when canonical.system is set', () => {
    const native = canonicalToOllamaNativeChat({
      model: 'x',
      system: 'be brief',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(native.messages).toHaveLength(2);
    expect(native.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(native.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('packs temperature / top_p / stop_sequences into options', () => {
    const native = canonicalToOllamaNativeChat({
      model: 'x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ['END'],
      max_tokens: 100,
    });
    expect(native.options).toEqual({
      temperature: 0.7,
      top_p: 0.9,
      stop: ['END'],
      num_predict: 100,
    });
  });
});
