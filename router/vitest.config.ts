import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 5_000,
    hookTimeout: 5_000,
  },
});
