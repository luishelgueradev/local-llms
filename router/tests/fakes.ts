/**
 * Shared test fakes for Phase 5+ BuildAppOpts dependencies.
 *
 * Plan 05-01 added a REQUIRED `bufferedWriter` field on BuildAppOpts (D-A4).
 * Every existing buildApp() caller in tests needs the field — this module
 * provides the canonical fake so the fixup is one import + one call per
 * test file rather than 30 ad-hoc inline shapes.
 *
 * The fake is intentionally minimal: push is a no-op, drain resolves
 * immediately, size always reports 0. Tests that care about writer behavior
 * (e.g., bufferedWriter.test.ts) build their own mock with vi.fn() spies.
 */
import type { BufferedWriter } from '../src/db/bufferedWriter.js';
import { makeMetricsRegistry, type MetricsRegistry } from '../src/metrics/registry.js';

export function makeFakeBufferedWriter(): BufferedWriter {
  return {
    push: () => {},
    drain: async () => {},
    get size() {
      return 0;
    },
  };
}

/**
 * Plan 05-02 — shared metrics registry factory for integration tests.
 *
 * Calls the real `makeMetricsRegistry()` (lightweight: fresh Registry +
 * 5 metrics + Node defaults). Each call returns a NEW registry — Pitfall 2
 * regression gate. Tests that need to inspect specific metric values
 * construct their own `makeMetricsRegistry()` directly so they have a
 * named reference.
 */
export function makeFakeMetrics(): MetricsRegistry {
  return makeMetricsRegistry();
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 17 (v0.11.0 — SESS-01 / CTXP-01 / SUMP-01) — fakes for downstream tests.
// Mirror the makeFakeBufferedWriter / makeFakeMetrics shape: single-arg opts
// builder returning an object satisfying the production interface. Used by
// tests/routes/session-attach.integration.test.ts + tests/providers/*.test.ts.
//
// Wave-0 note: the type imports below intentionally fail until Plans 17-03/04/05
// land the production interface files. That keeps `tsc --noEmit` red as the
// Wave-0 signal — mirrors the missing-module gate in tests/providers/*.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  SessionStore,
  Turn,
  CreateSessionInput,
  AppendTurnResult,
  LoadHistoryOpts,
  ListSessionsFilter,
  SessionSummary,
} from '../src/providers/session-store.js';
import type {
  ContextProvider,
  ProvideContextResult,
  ProvideContextOpts,
} from '../src/providers/context-provider.js';
import type {
  SummaryProvider,
  SummarizeOpts,
  SummarizeResult,
} from '../src/providers/summary-provider.js';
import type { CanonicalMessage } from '../src/translation/canonical.js';

export interface FakeSessionStoreOpts {
  /** Pre-seeded history returned by loadHistory. Defaults to []. */
  history?: Turn[];
  /** When true, appendTurn returns persisted:false (simulates SESS-04 1s timeout). */
  appendShouldTimeout?: boolean;
  /** When true, loadHistory returns [] regardless of agent_id (simulates missing session). */
  loadShouldMiss?: boolean;
  /** Captures all appendTurn calls for assertion. */
  appendCalls?: Array<{
    session_id: string;
    agent_id: string;
    turn: Parameters<SessionStore['appendTurn']>[2];
  }>;
}

/**
 * Phase 17 (SESS-01) — minimal SessionStore fake for integration + unit tests.
 *
 * Honors the SESS-03 anti-leak contract: loadHistory filters by agent_id. The
 * SESS-04 fail-open path is simulated via `opts.appendShouldTimeout` — when
 * true, appendTurn returns `{ persisted: false }` without recording state.
 *
 * Does NOT enforce session expiry (P4-01) or advisory locking (P4-02) — the
 * real PostgresSessionStore covers those in tests/providers/postgres-session-store.test.ts.
 */
export function makeFakeSessionStore(opts: FakeSessionStoreOpts = {}): SessionStore {
  const history: Turn[] = opts.history ?? [];
  const appendCalls = opts.appendCalls ?? [];
  let turnIndex = history.length;
  return {
    async createSession(input: CreateSessionInput): Promise<string> {
      return input.session_id ?? `fake-${input.agent_id}-${Date.now()}`;
    },
    async appendTurn(
      session_id: string,
      agent_id: string,
      turn: Parameters<SessionStore['appendTurn']>[2],
    ): Promise<AppendTurnResult> {
      appendCalls.push({ session_id, agent_id, turn });
      if (opts.appendShouldTimeout) {
        return { turn_id: '', turn_index: -1, persisted: false };
      }
      turnIndex += 1;
      return { turn_id: `fake-turn-${turnIndex}`, turn_index: turnIndex, persisted: true };
    },
    async loadHistory(
      _session_id: string,
      agent_id: string,
      _opts?: LoadHistoryOpts,
    ): Promise<Turn[]> {
      if (opts.loadShouldMiss) return [];
      // SESS-03: filter by agent_id (anti-leak parity with PostgresSessionStore).
      return history.filter((t) => t.agent_id === agent_id);
    },
    async deleteSession(_session_id: string, _agent_id: string): Promise<void> {
      /* noop */
    },
    async listSessions(
      _filter: ListSessionsFilter,
    ): Promise<{ sessions: SessionSummary[]; next_cursor?: string }> {
      return { sessions: [] };
    },
    async replaceTurns(
      _session_id: string,
      _agent_id: string,
      _turns: Parameters<SessionStore['replaceTurns']>[2],
    ): Promise<void> {
      /* noop */
    },
  };
}

export interface FakeContextProviderOpts {
  /** When true, returns incoming messages verbatim (no trim, no system pin). Default false. */
  passthrough?: boolean;
}

/**
 * Phase 17 (CTXP-01) — minimal ContextProvider fake.
 *
 * Default behavior pins `history.role === 'system'` turns into `result.system`
 * (CTXP-03 parity) and surfaces incoming messages verbatim in `result.messages`.
 * The `passthrough` opt skips the system-pin pass entirely — useful for tests
 * that want the un-trimmed echo path.
 */
export function makeFakeContextProvider(opts: FakeContextProviderOpts = {}): ContextProvider {
  return {
    provideContext(
      history: Turn[],
      incomingMessages: CanonicalMessage[],
      incomingSystem: string | undefined,
      _provideOpts: ProvideContextOpts,
    ): ProvideContextResult {
      if (opts.passthrough) {
        return {
          messages: incomingMessages,
          system: incomingSystem,
          dropped_count: 0,
          estimated_tokens: 0,
          has_pending_tool_call: false,
        };
      }
      // Default: pin all history.role==='system' into system field, return
      // user/assistant/tool only in messages[].
      const systemParts: string[] = [];
      const evictable: CanonicalMessage[] = [];
      for (const t of history) {
        if (t.role === 'system') {
          // Best-effort stringify of ContentBlock[] — fakes intentionally
          // don't share the full canonical-content union to avoid coupling.
          // Plan 17-07 Rule-1 typing cleanup: previously `filter` widened the
          // array element to the full ContentBlock union (text | image |
          // tool_use | tool_result), then `map` could not narrow back to
          // `{ text?: string }`. The explicit type-predicate in the filter
          // callback narrows the array element so map sees the text-block shape.
          const txt = Array.isArray(t.content)
            ? t.content
                .filter(
                  (b: { type?: string; text?: string }): b is { type: 'text'; text: string } =>
                    b.type === 'text',
                )
                .map((b) => b.text ?? '')
                .join('')
            : '';
          if (txt) systemParts.push(txt);
        }
        // tool/assistant/user mapping is intentionally simplified — the real
        // ContextProvider handles full canonicalization (Plan 17-03).
      }
      if (incomingSystem) systemParts.push(incomingSystem);
      evictable.push(...incomingMessages);
      return {
        messages: evictable,
        system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
        dropped_count: 0,
        estimated_tokens: 0,
        has_pending_tool_call: false,
      };
    },
  };
}

/**
 * Phase 17 (SUMP-01) — minimal SummaryProvider fake.
 *
 * Returns the Noop default shape `{ summary: '', replaced_turn_ids: [] }`
 * (REQUIREMENTS.md line 74, patched 2026-05-31), OR `null` when the SUMP-03
 * `has_pending_tool_call` guard fires — defense-in-depth, since the call
 * site is also expected to gate per SUMP-03.
 */
export function makeFakeSummaryProvider(): SummaryProvider {
  return {
    async summarize(
      _turns: Turn[],
      opts: SummarizeOpts,
    ): Promise<SummarizeResult | null> {
      if (opts.has_pending_tool_call) return null; // SUMP-03 BLOCK
      return { summary: '', replaced_turn_ids: [] };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 18 (v0.11.0 — MCPC-01..06 / RETR-01..06) — fakes for downstream tests.
// Mirror the Phase 17 makeFakeSessionStore shape: single-arg opts builder
// returning an object satisfying the production interface, with call-capture
// arrays for assertions.
//
// Wave-0 note: the type imports below intentionally fail until Plans 18-03/04
// land the production interface files. That keeps `tsc --noEmit` red as the
// Wave-0 signal — mirrors the missing-module gate in tests/hooks/*.test.ts +
// tests/mcp/client/*.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  RetrieverProvider,
  RetrieverRequest,
  RetrieverResponse,
  RetrievedDocument,
} from '../src/providers/retriever-provider.js';
import type {
  McpClientRegistry,
  McpServerConfig,
} from '../src/mcp/client/registry.js';
import type { CanonicalTool } from '../src/translation/canonical.js';

// Compile-time anchor — Plan 18-02/04 wires McpServerConfig into the registry
// fake constructor signature. Reference kept to surface the missing module
// at tsc time.
type _UnusedMcpServerConfig = McpServerConfig;

export interface FakeRetrieverProviderOpts {
  /** Documents returned by retrieve(). Default []. */
  documents?: RetrievedDocument[];
  /** When true, retrieve() never resolves (simulates P5-02 hook timeout). */
  shouldTimeout?: boolean;
  /** When set, retrieve() rejects with this error. */
  shouldThrow?: Error;
  /** Latency simulation in ms before retrieve() resolves. */
  latencyMs?: number;
  /** Captures every retrieve() call for assertion. */
  calls?: RetrieverRequest[];
}

/**
 * Phase 18 (RETR-01) — minimal RetrieverProvider fake for hook tests.
 *
 * Honors the P5-02 BLOCK timeout-arm contract: `shouldTimeout: true` returns
 * a Promise that never resolves, so `runHookChain`'s `Promise.race(retrieve,
 * timeout)` exercises the timeout arm deterministically. `shouldThrow`
 * exercises the error-arm (status:'error' in `hook_log`). The
 * `retrieved_at` value uses `new Date(0).toISOString()` so golden snapshots
 * stay stable across re-runs.
 *
 * Does NOT enforce filtering / scoring / hybrid retrieval — those live in
 * real RetrieverProvider implementations (Phase 19+).
 */
export function makeFakeRetrieverProvider(opts: FakeRetrieverProviderOpts = {}): RetrieverProvider {
  const calls = opts.calls ?? [];
  return {
    async retrieve(request: RetrieverRequest): Promise<RetrieverResponse> {
      calls.push(request);
      if (opts.shouldTimeout) {
        // Never-resolving Promise — Promise.race in runHookChain MUST observe
        // the timeout arm winning.
        return new Promise<RetrieverResponse>(() => {
          /* never resolves */
        });
      }
      if (opts.shouldThrow) {
        throw opts.shouldThrow;
      }
      if (opts.latencyMs && opts.latencyMs > 0) {
        await new Promise((r) => setTimeout(r, opts.latencyMs));
      }
      return {
        documents: opts.documents ?? [],
        retrieved_at: new Date(0).toISOString(), // deterministic for golden snapshots
      };
    },
  };
}

export interface FakeMcpClientRegistryOpts {
  /** Map alias → tools returned by getOrFetchTools (already prefixed). Default {}. */
  toolsByAlias?: Record<string, CanonicalTool[]>;
  /** Map alias → (toolName → result returned by callTool). Default {}. */
  toolResultsByAlias?: Record<string, Record<string, unknown>>;
  /** Captures every callTool invocation for assertion. */
  callTrace?: Array<{ alias: string; toolName: string; args: unknown }>;
  /** Force a failure mode on a specific alias + operation. */
  shouldFailOn?: { alias: string; on: 'connect' | 'list' | 'call' };
}

/**
 * Phase 18 (MCPC-02..06) — minimal McpClientRegistry fake for the MCP-loop
 * unit + integration tests. Mirrors the production interface in
 * `src/mcp/client/registry.ts` (Plan 18-04).
 *
 * The `callTrace` array captures every `callTool(alias, toolName, args)`
 * invocation, allowing the MCP-loop tests to assert dispatch ordering +
 * parallel-call semantics without needing a real MSW peer. The
 * `shouldFailOn` opt forces a single operation to throw — used by
 * registry-retry tests that exercise the "connect failure evicts the cached
 * promise" path.
 */
export function makeFakeMcpClientRegistry(
  opts: FakeMcpClientRegistryOpts = {},
): McpClientRegistry {
  const callTrace = opts.callTrace ?? [];
  return {
    // The SDK's `Client` type is heavily generic; tests assert against
    // structural shape (`{ name }`) not type-identity. The double-cast
    // through `unknown` matches the Phase 17 `makeFakeSessionStore` pattern
    // where the production interface is intentionally loose.
    async getOrConnect(alias: string) {
      if (opts.shouldFailOn?.alias === alias && opts.shouldFailOn.on === 'connect') {
        throw new Error(`fake-fail: connect ${alias}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { name: `fake-client-${alias}` } as any;
    },
    async getOrFetchTools(alias: string): Promise<CanonicalTool[]> {
      if (opts.shouldFailOn?.alias === alias && opts.shouldFailOn.on === 'list') {
        throw new Error(`fake-fail: list ${alias}`);
      }
      return opts.toolsByAlias?.[alias] ?? [];
    },
    async callTool(alias: string, toolName: string, args: unknown): Promise<unknown> {
      callTrace.push({ alias, toolName, args });
      if (opts.shouldFailOn?.alias === alias && opts.shouldFailOn.on === 'call') {
        throw new Error(`fake-fail: call ${alias}.${toolName}`);
      }
      return opts.toolResultsByAlias?.[alias]?.[toolName] ?? { ok: true };
    },
    async dispose(_alias: string): Promise<void> {
      /* noop */
    },
    async disposeAll(): Promise<void> {
      /* noop */
    },
  };
}
