import { describe, it } from 'vitest';

describe('OpenAI error envelope (D-C1, D-C2, D-C3)', () => {
  it.todo('ZodError -> { type: invalid_request_error, code: invalid_request, status: 400 }');
  it.todo('RegistryUnknownModelError -> { type: not_found_error, code: model_not_found, status: 404 }');
  it.todo('APIConnectionError -> { type: upstream_error, code: econnrefused, status: 502 }');
  it.todo('APIError 5xx -> { type: upstream_error, code: upstream_5xx, status: 502 }');
  it.todo('APITimeoutError -> { type: timeout_error, code: upstream_timeout, status: 504 }');
  it.todo('APIUserAbortError -> NO envelope emitted (client gone)');
  it.todo('BearerAuthError -> { type: authentication_error, code: unauthorized, status: 401 }');
  it.todo('default unknown error -> { type: internal_error, code: internal_error, status: 500 }');
  it.todo('mid-stream frame is byte-exact: "event: error\\ndata: {...}\\n\\ndata: [DONE]\\n\\n" (D-C2)');
});
