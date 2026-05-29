import { describe, it, expect } from 'vitest';
import {
  buildRepairMessage,
  validateJsonOutput,
  type ResponseFormat,
} from '../../src/translation/jsonValidation.js';

describe('validateJsonOutput — Phase 10 (JSON-01..04)', () => {
  it('returns ok when responseFormat is undefined (no gate)', () => {
    expect(validateJsonOutput('hello world', undefined)).toEqual({ ok: true });
  });

  it('returns ok when type=text (no validation contract)', () => {
    expect(validateJsonOutput('not json at all', { type: 'text' })).toEqual({ ok: true });
  });

  describe('json_object mode (JSON-01)', () => {
    it('accepts a well-formed JSON object', () => {
      const rf: ResponseFormat = { type: 'json_object' };
      expect(validateJsonOutput('{"x": 1}', rf)).toEqual({ ok: true });
    });

    it('accepts a JSON array', () => {
      const rf: ResponseFormat = { type: 'json_object' };
      expect(validateJsonOutput('[1, 2, 3]', rf)).toEqual({ ok: true });
    });

    it('accepts a JSON number / string / bool (any valid JSON value)', () => {
      const rf: ResponseFormat = { type: 'json_object' };
      expect(validateJsonOutput('42', rf)).toEqual({ ok: true });
      expect(validateJsonOutput('"hello"', rf)).toEqual({ ok: true });
      expect(validateJsonOutput('true', rf)).toEqual({ ok: true });
    });

    it('rejects non-JSON text', () => {
      const rf: ResponseFormat = { type: 'json_object' };
      const r = validateJsonOutput('this is plain text, not json', rf);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not valid JSON/);
    });

    it('strips ```json fences before parsing (lenient)', () => {
      const rf: ResponseFormat = { type: 'json_object' };
      expect(validateJsonOutput('```json\n{"x": 1}\n```', rf)).toEqual({ ok: true });
    });

    it('strips preamble before the first { (lenient)', () => {
      const rf: ResponseFormat = { type: 'json_object' };
      expect(validateJsonOutput('Here is the JSON: {"x": 1}', rf)).toEqual({ ok: true });
    });
  });

  describe('json_schema mode (JSON-02)', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name', 'age'],
      additionalProperties: false,
    };
    const rf: ResponseFormat = {
      type: 'json_schema',
      json_schema: { name: 'Person', schema, strict: true },
    };

    it('accepts JSON that conforms to the schema', () => {
      expect(validateJsonOutput('{"name": "Luis", "age": 35}', rf)).toEqual({ ok: true });
    });

    it('rejects JSON missing required fields', () => {
      const r = validateJsonOutput('{"name": "Luis"}', rf);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/does not validate against json_schema/);
    });

    it('rejects JSON with wrong field types', () => {
      const r = validateJsonOutput('{"name": "Luis", "age": "thirty-five"}', rf);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/json_schema/);
    });

    it('rejects extra properties when additionalProperties=false', () => {
      const r = validateJsonOutput('{"name": "L", "age": 1, "extra": true}', rf);
      expect(r.ok).toBe(false);
    });

    it('reports an actionable error when the schema itself is malformed', () => {
      const badRf: ResponseFormat = {
        type: 'json_schema',
        json_schema: { schema: { type: 'wrong_type_value' } },
      };
      const r = validateJsonOutput('{"x": 1}', badRf);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/json_schema is invalid/);
    });
  });
});

describe('buildRepairMessage — Phase 10 (JSON-03)', () => {
  it('embeds the failure reason verbatim', () => {
    const msg = buildRepairMessage('response is not valid JSON: Unexpected token h');
    expect(msg).toContain('response is not valid JSON: Unexpected token h');
  });

  it('instructs the model to return ONLY JSON', () => {
    const msg = buildRepairMessage('whatever');
    expect(msg).toMatch(/respond again with ONLY valid JSON/i);
    expect(msg).toMatch(/no prose|do not include any prose/i);
  });
});
