import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from '@bram-dc/fastify-type-provider-zod';
import { z } from 'zod/v4';
import type { ChatCompletionChunk, ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import type { RegistryStore } from '../../config/registry.js';
import type { AdapterFactory, BackendAdapter } from '../../backends/adapter.js';
import { startHeartbeat } from '../../sse/heartbeat.js';
import { chunkToSseEvents } from '../../sse/stream.js';
import { NO_ENVELOPE, mapToHttpStatus, toOpenAIErrorEnvelope } from '../../errors/envelope.js';

/**
 * OpenAI chat-completions request body. Required fields are zod-validated;
 * everything else (temperature, max_tokens, top_p, tools, tool_choice, response_format,
 * seed, presence_penalty, frequency_penalty, logit_bias, user, etc.) PASSES THROUGH
 * to the upstream SDK call without router-side reshaping.
 *
 * Phase 4 will add stricter validation for tool definitions; Phase 2 keeps it minimal.
 */
const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.unknown())]), // string OR array of content blocks (vision in Phase 4)
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
}).passthrough();

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
}).passthrough();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export interface RegisterChatCompletionsOpts {
  registry: RegistryStore;
  makeAdapter: AdapterFactory;
}

/**
 * Register POST /v1/chat/completions on the typed Fastify instance.
 *
 * Plan 02-04: non-stream branch from plan 02-03 is unchanged; stream branch
 * replaces the 501 stub with the full RESEARCH §Pattern 3 wiring.
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

      // Resolve model -> entry -> adapter. resolve(unknown) throws RegistryUnknownModelError
      // which the centralized error handler maps to 404 + OpenAI envelope (D-C3 row).
      const entry = opts.registry.resolve(body.model);
      const adapter: BackendAdapter = opts.makeAdapter(entry);

      // Map registry name -> backend model id (Phase 2: identical; the seam exists for Phase 3+)
      // Cast to ChatCompletionCreateParams so the adapter methods accept it — the zod
      // passthrough schema produces a superset that is type-compatible at runtime.
      const upstreamParams = { ...body, model: entry.backend_model } as unknown as ChatCompletionCreateParams;

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
      req.raw.socket?.once('close', onClose);

      try {
        if (body.stream === true) {
          // ── STREAM BRANCH (RESEARCH §Pattern 3 — load-bearing for SC1 + SC3) ──
          let upstream: AsyncIterable<ChatCompletionChunk>;
          try {
            // Some SDKs throw synchronously on bad params; some return a thenable that
            // rejects. Wrap in try/catch so a PRE-STREAM error becomes a JSON envelope
            // rather than starting an SSE response we can't recover from.
            upstream = await adapter.chatCompletionsStream(upstreamParams, controller.signal);
          } catch (err) {
            // HTTP not yet 200; emit envelope.
            req.raw.socket?.off('close', onClose);
            const env = toOpenAIErrorEnvelope(err);
            const status = mapToHttpStatus(err);
            if (env === NO_ENVELOPE) return;  // client gone — defensive
            return reply.code(status).send(env);
          }

          // Start the heartbeat AFTER the upstream resolves but BEFORE consuming.
          // Pattern 3 line 488 starts it after the first byte; in our shape, reply.sse(...)
          // flushes headers on the first iteration, so starting before the first yield
          // is equivalent. Stops in the iterator's onCleanup AND via onClose's stopHeartbeat
          // hook (single listener, belt-and-suspenders cleanup paths).
          const heartbeat = startHeartbeat(reply.raw);
          stopHeartbeat = () => heartbeat.stop();  // wires onClose to also stop heartbeat

          const sseCleanup = (): void => {
            heartbeat.stop();
            req.raw.socket?.off('close', onClose);
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
          try {
            await reply.sse(chunkToSseEvents(upstream, {
              signal: controller.signal,
              onCleanup: sseCleanup,
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

        // ── NON-STREAM BRANCH (unchanged from plan 02-03) ────────────────────
        const result = await adapter.chatCompletions(upstreamParams, controller.signal);
        req.raw.socket?.off('close', onClose);
        return reply.send(result);
      } catch (err) {
        // Defense in depth — anything thrown synchronously / from the non-stream branch
        // ends up here. setErrorHandler in app.ts will turn it into the OpenAI envelope;
        // re-throw so the centralized handler sees it.
        req.raw.socket?.off('close', onClose);
        throw err;
      }
    },
  );
}
