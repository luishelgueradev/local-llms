/**
 * Phase 20 / CAT-01 (v0.12.0 — D-01 LOCKED): Zod schema parse + filter
 * behavior tests for the new `disabled` field on ModelEntrySchema.
 *
 * Decision covered: D-01 — dead-backend entries get `disabled: true` instead
 * of removal. The disabled flag:
 *   1. Filters the entry out of `enabledModels(reg)` (public surface)
 *   2. Causes `resolve(name)` to throw RegistryUnknownModelError identically
 *      to an unknown name (anti-leak — T-20-01)
 *   3. Skips VRAM-envelope summing (re-enable is a 1-line flip without
 *      retrofitting other entries)
 *   4. Skips URL-uniqueness validation (a disabled entry can share its URL
 *      with another backend without tripping the gate)
 *
 * Pattern mirrors `registry.policies.test.ts` — inline YAML strings parsed
 * via `loadRegistryFromString` (no filesystem).
 */
import { describe, expect, it } from 'vitest';
import {
  loadRegistryFromString,
  enabledModels,
  makeRegistryStore,
  RegistryUnknownModelError,
} from '../registry.js';

// ---------------------------------------------------------------------------
// 1. Backward compat — YAML without `disabled` loads cleanly + all enabled
// ---------------------------------------------------------------------------

describe('Phase 20 / CAT-01 — backward compat: YAML without disabled field', () => {
  it('parses cleanly, every entry defaults to disabled=false, enabledModels returns all', () => {
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
  - name: vision-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2-vision:11b
    capabilities: [chat, vision]
    vram_budget_gb: 8
`);
    // Zod default populates the field on every entry — no migration needed
    // for pre-Phase-20 YAML files.
    expect(reg.models.every((m) => m.disabled === false)).toBe(true);
    expect(enabledModels(reg)).toHaveLength(3);
    expect(enabledModels(reg).map((m) => m.name).sort()).toEqual([
      'chat-local',
      'embed-local',
      'vision-local',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. enabledModels() excludes flagged entries
// ---------------------------------------------------------------------------

describe('Phase 20 / CAT-01 — enabledModels() filter excludes disabled entries', () => {
  it('returns only the 2 non-flagged entries when 1 of 3 is disabled', () => {
    const reg = loadRegistryFromString(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
  - name: qwen2.5-7b-instruct-awq
    backend: vllm
    backend_url: http://vllm:8000/v1
    backend_model: Qwen/Qwen2.5-7B-Instruct-AWQ
    capabilities: [chat]
    vram_budget_gb: 7
    disabled: true
  - name: vision-local
    backend: ollama
    backend_url: http://ollama-vision:11434/v1
    backend_model: llama3.2-vision:11b
    capabilities: [chat, vision]
    vram_budget_gb: 8
`);
    expect(reg.models).toHaveLength(3);
    const enabled = enabledModels(reg);
    expect(enabled).toHaveLength(2);
    expect(enabled.map((m) => m.name).sort()).toEqual(['chat-local', 'vision-local']);
    // Disabled entry is still in reg.models — operator can flip it back.
    expect(reg.models.find((m) => m.name === 'qwen2.5-7b-instruct-awq')?.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. resolve() throws on disabled with same message as unknown (anti-leak)
// ---------------------------------------------------------------------------

describe('Phase 20 / CAT-01 — resolve() treats disabled identically to unknown (T-20-01)', () => {
  it('throws RegistryUnknownModelError with identical message for disabled vs unknown', () => {
    const reg = loadRegistryFromString(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
  - name: qwen2.5-7b-instruct-awq
    backend: vllm
    backend_url: http://vllm:8000/v1
    backend_model: Qwen/Qwen2.5-7B-Instruct-AWQ
    capabilities: [chat]
    vram_budget_gb: 7
    disabled: true
`);
    const store = makeRegistryStore(reg);

    // Disabled alias → throws as if unknown.
    let disabledError: unknown;
    try {
      store.resolve('qwen2.5-7b-instruct-awq');
    } catch (err) {
      disabledError = err;
    }
    expect(disabledError).toBeInstanceOf(RegistryUnknownModelError);
    const dErr = disabledError as RegistryUnknownModelError;
    expect(dErr.modelName).toBe('qwen2.5-7b-instruct-awq');
    // Anti-leak: knownNames must NOT include the disabled alias itself.
    expect(dErr.knownNames).toEqual(['chat-local']);

    // Truly unknown alias → throws with same modelName-substitution shape +
    // identical `knownNames` array (disabled alias is invisible there too).
    let unknownError: unknown;
    try {
      store.resolve('completely-fake-alias');
    } catch (err) {
      unknownError = err;
    }
    expect(unknownError).toBeInstanceOf(RegistryUnknownModelError);
    const uErr = unknownError as RegistryUnknownModelError;
    expect(uErr.knownNames).toEqual(['chat-local']);

    // The two errors expose the SAME knownNames array contents — the consumer
    // cannot distinguish "unknown" from "disabled" by inspecting the suggestion list.
    expect(dErr.knownNames).toEqual(uErr.knownNames);
  });
});

// ---------------------------------------------------------------------------
// 4. resolve() returns enabled entries normally
// ---------------------------------------------------------------------------

describe('Phase 20 / CAT-01 — resolve() returns enabled entries unchanged', () => {
  it('returns the entry for a non-disabled alias', () => {
    const reg = loadRegistryFromString(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
  - name: qwen2.5-7b-instruct-awq
    backend: vllm
    backend_url: http://vllm:8000/v1
    backend_model: Qwen/Qwen2.5-7B-Instruct-AWQ
    capabilities: [chat]
    vram_budget_gb: 7
    disabled: true
`);
    const store = makeRegistryStore(reg);
    const entry = store.resolve('chat-local');
    expect(entry.name).toBe('chat-local');
    expect(entry.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. VRAM envelope skips disabled entries
// ---------------------------------------------------------------------------

describe('Phase 20 / CAT-01 — VRAM envelope superRefine skips disabled entries', () => {
  it('loads cleanly when enabled-only VRAM sum ≤ envelope, even if disabled inclusion would exceed it', () => {
    // VRAM_ENVELOPE_GB defaults to 16. Enabled entries sum to 10 (under cap).
    // Including the disabled 12-GB entry would push the ollama-bucket sum
    // to 22 (over cap) — the skip guards against this so a 1-line re-enable
    // doesn't suddenly require renegotiating other entries' budgets.
    const reg = loadRegistryFromString(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 5
  - name: vision-local
    backend: ollama
    backend_url: http://ollama-vision:11434/v1
    backend_model: llama3.2-vision:11b
    capabilities: [chat, vision]
    vram_budget_gb: 5
  - name: oversized-dormant
    backend: ollama
    backend_url: http://ollama-oversized:11434/v1
    backend_model: some-future-model
    capabilities: [chat]
    vram_budget_gb: 12
    disabled: true
`);
    // If the superRefine summed disabled entries, this would have thrown
    // "exceeds VRAM_ENVELOPE_GB=16" during parse. Reaching this assertion
    // proves the skip works.
    expect(reg.models).toHaveLength(3);
    expect(enabledModels(reg)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 6. URL uniqueness skips disabled entries
// ---------------------------------------------------------------------------

describe('Phase 20 / CAT-01 — URL-uniqueness superRefine skips disabled entries', () => {
  it('loads cleanly when a disabled entry shares its URL with a different enabled backend', () => {
    // Without the skip, two DISTINCT backend values at the same URL would
    // trigger the URL-collision superRefine. With `disabled: true` on the
    // colliding entry, the registry loads cleanly — the disabled entry is
    // never dispatched, so the URL collision is operationally moot.
    const reg = loadRegistryFromString(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://shared-host:8080/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
  - name: vllm-dormant-at-same-url
    backend: vllm
    backend_url: http://shared-host:8080/v1
    backend_model: Qwen/Qwen2.5-7B-Instruct-AWQ
    capabilities: [chat]
    vram_budget_gb: 7
    disabled: true
`);
    // If the superRefine had checked the disabled entry, this would have
    // thrown "backend_url ... is shared by backends [ollama, vllm]". Reaching
    // this assertion proves the skip works.
    expect(reg.models).toHaveLength(2);
    expect(enabledModels(reg)).toHaveLength(1);
    expect(enabledModels(reg)[0]?.name).toBe('chat-local');
  });
});
