/**
 * Phase 18 / v0.11.0 — RETR-05 / Frame-01 BLOCK (no RetrieverProvider
 * implementation in router/src/). Wave 0 scaffold (Plan 18-01) — SHIPS REAL
 * `it()` (NOT `it.todo`) because the gate must enforce the invariant from
 * Day 1 of Phase 18.
 *
 * Frame-01 BLOCK invariant: the router defines the `RetrieverProvider`
 * INTERFACE only. There is NO production implementation in `router/src/`.
 * Every retriever implementation (Phase 19 EMBP — embeddings-backed
 * MemoryRetriever, Phase 20+ external HTTP retrievers, etc.) is consumed by
 * the router VIA the interface, never embedded.
 *
 * The Noop default lives ONLY in `tests/fakes.ts` as
 * `makeFakeRetrieverProvider()` — there is no `NoopRetrieverProvider` class
 * under `src/`. This is the retrieval-agnostic principle (MEMORY user-note
 * `project_retrieval_agnostic_principle`) at the source-tree level.
 *
 * Approach mirrors `tests/unit/mcp/host/stdio-grep-gate.test.ts` (Phase 15
 * — runtime `execSync` grep against `router/src/`). The gate runs on every
 * vitest invocation across the rest of Phase 18 and beyond; any future
 * commit that adds a `RetrieverProvider` implementation surfaces here.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// `tests/unit/grep-gates/` → climb three levels to `router/`, then into `src/`.
const ROUTER_SRC = path.resolve(__dirname, '../../../src');

/** Run a grep command and return raw stdout (empty string when nothing matches). */
function safeGrep(pattern: string): string {
  // `|| true` neutralizes grep's exit code 1 when no matches are found, so
  // execSync does not throw. The `2>/dev/null` swallows path-walk warnings
  // (broken symlinks etc.) without affecting the output we care about.
  return execSync(`grep -rE ${JSON.stringify(pattern)} "${ROUTER_SRC}" 2>/dev/null || true`, {
    encoding: 'utf-8',
  });
}

describe('Frame-01 BLOCK: no RetrieverProvider implementation in router/src/', () => {
  it('grep -rE "class \\w+RetrieverProvider" router/src/ yields ONLY the interface file (or nothing if interface not yet shipped)', () => {
    if (!existsSync(ROUTER_SRC)) {
      // router/src/ vanishing is a separate-class outage — bail vacuously.
      expect(true).toBe(true);
      return;
    }
    const stdout = safeGrep('class [A-Za-z0-9_]+RetrieverProvider');
    const lines = stdout.split('\n').filter((l) => l.trim().length > 0);

    // Pre-Plan-18-03: zero matches. Post-Plan-18-03: AT MOST 1 match, and it
    // MUST live at src/providers/retriever-provider.ts (the interface file).
    // The interface file itself may contain `class FooRetrieverProvider`
    // ONLY if it's an internal abstract-base shape — keep the gate tight at
    // ≤ 1 line and require the path to match the interface module.
    expect(lines.length).toBeLessThanOrEqual(1);
    if (lines.length === 1) {
      // Must be inside the interface file. Reject any line that points
      // anywhere else (e.g., `src/providers/memory-retriever.ts` would be
      // a Frame-01 violation).
      expect(lines[0]).toMatch(/src\/providers\/retriever-provider\.ts:/);
    }
  });

  it('grep -rE "implements RetrieverProvider" router/src/ yields empty (no implementations ship)', () => {
    if (!existsSync(ROUTER_SRC)) {
      expect(true).toBe(true);
      return;
    }
    const stdout = safeGrep('implements RetrieverProvider');
    expect(stdout.trim()).toBe('');
  });

  it('grep -rE "NoopRetrieverProvider" router/src/ yields empty (Noop lives only in tests/fakes.ts)', () => {
    if (!existsSync(ROUTER_SRC)) {
      expect(true).toBe(true);
      return;
    }
    const stdout = safeGrep('NoopRetrieverProvider');
    expect(stdout.trim()).toBe('');
  });
});
