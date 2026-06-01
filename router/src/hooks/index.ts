/**
 * Phase 18 (v0.11.0 — RETR-02..06): hooks/ barrel.
 *
 * Re-exports the pre-completion hook execution shape + injection utility.
 * Plan 18-06 adds the runHookChain export.
 */

export {
  injectRetrievedContent,
  type InjectResult,
} from './inject.js';

// Plan 18-06 adds:
//   export { runHookChain, type PreCompletionHook, type HookLogEntry, type RunHookChainResult, ... } from './pre-completion.js';
