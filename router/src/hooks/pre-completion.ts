/**
 * Phase 18 (v0.11.0 — RETR-02..06 + P5-01..05 BLOCK)
 *
 * runHookChain executes the configured pre-completion hooks SEQUENTIALLY
 * (each hook sees prior hook's injections in the working canonical). Each
 * retrieve() call is wrapped in Promise.race([hookPromise, timeoutPromise])
 * with a CANCEL-ABLE timer (P5-02 BLOCK: the #1 race-timeout bug is leaked
 * setTimeout handles when the hook wins the race).
 *
 * STRATEGIC FRAME (binding): "Retrieval Interfaces, not Retrieval Logic" —
 * this module orchestrates an opaque, caller-supplied RetrieverProvider.
 * It does NOT implement retrieval. The only test-only fake retriever lives
 * in tests/fakes.ts (Frame-01 BLOCK; see `makeFakeRetrieverProvider`).
 *
 * Audit trail (P5-05): `hook_log[]` entries carry a SHA256 hash of the
 * post-truncate injected content — NEVER the full content. The forensic
 * trail lives in `request_log.hook_log JSONB` (migration 0007, Plan 18-02).
 *
 * X-Hook-Error semantics (RESOLVED #8): on the FIRST fail-open within a
 * chain, `fail_open_signaled=true` + `fail_open_hook_name` is the failing
 * hook's name. Subsequent fail-opens are silently logged + captured in
 * `hook_log[]` — they do NOT overwrite the header signal.
 */

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FastifyRequest } from 'fastify';
import type { Histogram } from 'prom-client';
import type {
  CanonicalRequest,
  CanonicalMessage,
} from '../translation/canonical.js';
import type {
  RetrieverProvider,
  RetrieverRequest,
  OnTimeout,
} from '../providers/retriever-provider.js';
import { injectRetrievedContent } from './inject.js';
import { HookTimeoutError } from '../errors/envelope.js';

/** Per-hook execution config — registered at boot via BuildAppOpts.preCompletionHooks. */
export interface PreCompletionHook {
  /** Operator-declared. Used for Prometheus label (bounded cardinality) + hook_log + X-Hook-Error. */
  name: string;
  /** Caller-supplied retriever implementation. Router never instantiates one. */
  retriever: RetrieverProvider;
  /** Hook-side budget in ms. Default 2000 (RESOLVED Open Question #1). */
  timeout_ms: number;
  /**
   * Required. No default. Missing = HookConfigError at buildApp time (P5-01 BLOCK).
   *  - 'fail-open': warn log + caller sets X-Hook-Error + request continues.
   *  - 'fail-closed': throw HookTimeoutError + caller maps to 502.
   */
  on_timeout: OnTimeout;
  /** Fenced-content character cap. Default 4000 (P5-03 BLOCK). */
  max_chars: number;
  /** Optional override; default 5 (RESOLVED Open Question #2). */
  top_k?: number;
  /** Optional override; default uses last user message content as query. */
  buildRequest?: (canonical: CanonicalRequest, req: FastifyRequest) => RetrieverRequest;
}

/** Per-hook audit entry — landed in request_log.hook_log JSONB (Plan 18-02 migration 0007). */
export interface HookLogEntry {
  hook_name: string;
  /** SHA256 of the post-truncate fenced content. NEVER the full content (P5-05). */
  context_hash: string;
  latency_ms: number;
  chars_retrieved: number;
  status: 'ok' | 'timeout' | 'error' | 'truncated';
  /** Optional. Bearer-redacted, truncated 500 chars. */
  error_message?: string;
}

export interface RunHookChainResult {
  /** Possibly-mutated canonical (system field appended; messages untouched). */
  canonical: CanonicalRequest;
  /** Pushed to request_log.hook_log in recordOutcome. */
  hook_log: HookLogEntry[];
  /** First fail-open hook fired (caller sets X-Hook-Error response header). */
  fail_open_signaled: boolean;
  fail_open_hook_name?: string;
}

/**
 * Cancel-able Promise.race timeout helper.
 *
 * The #1 race-timeout bug is leaked setTimeout handles when the hook wins
 * the race. ALWAYS call cancel() in finally — even on success — to prevent
 * the event-loop wallclock accumulator from blooming.
 *
 * @param ms   Timeout budget in milliseconds.
 * @param name Hook name — carried in the HookTimeoutError for the audit trail.
 * @returns    `{ promise, cancel }` — `cancel` clears the underlying setTimeout.
 */
export function timeout(
  ms: number,
  name: string,
): { promise: Promise<never>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new HookTimeoutError(name, ms)), ms);
  });
  return {
    promise,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

/**
 * Redact bearer-shaped strings from an error message + truncate to 500 chars
 * IS NOT performed here — call .slice(0, 500) at the call site after this.
 *
 * Defense-in-depth: a misbehaving retriever might echo Authorization headers
 * in its error responses. We strip ANY token-shaped capture before logging.
 */
export function redactBearer(s: string): string {
  return s
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]');
}

/**
 * Default buildRequest: extract the last user message's text content as `query`.
 * If no user message is present (unusual), returns empty string.
 *
 * Walks the message array in reverse (latest user message wins). Text blocks
 * inside a multimodal content array are joined with newline.
 */
function lastUserContent(canonical: CanonicalRequest): string {
  for (let i = canonical.messages.length - 1; i >= 0; i--) {
    const m: CanonicalMessage = canonical.messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const texts: string[] = [];
      for (const b of m.content) {
        if (b.type === 'text') texts.push(b.text);
      }
      return texts.join('\n');
    }
  }
  return '';
}

/**
 * Execute the sequential hook chain.
 *
 * Each hook runs in order. Each retrieve() call is wrapped in Promise.race
 * against a cancel-able timer. On success: inject + SHA256 audit + metrics.
 * On timeout/error: branch on `on_timeout` — fail-closed throws (after
 * stashing the partial hook_log on `req` so recordOutcome can persist it),
 * fail-open continues with a warn log + first-fail X-Hook-Error signal.
 *
 * @param req        The FastifyRequest (passed to hooks' buildRequest + req.log).
 * @param canonical  The post-ContextProvider, pre-adapter canonical.
 * @param hooks      Hooks for the current route (from opts.preCompletionHooks).
 * @param metrics    MetricsRegistry — observes routerHookDurationMs.
 * @returns          { canonical, hook_log, fail_open_signaled, fail_open_hook_name }.
 *                   Throws HookTimeoutError on fail-closed timeout/error.
 */
export async function runHookChain(
  req: FastifyRequest,
  canonical: CanonicalRequest,
  hooks: readonly PreCompletionHook[],
  metrics: { routerHookDurationMs: Histogram<'hook_name' | 'status'> },
): Promise<RunHookChainResult> {
  if (hooks.length === 0) {
    return { canonical, hook_log: [], fail_open_signaled: false };
  }

  let working = canonical;
  const hook_log: HookLogEntry[] = [];
  let fail_open_signaled = false;
  let fail_open_hook_name: string | undefined;

  for (const hook of hooks) {
    const request: RetrieverRequest = hook.buildRequest
      ? hook.buildRequest(working, req)
      : { query: lastUserContent(working), top_k: hook.top_k ?? 5 };

    const t0 = performance.now();
    const t = timeout(hook.timeout_ms, hook.name);

    let status: HookLogEntry['status'] = 'ok';
    let chars_retrieved = 0;
    let context_hash = '';
    let errorMessage: string | undefined;

    try {
      const resp = await Promise.race([hook.retriever.retrieve(request), t.promise]);
      const {
        canonical: nextCanonical,
        content,
        was_truncated,
      } = injectRetrievedContent(working, hook.name, resp, hook.max_chars);
      working = nextCanonical;
      chars_retrieved = content.length;
      // P5-05: SHA256 over the post-truncate injected content (matches what landed in canonical.system).
      context_hash = createHash('sha256').update(content).digest('hex');
      status = was_truncated ? 'truncated' : 'ok';
    } catch (err) {
      status = err instanceof HookTimeoutError ? 'timeout' : 'error';
      // Defense-in-depth: scrub bearer + cap at 500 chars before logging.
      errorMessage = redactBearer(String(err)).slice(0, 500);

      if (hook.on_timeout === 'fail-closed') {
        const latency_ms = Math.round(performance.now() - t0);
        // ms-scale histogram (matches Plan 18-02 bucket array [10,50,...,5000]).
        metrics.routerHookDurationMs.observe(
          { hook_name: hook.name, status },
          latency_ms,
        );
        hook_log.push({
          hook_name: hook.name,
          context_hash: '',
          latency_ms,
          chars_retrieved: 0,
          status,
          error_message: errorMessage,
        });
        // Stash partial hook_log on req so recordOutcome (Plan 18-07 route helper)
        // can persist it AFTER the throw bubbles to the centralized error handler.
        (req as unknown as { hookLog?: HookLogEntry[] }).hookLog = hook_log;
        t.cancel();
        throw new HookTimeoutError(hook.name, hook.timeout_ms);
      }

      // fail-open path: warn log + signal X-Hook-Error (caller stamps the header).
      req.log.warn(
        { hook_name: hook.name, err: errorMessage, status, event: 'hook_fail_open' },
        'pre-completion hook failed-open',
      );
      // RESOLVED #8: first fail-open hook only signals X-Hook-Error; subsequent
      // ones are silently logged here + captured in hook_log[].
      if (!fail_open_signaled) {
        fail_open_signaled = true;
        fail_open_hook_name = hook.name;
      }
    } finally {
      // P5-02 BLOCK: ALWAYS cancel the timer — including the happy path.
      t.cancel();
    }

    const latency_ms = Math.round(performance.now() - t0);
    // ms-scale histogram observe (Plan 18-02 bucket array is ms-scale).
    metrics.routerHookDurationMs.observe(
      { hook_name: hook.name, status },
      latency_ms,
    );

    hook_log.push({
      hook_name: hook.name,
      context_hash,
      latency_ms,
      chars_retrieved,
      status,
      error_message: errorMessage,
    });
  }

  return { canonical: working, hook_log, fail_open_signaled, fail_open_hook_name };
}
