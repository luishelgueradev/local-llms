// router/scripts/check-prometheus-cardinality.ts
//
// Phase 14 (v0.11.0 — POL-06 / D-25, D-26): static-grep guard against
// high-cardinality Prometheus labels. Scans src/metrics/registry.ts for
// labelNames arrays and asserts no array element ends in '_id'.
//
// Phase 19 (v0.11.0 — OBSV-02 / D-13, D-14): dual-mode extension.
// Added: checkCardinalityLive(exposition) — hand-rolled regex parser over
// Prometheus text exposition format (line-based; per spec one series per line).
// Added: CLI --live <url-or-dash> dispatch (--source <path> or no-arg = static mode).
//
// Catches: tenant_id, project_id, agent_id, session_id, request_id, and any
// future *_id label addition. This is the static-source case (the only case
// Phase 14 can introduce); live /metrics parse is deferred to Phase 19 (D-27).
//
// Scope limitation (T-14-08-01 / RESEARCH.md Assumption A6): Only scans
// src/metrics/registry.ts. A future inline metric declared outside registry.ts
// would slip past this guard. Phase 19's OBSV-02 covers the live-parse case.
//
// Exported as a function so vitest can call it directly (primary integration).
// The CLI entry point prints failures to stderr and exits non-zero — secondary
// integration for local dev / git hooks.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CardinalityViolation {
  /** Pretty source location, e.g. "registry.ts:36" or "/metrics:12" */
  location: string;
  /** The full labelNames array literal text, e.g. "['protocol', 'tenant_id']" */
  arrayText: string;
  /** The offending label, e.g. "tenant_id" */
  forbiddenLabel: string;
  /** The metric name nearest the violation, for the failure message */
  metricNameHint: string;
}

/** Regex matches `labelNames: ['a', 'b', 'c'] as const` style declarations. */
const LABEL_NAMES_RE = /labelNames\s*:\s*\[([^\]]*)\]/g;

/** Regex matches `name: 'router_xxx_total'` so we can hint the metric in the error. */
const METRIC_NAME_RE = /name\s*:\s*['"]([a-z0-9_]+)['"]/g;

/**
 * Labels matching this pattern are forbidden in Prometheus metric declarations.
 * Catches: tenant_id, project_id, agent_id, session_id — any label ending in _id
 * See CONTEXT.md D-25 / Pitfall P8-03 for the rationale.
 */
const FORBIDDEN_LABEL_RE = /_id$/; // Forbidden: any label ending in _id

/**
 * Scans the source text of a metrics file and returns an array of cardinality
 * violations. An empty array means the source is clean.
 *
 * @param source - The raw TypeScript source text to scan (typically registry.ts)
 * @returns Array of violations; empty if no forbidden labels found
 */
export function checkCardinality(source: string): CardinalityViolation[] {
  const violations: CardinalityViolation[] = [];

  // Build a sorted list of (offset, metricName) so we can look up the
  // nearest preceding metric name for each labelNames hit.
  const metricNames: Array<{ offset: number; name: string }> = [];
  for (const m of source.matchAll(METRIC_NAME_RE)) {
    if (m[1]?.startsWith('router_')) {
      metricNames.push({ offset: m.index ?? 0, name: m[1] });
    }
  }

  for (const m of source.matchAll(LABEL_NAMES_RE)) {
    const arrayText = m[1] ?? '';
    const labels = [...arrayText.matchAll(/['"]([a-z0-9_]+)['"]/g)].map((x) => x[1] ?? '');
    const offset = m.index ?? 0;
    const lineNo = source.slice(0, offset).split('\n').length;
    // Find the nearest preceding metric name by offset.
    const nearest = [...metricNames].reverse().find((mn) => mn.offset < offset);
    for (const label of labels) {
      if (FORBIDDEN_LABEL_RE.test(label)) {
        violations.push({
          location: `registry.ts:${lineNo}`,
          arrayText: `[${arrayText.trim()}]`,
          forbiddenLabel: label,
          metricNameHint: nearest?.name ?? 'unknown',
        });
      }
    }
  }

  return violations;
}

/**
 * Phase 19 (v0.11.0 — OBSV-02 / D-14): live Prometheus exposition format parser.
 *
 * Parses a Prometheus text exposition string (as returned by GET /metrics) and
 * returns cardinality violations — label names ending in _id.
 *
 * Parser handles (per RESEARCH §2 and Prometheus exposition format spec):
 *   - Lines starting with '#' (HELP / TYPE / comments) — SKIP
 *   - Blank lines — SKIP
 *   - Unlabeled metrics: `metric_name 42.0` — SKIP (no label brace found)
 *   - Empty-label-set: `metric_name{} 42.0` — SKIP (no labels to inspect)
 *   - Labeled metrics: `metric_name{l1="v1",l2="v2"} 42.0` — PARSE
 *   - Trailing timestamp: `metric_name{l1="v1"} 42.0 1234567890` — PARSE
 *   - Histogram buckets: `metric_bucket{le="100",route="/api"} 42` — PARSE
 *     (`le` does not end in _id so it is safe)
 *
 * Zero new npm dependencies — hand-rolled regex only.
 *
 * @param exposition - Raw Prometheus text format string from /metrics
 * @returns Array of violations; empty if no forbidden labels found
 */
export function checkCardinalityLive(exposition: string): CardinalityViolation[] {
  const violations: CardinalityViolation[] = [];
  const lines = exposition.split('\n');
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    if (!line || line.startsWith('#')) continue;

    // Phase 19 review-deferred fix: previous regex `^([a-z0-9_]+)\{([^}]*)\}`
    // had two failure modes:
    //   (a) `[^}]*` stops at the first literal `}` in a label value
    //       (Prometheus exposition allows raw `}` in label values — only
    //       `\\`, `\n`, `\"` are required escapes), silently truncating
    //       label-set parsing for any value containing `}`.
    //   (b) `[a-z0-9_]+` for the metric name misses uppercase + `:`,
    //       both permitted by `[a-zA-Z_:][a-zA-Z0-9_:]*` in the spec.
    //
    // Parse the metric name explicitly (per spec character set), then
    // require '{' to begin the label set, then walk the label set as a
    // sequence of `name="value"[,]` pairs honoring `\\` and `\"` so a
    // value containing `}` does not prematurely close the set. The line
    // is rejected only if we cannot find the closing `}` followed by
    // whitespace + a number.
    const nameMatch = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{/);
    if (!nameMatch) continue;
    const metricName = nameMatch[1]!;
    let cursor = nameMatch[0].length;
    const labelNames: string[] = [];
    while (cursor < line.length && line[cursor] !== '}') {
      // Whitespace + leading comma between pairs.
      while (cursor < line.length && (line[cursor] === ' ' || line[cursor] === ',')) {
        cursor++;
      }
      // Label name per spec: [a-zA-Z_][a-zA-Z0-9_]*
      const remaining = line.slice(cursor);
      const labelNameMatch = remaining.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"/);
      if (!labelNameMatch) break;
      labelNames.push(labelNameMatch[1]!);
      cursor += labelNameMatch[0].length;
      // Walk the quoted value, honoring `\\` and `\"` escapes.
      while (cursor < line.length) {
        const ch = line[cursor];
        if (ch === '\\' && cursor + 1 < line.length) {
          cursor += 2;
          continue;
        }
        if (ch === '"') {
          cursor++;
          break;
        }
        cursor++;
      }
    }
    if (labelNames.length === 0) continue;
    const labelText = line.slice(nameMatch[0].length, cursor);
    for (const labelName of labelNames) {
      if (FORBIDDEN_LABEL_RE.test(labelName)) {
        violations.push({
          location: `/metrics:${lineNo + 1}`,
          arrayText: `{${labelText}}`,
          forbiddenLabel: labelName,
          metricNameHint: metricName,
        });
      }
    }
  }
  return violations;
}

/** CLI entry — primary integration is via scripts/__tests__/check-prometheus-cardinality.test.ts. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const mode = args[0] === '--live' ? 'live' : 'source';

  if (mode === 'live') {
    // Live mode: --live <url-or-dash>
    // target='-' means read from stdin; target=<url> means HTTP GET.
    const target = args[1];
    // Phase 19 review-deferred fix: previous IIFE had no `.catch()`, so any
    // fetch/stdin failure escaped as an UnhandledPromiseRejection — Node 22
    // prints a stack and exits non-zero with no usable signal for operators.
    // Trap fetch / readFileSync failures explicitly and emit a stderr
    // message + exit 2 (distinct from exit 1 which signals cardinality
    // violation, so the smoke wrapper can distinguish "scrape failed" from
    // "scrape passed and found _id labels").
    (async () => {
      let text: string;
      if (!target || target === '-') {
        text = readFileSync(0, 'utf8');
      } else {
        text = await (await fetch(target)).text();
      }
      const violations = checkCardinalityLive(text);
      if (violations.length > 0) {
        for (const v of violations) {
          process.stderr.write(
            `cardinality-check: FORBIDDEN _id label "${v.forbiddenLabel}" found in ` +
              `${v.metricNameHint} (${v.location}). ` +
              `Labels matching /_id$/ are forbidden — see CONTEXT.md D-25 / Pitfall P8-03. ` +
              `Move per-request identifiers to request_log columns, not Prometheus labels.\n`,
          );
        }
        process.exit(1);
      }
      process.stdout.write('cardinality-check: OK — no /_id$/ labels found (mode=live)\n');
    })().catch((err) => {
      process.stderr.write(
        `cardinality-check: live scrape failed before parsing — ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      process.exit(2);
    });
  } else {
    // Static mode (default — backward compatible):
    // Usage: node check-prometheus-cardinality.ts [--source] [path]
    // When first arg is '--source', second arg is the path; otherwise first arg is path.
    let pathArg: string | undefined;
    if (args[0] === '--source') {
      pathArg = args[1];
    } else if (args[0] && args[0] !== '--live') {
      pathArg = args[0];
    }
    const path = resolve(process.cwd(), pathArg ?? 'src/metrics/registry.ts');
    const source = readFileSync(path, 'utf8');
    const violations = checkCardinality(source);
    if (violations.length > 0) {
      for (const v of violations) {
        process.stderr.write(
          `cardinality-check: FORBIDDEN _id label "${v.forbiddenLabel}" found in ` +
            `${v.metricNameHint} (${v.location}). ` +
            `Labels matching /_id$/ are forbidden — see CONTEXT.md D-25 / Pitfall P8-03. ` +
            `Move per-request identifiers to request_log columns, not Prometheus labels.\n`,
        );
      }
      process.exit(1);
    }
    process.stdout.write('cardinality-check: OK — no /_id$/ labels found (mode=source)\n');
  }
}
