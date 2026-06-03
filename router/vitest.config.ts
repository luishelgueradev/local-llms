import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.ts',
      'src/**/__tests__/**/*.test.ts',
      'scripts/__tests__/**/*.test.ts',
    ],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Phase 21 / HYG-04: raised from 5_000 to 10_000. Under system load
    // (Ollama hot + Whisper resident + concurrent CLI scripts) the full sweep
    // intermittently flaked 2–3 tests on the 5s ceiling — they pass cleanly in
    // isolation, so the failure was wall-clock contention, not real regression.
    // 10s doubles the head-room without slowing the green-path sweep (vitest
    // only blocks until the assertion resolves, not until the timeout fires).
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
