import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRegistryFromFile,
  loadRegistryFromString,
  makeRegistryStore,
  watchRegistry,
  RegistryUnknownModelError,
} from '../../src/config/registry.js';

const MIN_YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
`;

const FORWARD_COMPAT_YAML = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
    concurrency: 2
    max_model_len: 8192
    profile: ollama
`;

describe('models.yaml registry — zod schema (ROUTE-02 startup half)', () => {
  it('accepts the Phase 2 minimum', () => {
    expect(() => loadRegistryFromString(MIN_YAML)).not.toThrow();
  });

  it('accepts forward-compat fields (D-B4)', () => {
    const reg = loadRegistryFromString(FORWARD_COMPAT_YAML);
    expect(reg.models[0]?.capabilities).toEqual(['chat']);
    expect(reg.models[0]?.vram_budget_gb).toBe(4);
    expect(reg.models[0]?.concurrency).toBe(2);
    expect(reg.models[0]?.max_model_len).toBe(8192);
    expect(reg.models[0]?.profile).toBe('ollama');
  });

  it('rejects when models is empty', () => {
    expect(() => loadRegistryFromString(`models: []`)).toThrow(/at least one model/);
  });

  it('rejects when name is missing', () => {
    expect(() => loadRegistryFromString(`
models:
  - backend: ollama
    backend_url: http://x/v1
    backend_model: m
    `)).toThrow();
  });

  it('rejects when backend is unknown (Phase 2 enum is just ["ollama"])', () => {
    expect(() => loadRegistryFromString(`
models:
  - name: x
    backend: vllm
    backend_url: http://x/v1
    backend_model: m
    `)).toThrow();
  });

  it('rejects when backend_url is not a URL', () => {
    expect(() => loadRegistryFromString(`
models:
  - name: x
    backend: ollama
    backend_url: not-a-url
    backend_model: m
    `)).toThrow();
  });

  it('loadRegistryFromFile reads + validates a real file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-'));
    const path = join(dir, 'models.yaml');
    writeFileSync(path, MIN_YAML);
    const reg = loadRegistryFromFile(path);
    expect(reg.models).toHaveLength(1);
  });
});

describe('models.yaml registry — store (ROUTE-02 startup half)', () => {
  it('resolve(name) returns the model entry', () => {
    const reg = loadRegistryFromString(MIN_YAML);
    const store = makeRegistryStore(reg);
    const entry = store.resolve('llama3.2:3b-instruct-q4_K_M');
    expect(entry.backend).toBe('ollama');
  });

  it('resolve(unknown) throws RegistryUnknownModelError listing known names', () => {
    const reg = loadRegistryFromString(MIN_YAML);
    const store = makeRegistryStore(reg);
    expect(() => store.resolve('foo:1b')).toThrow(RegistryUnknownModelError);
    try {
      store.resolve('foo:1b');
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryUnknownModelError);
      if (!(err instanceof RegistryUnknownModelError)) return;
      expect(err.modelName).toBe('foo:1b');
      expect(err.knownNames).toEqual(['llama3.2:3b-instruct-q4_K_M']);
    }
  });

  it('_swap atomically replaces the snapshot (groundwork for plan 02-05 hot-reload)', () => {
    const reg = loadRegistryFromString(MIN_YAML);
    const store = makeRegistryStore(reg);
    const next: typeof reg = {
      models: [
        ...reg.models,
        { name: 'newmodel', backend: 'ollama', backend_url: 'http://ollama:11434/v1', backend_model: 'newmodel' },
      ],
    };
    store._swap(next);
    expect(store.resolve('newmodel').backend).toBe('ollama');
  });
});

describe('models.yaml registry — hot-reload (ROUTE-02 hot-reload half, SC4)', () => {
  async function writeAndWait(path: string, content: string, marginMs = 350): Promise<void> {
    writeFileSync(path, content);
    await new Promise((r) => setTimeout(r, marginMs));
  }

  it('valid edit swaps the registry atomically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-watch-'));
    const path = join(dir, 'models.yaml');
    writeFileSync(path, MIN_YAML);
    const store = makeRegistryStore(loadRegistryFromString(MIN_YAML));
    let reloaded: unknown = null;
    const w = watchRegistry(path, store, { debounceMs: 100, onReload: (n) => { reloaded = n; } });

    await writeAndWait(path, `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
  - name: newmodel
    backend: ollama
    backend_url: http://ollama:11434/v1
    backend_model: newmodel
    `, 250);

    expect(reloaded).toBeTruthy();
    expect(store.get().models).toHaveLength(2);
    expect(store.resolve('newmodel').backend).toBe('ollama');
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('debounce coalesces double-write within debounce window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-watch-'));
    const path = join(dir, 'models.yaml');
    writeFileSync(path, MIN_YAML);
    const store = makeRegistryStore(loadRegistryFromString(MIN_YAML));
    let reloadCount = 0;
    const w = watchRegistry(path, store, { debounceMs: 200, onReload: () => { reloadCount++; } });

    // Two rapid writes within the debounce window — should coalesce to 1 reload.
    writeFileSync(path, `${MIN_YAML}\n# comment one\n`);
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(path, `${MIN_YAML}\n# comment two\n`);
    await new Promise((r) => setTimeout(r, 350));

    expect(reloadCount).toBe(1);  // coalesced
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('invalid YAML keeps the previous registry in memory (D-C3 row)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-watch-'));
    const path = join(dir, 'models.yaml');
    writeFileSync(path, MIN_YAML);
    const store = makeRegistryStore(loadRegistryFromString(MIN_YAML));
    let errored = 0;
    let reloaded = 0;
    const w = watchRegistry(path, store, {
      debounceMs: 100,
      onReload: () => { reloaded++; },
      onError: () => { errored++; },
    });

    await writeAndWait(path, `
models:
  - backend: ollama
    backend_url: http://ollama:11434/v1
    # name missing — should fail zod
    `, 250);

    expect(errored).toBe(1);
    expect(reloaded).toBe(0);
    // Previous registry MUST still resolve correctly.
    expect(store.resolve('llama3.2:3b-instruct-q4_K_M').backend).toBe('ollama');
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('.stop() is idempotent and prevents further reloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-watch-'));
    const path = join(dir, 'models.yaml');
    writeFileSync(path, MIN_YAML);
    const store = makeRegistryStore(loadRegistryFromString(MIN_YAML));
    let reloaded = 0;
    const w = watchRegistry(path, store, { debounceMs: 50, onReload: () => { reloaded++; } });
    w.stop();
    w.stop();  // idempotent
    await writeAndWait(path, `${MIN_YAML}\n# after stop\n`, 200);
    expect(reloaded).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
