import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { z } from 'zod/v4';
import { loadRegistryFromString } from '../../src/config/registry.js';

// Zod v4 serializes ZodError.message as a JSON array of issues.
// This helper extracts the human-readable message text from the first issue.
function extractZodMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => i.message).join('; ');
  }
  if (err instanceof Error) {
    // Fallback: attempt to parse JSON from message (Zod v4 format)
    try {
      const issues = JSON.parse(err.message) as Array<{ message: string }>;
      return issues.map((i) => i.message).join('; ');
    } catch {
      return err.message;
    }
  }
  return String(err);
}

// Helper: expect a function to throw with a message matching a pattern (Zod v4 safe)
function expectZodThrow(fn: () => unknown, pattern: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  if (!thrown) {
    throw new Error(`Expected function to throw, but it did not.`);
  }
  const msg = extractZodMessage(thrown);
  if (!pattern.test(msg)) {
    throw new Error(`Expected error message matching ${pattern} but got:\n${msg}`);
  }
}

// Helper: build a model YAML entry string
function modelEntry(name: string, backend: string, vram: number): string {
  return `
  - name: ${name}
    backend: ${backend}
    backend_url: http://${backend}:8080/v1
    backend_model: ${name}
    capabilities: [chat]
    vram_budget_gb: ${vram}`;
}

describe('VRAM envelope enforcement (BCKND-04, superRefine)', () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it('accepts: one ollama (4 GB) + one llamacpp (6 GB) — both under 16 GB envelope', () => {
    expect(() => loadRegistryFromString(`
models:${modelEntry('llama3.2', 'ollama', 4)}${modelEntry('qwen2.5', 'llamacpp', 6)}
    `)).not.toThrow();
  });

  it('accepts: two ollama entries totaling exactly 16 GB (boundary — strict > not >=)', () => {
    expect(() => loadRegistryFromString(`
models:${modelEntry('model-a', 'ollama', 8)}${modelEntry('model-b', 'ollama', 8)}
    `)).not.toThrow();
  });

  // ── Sad path ────────────────────────────────────────────────────────────────

  it('rejects: two ollama entries summing to 18 GB (10 + 8) > 16 GB envelope', () => {
    expectZodThrow(
      () => loadRegistryFromString(`
models:${modelEntry('model-a', 'ollama', 10)}${modelEntry('model-b', 'ollama', 8)}
      `),
      /backend "ollama" declared models sum to 18 GB, exceeds VRAM_ENVELOPE_GB=16/,
    );
  });

  it('rejects: single llamacpp entry with vram_budget_gb: 20 > 16 GB', () => {
    expectZodThrow(
      () => loadRegistryFromString(`
models:${modelEntry('big-model', 'llamacpp', 20)}
      `),
      /backend "llamacpp".*exceeds VRAM_ENVELOPE_GB=16/,
    );
  });

  it('rejects: two backends each individually over the 16 GB limit', () => {
    // Two backends each over limit — both should trigger the superRefine
    expectZodThrow(
      () => loadRegistryFromString(`
models:${modelEntry('model-a', 'ollama', 10)}${modelEntry('model-b', 'ollama', 8)}${modelEntry('model-c', 'llamacpp', 20)}
      `),
      /exceeds VRAM_ENVELOPE_GB=16/,
    );
  });

  // ── Env-driven envelope ─────────────────────────────────────────────────────

  describe('env-driven VRAM_ENVELOPE_GB', () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env['VRAM_ENVELOPE_GB'];
      process.env['VRAM_ENVELOPE_GB'] = '8';
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env['VRAM_ENVELOPE_GB'];
      } else {
        process.env['VRAM_ENVELOPE_GB'] = originalEnv;
      }
    });

    it('with VRAM_ENVELOPE_GB=8, two llamacpp entries summing to 10 GB throws citing VRAM_ENVELOPE_GB=8', () => {
      expectZodThrow(
        () => loadRegistryFromString(`
models:${modelEntry('model-a', 'llamacpp', 5)}${modelEntry('model-b', 'llamacpp', 5)}
        `),
        /exceeds VRAM_ENVELOPE_GB=8/,
      );
    });
  });
});
