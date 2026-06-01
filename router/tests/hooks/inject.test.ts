/**
 * Phase 18 / v0.11.0 — P5-03 BLOCK fence + 4000-char cap.
 * Plan 18-03: real it() — production module landed in src/hooks/inject.ts.
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
 * Lock convention (Plan 18-01 lock): each `it()` case-name string below
 * is the authoritative wording (carry-over from the original it.todo names).
 */
import { describe, it, expect } from 'vitest';
import { injectRetrievedContent } from '../../src/hooks/inject.js';
import type { CanonicalRequest } from '../../src/translation/canonical.js';
import type { RetrieverResponse } from '../../src/providers/retriever-provider.js';

const MAX_CHARS = 4000;

function makeCanonical(system?: string): CanonicalRequest {
  return {
    model: 'chat-local',
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  };
}

function makeResp(docs: string[]): RetrieverResponse {
  return {
    documents: docs.map((content) => ({ content })),
    retrieved_at: '2026-06-01T00:00:00.000Z',
  };
}

describe('injectRetrievedContent — P5-03 BLOCK fence + char cap', () => {
  it('runtime sentinel: src/hooks/inject.js resolves (Wave-0 fails until Plan 18-03)', async () => {
    await import('../../src/hooks/inject.js');
  });

  it('wraps documents in <retrieved_context source="hook_name">...</retrieved_context> fence', () => {
    const out = injectRetrievedContent(makeCanonical(), 'my_hook', makeResp(['doc one']), MAX_CHARS);
    expect(out.content).toMatch(/^<retrieved_context source="my_hook">\n/);
    expect(out.content).toMatch(/<\/retrieved_context>$/);
    expect(out.content).toContain('doc one');
    expect(out.was_truncated).toBe(false);
  });

  it('joins multiple documents with \\n\\n---\\n\\n separator', () => {
    const out = injectRetrievedContent(
      makeCanonical(),
      'kb',
      makeResp(['alpha', 'beta', 'gamma']),
      MAX_CHARS,
    );
    expect(out.content).toContain('alpha\n\n---\n\nbeta\n\n---\n\ngamma');
  });

  it('escapes attribute value in source="..." (no XSS-via-hook-name)', () => {
    const out = injectRetrievedContent(
      makeCanonical(),
      'evil"><script>alert(1)</script>',
      makeResp(['x']),
      MAX_CHARS,
    );
    // The literal `"` must be escaped to &quot; so it cannot close the
    // attribute quote prematurely. `<` and `>` are also escaped.
    expect(out.content).toContain('source="evil&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
    // The dangerous unescaped sequence must NOT appear inside the fence.
    expect(out.content).not.toContain('"><script>');
  });

  it('content > 4000 chars: truncate, but fence-close </retrieved_context> tag SURVIVES at end', () => {
    const giant = 'x'.repeat(8000);
    const out = injectRetrievedContent(makeCanonical(), 'big', makeResp([giant]), MAX_CHARS);
    expect(out.was_truncated).toBe(true);
    // Length cap respected.
    expect(out.content.length).toBeLessThanOrEqual(MAX_CHARS);
    // Close tag preserved at the tail.
    expect(out.content.endsWith('</retrieved_context>')).toBe(true);
    // Open tag still present at the head.
    expect(out.content.startsWith('<retrieved_context source="big">')).toBe(true);
  });

  it('was_truncated:true when overage triggers truncate', () => {
    const giant = 'y'.repeat(MAX_CHARS + 100);
    const out = injectRetrievedContent(makeCanonical(), 'h', makeResp([giant]), MAX_CHARS);
    expect(out.was_truncated).toBe(true);
  });

  it('canonical.system is appended (\\n\\n separator) — existing system preserved', () => {
    const out = injectRetrievedContent(
      makeCanonical('existing instructions'),
      'h',
      makeResp(['retrieved doc']),
      MAX_CHARS,
    );
    expect(out.canonical.system).toBeDefined();
    expect(out.canonical.system!.startsWith('existing instructions\n\n')).toBe(true);
    expect(out.canonical.system).toContain('retrieved doc');
    expect(out.canonical.system).toContain('<retrieved_context source="h">');
  });

  it('canonical.messages is NEVER mutated (canonical.ts:108 forbids role:system in messages)', () => {
    const before = makeCanonical();
    const out = injectRetrievedContent(before, 'h', makeResp(['x']), MAX_CHARS);
    // Same reference on messages array (we use spread on the request — messages is shared).
    expect(out.canonical.messages).toBe(before.messages);
    // Length unchanged.
    expect(out.canonical.messages.length).toBe(1);
    // No system-role messages were injected.
    for (const m of out.canonical.messages) {
      expect(['user', 'assistant']).toContain(m.role);
    }
  });

  it('canonical.system: undefined → new system is just the fenced block', () => {
    const out = injectRetrievedContent(makeCanonical(undefined), 'h', makeResp(['x']), MAX_CHARS);
    expect(out.canonical.system).toBe(out.content);
  });

  it('content used for sha256 is the SAME string that landed in canonical.system (post-truncate)', () => {
    // Truncation case — verify that the `content` field returned (intended for
    // SHA256 hashing in pre-completion.ts) matches what was appended to system.
    const giant = 'z'.repeat(8000);
    const out = injectRetrievedContent(
      makeCanonical('preamble'),
      'h',
      makeResp([giant]),
      MAX_CHARS,
    );
    expect(out.canonical.system!.endsWith(out.content)).toBe(true);
  });
});
