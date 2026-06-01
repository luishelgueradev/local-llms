/**
 * Phase 18 / v0.11.0 — RETR-02 (hook fires AFTER ContextProvider, BEFORE
 * adapter). Wave 0 scaffold (Plan 18-01). `it.todo` until Plan 18-07.
 *
 * Three-route integration tests mirroring the Phase 17 SESS-05 pattern from
 * `tests/routes/session-attach.integration.test.ts` (PATTERNS lines
 * 797-808). The test fixture builds the app once per `describe` with a
 * shared adapter spy, then exercises all three OpenAI/Anthropic/Responses
 * surfaces:
 *   /v1/chat/completions
 *   /v1/messages
 *   /v1/responses
 *
 * The hook-position invariant is the route-pipeline contract:
 *
 *   1. ContextProvider runs first (history-merged messages land in canonical).
 *   2. Pre-completion hooks run next (each hook sees the prior hook's
 *      injection in `canonical.system`).
 *   3. Capability gates (vision / json_mode) run AFTER hooks.
 *   4. Adapter call dispatched LAST.
 *
 * The fenced `<retrieved_context>` block injects into `canonical.system`
 * — NEVER into `canonical.messages` (CTXP-03 BLOCK carry-over from
 * Phase 17). The route handler is responsible for this discipline.
 *
 * Lock convention (Plan 18-01 lock): each `it.todo` case-name string is the
 * authoritative wording for Plan 18-07's flip.
 */
import { describe, it } from 'vitest';

describe('RETR-02: hook fires AFTER ContextProvider, BEFORE adapter', () => {
  it.todo('chat-completions: hook receives canonical with history-merged messages (post-ContextProvider)');
  it.todo('chat-completions: adapter receives canonical with hook-injected system AFTER hook fires');
  it.todo('messages: hook position identical');
  it.todo('responses: hook position identical');
  it.todo('hook NEVER fires when entry has no pre_completion_hooks reference');
  it.todo('hook NEVER fires when opts.preCompletionHooks Map has no entry for routeKey');
  it.todo('fenced content lands in canonical.system (NOT canonical.messages — CTXP-03 carry-over)');
  it.todo('hook fires BEFORE capability gates (vision / json_mode)');
});
