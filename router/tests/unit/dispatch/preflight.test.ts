/**
 * Phase 15 (v0.11.0 — MCPS-01 / CONTEXT.md D-09): Unit tests for applyPreflight().
 *
 * 7-case matrix covering the canonical pipeline:
 *   registry.resolve → applyPolicyGate → breaker.check
 *
 * The helper consolidates the trio that today lives inline in five HTTP routes
 * (chat-completions.ts:161/225/331, messages.ts, embeddings.ts, rerank.ts,
 * responses.ts) and will also be called from each MCP tool handler in Wave 4.
 *
 * RESEARCH §Pattern 5 — Option A sentinel return: breaker.check's state is
 * RETURNED (not thrown) so HTTP callers can stamp `Retry-After` before raising
 * BreakerOpenError with their own cooldown context, while MCP tool handlers
 * can throw without setting any header.
 *
 * Test 1: happy path — closed breaker → {entry, breakerState:'closed'}
 * Test 2: registry.resolve throws RegistryUnknownModelError → propagates verbatim
 * Test 3: applyPolicyGate throws AllowlistViolationError → propagates; breaker.check NEVER called
 * Test 4: applyPolicyGate throws CloudNotAllowedError → propagates; breaker.check NEVER called
 * Test 5: breaker.check returns 'half-open' → returns sentinel; no throw
 * Test 6: breaker.check returns 'open' → returns sentinel; no throw (Option A)
 * Test 7: ordering invariant — gate throws ⇒ resolve called once, breaker NEVER called
 *         (mirrors Phase 14 POL-05 gate-before-breaker invariant)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyPreflight } from '../../../src/dispatch/preflight.js';
import {
  RegistryUnknownModelError,
  AllowlistViolationError,
  CloudNotAllowedError,
} from '../../../src/errors/envelope.js';
import type { ModelEntry, Registry, RegistryStore } from '../../../src/config/registry.js';
import type { CircuitBreaker, BreakerState } from '../../../src/resilience/circuitBreaker.js';

// ── Minimal fixtures ─────────────────────────────────────────────────────────
// The helper reads `entry.backend` + `entry.policy?.cloud_allowed` via applyPolicyGate.
// Registry-snapshot reads `policies.default.model_allowlist`. ModelEntry has many
// Zod-required fields irrelevant to this surface — we cast minimal shapes via
// `as unknown as ModelEntry` (same pattern as src/policy/__tests__/gate.test.ts).

function makeEntry(
  backend: string,
  policy?: { cloud_allowed: boolean },
  name = 'chat-local',
): ModelEntry {
  return {
    name,
    backend,
    backend_model: 'qwen2.5:7b',
    policy,
  } as unknown as ModelEntry;
}

function makeRegistry(
  entry: ModelEntry,
  policies?: Registry['policies'],
): Registry {
  return {
    models: [entry],
    policies,
  } as unknown as Registry;
}

/** Build a fake RegistryStore whose resolve returns `entry` and get returns `registry`. */
function makeFakeStore(entry: ModelEntry, policies?: Registry['policies']): {
  store: RegistryStore;
  resolveSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
} {
  const registry = makeRegistry(entry, policies);
  const resolveSpy = vi.fn().mockReturnValue(entry);
  const getSpy = vi.fn().mockReturnValue(registry);
  const store: RegistryStore = {
    get: getSpy,
    resolve: resolveSpy as unknown as RegistryStore['resolve'],
    getCreatedAtSec: (): number => 0,
    _swap: (): void => undefined,
  };
  return { store, resolveSpy, getSpy };
}

/** Build a fake RegistryStore whose resolve throws RegistryUnknownModelError. */
function makeFakeStoreUnknown(name: string): {
  store: RegistryStore;
  resolveSpy: ReturnType<typeof vi.fn>;
} {
  const resolveSpy = vi.fn().mockImplementation(() => {
    throw new RegistryUnknownModelError(name, ['chat-local']);
  });
  const store: RegistryStore = {
    get: vi.fn().mockReturnValue({ models: [], policies: undefined } as unknown as Registry),
    resolve: resolveSpy as unknown as RegistryStore['resolve'],
    getCreatedAtSec: (): number => 0,
    _swap: (): void => undefined,
  };
  return { store, resolveSpy };
}

/** Build a fake CircuitBreaker whose check resolves to the requested state. */
function makeFakeBreaker(state: BreakerState): {
  breaker: CircuitBreaker;
  checkSpy: ReturnType<typeof vi.fn>;
} {
  const checkSpy = vi.fn().mockResolvedValue({ state });
  const breaker: CircuitBreaker = {
    check: checkSpy as unknown as CircuitBreaker['check'],
    recordFailure: vi.fn().mockResolvedValue(undefined) as unknown as CircuitBreaker['recordFailure'],
    recordSuccess: vi.fn().mockResolvedValue(undefined) as unknown as CircuitBreaker['recordSuccess'],
    reset: vi.fn().mockResolvedValue(undefined) as unknown as CircuitBreaker['reset'],
  };
  return { breaker, checkSpy };
}

// ── Test matrix ──────────────────────────────────────────────────────────────

describe('applyPreflight — happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Test 1: closed breaker → returns { entry, breakerState: "closed" }', async () => {
    const entry = makeEntry('ollama', undefined, 'chat-local');
    const { store } = makeFakeStore(entry);
    const { breaker, checkSpy } = makeFakeBreaker('closed');

    const result = await applyPreflight('chat-local', { registry: store, breaker });

    expect(result.entry).toBe(entry);
    expect(result.breakerState).toBe('closed');
    expect(checkSpy).toHaveBeenCalledTimes(1);
    expect(checkSpy).toHaveBeenCalledWith('ollama');
  });
});

describe('applyPreflight — registry error propagation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Test 2: registry.resolve throws RegistryUnknownModelError → propagates verbatim', async () => {
    const { store } = makeFakeStoreUnknown('unknown-model');
    const { breaker, checkSpy } = makeFakeBreaker('closed');

    await expect(
      applyPreflight('unknown-model', { registry: store, breaker }),
    ).rejects.toThrow(RegistryUnknownModelError);
    expect(checkSpy).toHaveBeenCalledTimes(0);
  });
});

describe('applyPreflight — policy gate error propagation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Test 3: AllowlistViolationError → propagates; breaker.check NEVER called', async () => {
    const entry = makeEntry('ollama-cloud', undefined, 'big-cloud');
    const policies: Registry['policies'] = { default: { model_allowlist: ['chat-local'] } };
    const { store } = makeFakeStore(entry, policies);
    const { breaker, checkSpy } = makeFakeBreaker('closed');

    await expect(
      applyPreflight('big-cloud', { registry: store, breaker }),
    ).rejects.toThrow(AllowlistViolationError);
    expect(checkSpy).toHaveBeenCalledTimes(0);
  });

  it('Test 4: CloudNotAllowedError → propagates; breaker.check NEVER called', async () => {
    const entry = makeEntry('ollama-cloud', { cloud_allowed: false }, 'big-cloud');
    // No allowlist (so Rule 1 passes); Rule 2 fires on cloud_allowed=false.
    const { store } = makeFakeStore(entry, undefined);
    const { breaker, checkSpy } = makeFakeBreaker('closed');

    await expect(
      applyPreflight('big-cloud', { registry: store, breaker }),
    ).rejects.toThrow(CloudNotAllowedError);
    expect(checkSpy).toHaveBeenCalledTimes(0);
  });
});

describe('applyPreflight — breaker sentinel return (Option A)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Test 5: breaker state "half-open" → returns sentinel; no throw', async () => {
    const entry = makeEntry('ollama', undefined, 'chat-local');
    const { store } = makeFakeStore(entry);
    const { breaker, checkSpy } = makeFakeBreaker('half-open');

    const result = await applyPreflight('chat-local', { registry: store, breaker });

    expect(result.entry).toBe(entry);
    expect(result.breakerState).toBe('half-open');
    expect(checkSpy).toHaveBeenCalledTimes(1);
  });

  it('Test 6: breaker state "open" → returns sentinel WITHOUT throwing', async () => {
    // D-09 Option A: helper does NOT throw on state='open'. The caller decides
    // (HTTP stamps Retry-After then throws BreakerOpenError; MCP tool throws
    // without header).
    const entry = makeEntry('ollama', undefined, 'chat-local');
    const { store } = makeFakeStore(entry);
    const { breaker, checkSpy } = makeFakeBreaker('open');

    const result = await applyPreflight('chat-local', { registry: store, breaker });

    expect(result.entry).toBe(entry);
    expect(result.breakerState).toBe('open');
    expect(checkSpy).toHaveBeenCalledTimes(1);
  });
});

describe('applyPreflight — ordering invariant (POL-05 mirror)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Test 7: gate throws ⇒ resolve called once, breaker NEVER called', async () => {
    // Phase 14 POL-05: policy violations must not mutate the breaker counter.
    // The helper enforces this by calling applyPolicyGate BEFORE breaker.check;
    // a thrown gate short-circuits before the breaker is touched.
    const entry = makeEntry('ollama-cloud', { cloud_allowed: false }, 'big-cloud');
    const { store, resolveSpy } = makeFakeStore(entry, undefined);
    const { breaker, checkSpy } = makeFakeBreaker('closed');

    await expect(
      applyPreflight('big-cloud', { registry: store, breaker }),
    ).rejects.toThrow(CloudNotAllowedError);

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith('big-cloud');
    expect(checkSpy).toHaveBeenCalledTimes(0);
  });
});
