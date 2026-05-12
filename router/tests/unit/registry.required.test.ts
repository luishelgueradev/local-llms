import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { z } from 'zod/v4';
import {
  loadRegistryFromString,
  makeRegistryStore,
} from '../../src/config/registry.js';

// Zod v4 serializes ZodError.message as a JSON array of issues.
// This helper extracts structured issue info from a ZodError or JSON-encoded error.
function extractZodIssues(err: unknown): Array<{ path: unknown[]; message: string }> {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => ({ path: i.path, message: i.message }));
  }
  if (err instanceof Error) {
    try {
      const issues = JSON.parse(err.message) as Array<{ path: unknown[]; message: string }>;
      return issues;
    } catch {
      return [{ path: [], message: err.message }];
    }
  }
  return [{ path: [], message: String(err) }];
}

// Assert a function throws a ZodError whose first issue touches a field with the given name.
function expectZodIssueOnField(fn: () => unknown, fieldName: string): void {
  let thrown: unknown;
  try { fn(); } catch (err) { thrown = err; }
  if (!thrown) throw new Error(`Expected function to throw, but it did not.`);
  const issues = extractZodIssues(thrown);
  const paths = issues.map((i) => String(i.path.join('.')));
  const matches = paths.some((p) => p.includes(fieldName));
  if (!matches) {
    throw new Error(`Expected a ZodError issue on field "${fieldName}" but got paths: [${paths.join(', ')}]`);
  }
}

// Minimal valid YAML for Phase 3 (capabilities + vram_budget_gb are required)
const MIN_YAML_P3 = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

const TWO_ENTRY_YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4

  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5-7b-instruct-q4_K_M
    capabilities: [chat, tools]
    vram_budget_gb: 6
`;

const BACKENDS_YAML = `
backends:
  ollama:
    base_url: http://ollama:11434/v1
    concurrency: 4
    queue_max_wait_ms: 60000

models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

const BACKENDS_DEFAULTS_YAML = `
backends:
  ollama: {}

models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

describe('registry schema — required fields + LocalBackendEnum (Phase 3 hardening)', () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it('parses a minimal valid registry with all required fields', () => {
    const reg = loadRegistryFromString(MIN_YAML_P3);
    expect(reg.models[0]?.backend).toBe('ollama');
    expect(reg.models[0]?.capabilities).toEqual(['chat']);
    expect(reg.models[0]?.vram_budget_gb).toBe(4);
  });

  it('parses a registry with backend: llamacpp (widened enum — was rejected in Phase 2)', () => {
    const reg = loadRegistryFromString(`
models:
  - name: qwen2.5-7b-instruct-q4km
    backend: llamacpp
    backend_url: http://llamacpp:8080/v1
    backend_model: qwen2.5-7b-instruct-q4_K_M
    capabilities: [chat, tools]
    vram_budget_gb: 6
    `);
    expect(reg.models[0]?.backend).toBe('llamacpp');
  });

  it('parses a registry with both ollama AND llamacpp entries', () => {
    const reg = loadRegistryFromString(TWO_ENTRY_YAML);
    expect(reg.models).toHaveLength(2);
    expect(reg.models[0]?.backend).toBe('ollama');
    expect(reg.models[1]?.backend).toBe('llamacpp');
  });

  it('parses a registry with optional top-level backends: section', () => {
    const reg = loadRegistryFromString(BACKENDS_YAML);
    expect(reg.backends?.['ollama']?.concurrency).toBe(4);
    expect(reg.backends?.['ollama']?.queue_max_wait_ms).toBe(60000);
  });

  it('parses a registry WITHOUT a backends: section (the section is optional)', () => {
    expect(() => loadRegistryFromString(MIN_YAML_P3)).not.toThrow();
    const reg = loadRegistryFromString(MIN_YAML_P3);
    expect(reg.backends).toBeUndefined();
  });

  it('parses backends section with base_url + concurrency + queue_max_wait_ms', () => {
    const reg = loadRegistryFromString(BACKENDS_YAML);
    expect(reg.backends?.['ollama']?.base_url).toBe('http://ollama:11434/v1');
    expect(reg.backends?.['ollama']?.concurrency).toBe(4);
    expect(reg.backends?.['ollama']?.queue_max_wait_ms).toBe(60000);
  });

  it('parses backends: { ollama: {} } and defaults concurrency to 2, queue_max_wait_ms to 30000', () => {
    const reg = loadRegistryFromString(BACKENDS_DEFAULTS_YAML);
    expect(reg.backends?.['ollama']?.concurrency).toBe(2);
    expect(reg.backends?.['ollama']?.queue_max_wait_ms).toBe(30_000);
  });

  // ── Negative path ───────────────────────────────────────────────────────────

  it('rejects a registry where a model omits capabilities (issue path includes "capabilities")', () => {
    expectZodIssueOnField(() => loadRegistryFromString(`
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    vram_budget_gb: 4
    `), 'capabilities');
  });

  it('rejects a registry where capabilities is an empty array', () => {
    expect(() => loadRegistryFromString(`
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: []
    vram_budget_gb: 4
    `)).toThrow();
  });

  it('rejects a registry where a model omits vram_budget_gb (issue path includes "vram_budget_gb")', () => {
    expectZodIssueOnField(() => loadRegistryFromString(`
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    `), 'vram_budget_gb');
  });

  it('rejects a registry where backend is unknown', () => {
    expect(() => loadRegistryFromString(`
models:
  - name: x
    backend: unknown
    backend_url: http://x/v1
    backend_model: m
    capabilities: [chat]
    vram_budget_gb: 4
    `)).toThrow();
  });

  it('rejects backend: ollama-cloud in Phase 3 (not in LocalBackendEnum until Phase 8)', () => {
    expect(() => loadRegistryFromString(`
models:
  - name: x
    backend: ollama-cloud
    backend_url: http://x/v1
    backend_model: m
    capabilities: [chat]
    vram_budget_gb: 4
    `)).toThrow();
  });
});

describe('RegistryStore.getCreatedAtSec — snapshot-stable timestamp (D-C3)', () => {
  it('makeRegistryStore sets createdAtSec to approximately now at construction time', () => {
    const reg = loadRegistryFromString(MIN_YAML_P3);
    const nowSec = Math.floor(Date.now() / 1000);
    const store = makeRegistryStore(reg);
    const created = store.getCreatedAtSec();
    expect(created).toBeTypeOf('number');
    expect(created).toBeGreaterThanOrEqual(nowSec - 1);
    expect(created).toBeLessThanOrEqual(nowSec + 1);
  });

  it('two consecutive reads of getCreatedAtSec() on the same store without _swap return identical values', () => {
    const reg = loadRegistryFromString(MIN_YAML_P3);
    const store = makeRegistryStore(reg);
    const first = store.getCreatedAtSec();
    const second = store.getCreatedAtSec();
    expect(first).toBe(second);
  });

  it('_swap advances createdAtSec after at least 1 second has passed', async () => {
    const reg = loadRegistryFromString(MIN_YAML_P3);
    const reg2 = loadRegistryFromString(TWO_ENTRY_YAML);
    const store = makeRegistryStore(reg);
    const before = store.getCreatedAtSec();

    await new Promise((r) => setTimeout(r, 1100));
    store._swap(reg2);

    const after = store.getCreatedAtSec();
    expect(after).toBeGreaterThan(before);
  }, 10_000);
});
