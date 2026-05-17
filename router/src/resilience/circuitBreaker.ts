// router/src/resilience/circuitBreaker.ts — Phase 8 Plan 04 (CLOUD-03 +
// D-B1..D-B4).
//
// Per-backend circuit breaker with three states: closed -> open -> half-open
// -> closed. State is persisted in Valkey so it survives router restarts and
// (future-work) coordinates across multiple router instances.
//
// State storage (Valkey keys, all namespaced by backend per D-B4):
//   breaker:${backend}:fail_count   INCR with EXPIRE = CIRCUIT_WINDOW_MS;
//                                   reset on success/state transition.
//   breaker:${backend}:state        'open' | 'half-open' (closed = key absent);
//                                   SET PX = CIRCUIT_COOLDOWN_MS * 2 so the
//                                   key survives THROUGH the probe transition
//                                   at probe_at = open_time + cooldown, then
//                                   self-cleans after another cooldown if no
//                                   probe ever ran. TTL > cooldown is required
//                                   to avoid a race where state expires at the
//                                   exact moment probe_at says "time to probe";
//                                   if state were gone, check() would see
//                                   'closed' and skip the probe entirely.
//   breaker:${backend}:probe_at     epoch_ms when the next probe is allowed;
//                                   set on opening; TTL aligned with state.
//   breaker:${backend}:probe_lock   SETNX during half-open probe; ensures only
//                                   ONE probe runs concurrently; TTL = cooldown
//                                   so a wedged probe doesn't permanently
//                                   block re-arming.
//
// All keys are namespaced by backend so a cloud failure storm does not affect
// the local Ollama keys (D-B4 — per-backend scope is the asymmetry the
// project explicitly wants).
//
// Concurrency semantics for half-open (D-B3):
//   - check() observes state + probe_at. If state=open AND now >= probe_at,
//     attempts to acquire the probe_lock via SET NX PX.
//   - On lock acquired: transitions state to 'half-open', returns 'half-open'.
//     The caller is the probe — its outcome (success/failure) determines next
//     state.
//   - On lock NOT acquired (another probe in flight): returns 'open' from
//     THIS caller's POV. Only one probe ever runs concurrently.
//   - On probe success (recordSuccess called by the route's finally/onCleanup):
//     deletes all 4 keys.
//   - On probe failure (recordFailure called by the route's catch): re-opens
//     the breaker with a fresh cooldown window (state='open', probe_at advanced).
//
// Failure classification (D-B1) — see isBreakerTrip below.
//
// Why fixed-window TTL instead of Lua sliding-window:
//   The 5/30s threshold/window pair is small enough that the boundary case
//   (4 failures at t=29s, no failures from t=30s onward) is an acceptable
//   approximation of "5 failures in any 30s window". A Lua sliding-window
//   would be more precise but the latency tax (extra RTT for an EVAL) is not
//   justified for the v1 scope. Future plans can swap the counter for a Lua
//   ZADD/ZRANGEBYSCORE approach.

import type { ValkeyClient } from '../clients/valkey.js';
import type { Env } from '../config/env.js';
import type { Logger } from 'pino';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from 'openai';
import { z } from 'zod/v4';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreaker {
  /**
   * Read the breaker's current state for `backend`. If the breaker is open
   * AND the cooldown has elapsed, this call MAY transition the state to
   * half-open and acquire the probe_lock — the returned state==='half-open'
   * means "you are the probe; your outcome decides next state".
   */
  check(backend: string): Promise<{ state: BreakerState }>;

  /**
   * Record a failed adapter call. Only `isBreakerTrip(err)` errors count;
   * 4xx / abort / zod / generic errors are no-ops. Crossing the threshold
   * opens the breaker; a failure during half-open re-opens with a fresh
   * cooldown.
   */
  recordFailure(backend: string, err: unknown): Promise<void>;

  /**
   * Record a successful adapter call. On half-open: closes the breaker and
   * clears all state. On closed: no-op (we don't reset the counter on every
   * success — TTL handles window expiry).
   */
  recordSuccess(backend: string): Promise<void>;

  /**
   * Test-only: clear all state for `backend`. Not exposed at runtime to
   * routes — the natural reset path is recordSuccess on a probe.
   */
  reset(backend: string): Promise<void>;
}

export interface MakeCircuitBreakerOpts {
  valkey: ValkeyClient;
  log: Logger;
  env: Pick<
    Env,
    'CIRCUIT_FAILURE_THRESHOLD' | 'CIRCUIT_WINDOW_MS' | 'CIRCUIT_COOLDOWN_MS'
  >;
  /** Test injection — defaults to Date.now. */
  now?: () => number;
}

const keys = {
  failCount: (b: string): string => `breaker:${b}:fail_count`,
  state: (b: string): string => `breaker:${b}:state`,
  probeAt: (b: string): string => `breaker:${b}:probe_at`,
  probeLock: (b: string): string => `breaker:${b}:probe_lock`,
};

/**
 * Classify a thrown error as a breaker trip (true) or not (false).
 * Exported for unit testing the rules in isolation from the state machine.
 *
 * Trip rules (D-B1):
 *   - APIConnectionError + APIConnectionTimeoutError (openai SDK; covers
 *     ECONNREFUSED / ECONNRESET / ENOTFOUND / fetch network errors / SDK
 *     timeout) — TRUE
 *   - HTTP status >= 500 (server-side) — TRUE
 *   - Node fetch errors with code = ENOTFOUND / ECONNREFUSED / ECONNRESET
 *     (defensive — for non-SDK call sites) — TRUE
 *
 * Non-trip rules:
 *   - HTTP 4xx (client error) — FALSE
 *   - APIUserAbortError (client gone) — FALSE
 *   - ZodError (validation) — FALSE
 *   - Generic Error (unknown — defensive default; operator widens classifier
 *     in a follow-up if needed) — FALSE
 *
 * IMPORTANT: APIConnectionTimeoutError extends APIConnectionError, so check
 * the subclass FIRST (instanceof returns true for both). The order matters
 * for the read-classification semantics but not for the trip outcome here
 * since both trip — kept the explicit order anyway for the parity with
 * envelope.ts's mapToHttpStatus.
 */
export function isBreakerTrip(err: unknown): boolean {
  if (err instanceof APIUserAbortError) return false;
  if (err instanceof z.ZodError) return false;
  if (err instanceof APIConnectionTimeoutError) return true;
  if (err instanceof APIConnectionError) return true;
  if (typeof err === 'object' && err !== null) {
    const e = err as { status?: number; statusCode?: number; code?: string };
    if (typeof e.status === 'number') {
      return e.status >= 500;
    }
    if (typeof e.statusCode === 'number') {
      return e.statusCode >= 500;
    }
    if (
      e.code === 'ENOTFOUND' ||
      e.code === 'ECONNREFUSED' ||
      e.code === 'ECONNRESET'
    ) {
      return true;
    }
  }
  return false;
}

export function makeCircuitBreaker(opts: MakeCircuitBreakerOpts): CircuitBreaker {
  const { valkey, log, env } = opts;
  const now = opts.now ?? ((): number => Date.now());

  return {
    async check(backend: string): Promise<{ state: BreakerState }> {
      const [stateRaw, probeAtRaw] = await Promise.all([
        valkey.get(keys.state(backend)),
        valkey.get(keys.probeAt(backend)),
      ]);
      if (!stateRaw) return { state: 'closed' };

      const probeAt = probeAtRaw ? Number(probeAtRaw) : 0;
      const t = now();

      if (stateRaw === 'open') {
        if (t >= probeAt) {
          // Cooldown elapsed — attempt to acquire the probe lock. SET NX
          // returns 'OK' if acquired, null if already held by another caller.
          const acquired = await valkey.set(
            keys.probeLock(backend),
            String(t),
            'PX',
            env.CIRCUIT_COOLDOWN_MS,
            'NX',
          );
          if (acquired === 'OK') {
            await valkey.set(
              keys.state(backend),
              'half-open',
              'PX',
              env.CIRCUIT_COOLDOWN_MS * 2,
            );
            log.info(
              { backend },
              'circuit breaker transitioning to half-open (probe acquired)',
            );
            return { state: 'half-open' };
          }
          // Lock held by another concurrent caller -> still open for us.
          return { state: 'open' };
        }
        return { state: 'open' };
      }

      if (stateRaw === 'half-open') {
        // Another probe is in flight (probe_lock should exist). Treat as
        // open from this caller's POV — only the one probe-holder sees
        // 'half-open' and passes through.
        return { state: 'open' };
      }

      // Unknown state value (shouldn't happen unless an operator hand-set the
      // key to garbage). Fail safe -> closed.
      log.warn(
        { backend, stateRaw },
        'circuit breaker: unknown state value, treating as closed',
      );
      return { state: 'closed' };
    },

    async recordFailure(backend: string, err: unknown): Promise<void> {
      if (!isBreakerTrip(err)) return;

      const stateRaw = await valkey.get(keys.state(backend));
      if (stateRaw === 'half-open') {
        // Probe failed — re-open for another full cooldown window. The
        // probe_lock is released so the next post-cooldown check can re-arm.
        const t = now();
        await Promise.all([
          valkey.set(
            keys.state(backend),
            'open',
            'PX',
            env.CIRCUIT_COOLDOWN_MS * 2,
          ),
          valkey.set(
            keys.probeAt(backend),
            String(t + env.CIRCUIT_COOLDOWN_MS),
            'PX',
            env.CIRCUIT_COOLDOWN_MS * 2,
          ),
          valkey.del(keys.probeLock(backend)),
        ]);
        log.warn({ backend }, 'circuit breaker: probe failed, re-opening');
        return;
      }

      // closed (or stale) — increment fail counter. INCR returns the new
      // value; on the first increment we also set the WINDOW_MS TTL so the
      // counter expires naturally.
      const count = await valkey.incr(keys.failCount(backend));
      if (count === 1) {
        await valkey.pexpire(
          keys.failCount(backend),
          env.CIRCUIT_WINDOW_MS,
        );
      }
      if (count >= env.CIRCUIT_FAILURE_THRESHOLD) {
        const t = now();
        await Promise.all([
          valkey.set(
            keys.state(backend),
            'open',
            'PX',
            env.CIRCUIT_COOLDOWN_MS * 2,
          ),
          valkey.set(
            keys.probeAt(backend),
            String(t + env.CIRCUIT_COOLDOWN_MS),
            'PX',
            env.CIRCUIT_COOLDOWN_MS * 2,
          ),
        ]);
        log.warn(
          {
            backend,
            threshold: env.CIRCUIT_FAILURE_THRESHOLD,
            windowMs: env.CIRCUIT_WINDOW_MS,
          },
          'circuit breaker: opening',
        );
      }
    },

    async recordSuccess(backend: string): Promise<void> {
      const stateRaw = await valkey.get(keys.state(backend));
      if (stateRaw === 'half-open') {
        // Probe succeeded — close the breaker and clear all 4 keys so the
        // next failure starts a fresh count.
        await Promise.all([
          valkey.del(keys.state(backend)),
          valkey.del(keys.failCount(backend)),
          valkey.del(keys.probeAt(backend)),
          valkey.del(keys.probeLock(backend)),
        ]);
        log.info({ backend }, 'circuit breaker: probe succeeded, closing');
        return;
      }
      // closed -> no-op. We deliberately don't reset the counter on every
      // success; it expires naturally via TTL. This is the fixed-window
      // approximation — sufficient at the 5/30s threshold/window scale we
      // care about.
    },

    async reset(backend: string): Promise<void> {
      await Promise.all([
        valkey.del(keys.state(backend)),
        valkey.del(keys.failCount(backend)),
        valkey.del(keys.probeAt(backend)),
        valkey.del(keys.probeLock(backend)),
      ]);
    },
  };
}
