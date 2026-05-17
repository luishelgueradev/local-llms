// router/src/resilience/idempotency.ts — Phase 8 Plan 07 (ROUTE-12 / D-D5 / D-D6).
//
// Idempotency-Key multiplexer: when N concurrent requests share the same
// Idempotency-Key, only ONE upstream generation runs. The first request
// becomes the "leader" — it executes the adapter call and publishes events
// to a Valkey pub/sub channel. Subsequent requests become "followers" —
// they SUBSCRIBE to the channel, replay any cached chunks, and emit the
// leader's response.
//
// Key strategy (per CONTEXT.md D-D5 + D-D6 + the plan's `<interfaces>`):
//
//   idempotency:${key}:lock     — SETNX EX 1800. Presence = key in use.
//                                  30-min ceiling TTL covers a slow stream;
//                                  finalize() reduces effective data TTL
//                                  to 15 min on `done`/`error`/`aborted`.
//   idempotency:${key}:result   — JSON-serialized terminal payload
//                                  ({ $terminal, body?, upstreamMessageId?, error? }).
//                                  Read by followers arriving after finalize.
//                                  TTL = 900s (15 min, D-D6) on finalize.
//   idempotency:${key}:chunks   — RPUSH list of JSON-serialized canonical
//                                  stream events. Followers LRANGE 0 -1 to
//                                  replay cached chunks before piping
//                                  subscribe events. TTL = 900s on finalize.
//   idempotency:${key}:channel  — Valkey pub/sub channel. Leader PUBLISHes
//                                  each event + the terminal marker.
//                                  Followers SUBSCRIBE before reading
//                                  cached chunks (hybrid strategy — avoids
//                                  the race where the leader finalizes
//                                  between the follower's lock-check and
//                                  subscribe).
//
// Terminal markers are distinguished by a special `$terminal` field on the
// channel payload + result key — canonical stream events never use this
// field, so the discriminant is unambiguous.
//
// pub/sub MUST use a SEPARATE Valkey connection (ioredis: a client in
// subscribe-mode cannot issue other commands). The factory accepts a
// `subscriberFactory: () => ValkeyClient` opt — production wiring uses
// `valkey.duplicate()`; tests use a mock-aware factory.
//
// The 30s follower-wait timeout (IDEMPOTENCY_TIMEOUT_MS) is the safety
// catch when a leader hangs — followers throw IdempotencyTimeoutError so
// the route can 504. The 30-min lock TTL self-cleans the abandoned key.
//
// CONTEXT D-D5 / threat T-08-T-07: single-user single-bearer scope here.
// Multi-tenant would need bearer-prefixed keys; out of scope for v1.
import type { ValkeyClient } from '../clients/valkey.js';
import type { Logger } from 'pino';

/** D-D6 — followers wait at most 30s for the leader's `done` marker. */
export const IDEMPOTENCY_TIMEOUT_MS = 30_000;

/** D-D6 — data TTL after finalize. 15 min keeps replay window short. */
export const IDEMPOTENCY_DATA_TTL_SEC = 900;

/** D-D5 — lock TTL ceiling. 30 min covers worst-case slow streams. */
export const IDEMPOTENCY_LOCK_TTL_SEC = 1800;

export type TerminalStatus = 'done' | 'error' | 'aborted';

/**
 * Plan 08-07: thrown by awaitNonStreamResult / awaitStreamResult when the
 * leader doesn't finalize within IDEMPOTENCY_TIMEOUT_MS. Routes catch this
 * and emit a 504 envelope.
 */
export class IdempotencyTimeoutError extends Error {
  readonly code = 'idempotency_timeout';
  constructor(public readonly idempotencyKey: string) {
    super(`Idempotency-Key "${idempotencyKey}" leader did not finalize within ${IDEMPOTENCY_TIMEOUT_MS}ms`);
    this.name = 'IdempotencyTimeoutError';
  }
}

export interface IdempotencyMultiplexer {
  /**
   * Acquire lock for this key. Returns 'leader' if SETNX succeeded; 'follower'
   * if the key already exists. The lock has a 30-min ceiling TTL (Valkey side);
   * the data TTL is bumped down to 15 min on stream end via finalize().
   */
  acquire(key: string, requestId: string): Promise<{ role: 'leader' | 'follower' }>;

  /**
   * Leader API — non-stream path. Cache the JSON body + publish 'done' marker.
   * The body is serialized as JSON; followers parse and re-emit. Result key
   * TTL = 15 min (D-D6).
   */
  publishNonStream(key: string, body: unknown, upstreamMessageId?: string): Promise<void>;

  /**
   * Leader API — stream path, per-event. Serialize event as JSON, RPUSH to
   * the chunks list, PUBLISH to the channel. Called once per canonical event.
   */
  publishStreamEvent(key: string, event: unknown): Promise<void>;

  /**
   * Leader API — stream path, finalize. PUBLISH terminal marker; set EXPIRE
   * on chunks + result keys to 15 min (D-D6). finalPayload is optional — used
   * for error envelopes that followers re-emit on `status: 'error'`.
   */
  finalizeStream(
    key: string,
    status: TerminalStatus,
    upstreamMessageId?: string,
    finalPayload?: unknown,
  ): Promise<void>;

  /**
   * Follower API — non-stream path. SUBSCRIBE to channel FIRST, then GET
   * result; if 'done' marker present, return the cached body; else block
   * until the channel emits a terminal marker or IDEMPOTENCY_TIMEOUT_MS
   * elapses. Throws IdempotencyTimeoutError on timeout.
   */
  awaitNonStreamResult(key: string, requestId: string): Promise<{
    body: unknown;
    upstreamMessageId?: string;
  }>;

  /**
   * Follower API — stream path. SUBSCRIBE to channel FIRST, LRANGE cached
   * chunks, then yield each as { event } until a terminal marker is
   * observed (in cache or via subscribe). Terminal yield is
   * { terminal: 'done'|'error'|'aborted' }.
   */
  awaitStreamResult(
    key: string,
    requestId: string,
  ): AsyncIterable<{ event?: unknown; terminal?: TerminalStatus }>;
}

export interface MakeIdempotencyMultiplexerOpts {
  valkey: ValkeyClient;
  log: Logger;
  /**
   * Factory for subscriber-mode connections. Production: `() => valkey.duplicate()`.
   * Tests pass a mock-aware factory that returns a fresh ValkeyMock sharing the
   * underlying pub/sub bus.
   */
  subscriberFactory: () => ValkeyClient;
  /**
   * Test override for IDEMPOTENCY_TIMEOUT_MS. Production omits — the 30s default
   * is fixed by D-D6. Tests pass a short value (e.g. 200ms) so the timeout
   * path is exercisable without `vi.useFakeTimers()` (which freezes Fastify
   * timers in integration tests).
   */
  timeoutMs?: number;
}

const keys = {
  lock: (k: string): string => `idempotency:${k}:lock`,
  result: (k: string): string => `idempotency:${k}:result`,
  chunks: (k: string): string => `idempotency:${k}:chunks`,
  channel: (k: string): string => `idempotency:${k}:channel`,
};

interface TerminalPayload {
  $terminal: TerminalStatus;
  body?: unknown;
  upstreamMessageId?: string;
  finalPayload?: unknown;
}

interface StreamEventPayload {
  event: unknown;
  /**
   * 08-REVIEW CR-02 fix: monotonic per-key sequence number assigned by the
   * leader on PUBLISH. Followers use this to deduplicate against the LRANGE
   * replay window — see `awaitStreamResult` for the drop rule.
   *
   * The CACHED chunks list (RPUSH) does NOT need the seq embedded — the
   * LRANGE position implicitly identifies each chunk's seq (the index of
   * `chunks[i]` IS `i`). The seq is only required on the PUBLISH path so
   * the follower can correlate a live channel message back to its LRANGE
   * index. Optional in the channel payload so older publishers (pre-fix)
   * and the terminal-only path stay parseable.
   */
  seq?: number;
}

type ChannelMessage = TerminalPayload | StreamEventPayload;

function isTerminalPayload(p: ChannelMessage): p is TerminalPayload {
  return typeof (p as TerminalPayload).$terminal === 'string';
}

/**
 * Subscribe via the `subscriberFactory` connection. The returned object lets
 * the caller pull next messages via an internal queue + signal completion via
 * .unsubscribe. Both LRANGE-replay paths (non-stream, stream) reuse this.
 */
interface SubscriptionHandle {
  /** Awaitable promise that resolves to the next message; rejects on timeout/close. */
  next(timeoutMs: number): Promise<ChannelMessage>;
  /** Drain any queued messages without waiting (returns immediately). */
  drainQueued(): ChannelMessage[];
  /** Close the subscription + underlying connection. */
  close(): Promise<void>;
}

async function subscribeToChannel(
  channel: string,
  subscriberFactory: () => ValkeyClient,
  log: Logger,
): Promise<SubscriptionHandle> {
  const sub = subscriberFactory();
  const queue: ChannelMessage[] = [];
  // Resolver list for awaiters that arrived before any message landed.
  const waiters: ((m: ChannelMessage) => void)[] = [];

  const onMessage = (_channel: string, message: string): void => {
    let parsed: ChannelMessage;
    try {
      parsed = JSON.parse(message) as ChannelMessage;
    } catch (err) {
      log.warn({ err, message }, 'idempotency: unparseable channel message');
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  };

  // ioredis emits 'message' (channel, message) for pub/sub. The mock honors
  // the same surface via `attachMessageHandler` / on('message', ...).
  (sub as unknown as { on(event: string, cb: (...a: unknown[]) => void): unknown }).on(
    'message',
    onMessage as unknown as (...a: unknown[]) => void,
  );
  // 08-REVIEW CR-04 fix: if `subscribe(channel)` throws (transient Valkey
  // hiccup, AUTH failure after handshake, connection drop during the
  // SUBSCRIBE round-trip), the freshly-allocated subscriber connection
  // must be released. Without this guard the caller's try/finally never
  // runs because subscribeToChannel rejected before returning the handle,
  // and each transient failure leaks one TCP connection to Valkey.
  try {
    await (sub as unknown as { subscribe(c: string): Promise<unknown> }).subscribe(channel);
  } catch (err) {
    // Best-effort teardown — disconnect() is synchronous + non-throwing on
    // ioredis; quit() may block on a half-open socket so we don't await it.
    try {
      (sub as unknown as { disconnect?: () => void }).disconnect?.();
    } catch (closeErr) {
      log.warn(
        { closeErr, channel },
        'idempotency: subscribeToChannel teardown after subscribe failure errored',
      );
    }
    throw err;
  }

  return {
    next(timeoutMs: number): Promise<ChannelMessage> {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift()!);
      }
      return new Promise<ChannelMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(wrapped);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new IdempotencyTimeoutError(channel.split(':')[1] ?? channel));
        }, timeoutMs);
        const wrapped = (m: ChannelMessage): void => {
          clearTimeout(timer);
          resolve(m);
        };
        waiters.push(wrapped);
      });
    },
    drainQueued(): ChannelMessage[] {
      const out = queue.splice(0, queue.length);
      return out;
    },
    async close(): Promise<void> {
      try {
        await (sub as unknown as { unsubscribe(c?: string): Promise<unknown> })
          .unsubscribe(channel)
          .catch(() => {});
        await (sub as unknown as { quit(): Promise<unknown> }).quit().catch(() => {});
      } catch (err) {
        log.warn({ err }, 'idempotency: subscriber close error');
      }
    },
  };
}

export function makeIdempotencyMultiplexer(
  opts: MakeIdempotencyMultiplexerOpts,
): IdempotencyMultiplexer {
  const { valkey, log, subscriberFactory } = opts;
  const timeoutMs = opts.timeoutMs ?? IDEMPOTENCY_TIMEOUT_MS;

  async function acquire(
    key: string,
    requestId: string,
  ): Promise<{ role: 'leader' | 'follower' }> {
    // SETNX + EX in one round-trip via SET NX EX. ioredis surface accepts
    // both `valkey.set(key, val, 'EX', ttl, 'NX')` and `valkey.setnx`. We
    // use SET ... NX EX for atomicity (SETNX + EXPIRE is two RTTs and
    // technically race-able).
    const acquired = await (valkey as unknown as {
      set(k: string, v: string, ...args: (string | number)[]): Promise<string | null>;
    }).set(keys.lock(key), requestId, 'EX', IDEMPOTENCY_LOCK_TTL_SEC, 'NX');
    if (acquired === 'OK') {
      log.debug({ key, requestId }, 'idempotency: leader role acquired');
      return { role: 'leader' };
    }
    log.debug({ key, requestId }, 'idempotency: follower role');
    return { role: 'follower' };
  }

  async function publishNonStream(
    key: string,
    body: unknown,
    upstreamMessageId?: string,
  ): Promise<void> {
    const payload: TerminalPayload = {
      $terminal: 'done',
      body,
      upstreamMessageId,
    };
    const serialized = JSON.stringify(payload);
    // Cache result with 15-min TTL (D-D6).
    await (valkey as unknown as {
      set(k: string, v: string, ...args: (string | number)[]): Promise<string | null>;
    }).set(keys.result(key), serialized, 'EX', IDEMPOTENCY_DATA_TTL_SEC);
    // Publish the terminal marker so subscribed followers wake up.
    await valkey.publish(keys.channel(key), serialized);
  }

  async function publishStreamEvent(key: string, event: unknown): Promise<void> {
    // 08-REVIEW CR-02 fix: publish-with-seq to avoid the duplicate-event race.
    //
    // Race scenario this guards against (pre-fix):
    //   1. Leader publishes event E (RPUSH chunks, then PUBLISH channel).
    //   2. Follower subscribed BEFORE the leader published E but had NOT yet
    //      run its LRANGE replay.
    //   3. The follower's pub/sub handler receives E (queued live).
    //   4. The follower runs LRANGE and pulls E from the cached list.
    //   → Result: E is emitted TWICE on the wire (duplicate content delta).
    //
    // Fix: include a monotonic seq number on the PUBLISH payload. The seq is
    // the chunks-list index assigned by RPUSH (rpush returns the new list
    // length, so the appended item's index is `newLen - 1`). The cached
    // payload (in the list) is serialized WITHOUT seq — the list index itself
    // identifies seq during LRANGE replay. The publish payload carries seq so
    // the follower can dedupe against the maxReplayedSeq watermark observed
    // during replay (see awaitStreamResult below).
    //
    // The RPUSH-then-build-publish ordering keeps the seq authoritative: a
    // crash between RPUSH and PUBLISH means the chunks list has the event but
    // the channel didn't see it — followers find it during LRANGE replay or
    // the subsequent reconnect. A crash AFTER both means the leader is gone
    // and the follower will time out on the terminal marker (same behavior
    // as today).
    //
    // Both calls remain fail-soft (log + continue) so a Valkey blip doesn't
    // break the upstream stream from the leader's POV.
    const cachedPayload: StreamEventPayload = { event };
    const cachedSerialized = JSON.stringify(cachedPayload);
    let seq: number | undefined;
    try {
      const newLen = await valkey.rpush(keys.chunks(key), cachedSerialized);
      seq = newLen - 1;
    } catch (err) {
      log.warn({ err, key }, 'idempotency: rpush chunks failed');
    }
    try {
      const publishPayload: StreamEventPayload =
        seq !== undefined ? { event, seq } : { event };
      await valkey.publish(keys.channel(key), JSON.stringify(publishPayload));
    } catch (err) {
      log.warn({ err, key }, 'idempotency: publish event failed');
    }
  }

  async function finalizeStream(
    key: string,
    status: TerminalStatus,
    upstreamMessageId?: string,
    finalPayload?: unknown,
  ): Promise<void> {
    const payload: TerminalPayload = {
      $terminal: status,
      upstreamMessageId,
      finalPayload,
    };
    const serialized = JSON.stringify(payload);
    // Set result key + EXPIRE chunks list + result to 15 min (D-D6).
    await (valkey as unknown as {
      set(k: string, v: string, ...args: (string | number)[]): Promise<string | null>;
    }).set(keys.result(key), serialized, 'EX', IDEMPOTENCY_DATA_TTL_SEC);
    await valkey.expire(keys.chunks(key), IDEMPOTENCY_DATA_TTL_SEC).catch((err: unknown) => {
      log.warn({ err, key }, 'idempotency: expire chunks failed');
      return 0;
    });
    await valkey.publish(keys.channel(key), serialized);
  }

  async function awaitNonStreamResult(
    key: string,
    requestId: string,
  ): Promise<{ body: unknown; upstreamMessageId?: string }> {
    const sub = await subscribeToChannel(keys.channel(key), subscriberFactory, log);
    try {
      // Hybrid: AFTER subscribing, check if the result is already cached
      // (leader finalized before we subscribed).
      const cached = await valkey.get(keys.result(key));
      if (cached) {
        const parsed = JSON.parse(cached) as TerminalPayload;
        if (parsed.$terminal === 'done') {
          return {
            body: parsed.body,
            upstreamMessageId: parsed.upstreamMessageId,
          };
        }
        // 'error' / 'aborted' — surface as error envelope. Routes catch this
        // and decide how to map (mirror the leader's outcome for parity).
        const err = new Error(
          `idempotency leader finalized with status=${parsed.$terminal}`,
        );
        (err as Error & { code?: string; status?: TerminalStatus }).code =
          'idempotency_leader_error';
        (err as Error & { status?: TerminalStatus }).status = parsed.$terminal;
        throw err;
      }
      // No cached result yet — wait on the channel for a terminal marker.
      // Stream events may arrive first; ignore them and keep waiting.
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const msg = await sub.next(remaining);
        if (isTerminalPayload(msg)) {
          if (msg.$terminal === 'done') {
            return {
              body: msg.body,
              upstreamMessageId: msg.upstreamMessageId,
            };
          }
          const err = new Error(
            `idempotency leader finalized with status=${msg.$terminal}`,
          );
          (err as Error & { code?: string; status?: TerminalStatus }).code =
            'idempotency_leader_error';
          (err as Error & { status?: TerminalStatus }).status = msg.$terminal;
          throw err;
        }
        // Stream event during a non-stream follower wait — defensive; just
        // keep looping until the terminal marker arrives.
      }
      throw new IdempotencyTimeoutError(key);
    } finally {
      await sub.close();
      log.debug({ key, requestId }, 'idempotency: non-stream follower closed');
    }
  }

  function awaitStreamResult(
    key: string,
    requestId: string,
  ): AsyncIterable<{ event?: unknown; terminal?: TerminalStatus }> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<{
        event?: unknown;
        terminal?: TerminalStatus;
      }> {
        let sub: SubscriptionHandle | null = null;
        let cachedReplayed = false;
        const replayQueue: { event?: unknown; terminal?: TerminalStatus }[] = [];
        let done = false;
        // 08-REVIEW CR-02 fix: watermark for dedup against the subscribe queue.
        //
        // After LRANGE replay completes, `maxReplayedSeq` is set to
        // `cached.length - 1` (or -1 if no cached chunks). The leader assigns
        // each PUBLISH's seq as the chunks-list index at the time of RPUSH.
        // Any channel message we receive whose seq <= maxReplayedSeq was
        // ALREADY emitted from the LRANGE replay → drop it.
        //
        // Terminal markers carry no seq (they live in the result key, not
        // the chunks list) — they always pass through. Non-terminal messages
        // without a seq (defensive: pre-fix publishers or future codepaths
        // that don't populate it) also pass through, preserving the legacy
        // shape at the cost of a possible duplicate in the legacy case.
        let maxReplayedSeq = -1;

        function isDuplicateLiveEvent(m: ChannelMessage): boolean {
          if (isTerminalPayload(m)) return false;
          const seq = (m as StreamEventPayload).seq;
          // No seq → can't decide; let it through (legacy / defensive).
          if (typeof seq !== 'number') return false;
          return seq <= maxReplayedSeq;
        }

        async function ensureSetup(): Promise<void> {
          if (sub !== null) return;
          sub = await subscribeToChannel(keys.channel(key), subscriberFactory, log);
        }

        async function replayCached(): Promise<void> {
          if (cachedReplayed) return;
          cachedReplayed = true;
          // LRANGE cached chunks. Each entry is a stream-event payload (no
          // $terminal); the terminal lives in the result key (which we GET
          // separately to detect "leader already finalized before we joined").
          const cached = await valkey.lrange(keys.chunks(key), 0, -1);
          for (const raw of cached) {
            try {
              const parsed = JSON.parse(raw) as StreamEventPayload;
              replayQueue.push({ event: parsed.event });
            } catch (err) {
              log.warn({ err, raw, key }, 'idempotency: unparseable cached chunk');
            }
          }
          // 08-REVIEW CR-02: chunks-list indexes are 0..cached.length-1.
          // The leader's PUBLISH for cached[i] used seq=i (the rpush new-len
          // minus 1). Setting the watermark to cached.length-1 dedupes ALL
          // pub/sub messages that correspond to chunks we already replayed.
          maxReplayedSeq = cached.length - 1;
          // Check for already-finalized terminal in the result key.
          const result = await valkey.get(keys.result(key));
          if (result) {
            try {
              const parsed = JSON.parse(result) as TerminalPayload;
              replayQueue.push({ terminal: parsed.$terminal });
              done = true;
            } catch (err) {
              log.warn({ err, result, key }, 'idempotency: unparseable result key');
            }
          }
        }

        return {
          async next(): Promise<IteratorResult<{
            event?: unknown;
            terminal?: TerminalStatus;
          }>> {
            await ensureSetup();
            // Replay cached chunks first (LRANGE) — must happen AFTER subscribe.
            await replayCached();

            if (replayQueue.length > 0) {
              const item = replayQueue.shift()!;
              if (item.terminal) {
                done = true;
              }
              return { value: item, done: false };
            }

            if (done) {
              return { value: undefined, done: true };
            }

            // Drain any messages that landed during replayCached(). Apply
            // the CR-02 dedup filter to skip events already in the replay.
            const drained = sub!.drainQueued();
            for (const m of drained) {
              if (isTerminalPayload(m)) {
                replayQueue.push({ terminal: m.$terminal });
                done = true;
              } else if (!isDuplicateLiveEvent(m)) {
                replayQueue.push({ event: (m as StreamEventPayload).event });
              }
            }
            if (replayQueue.length > 0) {
              const item = replayQueue.shift()!;
              return { value: item, done: false };
            }

            // Block on the next channel message. Loop until we get a
            // non-duplicate event or a terminal marker — the dedup filter
            // can drop one or more raced events from the channel.
            while (true) {
              const msg = await sub!.next(timeoutMs);
              if (isTerminalPayload(msg)) {
                done = true;
                return { value: { terminal: msg.$terminal }, done: false };
              }
              if (isDuplicateLiveEvent(msg)) {
                continue;
              }
              return {
                value: { event: (msg as StreamEventPayload).event },
                done: false,
              };
            }
          },
          async return(): Promise<IteratorResult<{
            event?: unknown;
            terminal?: TerminalStatus;
          }>> {
            if (sub) {
              await sub.close();
              sub = null;
            }
            log.debug({ key, requestId }, 'idempotency: stream follower closed');
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  return {
    acquire,
    publishNonStream,
    publishStreamEvent,
    finalizeStream,
    awaitNonStreamResult,
    awaitStreamResult,
  };
}
