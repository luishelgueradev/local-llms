import { describe, it } from 'vitest';

describe('models.yaml hot-reload via fs.watch (SC4 hot-reload half, ROUTE-02) — implemented in plan 02-05', () => {
  it.todo('writing models.yaml triggers reload within 500ms (250ms debounce + margin)');
  it.todo('a second model added to models.yaml is resolvable after reload (no router restart)');
  it.todo('an invalid YAML write keeps the previous registry in memory (D-C3 row)');
  it.todo('canary for RESEARCH Assumption A4 (fs.watch on WSL2 bind mount)');
});
