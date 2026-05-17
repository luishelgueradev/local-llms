/**
 * Plan 08-02 (CLOUD-01 + D-A2) — RegistrySchema cloud-widening + boot
 * cross-check (assertCloudEnvIfConfigured) regression tests.
 *
 * Covers five behavioral cases (PLAN.md Task 1):
 *
 *   Test 1: YAML with `backend: ollama-cloud, vram_budget_gb: 0` parses cleanly.
 *   Test 2: Two cloud entries (vram_budget_gb=0 each) pass the VRAM envelope.
 *   Test 3: assertCloudEnvIfConfigured throws when registry has cloud entries
 *           AND env.OLLAMA_API_KEY is empty.
 *   Test 4: assertCloudEnvIfConfigured does NOT throw when both are set.
 *   Test 5: assertCloudEnvIfConfigured does NOT throw when registry has NO
 *           cloud entries even if OLLAMA_API_KEY is empty (local-only operator
 *           experience is zero-friction).
 *
 * The cross-check sits on the boot path in router/src/index.ts so it does not
 * require Fastify or a live registry watcher — direct invocation is enough.
 */
import { describe, expect, it } from 'vitest';
import { loadRegistryFromString, type Registry } from '../../src/config/registry.js';
import { assertCloudEnvIfConfigured } from '../../src/index.js';
import type { Env } from '../../src/config/env.js';

const SINGLE_CLOUD_YAML = `
models:
  - name: gpt-oss:120b-cloud
    backend: ollama-cloud
    backend_url: https://ollama.com/v1
    backend_model: gpt-oss:120b-cloud
    capabilities: [chat, tools]
    vram_budget_gb: 0
    concurrency: 4
    max_model_len: 65536
    profile: cloud
`;

const TWO_CLOUD_YAML = `
models:
  - name: gpt-oss:120b-cloud
    backend: ollama-cloud
    backend_url: https://ollama.com/v1
    backend_model: gpt-oss:120b-cloud
    capabilities: [chat, tools]
    vram_budget_gb: 0
    concurrency: 4

  - name: gpt-oss:20b-cloud
    backend: ollama-cloud
    backend_url: https://ollama.com/v1
    backend_model: gpt-oss:20b-cloud
    capabilities: [chat, tools]
    vram_budget_gb: 0
    concurrency: 4
`;

const LOCAL_ONLY_YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ROUTER_BEARER_TOKEN: 'test-bearer-token-1234',
    ROUTER_DATABASE_URL: 'postgres://router:pw@db/router',
    ROUTER_VALKEY_URL: 'redis://valkey:6379',
    ROUTER_VALKEY_PASSWORD: 'valkey-test-pw-12345',
    PORT: 3000,
    LOG_LEVEL: 'info',
    NODE_ENV: 'test',
    MODELS_YAML_PATH: '/app/models.yaml',
    ...overrides,
  } as Env;
}

describe('Plan 08-02 — RegistrySchema accepts backend: ollama-cloud', () => {
  it('Test 1: a single cloud entry with vram_budget_gb=0 parses cleanly', () => {
    let registry: Registry | null = null;
    expect(() => {
      registry = loadRegistryFromString(SINGLE_CLOUD_YAML);
    }).not.toThrow();
    expect(registry).not.toBeNull();
    expect(registry!.models.length).toBe(1);
    expect(registry!.models[0].backend).toBe('ollama-cloud');
    expect(registry!.models[0].vram_budget_gb).toBe(0);
  });

  it('Test 2: two cloud entries with vram_budget_gb=0 do not blow the VRAM envelope', () => {
    // VRAM_ENVELOPE_GB default is 16; cloud entries sum to 0+0=0 ≤ 16.
    let registry: Registry | null = null;
    expect(() => {
      registry = loadRegistryFromString(TWO_CLOUD_YAML);
    }).not.toThrow();
    expect(registry).not.toBeNull();
    expect(registry!.models.length).toBe(2);
    expect(registry!.models.every((m) => m.backend === 'ollama-cloud')).toBe(true);
  });
});

describe('Plan 08-02 — assertCloudEnvIfConfigured boot cross-check', () => {
  it('Test 3: throws when registry has cloud entries AND env.OLLAMA_API_KEY is empty', () => {
    const reg = loadRegistryFromString(SINGLE_CLOUD_YAML);
    const env = makeEnv({ OLLAMA_API_KEY: '' });
    expect(() => assertCloudEnvIfConfigured(reg, env)).toThrow(
      /models\.yaml declares.*ollama-cloud.*OLLAMA_API_KEY is empty/,
    );
  });

  it('Test 3b: also throws when OLLAMA_API_KEY is absent (undefined)', () => {
    const reg = loadRegistryFromString(SINGLE_CLOUD_YAML);
    const env = makeEnv(); // no OLLAMA_API_KEY at all
    expect(() => assertCloudEnvIfConfigured(reg, env)).toThrow(
      /models\.yaml declares.*ollama-cloud.*OLLAMA_API_KEY is empty/,
    );
  });

  it('Test 3c: also throws when OLLAMA_API_KEY is whitespace-only', () => {
    const reg = loadRegistryFromString(SINGLE_CLOUD_YAML);
    const env = makeEnv({ OLLAMA_API_KEY: '   ' });
    expect(() => assertCloudEnvIfConfigured(reg, env)).toThrow(
      /models\.yaml declares.*ollama-cloud.*OLLAMA_API_KEY is empty/,
    );
  });

  it('Test 4: does NOT throw when registry has cloud entries AND OLLAMA_API_KEY is non-empty', () => {
    const reg = loadRegistryFromString(SINGLE_CLOUD_YAML);
    const env = makeEnv({ OLLAMA_API_KEY: 'oss_test_key_abc' });
    expect(() => assertCloudEnvIfConfigured(reg, env)).not.toThrow();
  });

  it('Test 5: does NOT throw when registry has NO cloud entries even if OLLAMA_API_KEY is empty', () => {
    const reg = loadRegistryFromString(LOCAL_ONLY_YAML);
    const env = makeEnv({ OLLAMA_API_KEY: '' });
    expect(() => assertCloudEnvIfConfigured(reg, env)).not.toThrow();
  });

  it('Test 5b: also does not throw when registry has NO cloud entries and OLLAMA_API_KEY is absent', () => {
    const reg = loadRegistryFromString(LOCAL_ONLY_YAML);
    const env = makeEnv(); // no OLLAMA_API_KEY
    expect(() => assertCloudEnvIfConfigured(reg, env)).not.toThrow();
  });
});
