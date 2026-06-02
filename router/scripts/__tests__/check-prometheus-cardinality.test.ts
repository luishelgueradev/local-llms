/**
 * Prometheus cardinality guard — vitest test suite
 *
 * Phase 14 (v0.11.0 — POL-06 / D-25, D-26, D-27):
 * Asserts that labelNames arrays in src/metrics/registry.ts never contain
 * elements ending in '_id'. Catches tenant_id, project_id, agent_id,
 * session_id, and any future *_id addition.
 *
 * Phase 19 (v0.11.0 — OBSV-02 / D-14):
 * Extended with checkCardinalityLive edge-case coverage (10 cases).
 * Static-grep tests (5 cases) are unchanged.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCardinality, checkCardinalityLive } from '../check-prometheus-cardinality.js';

describe('Prometheus cardinality static-grep guard (POL-06 / D-25)', () => {
  it('Test 1 (production clean): src/metrics/registry.ts has no /_id$/ labels', () => {
    const path = resolve(import.meta.dirname, '../../src/metrics/registry.ts');
    const source = readFileSync(path, 'utf8');
    expect(checkCardinality(source)).toEqual([]);
  });

  it('Test 2 (regression — synthetic tenant_id): synthetic tenant_id label is detected', () => {
    const fake = `
      new Counter({
        name: 'router_fake_total',
        labelNames: ['protocol', 'tenant_id'] as const,
      });
    `;
    const violations = checkCardinality(fake);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.forbiddenLabel).toBe('tenant_id');
    expect(violations[0]?.metricNameHint).toBe('router_fake_total');
  });

  it('Test 3 (legitimate labels): legitimate model+dims labels are not flagged', () => {
    // router_embeddings_dims_total uses ['model', 'dims'] — both bounded, neither ends in _id.
    const fake = `
      new Counter({
        name: 'router_embeddings_dims_total',
        labelNames: ['model', 'dims'] as const,
      });
    `;
    expect(checkCardinality(fake)).toEqual([]);
  });

  it('Test 4 (defense — multiple violations counted): multiple _id labels in one array', () => {
    // Both tenant_id and project_id end in _id — two violations should be detected.
    const fake = `
      new Counter({
        name: 'router_multi_total',
        labelNames: ['protocol', 'tenant_id', 'project_id'] as const,
      });
    `;
    const violations = checkCardinality(fake);
    expect(violations).toHaveLength(2);
    const labels = violations.map((v) => v.forbiddenLabel);
    expect(labels).toContain('tenant_id');
    expect(labels).toContain('project_id');
  });

  it('Test 5 (defense — agent_id detected): agent_id label is detected', () => {
    const fake = `
      new Counter({
        name: 'router_agent_total',
        labelNames: ['agent_id'] as const,
      });
    `;
    const violations = checkCardinality(fake);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.forbiddenLabel).toBe('agent_id');
  });
});

describe('checkCardinalityLive — D-14 live exposition parser', () => {
  it('returns no violations when exposition is empty', () => {
    expect(checkCardinalityLive('')).toEqual([]);
  });

  it('skips # HELP / # TYPE / # comment lines', () => {
    const exposition = [
      '# HELP router_requests_total Total requests.',
      '# TYPE router_requests_total counter',
      '# This is a plain comment',
      'router_requests_total{method="GET"} 42',
    ].join('\n');
    expect(checkCardinalityLive(exposition)).toEqual([]);
  });

  it('skips unlabeled metric_name 42.0 lines', () => {
    const exposition = 'router_node_uptime_seconds 12345';
    expect(checkCardinalityLive(exposition)).toEqual([]);
  });

  it('skips empty-label-set metric_name{} 42.0 lines', () => {
    const exposition = 'router_xxx_total{} 0';
    expect(checkCardinalityLive(exposition)).toEqual([]);
  });

  it('detects label ending in _id on a labeled metric', () => {
    const exposition = 'router_test_total{tenant_id="acme"} 1';
    const violations = checkCardinalityLive(exposition);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.forbiddenLabel).toBe('tenant_id');
    expect(violations[0]?.metricNameHint).toBe('router_test_total');
  });

  it('handles trailing timestamp after the metric value', () => {
    const exposition = 'router_x{l="v"} 42 1234567890';
    expect(checkCardinalityLive(exposition)).toEqual([]);
  });

  it('handles histogram _bucket lines with le label correctly', () => {
    const exposition = 'router_request_duration_ms_bucket{le="100",route="/api"} 42';
    // `le` does not end in _id — no violation
    expect(checkCardinalityLive(exposition)).toEqual([]);
  });

  it('handles multi-label metrics finding _id label among many', () => {
    const exposition = 'router_x{good="1",tenant_id="x",other="y"} 1';
    const violations = checkCardinalityLive(exposition);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.forbiddenLabel).toBe('tenant_id');
  });

  it('handles labels with escaped quotes in values without false positive on label names', () => {
    // Label values may contain escaped quotes; parser keys off label NAMES only.
    const exposition = 'router_x{path="/api/v1/foo",route="/api"} 1';
    expect(checkCardinalityLive(exposition)).toEqual([]);
  });

  it('returns location as /metrics:lineNo (1-based) for violation on second line', () => {
    const exposition = [
      '# HELP router_test_total A test counter.',
      'router_test_total{tenant_id="acme"} 1',
    ].join('\n');
    const violations = checkCardinalityLive(exposition);
    expect(violations).toHaveLength(1);
    // Line 1 is the comment, line 2 is the metric — so lineNo=1 (0-based) gives lineNo+1=2
    expect(violations[0]?.location).toBe('/metrics:2');
  });

  // Phase 19 review-deferred fix: regex hardening for `}` and uppercase + `:`.
  it('detects _id label when an earlier label value contains a raw `}`', () => {
    // Spec: only `\\`, `\n`, `\"` are required escapes inside label values —
    // `}` is allowed raw. The pre-fix regex `[^}]*` truncated at the first
    // raw `}`, hiding any subsequent _id label from cardinality enforcement.
    const exposition = 'router_x{path="/api/v1/{id}",tenant_id="acme"} 1';
    const violations = checkCardinalityLive(exposition);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.forbiddenLabel).toBe('tenant_id');
  });

  it('detects _id label on a metric whose name contains uppercase letters', () => {
    // Spec: metric name charset is [a-zA-Z_:][a-zA-Z0-9_:]*. The pre-fix
    // regex used [a-z0-9_]+ and would never match such a line, so a
    // third-party-instrumented dep emitting MyMetric{TenantId="x"} would
    // slip past the cardinality guard entirely.
    const exposition = 'router_MyMetric{tenant_id="acme"} 1';
    const violations = checkCardinalityLive(exposition);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.forbiddenLabel).toBe('tenant_id');
    expect(violations[0]?.metricNameHint).toBe('router_MyMetric');
  });

  it('detects _id label on a metric whose name uses `:` separator (Prometheus rule)', () => {
    const exposition = 'router:rpc_total{session_id="abc"} 1';
    const violations = checkCardinalityLive(exposition);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.forbiddenLabel).toBe('session_id');
  });

  it('does not break on escaped quotes inside label values (legitimate path)', () => {
    const exposition = 'router_x{quote="a\\"b",route="/x"} 1';
    expect(checkCardinalityLive(exposition)).toEqual([]);
  });
});
