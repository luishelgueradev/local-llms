/**
 * Phase 15 Plan 12 (v0.11.0 — MCPS-06 / P1-01) — Stdio transport grep gate.
 *
 * Invariant under test:
 *   The MCP SDK ships TWO transport implementations: StreamableHTTPServerTransport
 *   (HTTP/SSE, the one we use) and StdioServerTransport (the local-process-pipes
 *   variant). The latter is appropriate for desktop/IDE host scenarios — it is
 *   NEVER appropriate for a hosted HTTP router. Importing it accidentally would:
 *     1. Hijack stdin/stdout on the router process (P1-01 — corrupts pino logs
 *        and trips Docker's stdout collection).
 *     2. Expose the McpServer over an out-of-band channel that bypasses the
 *        bearer-token authorization enforced on /mcp.
 *
 *   This test scans `router/src/` for any occurrence of the literal string
 *   `StdioServerTransport`. If grep returns ANY matches, the test fails and
 *   the offending import surfaces in CI before the PR can land.
 *
 * Why a runtime grep instead of a static lint rule:
 *   - eslint rules require maintenance + the existing flat-config setup is not
 *     extended with custom rules.
 *   - A vitest test runs unconditionally on every test invocation (CI + local
 *     pre-push), guarantees pass/fail visibility in the same report as the
 *     rest of the suite, and is impossible to forget.
 *   - The test deliberately matches the SDK class name. If a future SDK version
 *     renames it, the upgrade PR will be the natural place to update both the
 *     import sites (none expected) and this gate.
 *
 * Out-of-scope skips:
 *   - This file itself necessarily contains the literal `StdioServerTransport`
 *     in the grep command. The test scans `src/` only — NOT the tests/ tree —
 *     so the test file's own contents are excluded.
 *
 * Mitigates: P1-01 (accidental stdio transport introduction). Referenced from
 * `router/src/mcp/host/plugin.ts` header comments.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to `router/src/` resolved relative to this test file.
 * `__dirname` is `router/tests/unit/mcp/host/`, so we go four levels up
 * to reach the router workspace root, then into `src/`.
 */
const SRC_DIR = resolve(__dirname, '../../../../src');

describe('Phase 15 Plan 12 — MCPS-06 / P1-01 stdio grep gate', () => {
  it('router/src/ contains zero occurrences of StdioServerTransport', () => {
    // grep returns exit code 1 when nothing is matched, which would cause
    // execSync to throw. The `|| true` suffix neutralizes the exit code so
    // we can inspect the actual captured output. -r recurses, -n adds line
    // numbers (useful in the failure message), no -l so we get exact matches.
    const output = execSync(`grep -rn 'StdioServerTransport' . || true`, {
      cwd: SRC_DIR,
      encoding: 'utf8',
    });

    if (output.trim() !== '') {
      // Build a helpful failure message that points the operator at the
      // exact offending lines. The expected fix is to NOT import the stdio
      // transport — see plugin.ts header for the architectural rationale.
      throw new Error(
        `MCPS-06 violation: 'StdioServerTransport' was found in router/src/. ` +
          `The MCP host MUST use StreamableHTTPServerTransport exclusively. ` +
          `Offending lines:\n${output}`,
      );
    }

    expect(output.trim()).toBe('');
  });

  it('router/src/ also contains zero StdioClientTransport (defense in depth)', () => {
    // The SDK exports BOTH a server-side stdio transport and a client-side
    // stdio transport. Neither has any legitimate use inside the router.
    // Scanning for both names ensures a future contributor cannot accidentally
    // import the client variant either.
    const output = execSync(`grep -rn 'StdioClientTransport' . || true`, {
      cwd: SRC_DIR,
      encoding: 'utf8',
    });

    if (output.trim() !== '') {
      throw new Error(
        `MCPS-06 (defense-in-depth) violation: 'StdioClientTransport' was found in router/src/. ` +
          `The router does not act as an MCP client; remove the import. ` +
          `Offending lines:\n${output}`,
      );
    }

    expect(output.trim()).toBe('');
  });
});
