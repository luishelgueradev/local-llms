// router/src/providers/session-errors.ts — SessionStore error classes
// (Phase 17 / v0.11.0 — SESS-01..04 + Pitfall 17-B route-policy).
//
// Shape mirrors errors/envelope.ts:278-296 (InvalidAgentIdError) byte-for-byte:
// `readonly code = '...'`, `readonly httpStatus = N as const`, `super(...)`,
// `this.name = 'ErrorName'`. The error-envelope handler does `instanceof` checks
// against these classes — keep the inheritance chain direct (`extends Error`),
// never wrap in a parent class.
//
// ROUTE POLICY (cross-referenced to 17-RESEARCH.md lines 357-361 and Pitfall
// 17-B in the same doc):
//   - SessionNotFoundError / SessionExpiredError from loadHistory → caught
//     locally by the route handler; route continues stateless (treated as
//     "no history"). NEVER bubbles to a 4xx envelope. Log at info.
//   - SessionAgentMismatchError from loadHistory → ALSO caught locally.
//     Returning 403 would itself leak existence of the session_id. Log at warn.
//   - SessionAgentMismatchError from appendTurn → BUBBLES. The privileged-write
//     boundary: the caller has already presumed ownership (the X-Session-ID
//     header was sent with their X-Agent-Id), so refusing them with 403 is
//     correct and does not leak.
//   - InvalidSessionIdError from the sessionIdPreHandler → BUBBLES. Bad header
//     value is a caller bug; same pattern as InvalidScopedIdError / InvalidAgentIdError.

/**
 * Thrown when a session lookup misses entirely (no row in `sessions` for the
 * given session_id).
 *
 * ROUTE POLICY: caught locally by the route handler from `loadHistory`;
 * treated as "no history" — the route proceeds stateless. NEVER raised to a
 * 4xx envelope. Logged at info level. The 404 in `mapToHttpStatus` is
 * defense-in-depth for any future caller that fails to catch.
 */
export class SessionNotFoundError extends Error {
  readonly code = 'session_not_found';
  readonly httpStatus = 404 as const;
  constructor(public readonly session_id: string) {
    super(`session ${session_id} not found or expired`);
    this.name = 'SessionNotFoundError';
  }
}

/**
 * Thrown when a session row exists but `expires_at < now()` (P4-01 BLOCK).
 *
 * ROUTE POLICY: caught locally by the route handler from `loadHistory`; same
 * "no history" behavior as SessionNotFoundError. NEVER raised to a 4xx
 * envelope. Logged at info level.
 */
export class SessionExpiredError extends Error {
  readonly code = 'session_expired';
  readonly httpStatus = 410 as const;
  constructor(
    public readonly session_id: string,
    public readonly expired_at: Date,
  ) {
    super(`session ${session_id} expired at ${expired_at.toISOString()}`);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Thrown when a session row exists but its `agent_id` does not match the
 * caller's agent_id (SESS-03 / P4-03 BLOCK / Pitfall 17-B).
 *
 * ROUTE POLICY (asymmetric):
 *   - From `loadHistory`: caught locally — returning 403 would itself confirm
 *     that the session_id exists, leaking information to a probing client.
 *     The route returns [] and proceeds stateless. Logged at warn level for
 *     operator visibility.
 *   - From `appendTurn`: bubbles. The privileged-write boundary — the caller
 *     has already presumed ownership by submitting a body with the session_id
 *     under their agent_id. Refusing them with 403 is correct and does not
 *     leak (they already knew the session_id; the only new information is
 *     "...and it isn't yours").
 */
export class SessionAgentMismatchError extends Error {
  readonly code = 'session_agent_mismatch';
  readonly httpStatus = 403 as const;
  constructor(public readonly session_id: string) {
    super(`session ${session_id} belongs to a different agent`);
    this.name = 'SessionAgentMismatchError';
  }
}

/**
 * Thrown by `sessionIdPreHandler` (Plan 17-05) when the X-Session-ID header
 * is present but violates `/^[A-Za-z0-9._:-]{1,128}$/`.
 *
 * ROUTE POLICY: BUBBLES — a malformed header is a caller bug and deserves
 * a 4xx envelope. Same pattern as InvalidScopedIdError + InvalidAgentIdError
 * from Phase 14. Mapped through `errors/envelope.ts` (mapToHttpStatus → 400,
 * toOpenAIErrorEnvelope + toAnthropicErrorEnvelope add `invalid_request_error`
 * + `code:'invalid_session_id'`).
 *
 * `raw` is the supplied value, truncated for log-injection defense in the
 * envelope mapper (mirror InvalidAgentIdError pattern).
 */
export class InvalidSessionIdError extends Error {
  readonly code = 'invalid_session_id';
  readonly httpStatus = 400 as const;
  constructor(public readonly raw: string) {
    super(`X-Session-ID must match /^[A-Za-z0-9._:-]{1,128}$/`);
    this.name = 'InvalidSessionIdError';
  }
}
