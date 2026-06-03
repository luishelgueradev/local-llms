/**
 * Phase 20 (v0.12.0 — CAT-04 / D-03 LOCKED): Unit tests for deprecation alias
 * resolver + schema cross-field validation.
 *
 * Two surfaces under test:
 *
 *   1. `resolveAlias(alias, registry)` (pure function):
 *      - Pass-through for non-deprecated aliases (canonical === input, meta undefined)
 *      - Redirect for deprecated aliases (canonical === target, meta populated)
 *      - Pass-through for completely unknown aliases (no special handling here —
 *        registry.resolve() downstream will throw RegistryUnknownModelError)
 *
 *   2. `RegistrySchema.superRefine` cross-field validation:
 *      - REJECT YAML where deprecated_aliases target points to a nonexistent model
 *      - REJECT YAML where deprecated_aliases target points to a disabled model
 *      - REJECT YAML where the deprecated key itself is not present in models[]
 *      - ACCEPT YAML where target is enabled AND key is a known (typically disabled) entry
 *
 * Pattern mirrors `registry-disabled.test.ts` — inline YAML strings parsed via
 * `loadRegistryFromString` (no filesystem); the resolver test builds a minimal
 * Registry by hand via `loadRegistryFromString` so the test exercises the real
 * parse pipeline, not a hand-cast fixture.
 */
import { describe, expect, it } from 'vitest';
import { resolveAlias } from '../deprecation.js';
import { loadRegistryFromString } from '../registry.js';

// ---------------------------------------------------------------------------
// resolveAlias() — pure-function surface
// ---------------------------------------------------------------------------

describe('Phase 20 / CAT-04 — resolveAlias (pass-through cases)', () => {
  it('returns canonical=input + meta=undefined for an alias NOT in deprecated_aliases', () => {
    const reg = loadRegistryFromString(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`);
    const result = resolveAlias('chat-local', reg);
    expect(result.canonical).toBe('chat-local');
    expect(result.deprecation_meta).toBeUndefined();
  });

  it('returns canonical=input + meta=undefined for an UNKNOWN alias (downstream registry.resolve handles the 404)', () => {
    const reg = loadRegistryFromString(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`);
    const result = resolveAlias('totally-bogus-name', reg);
    expect(result.canonical).toBe('totally-bogus-name');
    expect(result.deprecation_meta).toBeUndefined();
  });
});

describe('Phase 20 / CAT-04 — resolveAlias (deprecated alias redirect)', () => {
  it('returns canonical=target + populated meta when input is in deprecated_aliases', () => {
    const reg = loadRegistryFromString(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5-7b-q4km.gguf
    capabilities: [chat]
    vram_budget_gb: 4
    disabled: true
deprecated_aliases:
  qwen2.5-7b-instruct-q4km:
    target: chat-local
    deprecated_since: v0.12.0
    removal_target: v0.13.0
`);
    const result = resolveAlias('qwen2.5-7b-instruct-q4km', reg);
    expect(result.canonical).toBe('chat-local');
    expect(result.deprecation_meta).toEqual({
      old_name: 'qwen2.5-7b-instruct-q4km',
      new_name: 'chat-local',
      deprecated_since: 'v0.12.0',
      removal_target: 'v0.13.0',
    });
  });
});

// ---------------------------------------------------------------------------
// RegistrySchema.superRefine — cross-field validation
// ---------------------------------------------------------------------------

describe('Phase 20 / CAT-04 — RegistrySchema rejects malformed deprecated_aliases', () => {
  it('REJECTS when target points to a nonexistent model', () => {
    expect(() =>
      loadRegistryFromString(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5-7b-q4km.gguf
    capabilities: [chat]
    vram_budget_gb: 4
    disabled: true
deprecated_aliases:
  qwen2.5-7b-instruct-q4km:
    target: nonexistent-canonical
    deprecated_since: v0.12.0
    removal_target: v0.13.0
`),
    ).toThrow(/no enabled model has that name/);
  });

  it('REJECTS when target points to a DISABLED entry (Wave 0 boundary check)', () => {
    expect(() =>
      loadRegistryFromString(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
  - name: legacy-chat
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: old-model
    capabilities: [chat]
    vram_budget_gb: 4
    disabled: true
  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5-7b-q4km.gguf
    capabilities: [chat]
    vram_budget_gb: 4
    disabled: true
deprecated_aliases:
  qwen2.5-7b-instruct-q4km:
    target: legacy-chat
    deprecated_since: v0.12.0
    removal_target: v0.13.0
`),
    ).toThrow(/no enabled model has that name/);
  });

  it('REJECTS when the deprecated key is NOT a known model name (operator must keep the disabled stub)', () => {
    expect(() =>
      loadRegistryFromString(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
deprecated_aliases:
  ghost-alias-not-in-models:
    target: chat-local
    deprecated_since: v0.12.0
    removal_target: v0.13.0
`),
    ).toThrow(/must be a known model name/);
  });

  it('ACCEPTS YAML with valid deprecated_aliases pointing to enabled targets (canonical case)', () => {
    const reg = loadRegistryFromString(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
  - name: embed-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: bge-m3
    capabilities: [embeddings]
    dims: 1024
    vram_budget_gb: 2
  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5-7b-q4km.gguf
    capabilities: [chat]
    vram_budget_gb: 4
    disabled: true
  - name: bge-m3-vllm
    backend: vllm-embed
    backend_url: http://vllm-embed:8000/v1
    backend_model: BAAI/bge-m3
    capabilities: [embeddings]
    dims: 1024
    vram_budget_gb: 2
    disabled: true
deprecated_aliases:
  qwen2.5-7b-instruct-q4km:
    target: chat-local
    deprecated_since: v0.12.0
    removal_target: v0.13.0
  bge-m3-vllm:
    target: embed-local
    deprecated_since: v0.12.0
    removal_target: v0.13.0
`);
    expect(reg.deprecated_aliases).toBeDefined();
    expect(reg.deprecated_aliases?.['qwen2.5-7b-instruct-q4km']?.target).toBe('chat-local');
    expect(reg.deprecated_aliases?.['bge-m3-vllm']?.target).toBe('embed-local');
  });
});
