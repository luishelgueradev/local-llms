/**
 * heartbeat-no-data-event.test.ts — Phase 16 Plan 16-04 (v0.11.0 — RESS / P3-04 BLOCK).
 *
 * Invariant under test:
 *   The SSE heartbeat MUST be a comment line (`: keep-alive\n\n`) — NEVER a
 *   `data:` event whose payload contains the literal string "heartbeat". A
 *   `data: {"type":"heartbeat"}` line would collide with the canonical
 *   `response.*` event stream and confuse SDK parsers (they iterate `data:`
 *   lines as decoded JSON events). See .planning/research/PITFALLS.md §P3-04
 *   for the full justification.
 *
 *   This test scans `router/src/` for two patterns:
 *     1. `reply.raw.write(...heartbeat...)` — the route writing a heartbeat
 *        as a raw SSE data event (the primary regression risk on copy-paste).
 *     2. `yield ...heartbeat...` / `emit ...heartbeat...` — async generators
 *        synthesizing a heartbeat into the canonical event stream (which would
 *        push into the SSE data: channel via fastify-sse-v2).
 *
 *   A third gate enforces RESS-04: `[DONE]` literal MUST NOT appear in the
 *   responses-stream translator (the Responses API uses `response.completed`
 *   as terminator, not `[DONE]`).
 *
 * Why a runtime grep instead of a static lint rule:
 *   - eslint flat-config is the project's lint format but no custom rule is
 *     wired; adding one would mean a parser plugin + maintenance overhead.
 *   - A vitest test runs on every `npm test` (CI + local) and surfaces in the
 *     same pass/fail report as the rest of the suite. Impossible to forget.
 *
 *   Mirrors the Phase 15 MCPS-06 stdio grep gate pattern at
 *   `router/tests/unit/mcp/host/stdio-grep-gate.test.ts`.
 *
 * Out-of-scope skips:
 *   - This test file itself contains the literal "heartbeat" in its grep
 *     argument; scanning is restricted to `router/src/` only, so the test
 *     file's own contents (under `router/tests/`) are excluded.
 *
 * Mitigates: P3-04 (heartbeat-as-data-event regression). Referenced from
 * `router/src/sse/heartbeat.ts` and the responses streaming branch in
 * `router/src/routes/v1/responses.ts`.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to `router/src/` resolved relative to this test file.
 * `__dirname` is `router/tests/unit/grep-gates/`, so go three levels up
 * to reach the router workspace root, then into `src/`.
 */
const SRC_DIR = resolve(__dirname, '../../../src');
const TRANSLATION_DIR = resolve(SRC_DIR, 'translation');

describe('Phase 16 Plan 16-04 — P3-04 grep gate: heartbeat MUST be SSE comment line, not data event', () => {
  it('no router/src/ file writes a heartbeat as a raw data: event via reply.raw.write', () => {
    // grep returns exit 1 on "no match", which would cause execSync to throw.
    // The `|| true` suffix neutralizes the exit code so we can inspect output.
    // -r recurses, -n adds line numbers (useful in failure message), -E enables ERE.
    const output = execSync(
      `grep -rnE 'reply\\.raw\\.write.*heartbeat' . || true`,
      { cwd: SRC_DIR, encoding: 'utf8' },
    );

    if (output.trim() !== '') {
      throw new Error(
        `P3-04 violation: 'reply.raw.write(...heartbeat...)' found in router/src/. ` +
          `Heartbeats MUST be SSE comment lines (\`: keep-alive\\n\\n\`), NEVER data events. ` +
          `See .planning/research/PITFALLS.md §P3-04. Offending lines:\n${output}`,
      );
    }
    expect(output.trim()).toBe('');
  });

  it('no router/src/ file synthesizes a "heartbeat" event in an async generator', () => {
    // Defense in depth: a generator yielding a `data:`-channel heartbeat
    // would also violate P3-04 because fastify-sse-v2 turns yielded values
    // into `data:` lines. Catch both `yield ...heartbeat...` and the older
    // `emit(...heartbeat...)` shape just in case.
    const output = execSync(
      `grep -rnE 'yield.*heartbeat|emit.*heartbeat' . || true`,
      { cwd: SRC_DIR, encoding: 'utf8' },
    );

    if (output.trim() !== '') {
      throw new Error(
        `P3-04 (defense-in-depth) violation: a 'heartbeat' value is being yielded or emitted in router/src/. ` +
          `Heartbeats MUST come from startHeartbeat() (sse/heartbeat.ts) as SSE comment lines. ` +
          `Offending lines:\n${output}`,
      );
    }
    expect(output.trim()).toBe('');
  });

  it('responses-stream.ts contains zero quoted "[DONE]" literals in code (RESS-04 — Responses uses response.completed)', () => {
    // RESS-04: the Responses API stream terminator is `response.completed`,
    // NEVER `data: [DONE]`. Chat-completions uses `[DONE]` (OpenAI legacy);
    // the responses-stream translator must NOT inherit that pattern.
    //
    // The grep filters to STRING-QUOTED `[DONE]` literals (`'[DONE]'` and
    // `"[DONE]"`) so the test does not false-trigger on doc-comment
    // references (which use markdown backticks: `[DONE]`). Any code path
    // that actually emits the OpenAI legacy terminator over SSE will use a
    // single- or double-quoted string literal; markdown-quoted backticks in
    // a JSDoc/block comment are documentation, not code.
    const output = execSync(
      `grep -nE "['\\"]\\[DONE\\]['\\"]" responses-stream.ts || true`,
      { cwd: TRANSLATION_DIR, encoding: 'utf8' },
    );

    if (output.trim() !== '') {
      throw new Error(
        `RESS-04 violation: quoted '[DONE]' literal found in src/translation/responses-stream.ts code. ` +
          `The Responses API stream terminator is 'response.completed', not '[DONE]'. ` +
          `Offending lines:\n${output}`,
      );
    }
    expect(output.trim()).toBe('');
  });
});
