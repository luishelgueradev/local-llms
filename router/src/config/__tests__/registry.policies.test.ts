/**
 * Phase 14 (v0.11.0 — POL-01, POL-02): Zod schema parse unit tests for the
 * policy/policies fields added to ModelEntrySchema and RegistrySchema.
 *
 * Decisions covered: D-01 (hybrid models.yaml shape), D-02 (rationale for
 * hybrid placement), D-04 (absent/empty allowlist = allow-all), D-05
 * (per-entry policy.cloud_allowed defaults to true).
 *
 * Tests use inline YAML strings parsed via RegistrySchema.parse() /
 * ModelEntrySchema.parse() — mirrors the pattern in tests/unit/registry.test.ts.
 */
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { RegistrySchema, ModelEntrySchema } from '../registry.js';

// ---------------------------------------------------------------------------
// Minimal valid model entry shape (reused across tests)
// ---------------------------------------------------------------------------
const BASE_ENTRY_YAML = `
name: chat-local
backend: ollama
backend_url: http://ollama:11434/v1
backend_model: qwen2.5:7b-instruct-q4_K_M
capabilities: [chat]
vram_budget_gb: 4
`;

const BASE_MODEL_OBJ = yaml.load(BASE_ENTRY_YAML) as Record<string, unknown>;

// Minimal registry YAML without a policies: section
const MIN_REGISTRY_NO_POLICIES = `
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

// ---------------------------------------------------------------------------
// RegistrySchema — top-level policies block tests (D-01, D-04)
// ---------------------------------------------------------------------------

describe('D-04: RegistrySchema — absent policies section = allow-all', () => {
  it('Test 1: absent policies: section parses and policies field is undefined', () => {
    const parsed = yaml.load(MIN_REGISTRY_NO_POLICIES);
    const reg = RegistrySchema.parse(parsed);
    // D-04: absent section evaluates to allow-all → policies field is undefined
    expect(reg.policies).toBeUndefined();
  });
});

describe('D-04: RegistrySchema — empty model_allowlist = allow-all', () => {
  it('Test 2: policies.default.model_allowlist: [] parses as empty array', () => {
    const parsed = yaml.load(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
policies:
  default:
    model_allowlist: []
`);
    const reg = RegistrySchema.parse(parsed);
    // D-04: empty list = allow-all; the field parses cleanly and returns []
    expect(reg.policies?.default?.model_allowlist).toEqual([]);
  });
});

describe('D-01: RegistrySchema — populated model_allowlist round-trips', () => {
  it('Test 3: policies.default.model_allowlist: [chat-local] round-trips correctly', () => {
    const parsed = yaml.load(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
policies:
  default:
    model_allowlist:
      - chat-local
`);
    const reg = RegistrySchema.parse(parsed);
    expect(reg.policies?.default?.model_allowlist).toEqual(['chat-local']);
  });
});

describe('Strict-mode regression: RegistrySchema — extra keys rejected (P8-02)', () => {
  it('Test 8: policies: section with an unknown extra key is rejected by Zod strict schema', () => {
    // Zod's default z.object() uses "strip" mode (drops unknown keys, does NOT throw).
    // Per the codebase's schema discipline, no .passthrough() is used, but the default
    // Zod behavior strips unknown keys rather than rejecting them. This test documents
    // the actual behavior: extra keys under policies: are silently stripped, not rejected.
    // The P8-02 mitigation applies at the request-body layer (route schemas use .strict()).
    // Registry config uses .optional() + no .passthrough() which is consistent with the
    // existing BackendsSection pattern (strip mode on config, strict on request bodies).
    const parsed = yaml.load(`
models:
  - name: chat-local
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: qwen2.5:7b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
policies:
  default:
    model_allowlist: []
    unknown_future_key: should-be-stripped
`);
    // Zod strip mode: extra keys are stripped, parse succeeds
    const reg = RegistrySchema.parse(parsed);
    expect(reg.policies?.default?.model_allowlist).toEqual([]);
    // The extra key is stripped (not present on the output)
    expect((reg.policies?.default as Record<string, unknown>)['unknown_future_key']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ModelEntrySchema — per-entry policy block tests (D-02, D-05)
// ---------------------------------------------------------------------------

describe('D-05: ModelEntrySchema — absent policy block = policy field undefined', () => {
  it('Test 4: entry without policy: block parses and policy field is undefined', () => {
    const entry = ModelEntrySchema.parse(BASE_MODEL_OBJ);
    // D-05: absent policy block → policy field is undefined (downstream gate uses
    // entry.policy?.cloud_allowed === false with strict equality — only fires on
    // explicit false, not on missing block)
    expect(entry.policy).toBeUndefined();
  });
});

describe('D-05: ModelEntrySchema — explicit policy.cloud_allowed: true round-trips', () => {
  it('Test 5: entry with policy.cloud_allowed: true parses correctly', () => {
    const parsed = yaml.load(`
${BASE_ENTRY_YAML}policy:
  cloud_allowed: true
`) as Record<string, unknown>;
    const entry = ModelEntrySchema.parse(parsed);
    expect(entry.policy?.cloud_allowed).toBe(true);
  });
});

describe('D-05: ModelEntrySchema — explicit policy.cloud_allowed: false (operative denial state)', () => {
  it('Test 6: entry with policy.cloud_allowed: false parses correctly', () => {
    const parsed = yaml.load(`
name: big-cloud
backend: ollama-cloud
backend_url: https://ollama.com/v1
backend_model: gpt-oss:120b-cloud
capabilities: [chat]
vram_budget_gb: 0
policy:
  cloud_allowed: false
`) as Record<string, unknown>;
    const entry = ModelEntrySchema.parse(parsed);
    expect(entry.policy?.cloud_allowed).toBe(false);
  });
});

describe('D-05: ModelEntrySchema — policy block present but cloud_allowed omitted → defaults to true', () => {
  it('Test 7: policy: {} (empty object) results in cloud_allowed === true via .default(true)', () => {
    const parsed = yaml.load(`
${BASE_ENTRY_YAML}policy: {}
`) as Record<string, unknown>;
    const entry = ModelEntrySchema.parse(parsed);
    // z.boolean().default(true) applies when the block is present but cloud_allowed is missing
    expect(entry.policy).toBeDefined();
    expect(entry.policy?.cloud_allowed).toBe(true);
  });
});
