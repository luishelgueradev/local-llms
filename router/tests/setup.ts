import { afterAll, afterEach, beforeAll } from 'vitest';
import { setupServer } from 'msw/node';
import { handlers } from './msw/handlers.js';

// Single shared msw server for the whole suite. Tests can call
// server.use(...) inside individual it() blocks to register one-off
// handlers — these are reset per-test by the afterEach below.
export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
