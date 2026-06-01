/**
 * Phase 18 / v0.11.0 — RETR-02 / RETR-04 / P5-02 / P5-05.
 * Plan 18-06: real it() — production module landed in src/hooks/pre-completion.ts.
 *
 * Unit tests for `runHookChain` — the orchestrator that executes the
 * `PreCompletionHook[]` sequence configured against a model entry.
 *
 * Contract source (RESEARCH §"Pattern 2" lines 369-403 + §"Code Examples
 * Example 2" lines 752-810):
 *   - Sequential execution (NOT parallel — each hook sees prior injections).
 *   - Promise.race timeout per hook (P5-02 BLOCK no-leak helper).
 *   - on_timeout: 'fail-closed' throws HookTimeoutError; 'fail-open' warns
 *     and returns `fail_open_signaled: true`.
 *   - SHA256 context_hash is computed over the EXACT injected fenced content
 *     (post-truncate), NOT the raw retriever response (P5-05 audit-trail).
 *   - error_message redacts bearer-shaped tokens + truncates to 500 chars.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { Histogram, Registry } from 'prom-client';
import {
  runHookChain,
  type PreCompletionHook,
  type HookLogEntry,
  type RunHookChainResult,
} from '../../src/hooks/pre-completion.js';
import { HookTimeoutError } from '../../src/errors/envelope.js';
import { makeFakeRetrieverProvider } from '../fakes.js';
import type { CanonicalRequest } from '../../src/translation/canonical.js';
import type { RetrievedDocument } from '../../src/providers/retriever-provider.js';

// Compile-time references — keep tsc honest.
type _UnusedHook = PreCompletionHook;
type _UnusedLog = HookLogEntry;
type _UnusedResult = RunHookChainResult;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCanonical(userText = 'tell me about kafka'): CanonicalRequest {
  return {
    model: 'chat-local',
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  };
}

function makeMetrics() {
  const register = new Registry();
  const routerHookDurationMs = new Histogram({
    name: 'router_hook_duration_ms',
    help: 'test',
    labelNames: ['hook_name', 'status'] as const,
    buckets: [10, 50, 100, 250, 500, 1000, 2000, 5000],
    registers: [register],
  });
  return { routerHookDurationMs };
}

/** Minimal FastifyRequest stub — only the fields runHookChain reads. */
function makeReq(): FastifyRequest {
  const warns: Array<{ obj: unknown; msg: string }> = [];
  const log = {
    warn: (obj: unknown, msg: string) => {
      warns.push({ obj, msg });
    },
  };
  return { log, _warns: warns } as unknown as FastifyRequest;
}

function warns(req: FastifyRequest): Array<{ obj: unknown; msg: string }> {
  return (req as unknown as { _warns: Array<{ obj: unknown; msg: string }> })._warns;
}

function makeDocs(...contents: string[]): RetrievedDocument[] {
  return contents.map((content) => ({ content }));
}

describe('runHookChain — pre-completion hook execution', () => {
  it('runtime sentinel: src/hooks/pre-completion.js resolves', async () => {
    await import('../../src/hooks/pre-completion.js');
  });

  it('empty hooks array returns canonical unchanged + empty hook_log', async () => {
    const req = makeReq();
    const canonical = makeCanonical();
    const result = await runHookChain(req, canonical, [], makeMetrics());
    expect(result.canonical).toBe(canonical);
    expect(result.hook_log).toEqual([]);
    expect(result.fail_open_signaled).toBe(false);
    expect(result.fail_open_hook_name).toBeUndefined();
  });

  it('single happy-path hook: retrieves + injects + hook_log entry status:ok', async () => {
    const retriever = makeFakeRetrieverProvider({
      documents: makeDocs('Kafka is a distributed streaming platform.'),
    });

    const hook: PreCompletionHook = {
      name: 'kb',
      retriever,
      timeout_ms: 2000,
      on_timeout: 'fail-open',
      max_chars: 4000,
    };

    const req = makeReq();
    const canonical = makeCanonical();
    const result = await runHookChain(req, canonical, [hook], makeMetrics());

    // canonical.system contains the fence + injected content.
    expect(result.canonical.system).toBeDefined();
    expect(result.canonical.system!).toContain('<retrieved_context source="kb">');
    expect(result.canonical.system!).toContain(
      'Kafka is a distributed streaming platform.',
    );

    // messages untouched.
    expect(result.canonical.messages).toBe(canonical.messages);

    // hook_log entry.
    expect(result.hook_log).toHaveLength(1);
    const entry = result.hook_log[0];
    expect(entry.hook_name).toBe('kb');
    expect(entry.status).toBe('ok');
    expect(entry.chars_retrieved).toBeGreaterThan(0);
    expect(entry.context_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof entry.latency_ms).toBe('number');
    expect(entry.error_message).toBeUndefined();

    // No fail-open.
    expect(result.fail_open_signaled).toBe(false);
  });

  it('sequential chain: each hook sees prior hook injections in working canonical.system', async () => {
    // Hook 1's retriever returns doc A.
    // Hook 2's buildRequest inspects `canonical.system` to verify hook 1's injection is visible.
    const observedSystemAtHook2: { value: string | undefined } = { value: undefined };

    const hook1: PreCompletionHook = {
      name: 'first',
      retriever: makeFakeRetrieverProvider({
        documents: makeDocs('FIRST_HOOK_DOC'),
      }),
      timeout_ms: 2000,
      on_timeout: 'fail-open',
      max_chars: 4000,
    };

    const hook2: PreCompletionHook = {
      name: 'second',
      retriever: makeFakeRetrieverProvider({
        documents: makeDocs('SECOND_HOOK_DOC'),
      }),
      timeout_ms: 2000,
      on_timeout: 'fail-open',
      max_chars: 4000,
      buildRequest: (working) => {
        // Capture what hook 2 sees — must include first hook's injection.
        observedSystemAtHook2.value = working.system;
        return { query: 'q2', top_k: 5 };
      },
    };

    const result = await runHookChain(
      makeReq(),
      makeCanonical(),
      [hook1, hook2],
      makeMetrics(),
    );

    // Hook 2 saw hook 1's injection.
    expect(observedSystemAtHook2.value).toBeDefined();
    expect(observedSystemAtHook2.value!).toContain('FIRST_HOOK_DOC');
    expect(observedSystemAtHook2.value!).toContain('<retrieved_context source="first">');

    // Final canonical has BOTH injections, in order.
    expect(result.canonical.system!).toContain('FIRST_HOOK_DOC');
    expect(result.canonical.system!).toContain('SECOND_HOOK_DOC');
    const idxFirst = result.canonical.system!.indexOf('FIRST_HOOK_DOC');
    const idxSecond = result.canonical.system!.indexOf('SECOND_HOOK_DOC');
    expect(idxFirst).toBeLessThan(idxSecond);

    expect(result.hook_log).toHaveLength(2);
    expect(result.hook_log[0].hook_name).toBe('first');
    expect(result.hook_log[1].hook_name).toBe('second');
  });

  it('fail-closed timeout throws HookTimeoutError + hook_log captured with status:timeout + partial req.hookLog stash for recordOutcome', async () => {
    const hook: PreCompletionHook = {
      name: 'slow_kb',
      retriever: makeFakeRetrieverProvider({ shouldTimeout: true }),
      timeout_ms: 25, // tiny timeout for fast test
      on_timeout: 'fail-closed',
      max_chars: 4000,
    };

    const req = makeReq();
    await expect(runHookChain(req, makeCanonical(), [hook], makeMetrics())).rejects.toThrow(
      HookTimeoutError,
    );

    // Partial hook_log stashed on req for recordOutcome.
    const stashed = (req as unknown as { hookLog?: HookLogEntry[] }).hookLog;
    expect(stashed).toBeDefined();
    expect(stashed!).toHaveLength(1);
    expect(stashed![0].hook_name).toBe('slow_kb');
    expect(stashed![0].status).toBe('timeout');
    expect(stashed![0].context_hash).toBe('');
    expect(stashed![0].chars_retrieved).toBe(0);
    expect(stashed![0].error_message).toBeDefined();
  });

  it('fail-open timeout warns + returns fail_open_signaled:true + fail_open_hook_name set', async () => {
    const hook: PreCompletionHook = {
      name: 'optional_kb',
      retriever: makeFakeRetrieverProvider({ shouldTimeout: true }),
      timeout_ms: 25,
      on_timeout: 'fail-open',
      max_chars: 4000,
    };

    const req = makeReq();
    const result = await runHookChain(req, makeCanonical(), [hook], makeMetrics());

    expect(result.fail_open_signaled).toBe(true);
    expect(result.fail_open_hook_name).toBe('optional_kb');
    expect(result.hook_log).toHaveLength(1);
    expect(result.hook_log[0].status).toBe('timeout');

    // Warn log emitted with the canonical event field.
    const log = warns(req);
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect((log[0].obj as { event?: string }).event).toBe('hook_fail_open');
    expect((log[0].obj as { hook_name?: string }).hook_name).toBe('optional_kb');
  });

  it('multiple fail-open hooks: X-Hook-Error header receives FIRST hook name only (per RESOLVED #8)', async () => {
    const hook1: PreCompletionHook = {
      name: 'first_fail',
      retriever: makeFakeRetrieverProvider({ shouldThrow: new Error('boom 1') }),
      timeout_ms: 1000,
      on_timeout: 'fail-open',
      max_chars: 4000,
    };
    const hook2: PreCompletionHook = {
      name: 'second_fail',
      retriever: makeFakeRetrieverProvider({ shouldThrow: new Error('boom 2') }),
      timeout_ms: 1000,
      on_timeout: 'fail-open',
      max_chars: 4000,
    };
    const hook3: PreCompletionHook = {
      name: 'third_ok',
      retriever: makeFakeRetrieverProvider({ documents: makeDocs('ok') }),
      timeout_ms: 1000,
      on_timeout: 'fail-open',
      max_chars: 4000,
    };

    const result = await runHookChain(
      makeReq(),
      makeCanonical(),
      [hook1, hook2, hook3],
      makeMetrics(),
    );

    expect(result.fail_open_signaled).toBe(true);
    // RESOLVED #8: FIRST fail-open hook only.
    expect(result.fail_open_hook_name).toBe('first_fail');
    expect(result.hook_log).toHaveLength(3);
    expect(result.hook_log[0].status).toBe('error');
    expect(result.hook_log[1].status).toBe('error');
    expect(result.hook_log[2].status).toBe('ok');
  });

  it('SHA256 context_hash computed over the EXACT injected fenced content (post-truncate)', async () => {
    const hook: PreCompletionHook = {
      name: 'kb',
      retriever: makeFakeRetrieverProvider({
        documents: makeDocs('hello world'),
      }),
      timeout_ms: 2000,
      on_timeout: 'fail-open',
      max_chars: 4000,
    };

    const canonical = makeCanonical();
    const result = await runHookChain(makeReq(), canonical, [hook], makeMetrics());

    // canonical.system ends with the fenced content (no prior system), so
    // sha256(canonical.system) == hook_log[0].context_hash.
    const injectedContent = result.canonical.system!;
    const expected = createHash('sha256').update(injectedContent).digest('hex');
    expect(result.hook_log[0].context_hash).toBe(expected);
  });

  it('SHA256 hash matches post-truncate content (not pre-truncate)', async () => {
    // Build a giant doc that overshoots max_chars to trigger truncate.
    const giant = 'x'.repeat(8000);
    const hook: PreCompletionHook = {
      name: 'big',
      retriever: makeFakeRetrieverProvider({ documents: makeDocs(giant) }),
      timeout_ms: 2000,
      on_timeout: 'fail-open',
      max_chars: 4000,
    };

    const result = await runHookChain(makeReq(), makeCanonical(), [hook], makeMetrics());

    expect(result.hook_log[0].status).toBe('truncated');
    expect(result.hook_log[0].chars_retrieved).toBeLessThanOrEqual(4000);

    // hash matches the post-truncate content (which equals the injected system text).
    const injected = result.canonical.system!;
    const expected = createHash('sha256').update(injected).digest('hex');
    expect(result.hook_log[0].context_hash).toBe(expected);

    // Sanity: the hash of the raw 8000-char doc would be different.
    const preTruncHash = createHash('sha256').update(giant).digest('hex');
    expect(result.hook_log[0].context_hash).not.toBe(preTruncHash);
  });

  it('error_message redacts bearer tokens and truncates to 500 chars', async () => {
    const longErr =
      'Upstream failed with Authorization: Bearer sk-VERY-SECRET-TOKEN-xyz; ' +
      'context: ' +
      'a'.repeat(600);
    const hook: PreCompletionHook = {
      name: 'leaky',
      retriever: makeFakeRetrieverProvider({ shouldThrow: new Error(longErr) }),
      timeout_ms: 2000,
      on_timeout: 'fail-open',
      max_chars: 4000,
    };

    const result = await runHookChain(makeReq(), makeCanonical(), [hook], makeMetrics());

    const entry = result.hook_log[0];
    expect(entry.error_message).toBeDefined();
    expect(entry.error_message!.length).toBeLessThanOrEqual(500);
    expect(entry.error_message!).not.toContain('sk-VERY-SECRET-TOKEN-xyz');
    expect(entry.error_message!).toContain('[REDACTED]');
  });

  it('latency_ms uses performance.now() ms (rounded), present on every entry', async () => {
    const hook: PreCompletionHook = {
      name: 'h',
      retriever: makeFakeRetrieverProvider({ documents: makeDocs('x'), latencyMs: 5 }),
      timeout_ms: 2000,
      on_timeout: 'fail-open',
      max_chars: 4000,
    };

    const result = await runHookChain(makeReq(), makeCanonical(), [hook], makeMetrics());
    const entry = result.hook_log[0];
    expect(typeof entry.latency_ms).toBe('number');
    expect(Number.isInteger(entry.latency_ms)).toBe(true);
    expect(entry.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('default top_k=5 + default buildRequest uses lastUserContent (RESOLVED #2)', async () => {
    const calls: import('../../src/providers/retriever-provider.js').RetrieverRequest[] = [];
    const retriever = makeFakeRetrieverProvider({
      documents: makeDocs('x'),
      calls,
    });
    const hook: PreCompletionHook = {
      name: 'h',
      retriever,
      timeout_ms: 2000,
      on_timeout: 'fail-open',
      max_chars: 4000,
      // No top_k, no buildRequest → defaults apply.
    };

    const canonical: CanonicalRequest = {
      model: 'chat-local',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first user msg' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        { role: 'user', content: [{ type: 'text', text: 'LATEST_USER_QUERY' }] },
      ],
    };

    await runHookChain(makeReq(), canonical, [hook], makeMetrics());

    expect(calls).toHaveLength(1);
    expect(calls[0].top_k).toBe(5);
    expect(calls[0].query).toBe('LATEST_USER_QUERY');
  });
});
