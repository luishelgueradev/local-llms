/**
 * Phase 18 / v0.11.0 — P7-01 BLOCK (/v1/embeddings route untouched).
 * Wave 0 scaffold (Plan 18-01) — SHIPS REAL `it()` (NOT `it.todo`) because
 * the gate must enforce the invariant from Day 1 of Phase 18.
 *
 * Invariant: the `EMBP` (embeddings provider) requirements are scoped to
 * Phase 19. Phase 18 must NOT modify `router/src/routes/v1/embeddings.ts`.
 * Any change to that file during this phase is a Frame-01 / EMBP scope
 * leak and must be surfaced before the offending plan commit lands.
 *
 * Approach: snapshot the SHA-256 hash of `embeddings.ts` at the Wave-0
 * baseline (computed when Plan 18-01 was written) into
 * `embeddings-untouched-baseline.json`. Every vitest run across Plans
 * 18-02..18-08 recomputes the hash and compares — any drift fails the gate.
 *
 * If a future plan MUST modify the embeddings route (unlikely; would
 * require a phase-replan), the baseline file is updated atomically with
 * that plan's commit, and the modification is documented in the plan's
 * SUMMARY.md "Deviations" section.
 *
 * The two grep gates at the bottom defend the converse: no embedding logic
 * leaks into the MCP-client or hooks subsystems (those subsystems own
 * retrieval *invocation*, not the embedding pipeline itself).
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// `tests/unit/grep-gates/` → climb three levels to `router/`.
const ROUTER_ROOT = path.resolve(__dirname, '../../..');
const EMBEDDINGS_PATH = path.join(ROUTER_ROOT, 'src/routes/v1/embeddings.ts');
const BASELINE_PATH = path.join(__dirname, 'embeddings-untouched-baseline.json');
const MCP_CLIENT_DIR = path.join(ROUTER_ROOT, 'src/mcp/client');
const HOOKS_DIR = path.join(ROUTER_ROOT, 'src/hooks');

interface Baseline {
  file: string;
  sha256: string;
  captured_at: string;
  phase: string;
  plan: string;
  rationale: string;
}

describe('P7-01 BLOCK: /v1/embeddings route untouched by Phase 18', () => {
  it('git diff baseline: router/src/routes/v1/embeddings.ts SHA-256 matches embeddings-untouched-baseline.json', () => {
    expect(existsSync(EMBEDDINGS_PATH)).toBe(true);
    expect(existsSync(BASELINE_PATH)).toBe(true);
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Baseline;
    const actual = createHash('sha256')
      .update(readFileSync(EMBEDDINGS_PATH))
      .digest('hex');
    if (actual !== baseline.sha256) {
      throw new Error(
        `P7-01 BLOCK violation: router/src/routes/v1/embeddings.ts changed during Phase 18.\n` +
          `  baseline (${baseline.captured_at}, ${baseline.phase}/${baseline.plan}): ${baseline.sha256}\n` +
          `  actual:                                              ${actual}\n` +
          `If this change is intentional, update embeddings-untouched-baseline.json in the same commit ` +
          `AND document the modification in the plan's SUMMARY.md "Deviations" section.`,
      );
    }
    expect(actual).toBe(baseline.sha256);
  });

  it('grep -rE "embeddings" router/src/mcp/client/ yields empty (no embedding logic in MCP client subsystem)', () => {
    if (!existsSync(MCP_CLIENT_DIR)) {
      // Directory not yet present — gate is vacuously satisfied.
      expect(true).toBe(true);
      return;
    }
    const stdout = execSync(`grep -rE "embeddings" "${MCP_CLIENT_DIR}" 2>/dev/null || true`, {
      encoding: 'utf-8',
    });
    expect(stdout.trim()).toBe('');
  });

  it('grep -rE "embeddings" router/src/hooks/ yields empty (no embedding logic in hooks subsystem)', () => {
    if (!existsSync(HOOKS_DIR)) {
      // Directory not yet present — gate is vacuously satisfied.
      expect(true).toBe(true);
      return;
    }
    const stdout = execSync(`grep -rE "embeddings" "${HOOKS_DIR}" 2>/dev/null || true`, {
      encoding: 'utf-8',
    });
    expect(stdout.trim()).toBe('');
  });
});
