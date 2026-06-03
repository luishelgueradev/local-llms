/**
 * Phase 20 / CDX-01 (v0.12.0 — D-05 LOCKED) — unit tests for
 * `deriveRecommendedFor()` (the per-entry capability-to-tag derivation helper).
 *
 * The integration-level behavior of `computeRecommendations()` + per-entry
 * `recommended_for` field on the /v1/models response shape is covered by
 * `router/tests/integration/v1-models-recommendations.integration.test.ts`
 * (real buildApp + fake Valkey + fake fetch). This file pins the pure-function
 * contract that downstream call sites depend on.
 *
 * Plan 20-03 Task 3 / Part B contract — 5 unit cases:
 *   1. chat + tools + json_mode → [chat, chat-tools, function-calling, chat-json-strict]
 *   2. embeddings → [embeddings]
 *   3. rerank → [rerank]
 *   4. chat + vision → [chat, vision]
 *   5. operator-declared recommended_for WINS over capability derivation
 */
import { describe, it, expect } from 'vitest';
import { deriveRecommendedFor } from '../../../config/registry.js';
import type { ModelEntry } from '../../../config/registry.js';

// Minimal ModelEntry literal builder — keep tests self-contained. Mirrors the
// `disabled: false` + `ctx_size`/`context_strategy` defaults convention from
// the Phase 17/20 fixture-update pattern (factory.test.ts etc.).
function mkEntry(overrides: Partial<ModelEntry>): ModelEntry {
  return {
    name: overrides.name ?? 'test-entry',
    backend: overrides.backend ?? 'ollama',
    backend_url: overrides.backend_url ?? 'http://ollama:11434/v1',
    backend_model: overrides.backend_model ?? 'test',
    // Cast through any to keep the builder type-flexible — Zod schema validates
    // the actual shape; tests intentionally exercise edge combinations.
    // biome-ignore lint/suspicious/noExplicitAny: test fixture builder
    capabilities: (overrides.capabilities ?? ['chat']) as any,
    vram_budget_gb: overrides.vram_budget_gb ?? 4,
    disabled: overrides.disabled ?? false,
    ctx_size: overrides.ctx_size ?? 8192,
    context_strategy: overrides.context_strategy ?? 'sliding-window',
    recommended_for: overrides.recommended_for,
  } as ModelEntry;
}

describe('deriveRecommendedFor (Phase 20 / CDX-01 / D-05 LOCKED)', () => {
  it('1. capabilities [chat, tools, json_mode] → [chat, chat-tools, function-calling, chat-json-strict] (set-equal)', () => {
    const entry = mkEntry({ capabilities: ['chat', 'tools', 'json_mode'] });
    const tags = deriveRecommendedFor(entry);
    // Assert SET equality (order is internal — operators shouldn't depend on it).
    expect(new Set(tags)).toEqual(
      new Set(['chat', 'chat-tools', 'function-calling', 'chat-json-strict']),
    );
    // Sanity: every tag is unique (no double-pushes of the same value).
    expect(tags.length).toBe(new Set(tags).size);
  });

  it('2. capabilities [embeddings] → [embeddings]', () => {
    const entry = mkEntry({ capabilities: ['embeddings'], backend: 'ollama' });
    expect(deriveRecommendedFor(entry)).toEqual(['embeddings']);
  });

  it('3. capabilities [rerank] → [rerank]', () => {
    const entry = mkEntry({ capabilities: ['rerank'] });
    expect(deriveRecommendedFor(entry)).toEqual(['rerank']);
  });

  it('4. capabilities [chat, vision] → [chat, vision] (set-equal)', () => {
    const entry = mkEntry({ capabilities: ['chat', 'vision'] });
    expect(new Set(deriveRecommendedFor(entry))).toEqual(new Set(['chat', 'vision']));
  });

  it('5. operator-declared recommended_for WINS over derivation (caps suggest more, operator says just [chat])', () => {
    // Capabilities would derive [chat, chat-tools, function-calling, chat-json-strict, vision]
    // but operator has hand-tagged just [chat] — that wins.
    const entry = mkEntry({
      capabilities: ['chat', 'tools', 'json_mode', 'vision'],
      recommended_for: ['chat'],
    });
    expect(deriveRecommendedFor(entry)).toEqual(['chat']);
  });

  it('5b. operator-declared empty array does NOT win — falls through to derivation', () => {
    // Defensive check: empty operator array should NOT silently hide all tags;
    // the helper treats empty/absent identically (per `entry.recommended_for.length > 0`
    // guard in the implementation). Mirrors the "Open Q: what does [] mean?"
    // edge case — we treat it as "operator forgot to populate" not "operator
    // explicitly cleared every tag".
    const entry = mkEntry({
      capabilities: ['embeddings'],
      recommended_for: [],
    });
    expect(deriveRecommendedFor(entry)).toEqual(['embeddings']);
  });

  it('5c. operator-declared subset wins (operator says [chat, chat-tools] for a chat+tools+json_mode model)', () => {
    // Operator wants to hide chat-json-strict from recommendations (e.g. flaky
    // json_mode adherence on this model). Derivation would include
    // chat-json-strict; operator override suppresses it.
    const entry = mkEntry({
      capabilities: ['chat', 'tools', 'json_mode'],
      recommended_for: ['chat', 'chat-tools'],
    });
    expect(deriveRecommendedFor(entry)).toEqual(['chat', 'chat-tools']);
  });
});
