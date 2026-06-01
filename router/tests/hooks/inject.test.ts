/**
 * Phase 18 / v0.11.0 — P5-03 BLOCK fence + 4000-char cap.
 * Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-03 lands the impl.
 *
 * Unit tests for `injectRetrievedContent` — the function that takes a
 * `RetrieverResponse` plus the working `CanonicalRequest` and appends a
 * `<retrieved_context source="...">...</retrieved_context>` fence into
 * `canonical.system`. NEVER mutates `canonical.messages` (canonical.ts:108
 * forbids `role: 'system'` inside the messages array — CTXP-03 carry-over).
 *
 * Contract invariants under test:
 *   - Single document → fence with the content as-is.
 *   - Multiple documents → joined with `\n\n---\n\n`.
 *   - `source="..."` attribute is XML-attribute-escaped (no XSS-via-hook-name).
 *   - Content > 4000 chars → truncate. Truncation MUST preserve the closing
 *     `</retrieved_context>` tag (truncate the inner content, not the wrapper).
 *   - `was_truncated: true` when the cap fires.
 *   - The content string used to compute the SHA256 hash in
 *     `pre-completion.ts` is the SAME string that landed in `canonical.system`.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string is the
 * authoritative wording for Plan 18-03's flip.
 */
import { describe, it } from 'vitest';
import type { InjectResult } from '../../src/hooks/inject.js';
// Compile-time anchor — keep tsc red until Plan 18-03.
type _UnusedInjectResult = InjectResult;

describe('injectRetrievedContent — P5-03 BLOCK fence + char cap', () => {
  it('runtime sentinel: src/hooks/inject.js resolves (Wave-0 fails until Plan 18-03)', async () => {
    // esbuild strips `import type` above — this dynamic import surfaces the
    // Wave-0 missing-module failure (PATTERNS line 41).
    await import('../../src/hooks/inject.js');
  });
  it.todo('wraps documents in <retrieved_context source="hook_name">...</retrieved_context> fence');
  it.todo('joins multiple documents with \\n\\n---\\n\\n separator');
  it.todo('escapes attribute value in source="..." (no XSS-via-hook-name)');
  it.todo(
    'content > 4000 chars: truncate, but fence-close </retrieved_context> tag SURVIVES at end',
  );
  it.todo('was_truncated:true when overage triggers truncate');
  it.todo('canonical.system is appended (\\n\\n separator) — existing system preserved');
  it.todo('canonical.messages is NEVER mutated (canonical.ts:108 forbids role:system in messages)');
  it.todo('canonical.system: undefined → new system is just the fenced block');
  it.todo('content used for sha256 is the SAME string that landed in canonical.system (post-truncate)');
});
