import { describe, it } from 'vitest';

describe('models.yaml registry — zod schema + load (ROUTE-02, SC4 registry half)', () => {
  it.todo('zod accepts the Phase 2 minimum (name, backend, backend_url, backend_model)');
  it.todo('zod accepts forward-compat fields (capabilities, vram_budget_gb, concurrency, max_model_len, profile) per D-B4');
  it.todo('zod rejects when models is empty');
  it.todo('zod rejects when name is missing');
  it.todo('zod rejects when backend is unknown (Phase 2 enum is just ["ollama"])');
  it.todo('zod rejects when backend_url is not a URL');
  it.todo('resolve(name) returns the model entry');
  it.todo('resolve(unknown) throws RegistryUnknownModelError');
});

describe('models.yaml registry — hot-reload (ROUTE-02, SC4 registry half) — implemented in plan 02-05', () => {
  it.todo('debounce coalesces double-write within 250ms');
  it.todo('invalid YAML keeps the previous registry in memory (D-C3 row)');
  it.todo('valid edit swaps the registry atomically');
});
