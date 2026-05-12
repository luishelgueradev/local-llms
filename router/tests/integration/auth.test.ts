import { describe, it } from 'vitest';

describe('bearer auth + skip-list (SC4 auth half, ROUTE-03, ROUTE-04) — implemented in plan 02-02', () => {
  it.todo('GET /healthz returns 200 with NO Authorization header');
  it.todo('GET /healthz returns 200 even with a wrong token (skip-list does not validate)');
  it.todo('POST /v1/chat/completions returns 401 with NO Authorization header');
  it.todo('POST /v1/chat/completions returns 401 with malformed Authorization');
  it.todo('POST /v1/chat/completions returns 401 with wrong bearer');
  it.todo('POST /v1/chat/completions returns NOT 401 (e.g. 400/500/200) with correct bearer');
});
