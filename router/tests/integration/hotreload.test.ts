import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { server } from '../setup.js';
import { ollamaNonStreamHandler } from '../msw/handlers.js';
import { buildApp } from '../../src/app.js';
import { makeFakeBufferedWriter, makeFakeMetrics } from '../fakes.js';
import {
  loadRegistryFromFile,
  makeRegistryStore,
  watchRegistry,
  type RegistryWatcher,
} from '../../src/config/registry.js';
import { OllamaOpenAIAdapter } from '../../src/backends/ollama-openai.js';
import type { ModelEntry } from '../../src/config/registry.js';

const TOKEN = 'local-llms_t1t2t3t4t5t6t7t8t9t0aabbccddeeff';
// Phase 3: capabilities + vram_budget_gb are required in the schema.
const INITIAL = `
models:
  - name: llama3.2:3b-instruct-q4_K_M
    backend: ollama
    backend_url: http://upstream-mock:11434/v1
    backend_model: llama3.2:3b-instruct-q4_K_M
    capabilities: [chat]
    vram_budget_gb: 4
`;

let dir: string;
let path: string;
let app: FastifyInstance;
let watcher: RegistryWatcher;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'router-hotreload-it-'));
  path = join(dir, 'models.yaml');
  writeFileSync(path, INITIAL);
  const registry = makeRegistryStore(loadRegistryFromFile(path));
  app = await buildApp({
    registry,
    bearerToken: TOKEN,
    loggerOpts: false as never,
    makeAdapter: (entry: ModelEntry) => new OllamaOpenAIAdapter(entry.backend_url),
    bufferedWriter: makeFakeBufferedWriter(),
    metrics: makeFakeMetrics(),
  });
  watcher = watchRegistry(path, registry, { debounceMs: 100 });
});
afterEach(async () => {
  watcher.stop();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('models.yaml hot-reload (SC4 hot-reload half, ROUTE-02)', () => {
  it('writing a new model to models.yaml is resolvable after the debounce window (no router restart)', async () => {
    const res1 = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'qwen-new', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res1.statusCode).toBe(404);

    writeFileSync(path, `${INITIAL}
  - name: qwen-new
    backend: ollama
    backend_url: http://upstream-mock:11434/v1
    backend_model: qwen-new
    capabilities: [chat]
    vram_budget_gb: 4
`);
    await new Promise((r) => setTimeout(r, 250));

    server.use(ollamaNonStreamHandler({
      url: 'http://upstream-mock:11434/v1/chat/completions',
      model: 'qwen-new',
      content: 'hi from qwen',
    }));
    const res2 = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'qwen-new', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().choices[0].message.content).toBe('hi from qwen');
  }, 5_000);

  it('an invalid YAML write keeps the previous registry resolvable (D-C3)', async () => {
    writeFileSync(path, 'this is not valid models yaml { [');
    await new Promise((r) => setTimeout(r, 250));

    server.use(ollamaNonStreamHandler({
      url: 'http://upstream-mock:11434/v1/chat/completions',
      model: 'llama3.2:3b-instruct-q4_K_M',
      content: 'still working',
    }));
    const res = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { model: 'llama3.2:3b-instruct-q4_K_M', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('canary for RESEARCH Assumption A4: fs.watch fires on the bind-mounted file (in-process equivalent)', async () => {
    let reloads = 0;
    watcher.stop();
    const r2 = makeRegistryStore(loadRegistryFromFile(path));
    const w2 = watchRegistry(path, r2, { debounceMs: 80, onReload: () => { reloads++; } });
    writeFileSync(path, `${INITIAL}\n# canary trigger\n`);
    await new Promise((r) => setTimeout(r, 200));
    expect(reloads).toBeGreaterThanOrEqual(1);
    w2.stop();
  });
});
