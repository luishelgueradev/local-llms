/**
 * Phase 18 (v0.11.0 — RETR-01 / RETR-05 / Frame-01 BLOCK)
 *
 * RetrieverProvider interface — declarative seam for downstream consumers.
 *
 * STRATEGIC FRAME (binding): "Retrieval Interfaces, not Retrieval Logic" —
 * this file declares the contract. NO production implementation lives in
 * router/src/. The ONLY ships-by-default RetrieverProvider is the
 * ABSENCE of one. A test-only fake exists in tests/fakes.ts
 * (Phase 18 Plan 18-01 Task 3 — `makeFakeRetrieverProvider`).
 *
 * Operators register a real RetrieverProvider via the composition root
 * (router/src/index.ts — Plan 18-07) by attaching a PreCompletionHook to
 * the BuildAppOpts.preCompletionHooks Map. The router never instantiates
 * a retriever on its own.
 */

/**
 * Failure mode for pre-completion hook timeouts.
 *
 * REQUIRED on every hook — no default (P5-01 BLOCK). Missing field is a
 * startup error (HookConfigError thrown by buildApp — Plan 18-07).
 *
 * - `fail-open`: augmentation hooks (retrieval adds context; missing context
 *   degrades quality, not safety). Request continues to completion with the
 *   X-Hook-Error response header set + warn log.
 * - `fail-closed`: authorization hooks (retrieval gates access; missing
 *   context = unsafe). Request returns 502 via HookTimeoutError envelope.
 *
 * The router does NOT pick a default — operators MUST declare intent.
 */
export type OnTimeout = 'fail-open' | 'fail-closed';

/**
 * A document returned by the retriever. The router does not interpret
 * `metadata` — it's passed through to the audit log + (optionally) the
 * caller's downstream consumer.
 */
export interface RetrievedDocument {
  /** The text content. The router fences this in <retrieved_context source="..."> */
  content: string;
  /** Optional retrieval score (0..1). Higher = better match. Not used by router. */
  score?: number;
  /** Opaque metadata. Pass-through only. */
  metadata?: Record<string, unknown>;
}

/**
 * Request shape passed to the retriever. The `query` is derived by default
 * from the last user message in the canonical request (see Plan 18-06's
 * `runHookChain` default `buildRequest`). Hooks may override the default
 * via `PreCompletionHook.buildRequest`.
 */
export interface RetrieverRequest {
  query: string;
  /** Default 5 (RESOLVED Open Question #2). Caller-overridable per hook. */
  top_k?: number;
  /** Opaque filters forwarded to the retriever. */
  filters?: Record<string, unknown>;
  /** Opaque request metadata (DO NOT put bearer tokens here — see Anti-Patterns). */
  metadata?: Record<string, unknown>;
  /** Hybrid search opts (sparse/dense weights + rerank flag). Opaque to router. */
  hybrid?: {
    sparse_weight?: number;
    dense_weight?: number;
    rerank?: boolean;
  };
}

/**
 * Response shape from the retriever.
 */
export interface RetrieverResponse {
  documents: RetrievedDocument[];
  /** ISO timestamp from the retriever's clock (informational). */
  retrieved_at: string;
}

/**
 * The interface every external retriever implementation must satisfy.
 *
 * Frame-01 BLOCK: router/src/ contains NO classes implementing this
 * interface. Implementations live in caller-supplied modules attached to
 * BuildAppOpts.preCompletionHooks (see router/src/hooks/pre-completion.ts —
 * Plan 18-06). A test-only fake lives in tests/fakes.ts.
 */
export interface RetrieverProvider {
  retrieve(request: RetrieverRequest): Promise<RetrieverResponse>;
}
