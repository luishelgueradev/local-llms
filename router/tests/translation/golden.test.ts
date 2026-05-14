/**
 * golden.test.ts — fixture-driven round-trip runner (Plan 04-04 TOOL-05).
 *
 * For each scenario directory under `router/tests/translation/golden/`:
 *  - input-openai.json + input-anthropic.json → canonical.request (identity)
 *  - canonical.response → output-openai.json + output-anthropic.json (identity)
 *
 * The runner uses the Plan 04-04 translator-option seam (`idOverride`) so the
 * translators emit deterministic ids that match the output fixtures — no test-only
 * mutation of production code. `displayModel` is set to `canonical.response.model`
 * so the wire model is whatever the fixture says (no test-time backend remap).
 *
 * Special branch: `09-malformed-tool-args/` has only `input-openai.json` and asserts
 * `openAIRequestToCanonical` throws `InvalidToolArgumentsError` (T-04-02 mitigation).
 *
 * `created` field on OpenAI ChatCompletion comes from Math.floor(Date.now()/1000) —
 * the runner uses `vi.useFakeTimers()` + `vi.setSystemTime(new Date(0))` so the
 * field is deterministically 0 across runs, matching the output fixtures.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  openAIRequestToCanonical,
  canonicalToOpenAIChatCompletionParams,
} from '../../src/translation/openai-in.js';
import { canonicalToOpenAIResponse } from '../../src/translation/openai-out.js';
import { anthropicRequestToCanonical } from '../../src/translation/anthropic-in.js';
import { canonicalToAnthropicResponse } from '../../src/translation/anthropic-out.js';
import { InvalidToolArgumentsError } from '../../src/errors/envelope.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const goldenDir = join(__dirname, 'golden');

const scenarios = existsSync(goldenDir)
  ? readdirSync(goldenDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+-/.test(d.name))
      .map((d) => d.name)
      .sort()
  : [];

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date(0));
});

afterAll(() => {
  vi.useRealTimers();
});

if (scenarios.length === 0) {
  describe('golden round-trip fixtures (TOOL-05)', () => {
    it('golden directory exists (Plan 04 will populate scenarios)', () => {
      expect(existsSync(goldenDir)).toBe(true);
    });
  });
}

for (const sc of scenarios) {
  describe(`golden round-trip: ${sc}`, () => {
    const dir = join(goldenDir, sc);
    const has = (f: string) => existsSync(join(dir, f));
    const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;

    if (sc === '09-malformed-tool-args') {
      it('openAIRequestToCanonical throws InvalidToolArgumentsError on malformed args', () => {
        const input = read('input-openai.json');
        expect(() => openAIRequestToCanonical(input)).toThrow(InvalidToolArgumentsError);
      });
      return;
    }

    if (!has('canonical.json')) {
      // Scenario directory exists but is still being authored — skip (placeholder).
      it.skip('canonical.json not present yet (scenario still being authored)', () => {});
      return;
    }

    const canonical = read('canonical.json') as {
      request?: Record<string, unknown>;
      response?: { id: string; model: string };
    };
    const idOverride = canonical.response?.id;
    const displayModel = canonical.response?.model;

    if (has('input-openai.json') && canonical.request) {
      it('OpenAI → canonical (request)', () => {
        expect(openAIRequestToCanonical(read('input-openai.json'))).toEqual(canonical.request);
      });
    }

    if (has('input-anthropic.json') && canonical.request) {
      it('Anthropic → canonical (request)', () => {
        expect(anthropicRequestToCanonical(read('input-anthropic.json'))).toEqual(
          canonical.request,
        );
      });
    }

    if (has('output-openai.json') && canonical.response) {
      it('canonical → OpenAI (response)', () => {
        const out = canonicalToOpenAIResponse(canonical.response as never, {
          idOverride,
          displayModel,
        });
        expect(out).toEqual(read('output-openai.json'));
      });
    }

    if (has('output-anthropic.json') && canonical.response) {
      it('canonical → Anthropic (response)', () => {
        const out = canonicalToAnthropicResponse(canonical.response as never, {
          idOverride,
          displayModel,
        });
        expect(out).toEqual(read('output-anthropic.json'));
      });
    }

    if (has('input-openai.json') && canonical.request) {
      it('canonical (request) → OpenAI ChatCompletionCreateParams round-trip', () => {
        // Sanity: canonical_request → OpenAI params should be valid (no throw).
        const params = canonicalToOpenAIChatCompletionParams(canonical.request as never);
        expect(params.model).toBe((canonical.request as { model: string }).model);
      });
    }
  });
}
