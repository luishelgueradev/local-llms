import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory, BackendAdapter } from '../../backends/adapter.js';
import type { BackendSemaphore } from '../../concurrency/semaphore.js';
import { BackendSaturatedError } from '../../concurrency/semaphore.js';
import { startHeartbeat } from '../../sse/heartbeat.js';
import { openAIRequestToCanonical } from '../../translation/openai-in.js';
import { canonicalToOpenAIResponse, canonicalToOpenAISse } from '../../translation/openai-out.js';
import type { CanonicalResponse, CanonicalStreamEvent, ContentBlock } from '../../translation/canonical.js';
import {
  BreakerOpenError,
  CapabilityNotSupportedError,
  CloudMaxTokensExceededError,
  InvalidStructuredOutputError,
  NO_ENVELOPE,
  mapToHttpStatus,
  toOpenAIErrorEnvelope,
} from '../../errors/envelope.js';
// Phase 17 (v0.11.0 — SESS-01..06 / CTXP-01..03 / SUMP-02): session attach.
import type { SessionStore } from '../../providers/session-store.js';
import type { ContextProvider } from '../../providers/context-provider.js';
import type { SummaryProvider } from '../../providers/summary-provider.js';
import {
  extractIncomingSystemFromOpenAIMessages,
  openAIMessagesToCanonical,
  canonicalToOpenAIMessages,
  lastUserContentFromOpenAI,
  extractToolCallsFromResponse,
  assembleTextFromStreamedChunks,
} from './helpers/session-attach.js';
// Phase 18 (v0.11.0 — MCPC-01..06 + RETR-02..06): shared hook + MCP tool injection helper.
import { runPreCompletionAndInjectMcpTools } from './helpers/pre-completion.js';
import { runMcpToolLoop } from '../../mcp/client/tool-loop.js';
import type { McpClientRegistry } from '../../mcp/client/registry.js';
import type { PreCompletionHook } from '../../hooks/pre-completion.js';
import { applyPreflight } from '../../dispatch/preflight.js';
import {
  buildRepairMessage,
  validateJsonOutput,
  type ResponseFormat,
} from '../../translation/jsonValidation.js';
import { CLOUD_MAX_TOKENS_CAP } from '../../config/constants.js';
import type { CircuitBreaker } from '../../resilience/circuitBreaker.js';
import type { IdempotencyMultiplexer } from '../../resilience/idempotency.js';
import { extractIdempotencyKey } from '../../middleware/idempotencyKey.js';
import {
  deriveStatusClass,
  mapErrorToCode,
  type OutcomeContext,
  type RecordRequestOutcome,
} from '../../metrics/recordOutcome.js';
import { computeCostCents } from '../../cost/computeCostCents.js';

/**
 * OpenAI chat-completions request body. Required fields are zod-validated;
 * everything else (temperature, max_tokens, top_p, tools, tool_choice, response_format,
 * seed, presence_penalty, frequency_penalty, logit_bias, user, etc.) PASSES THROUGH
 * to the upstream SDK call without router-side reshaping.
 *
 * Phase 4 (Plan 04-01) flows the parsed body through openAIRequestToCanonical →
 * adapter.chatCompletionsCanonical{,Stream} → canonicalToOpenAIResponse|canonicalToOpenAISse.
 * The wire output stays byte-identical to Phase 2/3 (the existing chat-completions
 * integration tests are the regression gate).
 */
const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.unknown())]), // string OR array of content blocks (vision in Phase 4)
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
}).passthrough();

// Phase 10 (v0.10.0 — JSON-01/02/05). `response_format` is explicitly typed so:
//   - the capability gate can detect its presence pre-adapter (.passthrough() would still
//     work but we'd lose IntelliSense + zod-level shape validation),
//   - downstream we can branch on `type` without `as` casts,
//   - mis-shaped `response_format` bodies are rejected at the route boundary with the
//     same 400 + invalid_request envelope as any other schema violation.
//
// Unknown `type` values are rejected by the discriminated union → caller must pass
// "text" | "json_object" | "json_schema" verbatim per OpenAI spec.
const ResponseFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string().optional(),
      schema: z.record(z.string(), z.unknown()),
      strict: z.boolean().optional(),
    }),
  }),
]);

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
  response_format: ResponseFormatSchema.optional(),
}).passthrough();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export interface RegisterChatCompletionsOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
  /** Per-backend semaphore map (Plan 03-04, ROUTE-07). */
  semaphores: { get(backend: string): BackendSemaphore };
  /**
   * Plan 05-02 (D-C6) — single helper that records prom-client metrics +
   * enqueues the request_log row. Called from BOTH sseCleanup (stream) and
   * the non-stream finally branch via a per-request safeRecord closure
   * (Pitfall 8 idempotency).
   */
  recordOutcome: RecordRequestOutcome;
  /**
   * Plan 08-04 (CLOUD-03 / D-B1..D-B4) — per-backend circuit breaker. The
   * route calls breaker.check(entry.backend) AFTER capability gating and
   * BEFORE semaphore acquire; on state='open' throws BreakerOpenError (503).
   * recordSuccess/recordFailure are fire-and-forget around the adapter call.
   *
   * Construction lives in app.ts; tests pass either a real Valkey-backed
   * breaker or the no-op fallback (check always 'closed').
   */
  breaker: CircuitBreaker;
  /**
   * Plan 08-04 — Retry-After header value (seconds) when the breaker is
   * open. Derived from env.CIRCUIT_COOLDOWN_MS in app.ts so the route
   * doesn't need access to the env object.
   */
  breakerCooldownSec: number;
  /**
   * Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — optional idempotency multiplexer.
   * When present AND an Idempotency-Key header is supplied, the route
   * either acts as the leader (first request with this key — executes the
   * adapter call and publishes events) or as a follower (subsequent
   * requests with the same key — subscribes and replays the leader's
   * response). When opts.idempotency is undefined (test fixtures without
   * Valkey) the header is silently ignored.
   */
  idempotency?: IdempotencyMultiplexer;
  /**
   * Phase 10 (v0.10.0 — JSON-06) — observe structured-output validation outcomes.
   * Phase 18 (v0.11.0 — RETR-02) widens this with `routerHookDurationMs` so the
   * pre-completion helper can observe per-hook latency. Phase 18 also adds
   * `routerMcpToolCallsExternalTotal` for the runMcpToolLoop dispatch counter.
   * The type stays narrow so tests can inject a no-op without rebuilding the
   * entire MetricsRegistry. When undefined, validation still runs but the
   * metric is not recorded — hooks however REQUIRE the histogram when registered
   * (the helper passes opts.metrics into runHookChain which observe()s it).
   */
  metrics?: {
    jsonValidationTotal: { inc(labels: { result: 'ok' | 'retry' | 'failed' }): void };
    /** Phase 18 (v0.11.0 — RETR-02): observed by runHookChain inside the helper. */
    routerHookDurationMs?: import('prom-client').Histogram<'hook_name' | 'status'>;
    /** Phase 18 (v0.11.0 — MCPC-04): observed by runMcpToolLoop per dispatched call. */
    routerMcpToolCallsExternalTotal?: import('prom-client').Counter<'server_alias' | 'status_class'>;
  };
  /**
   * Phase 18 (v0.11.0 — MCPC-01..06): optional MCP client registry. Absent →
   * no external MCP tools injected and runMcpToolLoop is never invoked. The
   * route still functions byte-identical to Phase 17 (SESS-06 stateless contract
   * extends here: also Phase 18 is opt-in via this field).
   */
  mcpClientRegistry?: McpClientRegistry;
  /**
   * Phase 18 (v0.11.0 — RETR-02/03): per-route pre-completion hook map.
   * Map key = route path ('/v1/chat/completions' | '/v1/messages' | '/v1/responses').
   * Absent → no hooks fire (Frame-01 BLOCK: production composition root passes
   * an EMPTY Map, not undefined — the gate is at the helper).
   */
  preCompletionHooks?: Map<string, PreCompletionHook[]>;
  /**
   * Phase 17 (v0.11.0 — SESS-01..06): optional Postgres-backed session store.
   * When undefined the route's session-attach block is a no-op (SESS-06 stateless
   * contract — byte-identical to Phase 16). Production wiring (Plan 17-07)
   * threads PostgresSessionStore via BuildAppOpts.sessionStore.
   */
  sessionStore?: SessionStore;
  /**
   * Phase 17 (v0.11.0 — CTXP-01..03): optional context provider. When undefined
   * the route skips history merge / system pinning entirely. Plan 17-07 wires
   * DefaultContextProvider (sliding-window + truncate strategies).
   */
  contextProvider?: ContextProvider;
  /**
   * Phase 17 (v0.11.0 — SUMP-01/02): optional summary provider. Currently
   * unused by the route handler (the v0.11.0 ContextProvider does NOT invoke
   * SummaryProvider — SC-5 binding). Threaded here so Plan 17-07's BuildAppOpts
   * wire-up is uniform across all three routes; future ContextProvider
   * compaction strategies (SUMP-FUT-02) will consume it.
   */
  summaryProvider?: SummaryProvider;
}

/**
 * Register POST /v1/chat/completions on the typed Fastify instance.
 *
 * Plan 04-01 (D-A3, D-F3): zod parse → openAIRequestToCanonical → adapter.canonical
 * → canonicalToOpenAI{Response,Sse}. The AbortController + onClose + safeRelease
 * + semaphore + heartbeat + sseCleanup plumbing is unchanged byte-for-byte from
 * Phase 3 — only the middle-three-lines translator pipeline differs.
 */
export function registerChatCompletionsRoute(
  app: FastifyInstance,
  opts: RegisterChatCompletionsOpts,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/v1/chat/completions',
    { schema: { body: ChatCompletionRequestSchema } },
    async (req, reply) => {
      const body = req.body;

      // Phase 15 (v0.11.0 — MCPS-01 / CONTEXT.md D-09): consolidated preflight.
      // applyPreflight runs the canonical trio resolve → applyPolicyGate → breaker.check
      // in a single helper shared with MCP tool handlers (Wave 4). It throws:
      //   - RegistryUnknownModelError (404) on unknown model;
      //   - AllowlistViolationError / CloudNotAllowedError (403) on policy gate;
      // and RETURNS `breakerState` (Option A sentinel) so this HTTP caller can stamp
      // `Retry-After` BEFORE raising BreakerOpenError. POL-05 (gate-before-breaker)
      // is preserved structurally inside applyPreflight — a thrown gate never reaches
      // the breaker.check step. (See dispatch/preflight.ts header comments.)
      const { entry, breakerState } = await applyPreflight(body.model, {
        registry: opts.registry,
        breaker: opts.breaker,
      });
      req.resolvedBackend = entry.backend;       // Plan 08-03 (ROUTE-10) — stamp for onSend hook
      // Plan 08-04 (CLOUD-03) — circuit-breaker sentinel branch. On state='open',
      // stamp Retry-After BEFORE the throw so the centralized error handler's envelope
      // carries the back-off hint; on 'half-open', this caller IS the probe — fall
      // through to the adapter call. BreakerOpenError is excluded from
      // recordFailure by the centralized handler's classifier (isBreakerTrip),
      // so throwing here does not feed back into the breaker counter.
      if (breakerState === 'open') {
        void reply.header('Retry-After', String(opts.breakerCooldownSec));
        throw new BreakerOpenError(entry.backend, opts.breakerCooldownSec);
      }

      // Plan 08-05 (CLOUD-04 / D-C1, D-C2): cloud-served models hard-cap
      // max_tokens at CLOUD_MAX_TOKENS_CAP (Ollama Cloud documented ceiling).
      // Reject (never silently clip — D-C1). The guard fires:
      //   - AFTER req.resolvedBackend stamp (so the 400 response still carries
      //     X-Model-Backend: ollama-cloud via Plan 08-03's onSend hook).
      //   - BEFORE the breaker.check (so a request that would 400 doesn't
      //     consume a half-open probe slot).
      //   - BEFORE semaphore.acquire (so it doesn't queue against the cloud
      //     semaphore).
      // Local models are unaffected — only entries with backend === 'ollama-cloud'
      // enforce the cap. typeof guard skips undefined max_tokens (the
      // OpenAI body schema is .passthrough() so the field may be absent).
      if (
        entry.backend === 'ollama-cloud' &&
        typeof body.max_tokens === 'number' &&
        body.max_tokens > CLOUD_MAX_TOKENS_CAP
      ) {
        throw new CloudMaxTokensExceededError(
          body.max_tokens,
          CLOUD_MAX_TOKENS_CAP,
          entry.name,
        );
      }

      const adapter: BackendAdapter = opts.makeAdapter(entry);

      // ─── Phase 17 (SESS-01..06 + CTXP-01..03 + SUMP-02): session attach ──
      // Gated on req.sessionId + opts.sessionStore. When either is absent the
      // block is a no-op and the route behavior is byte-identical to Phase 16
      // (SESS-06 stateless contract). See RESEARCH §Route handler integration.
      //
      // Q5 RESOLVED: only the idempotency LEADER writes to SessionStore.
      // Followers replay from the multiplexer cache and skip session mutation.
      // The local `idempotencyRole` variable inside the try block is the
      // authoritative source (set after acquire). We initialize sessionAttached
      // here at the OUTER scope so both the non-stream appendTurn and the
      // stream-path IIFE can read it.
      let sessionAttached = false;
      let pinnedSystem: string | undefined;
      let mergedOpenAIMessages = body.messages;
      const incomingLastUserContent = lastUserContentFromOpenAI(body.messages);

      // Sub-block: only when req.sessionId AND opts.sessionStore AND req.agentId.
      // Errors are caught locally + logged + continue stateless (Pitfall 17-B).
      if (req.sessionId && opts.sessionStore && req.agentId) {
        // Pitfall 17-D: stamp X-Session-ID header BEFORE reply.sse/reply.send.
        void reply.header('X-Session-ID', req.sessionId);
        try {
          await opts.sessionStore.createSession({
            session_id: req.sessionId,
            agent_id: req.agentId,
            tenant_id: req.tenantId,
            project_id: req.projectId,
          });
          const history = await opts.sessionStore.loadHistory(
            req.sessionId,
            req.agentId,
          );
          if (opts.contextProvider) {
            // W4 mitigation: pull role:'system' out of incoming messages before
            // handing to ContextProvider — canonical.ts:108 rejects role:'system'.
            const { system: incomingSystem, nonSystemMessages: incomingClean } =
              extractIncomingSystemFromOpenAIMessages(body.messages);
            const incoming = openAIMessagesToCanonical(incomingClean);
            const ctxResult = opts.contextProvider.provideContext(
              history,
              incoming,
              incomingSystem,
              { entry },
            );
            mergedOpenAIMessages = canonicalToOpenAIMessages(
              ctxResult.messages,
            ) as typeof body.messages;
            pinnedSystem = ctxResult.system;
          }
          sessionAttached = true;
        } catch (sessErr) {
          // A10 RESOLVED: SessionNotFoundError / SessionExpiredError /
          // SessionAgentMismatchError → log warn, proceed stateless. Pitfall 17-B.
          // (InvalidSessionIdError is thrown by the preHandler — never reaches here.)
          req.log.warn(
            {
              err: sessErr,
              session_id: req.sessionId,
              event: 'session_attach_failed',
            },
            'session attach failed; continuing stateless',
          );
        }
      }
      // ─── End session attach ──────────────────────────────────────────────

      // Plan 04-01 (D-A3, D-F3): translate inbound OpenAI body → canonical with the
      // backend_model id remapped BEFORE translation so the canonical's `model` field
      // already points to the upstream model id when the adapter receives it.
      // openAIRequestToCanonical throws ZodError on shape violations — the centralized
      // error handler maps to 400 + invalid_request envelope (envelope.ts:60-69).
      //
      // Phase 18 (v0.11.0 — MCPC-01..06 + RETR-02..06): `let canonical` because the
      // hook + MCP injection helper returns a possibly-new canonical (spread-mutation
      // for canonical.tools, mutation in place for canonical.system via runHookChain).
      let canonical = openAIRequestToCanonical({
        ...body,
        model: entry.backend_model,
        messages: mergedOpenAIMessages,
      });
      // Phase 17: pinned system from ContextProvider (joined history + incoming
      // system, in turn_index ascending order — Q4 RESOLVED). openAIRequestToCanonical
      // does not project incoming OpenAI body's `system` field (it's not a wire
      // field on the chat-completions surface), so we set it directly on canonical
      // here. canonical.system is z.string().optional() — undefined when no
      // session attach or no system parts.
      if (pinnedSystem !== undefined) {
        canonical.system = pinnedSystem;
      }

      // ─── Phase 18 (MCPC-01..06 + RETR-02..06): hook chain + MCP tool injection ──
      // Helper fires pre-completion hooks (AFTER ContextProvider, BEFORE adapter)
      // and injects external MCP tools into canonical.tools[] when applicable.
      // mcpToolLoopEnabled is true ONLY on non-stream + enabled aliases + registry
      // present + at least one tool fetched successfully (RESOLVED #4 — stream
      // path stays Phase 16 byte-identical, tool emission without loop).
      // X-Hook-Error header (on fail-open) is stamped via reply.header() inside
      // the helper BEFORE any reply.send/reply.sse call here.
      let mcpToolLoopEnabled = false;
      // Helper requires routerHookDurationMs (runHookChain observe()s it). When
      // metrics are absent OR the Phase 18 histogram wasn't threaded, skip the
      // helper entirely — byte-identical to Phase 17 (the gate is "wiring
      // existed" not "hooks declared"; the helper itself is a no-op when
      // preCompletionHooks is undefined AND mcpClientRegistry is undefined).
      if (opts.metrics?.routerHookDurationMs) {
        const hookResult = await runPreCompletionAndInjectMcpTools(
          req,
          reply,
          canonical,
          entry,
          {
            routeKey: '/v1/chat/completions',
            preCompletionHooks: opts.preCompletionHooks,
            mcpClientRegistry: opts.mcpClientRegistry,
            metrics: { routerHookDurationMs: opts.metrics.routerHookDurationMs },
          },
        );
        canonical = hookResult.canonical;
        mcpToolLoopEnabled = hookResult.mcpToolLoopEnabled;
      }
      // ─── End Phase 18 hook + MCP injection ──────────────────────────────

      // Plan 04-05 D-C2 / VISION-02: capability gating on the OpenAI surface too.
      // Fire BEFORE semaphore acquire / adapter call so non-vision-model image
      // requests get a clean 400 without consuming a slot. CapabilityNotSupportedError
      // → 400 + OpenAI envelope (model_capability_mismatch) per envelope.ts.
      const hasImage = canonical.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'),
      );
      if (hasImage && !entry.capabilities.includes('vision')) {
        throw new CapabilityNotSupportedError(entry.name, 'vision');
      }

      // Phase 10 (v0.10.0 — JSON-05): json_mode capability gate.
      // Any request with `response_format` whose type is "json_object" or "json_schema"
      // requires the model to declare `json_mode` in its registry capabilities — even
      // for `stream: true` (the contract is "the assembled body MUST validate", so a
      // model that can't reliably produce JSON should be rejected at the route boundary,
      // not allowed to produce an unparseable stream the client then can't repair).
      const wantsJson =
        body.response_format !== undefined &&
        (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema');
      if (wantsJson && !entry.capabilities.includes('json_mode')) {
        throw new CapabilityNotSupportedError(entry.name, 'json_mode');
      }

      // ── AbortController: load-bearing for SC3 ──────────────────────────────
      // The signal is forwarded to undici by the openai SDK, which closes the
      // upstream TCP socket when controller.abort() fires. RESEARCH Pitfall 2.
      const controller = new AbortController();

      // BLOCKER fix (D-C4): exactly ONE 'close' listener; heartbeat-stop wired through
      // a mutable closure variable so the listener can clean up BOTH the abort and the
      // heartbeat. Adding a second anonymous listener would leak (no .off() ref).
      let stopHeartbeat: (() => void) | null = null;

      // IMPORTANT: Use req.raw.socket.once('close') NOT req.raw.once('close').
      // IncomingMessage 'close' fires when the HTTP message body is fully consumed
      // by Fastify's body parser — i.e., IMMEDIATELY after the body is parsed, not
      // when the TCP connection closes. This was verified empirically in plan 02-03
      // (see "Socket vs IncomingMessage close" decision) and confirmed in plan 02-04
      // live testing: using req.raw.once('close') caused controller.abort() to fire
      // before chatCompletionsStream() was called, producing empty 200 responses.
      // Socket 'close' fires only when the underlying TCP connection is destroyed,
      // which is the correct signal for client disconnect.
      // Not using req.raw.once('aborted') because 'aborted' is HTTP/1.1-only.
      const onClose = (): void => {
        controller.abort(new Error('client-disconnect'));
        stopHeartbeat?.();  // no-op until heartbeat starts in the stream branch
      };
      // WR-05 fix: silent optional-chain previously masked the no-socket case
      // (app.inject() under vitest; future HTTP/2 where IncomingMessage.socket
      // detaches). Without a `socket`, the 'close' listener never registers and
      // SC3 (client-disconnect → abort propagation) silently degrades to "router
      // holds the stream open until upstream completes". Log a warn when this
      // happens so the degradation is observable in production logs.
      const sock = req.raw.socket;
      if (sock) {
        sock.once('close', onClose);
      } else {
        req.log.warn(
          { url: req.url },
          'stream: req.raw.socket undefined — abort propagation may not fire (HTTP/2 or inject?)',
        );
      }

      // ── Semaphore acquire (Plan 03-04, D-B5) ─────────────────────────────────
      // Acquire BEFORE the adapter call. If the backend is saturated the acquire
      // rejects with BackendSaturatedError which is caught in the outer catch below
      // and forwarded to the centralized error handler as a 429.
      //
      // The signal is controller.signal so a client disconnect (onClose → controller.abort())
      // also aborts the queue-wait (T-3-D6 mitigation).
      //
      // IMPORTANT: The acquire is inside the try block so that BackendSaturatedError
      // is caught by the catch clause that sets the Retry-After header before re-throw.
      // If acquire were outside the try, the header would never be set.
      //
      // WR-01 fix: opts.semaphores.get() is also inside the try block so a missing
      // semaphore entry (hot-reload adds a new backend whose Map entry was not rebuilt
      // — IN-01 forward-looking issue) cleans up the socket 'close' listener via the
      // catch clause's req.raw.socket?.off('close', onClose) call.

      // Idempotent release closure — mirrors heartbeat.stop() pattern.
      // Called from BOTH the finally block AND sseCleanup (Pitfall 1 / T-3-D4).
      // Initialized as a no-op until acquire succeeds; ensures finally never panics.
      let released = false;
      let release: () => void = () => {};
      const safeRelease = (): void => {
        if (released) return;
        released = true;
        release();
      };

      // Plan 05-02 Task 3 (Pitfall 8): idempotent record closure mirrors the
      // safeRelease shape. sseCleanup may fire twice in rare error paths
      // (stream end + onClose + error handler); without this guard we'd
      // double-row the request_log AND double-count the metric.
      let recorded = false;
      const safeRecord = (ctx: OutcomeContext): void => {
        if (recorded) return;
        recorded = true;
        req.__recorded = true; // suppress app.setErrorHandler from also recording
        opts.recordOutcome(ctx);
      };

      // Captured by both catch + finally so safeRecord can know whether to
      // populate error_code / errorMessage vs tokens.
      let caughtErr: Error | undefined;
      let canonicalResult: CanonicalResponse | undefined;

      // Plan 08-07 (ROUTE-12 / D-D5) — extract + validate Idempotency-Key. The
      // extraction throws InvalidIdempotencyKeyError (400) on regex violation;
      // the centralized error handler maps it to the OpenAI envelope. Done
      // BEFORE the try block so the listener cleanup is irrelevant (no socket
      // listener attached yet). When opts.idempotency is undefined (no Valkey)
      // we skip the multiplexer dance entirely — the key is silently ignored.
      const idempotencyKey = extractIdempotencyKey(req.headers);
      let idempotencyRole: 'leader' | 'follower' | undefined;
      // For follower replay, capture the shared upstream_message_id so the
      // request_log row records it under the SAME upstream_message_id as the
      // leader (Plan 08-08 cost-attribution dashboard groups by this field).
      let followerUpstreamMessageId: string | undefined;

      try {
        // Plan 15 (v0.11.0 — MCPS-01 / CONTEXT.md D-09): the breaker gate now
        // lives in applyPreflight() (called above before this try block). The
        // sentinel-open branch and Retry-After stamp moved alongside it.
        //
        // Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — Idempotency-Key acquire. Runs
        // AFTER applyPreflight (so a backend-out request fails fast and doesn't
        // pollute the idempotency key) and BEFORE semaphore.acquire (followers
        // must NOT consume a slot — that's the cost-saving the multiplexer
        // provides).
        if (idempotencyKey && opts.idempotency) {
          const acq = await opts.idempotency.acquire(idempotencyKey, req.id);
          idempotencyRole = acq.role;
          if (acq.role === 'follower') {
            if (body.stream !== true) {
              // ── NON-STREAM FOLLOWER ──────────────────────────────────
              const { body: cachedBody, upstreamMessageId } =
                await opts.idempotency.awaitNonStreamResult(idempotencyKey, req.id);
              followerUpstreamMessageId = upstreamMessageId;
              // Phase 13 (v0.10.0 — COST-01/02): the cached wire body carries
              // the leader's `usage` block. Reconstruct a canonical-shape result
              // so the outer-finally's safeRecord computes cost from real tokens
              // rather than recording NULL. The wire body uses OpenAI's snake_case
              // `prompt_tokens` / `completion_tokens` — translate them.
              const cb = cachedBody as {
                usage?: { prompt_tokens?: number; completion_tokens?: number };
              };
              if (cb.usage) {
                canonicalResult = {
                  id: '',
                  type: 'message',
                  role: 'assistant',
                  content: [],
                  model: entry.backend_model,
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {
                    input_tokens: cb.usage.prompt_tokens ?? 0,
                    output_tokens: cb.usage.completion_tokens ?? 0,
                  },
                };
                // Stamp X-Cost-Cents header before reply.send() (Fastify onSend
                // fires synchronously inside .send()).
                const followerCost =
                  computeCostCents({
                    entry,
                    tokensIn: canonicalResult.usage.input_tokens,
                    tokensOut: canonicalResult.usage.output_tokens,
                  }) ?? undefined;
                if (followerCost !== undefined) {
                  req.computedCostCents = followerCost;
                }
              }
              req.raw.socket?.off('close', onClose);
              return reply.send(cachedBody);
            }
            // ── STREAM FOLLOWER (Task 3) ─────────────────────────────
            // Pipe the multiplexer's iterator through the canonical→OpenAI
            // SSE translator. The leader's wire output is reproduced exactly
            // because both leader + follower run the SAME translator with
            // the SAME displayModel argument over the SAME canonical events.
            const followerHeartbeat = startHeartbeat(reply.raw);
            stopHeartbeat = (): void => followerHeartbeat.stop();
            const muxIter = opts.idempotency.awaitStreamResult(
              idempotencyKey,
              req.id,
            );
            // Adapter-shaped iterable that yields canonical events from the
            // multiplexer's stream. Terminal markers (done/error/aborted)
            // end the iteration; `aborted`/`error` also flip a flag so the
            // route records the appropriate status_class via sseCleanup.
            let muxTerminal: 'done' | 'error' | 'aborted' | undefined;
            const followerEvents: AsyncIterable<CanonicalStreamEvent> = {
              async *[Symbol.asyncIterator](): AsyncGenerator<CanonicalStreamEvent> {
                for await (const item of muxIter) {
                  if (item.terminal) {
                    muxTerminal = item.terminal;
                    return;
                  }
                  if (item.event !== undefined) {
                    yield item.event as CanonicalStreamEvent;
                  }
                }
              },
            };
            const followerSseCleanup = (final?: {
              tokensIn: number;
              tokensOut: number;
              error?: Error;
            }): void => {
              followerHeartbeat.stop();
              req.raw.socket?.off('close', onClose);
              // No semaphore release — follower never acquired one.
              const aborted = muxTerminal === 'aborted' || controller.signal.aborted;
              const httpStatusFollow = final?.error
                ? mapToHttpStatus(final.error)
                : reply.statusCode;
              const statusClass = aborted
                ? 'disconnect'
                : final?.error
                  ? deriveStatusClass(httpStatusFollow, false)
                  : deriveStatusClass(reply.statusCode, false);
              // Phase 13 (v0.10.0 — COST-01): follower replays the same canonical
              // events so its token counts are equivalent to the leader's. Recompute
              // cost here rather than fetch the leader's cached value — the formula
              // is local + cheap. The cost_per_agent_daily view SUM(cost_cents) over
              // GROUP BY upstream_message_id thus reports (1 leader + N followers) ×
              // per-request cost, which matches request_count semantics in the same
              // view (N+1 served requests, N+1 cost rows).
              const followerCost = final?.error
                ? undefined
                : computeCostCents({
                    entry,
                    tokensIn: final?.tokensIn,
                    tokensOut: final?.tokensOut,
                  }) ?? undefined;
              safeRecord({
                protocol: 'openai',
                route: req.url.split('?')[0] ?? req.url,
                backend: entry.backend,
                model: entry.name,
                statusClass,
                httpStatus: httpStatusFollow,
                durationMs: performance.now() - (req._t0 ?? performance.now()),
                ttftMs: followerHeartbeat.msSinceStart,
                tokensIn: final?.tokensIn,
                tokensOut: final?.tokensOut,
                errorCode: aborted
                  ? 'client_disconnect'
                  : final?.error
                    ? mapErrorToCode(final.error)
                    : undefined,
                errorMessage: final?.error?.message,
                agentId: req.agentId,
                tenantId: req.tenantId,
                projectId: req.projectId,
                workloadClass: req.workloadClass,
                requestId: req.id,
                upstreamMessageId: followerUpstreamMessageId,
                // 08-REVIEW CR-01: persist Idempotency-Key so dedup verification
                // queries (smoke-test-cloud.sh + README) find the follower rows.
                idempotencyKey,
                costCents: followerCost,
                timestamp: new Date(),
              });
            };
            try {
              await reply.sse(
                canonicalToOpenAISse(followerEvents, {
                  signal: controller.signal,
                  onCleanup: followerSseCleanup,
                  displayModel: entry.name,
                }),
              );
            } finally {
              followerHeartbeat.stop();
            }
            return;
          }
          // Leader role: fall through and execute the adapter call.
        }

        // Lookup the semaphore for the resolved backend. Inside the try so a missing
        // entry routes through the centralized error handler with proper listener cleanup.
        const semaphore = opts.semaphores.get(entry.backend);
        // Acquire the semaphore slot INSIDE the try block so BackendSaturatedError
        // is caught below and Retry-After can be set before re-throw.
        release = await semaphore.acquire(controller.signal);
        released = false; // reset: the slot is now held
        if (body.stream === true) {
          // ── STREAM BRANCH (RESEARCH §Pattern 3 — load-bearing for SC1 + SC3) ──
          let upstream: AsyncIterable<CanonicalStreamEvent>;
          try {
            // Some SDKs throw synchronously on bad params; some return a thenable that
            // rejects. Wrap in try/catch so a PRE-STREAM error becomes a JSON envelope
            // rather than starting an SSE response we can't recover from.
            upstream = await adapter.chatCompletionsCanonicalStream(canonical, controller.signal);
          } catch (err) {
            // Plan 08-04 — pre-stream adapter error (the SDK threw before the
            // stream began). The classifier filters non-trip errors; fire-and-
            // forget so the JSON envelope below isn't delayed by Valkey RTT.
            void opts.breaker.recordFailure(entry.backend, err);
            // Plan 08-07 — pre-stream error: publish 'error' terminal so any
            // follower waiting on the channel disconnects with a structured
            // outcome (fire-and-forget — Valkey blip shouldn't delay the
            // 4xx/5xx envelope from the leader's POV).
            if (idempotencyKey && idempotencyRole === 'leader' && opts.idempotency) {
              void opts.idempotency
                .finalizeStream(idempotencyKey, 'error')
                .catch((finalizeErr: unknown) => {
                  req.log.warn(
                    { err: finalizeErr, idempotencyKey },
                    'idempotency: finalizeStream(error) failed (leader pre-stream catch)',
                  );
                });
            }
            // HTTP not yet 200; emit envelope.
            req.raw.socket?.off('close', onClose);
            const env = toOpenAIErrorEnvelope(err);
            const status = mapToHttpStatus(err);
            // CR-02 (05-VERIFICATION.md gaps[1]): pre-stream error must produce a
            // request_log row. safeRecord is idempotent via the recorded flag (lines
            // 181-187) so calling it here AND from the finally is structurally safe —
            // only the first call observes effects. NO_ENVELOPE → client disconnect
            // (APIUserAbortError) records as 'disconnect' status_class with the
            // 'client_disconnect' error_code. Regular envelope → typed error_code
            // via mapErrorToCode + redactable error_message via err.message.
            if (env === NO_ENVELOPE) {
              safeRecord({
                protocol: 'openai',
                route: req.url.split('?')[0] ?? req.url,
                backend: entry.backend,
                model: entry.name,
                statusClass: 'disconnect',
                httpStatus: status,
                durationMs: performance.now() - (req._t0 ?? performance.now()),
                errorCode: 'client_disconnect',
                agentId: req.agentId,
                tenantId: req.tenantId,
                projectId: req.projectId,
                workloadClass: req.workloadClass,
                requestId: req.id,
                // 08-REVIEW CR-01: persist Idempotency-Key on pre-stream errors.
                idempotencyKey,
                timestamp: new Date(),
              });
              return; // client gone — defensive
            }
            const errInst = err instanceof Error ? err : new Error(String(err));
            safeRecord({
              protocol: 'openai',
              route: req.url.split('?')[0] ?? req.url,
              backend: entry.backend,
              model: entry.name,
              statusClass: deriveStatusClass(status, false),
              httpStatus: status,
              durationMs: performance.now() - (req._t0 ?? performance.now()),
              errorCode: mapErrorToCode(errInst),
              errorMessage: errInst.message,
              agentId: req.agentId,
              tenantId: req.tenantId,
              projectId: req.projectId,
              workloadClass: req.workloadClass,
              requestId: req.id,
              // 08-REVIEW CR-01: persist Idempotency-Key on pre-stream errors.
              idempotencyKey,
              timestamp: new Date(),
            });
            return reply.code(status).send(env);
          }

          // Start the heartbeat AFTER the upstream resolves but BEFORE consuming.
          // Pattern 3 line 488 starts it after the first byte; in our shape, reply.sse(...)
          // flushes headers on the first iteration, so starting before the first yield
          // is equivalent. Stops in the iterator's onCleanup AND via onClose's stopHeartbeat
          // hook (single listener, belt-and-suspenders cleanup paths).
          const heartbeat = startHeartbeat(reply.raw);
          stopHeartbeat = () => heartbeat.stop();  // wires onClose to also stop heartbeat

          // Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — leader-side multiplexer
          // wiring. Wrap the upstream iterable so each canonical event is
          // fire-and-forget RPUSHed + PUBLISHed to the channel BEFORE being
          // yielded to the SSE translator. Followers subscribed to the
          // channel receive byte-identical events; followers arriving later
          // LRANGE the cached chunks list. capturedUpstreamMessageId is
          // captured from message_start.message.id so finalizeStream can
          // surface the shared id to followers' request_log rows.
          let capturedUpstreamMessageId: string | undefined;
          // Phase 17 stream-path accumulators (for fire-and-forget appendTurn
          // inside sseCleanup). Captured by reference so the IIFE below sees
          // the final state after the stream completes.
          const streamedTextParts: string[] = [];
          const streamedToolUseBlocks: import('../../translation/canonical.js').ToolUseBlock[] = [];
          // partials for tool_use input JSON accumulation (input_json_delta).
          const toolUseInProgress = new Map<
            number,
            { id: string; name: string; jsonParts: string[] }
          >();
          let streamFinalTokensIn: number | undefined;
          let streamFinalTokensOut: number | undefined;
          const upstreamWithMux: AsyncIterable<CanonicalStreamEvent> = {
            async *[Symbol.asyncIterator](): AsyncGenerator<CanonicalStreamEvent> {
              for await (const ev of upstream) {
                if (ev.type === 'message_start') {
                  capturedUpstreamMessageId = ev.message.id;
                  if (typeof ev.message.usage?.input_tokens === 'number') {
                    streamFinalTokensIn = ev.message.usage.input_tokens;
                  }
                } else if (ev.type === 'content_block_start') {
                  if (ev.content_block.type === 'tool_use') {
                    toolUseInProgress.set(ev.index, {
                      id: ev.content_block.id,
                      name: ev.content_block.name,
                      jsonParts: [],
                    });
                  }
                } else if (ev.type === 'content_block_delta') {
                  if (ev.delta.type === 'text_delta') {
                    streamedTextParts.push(ev.delta.text);
                  } else if (ev.delta.type === 'input_json_delta') {
                    const tu = toolUseInProgress.get(ev.index);
                    if (tu) tu.jsonParts.push(ev.delta.partial_json);
                  }
                } else if (ev.type === 'content_block_stop') {
                  const tu = toolUseInProgress.get(ev.index);
                  if (tu) {
                    let parsed: Record<string, unknown> = {};
                    try {
                      parsed = tu.jsonParts.length > 0
                        ? (JSON.parse(tu.jsonParts.join('')) as Record<string, unknown>)
                        : {};
                    } catch {
                      // Malformed JSON in stream — keep as empty input; the
                      // wire-level translator already surfaced what it could.
                    }
                    streamedToolUseBlocks.push({
                      type: 'tool_use',
                      id: tu.id,
                      name: tu.name,
                      input: parsed,
                    });
                    toolUseInProgress.delete(ev.index);
                  }
                } else if (ev.type === 'message_delta') {
                  if (typeof ev.usage?.output_tokens === 'number') {
                    streamFinalTokensOut = ev.usage.output_tokens;
                  }
                }
                // Idempotency leader: fire-and-forget publish to the multiplexer
                // channel. publishStreamEvent catches + logs internally — a
                // Valkey blip never stalls the upstream → SSE pipeline.
                if (
                  idempotencyKey &&
                  idempotencyRole === 'leader' &&
                  opts.idempotency
                ) {
                  void opts.idempotency.publishStreamEvent(idempotencyKey, ev);
                }
                yield ev;
              }
            },
          };

          // sseCleanup is called by canonicalToOpenAISse onCleanup on stream end / abort / error.
          // CRITICAL (Pitfall 1 / T-3-D4): sseCleanup MUST call safeRelease so the semaphore
          // slot is released when the SSE stream closes — NOT when the adapter call returns
          // (which is immediately for streaming). Revision 1 Warning 7 makes this grep-verifiable.
          //
          // Plan 05-02 Task 3: also call safeRecord with the final tokens passed
          // from canonicalToOpenAISse's widened onCleanup signature. The route is
          // the structural enforcement point for the request_log row (D-D6).
          //
          // CR-03 (05-VERIFICATION.md gaps[2]): when the translator reports a
          // mid-stream upstream error via final.error, override status_class /
          // error_code / error_message to reflect the real outcome. Without this
          // override, reply.statusCode === 200 (SSE headers already flushed) +
          // controller.signal.aborted === false → deriveStatusClass returns
          // 'success' — the audit trail would record success for a wire-correct
          // error. Reuses existing helpers (mapToHttpStatus + mapErrorToCode) —
          // NO new helper duplication.
          const sseCleanup = (final?: {
            tokensIn: number;
            tokensOut: number;
            error?: Error;
          }): void => {
            heartbeat.stop();
            req.raw.socket?.off('close', onClose);
            safeRelease();  // Pitfall 1 mitigation — slot released on stream end/abort/error
            // Plan 08-04 — stream-branch breaker signaling. Fire-and-forget so
            // sseCleanup stays synchronous. final.error => recordFailure
            // (the classifier filters non-trip errors anyway); otherwise
            // recordSuccess closes a half-open probe / no-op on closed.
            if (final?.error !== undefined) {
              void opts.breaker.recordFailure(entry.backend, final.error);
            } else {
              void opts.breaker.recordSuccess(entry.backend);
            }
            // Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — leader-side finalize.
            // Fire-and-forget. Status mapping: error => 'error'; client
            // disconnect => 'aborted'; otherwise 'done'. Followers
            // subscribed to the channel receive a terminal marker and
            // disconnect cleanly. The cached chunks list + result key
            // get EXPIRE 900s (15 min) for late-arriving followers.
            if (idempotencyKey && idempotencyRole === 'leader' && opts.idempotency) {
              const terminal: 'done' | 'error' | 'aborted' =
                final?.error !== undefined
                  ? 'error'
                  : controller.signal.aborted
                    ? 'aborted'
                    : 'done';
              void opts.idempotency
                .finalizeStream(idempotencyKey, terminal, capturedUpstreamMessageId)
                .catch((finalizeErr: unknown) => {
                  req.log.warn(
                    { err: finalizeErr, idempotencyKey, terminal },
                    'idempotency: finalizeStream failed (leader stream end)',
                  );
                });
            }
            const hasUpstreamError = final?.error !== undefined;
            const errStatus = hasUpstreamError
              ? mapToHttpStatus(final!.error)
              : reply.statusCode;
            const statusClass = hasUpstreamError
              ? deriveStatusClass(errStatus, false)
              : deriveStatusClass(reply.statusCode, controller.signal.aborted);
            const errorCode = hasUpstreamError
              ? mapErrorToCode(final!.error)
              : controller.signal.aborted
                ? 'client_disconnect'
                : undefined;
            const errorMessage = hasUpstreamError ? final!.error!.message : undefined;
            // Phase 13 (v0.10.0 — COST-01): record cost on the streaming path
            // too. The X-Cost-Cents header CANNOT be sent on streamed responses
            // (SSE headers are flushed before the first chunk, long before tokens
            // are known) — the request_log row is the only durable record of
            // streamed-request cost. The dashboard view cost_per_agent_daily
            // sums this faithfully across stream + non-stream alike.
            const costCents = hasUpstreamError
              ? undefined
              : computeCostCents({
                  entry,
                  tokensIn: final?.tokensIn,
                  tokensOut: final?.tokensOut,
                }) ?? undefined;
            safeRecord({
              protocol: 'openai',
              route: req.url.split('?')[0] ?? req.url,
              backend: entry.backend,
              model: entry.name,
              statusClass,
              httpStatus: errStatus,
              durationMs: performance.now() - (req._t0 ?? performance.now()),
              ttftMs: heartbeat.msSinceStart,
              tokensIn: final?.tokensIn,
              tokensOut: final?.tokensOut,
              errorCode,
              errorMessage,
              agentId: req.agentId,
              tenantId: req.tenantId,
              projectId: req.projectId,
              workloadClass: req.workloadClass,
              requestId: req.id,
              // Plan 08-07 — share upstream_message_id with followers'
              // request_log rows for Plan 08-08 cost-attribution grouping.
              upstreamMessageId: capturedUpstreamMessageId,
              // 08-REVIEW CR-01: persist Idempotency-Key so dedup verification
              // queries can group leader + follower rows on this column.
              idempotencyKey,
              costCents,
              timestamp: new Date(),
            });

            // ─── Phase 17 stream-path appendTurn — Pitfall 17-F BLOCK ────
            // FIRE-AND-FORGET: never `await` inside sseCleanup — that would
            // block the TCP close on Postgres. The IIFE catches all errors
            // and logs them; the response has already streamed to the client
            // by this point.
            if (
              !hasUpstreamError &&
              !controller.signal.aborted &&
              sessionAttached &&
              req.sessionId &&
              req.agentId &&
              opts.sessionStore &&
              idempotencyRole !== 'follower'
            ) {
              const sid = req.sessionId;
              const aid = req.agentId;
              const log = req.log;
              const store = opts.sessionStore;
              const tokensIn = streamFinalTokensIn ?? final?.tokensIn;
              const tokensOut = streamFinalTokensOut ?? final?.tokensOut;
              const assistantContent: ContentBlock[] = [
                ...assembleTextFromStreamedChunks(streamedTextParts),
                ...streamedToolUseBlocks,
              ];
              const assistantToolCalls =
                streamedToolUseBlocks.length > 0
                  ? streamedToolUseBlocks
                  : undefined;
              void (async (): Promise<void> => {
                try {
                  if (incomingLastUserContent !== undefined) {
                    await store.appendTurn(sid, aid, {
                      role: 'user',
                      content: incomingLastUserContent,
                    });
                  }
                  await store.appendTurn(sid, aid, {
                    role: 'assistant',
                    content: assistantContent,
                    tool_calls: assistantToolCalls,
                    model: entry.name,
                    tokens_in: tokensIn,
                    tokens_out: tokensOut,
                  });
                } catch (e) {
                  log.warn(
                    {
                      err: e,
                      session_id: sid,
                      event: 'session_append_unexpected',
                    },
                    'session append after stream failed',
                  );
                }
              })();
            }
            // ─── End stream-path appendTurn ──────────────────────────────
          };

          // The SSE plugin sets Content-Type + Cache-Control + Connection on first yield
          // and calls reply.raw.end() when the iterable completes.
          //
          // WR-04 fix: wrap in try/finally so the heartbeat is always stopped, including
          // when `reply.sse(...)` rejects synchronously (e.g., headers already sent /
          // plugin in a degraded state). Without this, the `onCleanup` callback inside
          // the iterator never runs, and `onClose`/`stopHeartbeat` may also have been
          // detached, leaving an unref'd interval scheduled until the next EPIPE.
          // `heartbeat.stop()` is idempotent — calling it twice (here AND from
          // sseCleanup) is safe.
          //
          // ROUTE-08 (TD-02 resolution) — backpressure: fastify-sse-v2's
          // reply.sse(asyncIterable) consumer awaits `reply.raw.write()` before
          // pulling the next value from the iterable. When the underlying TCP
          // socket buffer is full, the write Promise resolves only after the
          // socket drains. Result: the async iterable pauses naturally, the
          // upstream SDK reader pauses, and no memory accumulates in the
          // generator. This is the JavaScript-native async-iterable equivalent
          // of the textual ROUTE-08 spec ("reply.raw.write() return value +
          // 'drain' await") — the same property, expressed in the higher-level
          // primitive. See tests/integration/chat-completions.backpressure.test.ts
          // for the regression gate that a slow consumer (deliberately delayed
          // socket writes) does NOT pile rows in memory.
          try {
            await reply.sse(canonicalToOpenAISse(upstreamWithMux, {
              signal: controller.signal,
              onCleanup: sseCleanup,
              // Plan 04-05: registry name on the wire (parity with Anthropic surface).
              displayModel: entry.name,
            }));
          } finally {
            heartbeat.stop();
          }

          // Belt-and-suspenders log: if the request ended with a client-abort, log info.
          if (controller.signal.aborted) {
            req.log.info({
              url: req.url,
              bytesEmitted: heartbeat.bytesSinceStart,
              msSinceStart: heartbeat.msSinceStart,
            }, 'stream: client disconnected');
          }
          return;
        }

        // ── NON-STREAM BRANCH (Plan 04-01 D-A3 / D-F3) ───────────────────────
        // adapter.chatCompletionsCanonical returns a CanonicalResponse; we map it
        // back to OpenAI ChatCompletion shape (preserving body.id via _upstreamId).
        // Plan 04-05: pass displayModel so the wire `model` field is the registry
        // name (parity with the Anthropic surface).
        // Plan 05-02 Task 3: capture canonicalResult on the OUTER scope so the
        // finally block can populate request_log.tokens_in / tokens_out for the
        // non-stream branch.
        //
        // Phase 10 (v0.10.0 — JSON-01..04): when response_format is json_object or
        // json_schema, validate the assistant content after the adapter call. On
        // failure, append a synthetic repair message to the canonical and retry
        // exactly ONCE (single-shot). If the second response also fails to validate,
        // throw InvalidStructuredOutputError → 400 + invalid_structured_output envelope.
        //
        // The repair loop happens INSIDE the try block, BEFORE breaker.recordSuccess —
        // so a request that ultimately fails validation is recorded as a failure (and
        // the breaker sees recordFailure via the catch path), not a success.
        //
        // Phase 18 (v0.11.0 — MCPC-04): when mcpToolLoopEnabled is true, drive the
        // model → external-MCP-tool → model loop via runMcpToolLoop (capped at 10
        // iterations; per-iteration parallel dispatch). Stream path stays untouched
        // (RESOLVED #4 — non-stream only). The non-stream adapter call here is the
        // ONLY load-bearing site for the tool loop.
        canonicalResult =
          mcpToolLoopEnabled &&
          opts.mcpClientRegistry &&
          opts.metrics?.routerMcpToolCallsExternalTotal
            ? await runMcpToolLoop({
                initial: canonical,
                adapter,
                signal: controller.signal,
                registry: opts.mcpClientRegistry,
                enabledAliases: entry.mcp_servers_enabled ?? [],
                // Cast to pino Logger — Fastify exposes FastifyBaseLogger which
                // is a structural superset minus `msgPrefix`. runMcpToolLoop's
                // signature is pino Logger; the child loggers exposed by Fastify
                // v5 ARE pino logger instances at runtime, just typed narrower
                // at the public boundary.
                log: req.log as unknown as import('pino').Logger,
                metrics: {
                  routerMcpToolCallsExternalTotal:
                    opts.metrics.routerMcpToolCallsExternalTotal,
                },
              })
            : await adapter.chatCompletionsCanonical(canonical, controller.signal);

        if (wantsJson) {
          const rf = body.response_format as ResponseFormat;
          const firstContent = extractAssistantText(canonicalResult);
          const firstCheck = validateJsonOutput(firstContent, rf);
          if (firstCheck.ok) {
            opts.metrics?.jsonValidationTotal.inc({ result: 'ok' });
          } else {
            // Single-shot repair: append the failing assistant turn AND a user message
            // with the repair instruction, then re-call the adapter exactly once.
            const repairCanonical = {
              ...canonical,
              messages: [
                ...canonical.messages,
                { role: 'assistant' as const, content: [{ type: 'text' as const, text: firstContent }] },
                { role: 'user' as const, content: [{ type: 'text' as const, text: buildRepairMessage(firstCheck.reason) }] },
              ],
            };
            const repairResult = await adapter.chatCompletionsCanonical(repairCanonical, controller.signal);
            const repairContent = extractAssistantText(repairResult);
            const repairCheck = validateJsonOutput(repairContent, rf);
            if (repairCheck.ok) {
              opts.metrics?.jsonValidationTotal.inc({ result: 'retry' });
              canonicalResult = repairResult;
            } else {
              opts.metrics?.jsonValidationTotal.inc({ result: 'failed' });
              throw new InvalidStructuredOutputError(entry.name, repairCheck.reason);
            }
          }
        }

        // Plan 08-04 — fire-and-forget breaker success signal. Not awaited so
        // it doesn't add tail latency to the response. If Valkey is slow / down,
        // the breaker's internal client-options (lazyConnect:false +
        // enableOfflineQueue:false) surface a rejection that pino logs via the
        // breaker's `log.warn`; the route is unaffected.
        void opts.breaker.recordSuccess(entry.backend);
        req.raw.socket?.off('close', onClose);
        // Phase 13 (v0.10.0 — COST-02): stamp req.computedCostCents BEFORE
        // reply.send() — Fastify v5 triggers onSend synchronously inside
        // .send(), before this function's outer finally runs.
        const earlyCost =
          computeCostCents({
            entry,
            tokensIn: canonicalResult.usage.input_tokens,
            tokensOut: canonicalResult.usage.output_tokens,
          }) ?? undefined;
        if (earlyCost !== undefined) {
          req.computedCostCents = earlyCost;
        }
        const wireBody = canonicalToOpenAIResponse(canonicalResult, {
          displayModel: entry.name,
        });
        // Plan 08-07 (ROUTE-12 / D-D5 / D-D6) — leader publishes the wire
        // body so concurrent followers waiting on the channel can replay it
        // byte-identically. Fire-and-forget IS NOT used here: we await so
        // that any follower currently subscribed sees the result BEFORE the
        // response is flushed. Failure here is logged but does not block the
        // 200 response — multiplexer publish failures should not fail the
        // leader's request from the client's POV.
        if (idempotencyKey && idempotencyRole === 'leader' && opts.idempotency) {
          try {
            await opts.idempotency.publishNonStream(
              idempotencyKey,
              wireBody,
              canonicalResult.id,
            );
          } catch (err) {
            req.log.warn(
              { err, idempotencyKey },
              'idempotency: publishNonStream failed (leader response still returned)',
            );
          }
        }

        // ─── Phase 17 non-stream appendTurn (SESS-01/03/04, SUMP-03 via store) ──
        // Q5 leader-only writes: skip when this request is a follower. Bounded
        // by SESS-04's 1s timeout inside appendTurn itself; persisted:false on
        // timeout → log + continue (Pitfall 17-E; counter increment deferred
        // to Plan 17-07).
        if (
          sessionAttached &&
          req.sessionId &&
          req.agentId &&
          opts.sessionStore &&
          idempotencyRole !== 'follower'
        ) {
          try {
            if (incomingLastUserContent !== undefined) {
              const r1 = await opts.sessionStore.appendTurn(
                req.sessionId,
                req.agentId,
                { role: 'user', content: incomingLastUserContent },
              );
              if (r1.persisted === false) {
                req.log.warn(
                  {
                    session_id: req.sessionId,
                    agent_id: req.agentId,
                    event: 'session_append_failed_open',
                  },
                  'appendTurn fail-open: persisted:false (user turn)',
                );
              }
            }
            const r2 = await opts.sessionStore.appendTurn(
              req.sessionId,
              req.agentId,
              {
                role: 'assistant',
                content: canonicalResult.content,
                tool_calls: extractToolCallsFromResponse(canonicalResult),
                model: entry.name,
                tokens_in: canonicalResult.usage.input_tokens,
                tokens_out: canonicalResult.usage.output_tokens,
              },
            );
            if (r2.persisted === false) {
              req.log.warn(
                {
                  session_id: req.sessionId,
                  agent_id: req.agentId,
                  event: 'session_append_failed_open',
                },
                'appendTurn fail-open: persisted:false (assistant turn)',
              );
            }
          } catch (appendErr) {
            req.log.warn(
              {
                err: appendErr,
                session_id: req.sessionId,
                event: 'session_append_unexpected',
              },
              'session append unexpected failure',
            );
          }
        }
        // ─── End non-stream appendTurn ───────────────────────────────────────

        return reply.send(wireBody);
      } catch (err) {
        // Defense in depth — anything thrown synchronously / from the non-stream branch
        // ends up here. setErrorHandler in app.ts will turn it into the OpenAI envelope;
        // re-throw so the centralized handler sees it.
        //
        // BackendSaturatedError: set Retry-After header before re-throw (per 03-PATTERNS.md
        // line 705-707). The centralized error handler in app.ts maps the error to 429 +
        // rate_limit_error envelope; we set the header here so it's present on the reply.
        if (err instanceof BackendSaturatedError) {
          void reply.header('Retry-After', String(Math.ceil(err.waitedMs / 1000)));
        }
        // Plan 08-04 — fire-and-forget breaker failure signal. The classifier
        // (isBreakerTrip) filters out non-trip errors (4xx, ZodError, abort,
        // BreakerOpenError itself), so calling on every catch is safe; only
        // trip-eligible errors actually increment the counter. NOT awaited
        // (same rationale as the success path).
        if (!(err instanceof BreakerOpenError)) {
          void opts.breaker.recordFailure(entry.backend, err);
        }
        req.raw.socket?.off('close', onClose);
        caughtErr = err instanceof Error ? err : new Error(String(err));
        throw err;
      } finally {
        // Always release the semaphore slot. safeRelease is idempotent — if sseCleanup
        // already called it (stream end / abort), this is a no-op. For non-stream and
        // error paths, this is the primary release point.
        safeRelease();

        // CR-02 (05-VERIFICATION.md gaps[1]) + CR-03 (Plan 05-05 Task 5 deviation):
        // The plan instructed to drop the `body.stream !== true` guard entirely
        // and rely on safeRecord idempotency. In practice, fastify-sse-v2's
        // reply.sse(asyncIterable) RETURNS IMMEDIATELY (it pipes the iterable
        // via it-to-stream; the stream completes asynchronously) — so the route
        // handler's outer finally fires BEFORE sseCleanup runs. Without a guard,
        // the outer finally records status_class='success' (caughtErr=undefined,
        // reply.statusCode=200) and sseCleanup's later call is a recorded=true
        // no-op — which silently regresses the stream-success observability AND
        // invalidates the CR-03 status_class override (the override happens
        // inside sseCleanup, but sseCleanup never gets to write the row).
        //
        // Resolution (deviation Rule 1): re-instate the body.stream guard, but
        // keep CR-02's intent intact by adding a `caughtErr` exception clause —
        // when a stream-branch path throws BEFORE reply.sse spawns the iterable
        // (e.g. the outer try threw between adapter call and the inner sseCleanup
        // wiring), the outer finally MUST record because sseCleanup will not
        // fire. The inner pre-stream catch (CR-02 Task 2) covers the most common
        // stream-error path; the caughtErr clause here is the safety net for
        // anything else that throws in the stream branch outer scope.
        if (body.stream !== true || caughtErr) {
          // Status / http_status from reply (set by reply.send for success or by
          // the centralized error handler for re-thrown errors).
          const httpStatus = caughtErr ? mapToHttpStatus(caughtErr) : reply.statusCode;
          const tokensIn = caughtErr ? undefined : canonicalResult?.usage.input_tokens;
          const tokensOut = caughtErr ? undefined : canonicalResult?.usage.output_tokens;
          // Phase 13 (v0.10.0 — COST-01/02): compute cost_cents on the success
          // path; stamp req.computedCostCents BEFORE the function returns so the
          // onSend hook in app.ts (which fires AFTER this finally) can read it
          // and emit the X-Cost-Cents header. For followers, tokens are unknown
          // here (the cached body owns them) — costCents stays undefined for
          // those rows; the leader's row carries the chargeable value.
          const costCents = caughtErr
            ? undefined
            : computeCostCents({ entry, tokensIn, tokensOut }) ?? undefined;
          if (costCents !== undefined) {
            req.computedCostCents = costCents;
          }
          safeRecord({
            protocol: 'openai',
            route: req.url.split('?')[0] ?? req.url,
            backend: entry.backend,
            model: entry.name,
            statusClass: caughtErr
              ? deriveStatusClass(httpStatus, false)
              : deriveStatusClass(reply.statusCode, false),
            httpStatus,
            durationMs: performance.now() - (req._t0 ?? performance.now()),
            tokensIn,
            tokensOut,
            errorCode: caughtErr ? mapErrorToCode(caughtErr) : undefined,
            errorMessage: caughtErr?.message,
            agentId: req.agentId,
            tenantId: req.tenantId,
            projectId: req.projectId,
            workloadClass: req.workloadClass,
            requestId: req.id,
            // Plan 08-07 (D-D5) — follower request_log row carries the leader's
            // upstream_message_id so Plan 08-08's cost-attribution dashboard
            // can collapse the 1 leader + N followers into a single charged
            // generation via GROUP BY upstream_message_id.
            upstreamMessageId: followerUpstreamMessageId,
            // 08-REVIEW CR-01: persist Idempotency-Key for the outer-finally
            // path (non-stream success + thrown errors).
            idempotencyKey,
            costCents,
            timestamp: new Date(),
          });
        }
      }
    },
  );
}

/**
 * Phase 10 (v0.10.0 — JSON-01..04) helper: concatenate all `text`-type content blocks
 * from a CanonicalResponse into a single string. Used by the validation pass to feed
 * `validateJsonOutput`; tool_use blocks are ignored (json_mode + tools is an unusual
 * combination but the contract is "the textual reply must be JSON" — tool_calls are
 * orthogonal data).
 */
function extractAssistantText(response: CanonicalResponse): string {
  return response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
