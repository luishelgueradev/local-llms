// router/scripts/check-prometheus-cardinality.ts
//
// Phase 14 (v0.11.0 — POL-06 / D-25, D-26): static-grep guard against
// high-cardinality Prometheus labels. Scans src/metrics/registry.ts for
// labelNames arrays and asserts no array element ends in '_id'.
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
  /** Pretty source location, e.g. "registry.ts:36" */
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

/** CLI entry — primary integration is via scripts/__tests__/check-prometheus-cardinality.test.ts. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = resolve(process.cwd(), 'src/metrics/registry.ts');
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
  process.stdout.write('cardinality-check: OK — no /_id$/ labels found in src/metrics/registry.ts\n');
}
