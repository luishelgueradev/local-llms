/**
 * Pitfall-9 grep gate — Phase 14 / v0.11.0 (D-20, T-14-05).
 *
 * Asserts that there is EXACTLY ONE `req.log = ` assignment in the production
 * source tree under router/src/ (excluding __tests__ directories), and that
 * this line is in middleware/agentId.ts.
 *
 * Why this matters: pino's .child() API creates a new child logger bound to the
 * current bindings. If a second `req.log = ` assignment fires after
 * agentIdPreHandler, those bindings are LOST — downstream log lines would be
 * missing tenant_id/project_id/workload_class/agent_id (information disclosure
 * in observability context: T-14-05).
 *
 * Analog: RESEARCH.md §"The Pitfall-9 Grep Gate" (verbatim vitest module).
 *
 * Note on CWD: vitest in this repo runs from `router/` (package.json "test":
 * "vitest run"). The grep target therefore uses `./src/` (relative to router/).
 */
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Pitfall 9 invariant — single req.log assignment (D-20, T-14-05)', () => {
  it('production source contains exactly one req.log = assignment in middleware/agentId.ts', () => {
    // Run from CWD = router/ (vitest working directory).
    // grep returns exit code 1 when no matches — `|| true` prevents execSync from throwing.
    const out = execSync(
      "grep -rn 'req\\.log = ' ./src/ || true",
      { encoding: 'utf8', cwd: process.cwd() },
    ).trim();

    const lines = out
      .split('\n')
      .filter(Boolean)
      // Exclude __tests__ directories — they may contain synthetic injections
      // for future regression tests without violating the production invariant.
      .filter((line) => !line.includes('__tests__'));

    // Exactly one production-source line must match.
    expect(lines).toHaveLength(1);

    // The surviving line must be in agentId.ts (the single sanctioned site).
    expect(lines[0]).toMatch(/middleware\/agentId\.ts/);
  });
});
