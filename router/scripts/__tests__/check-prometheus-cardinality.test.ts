/**
 * Prometheus cardinality static-grep guard — vitest test suite
 *
 * Phase 14 (v0.11.0 — POL-06 / D-25, D-26, D-27):
 * Asserts that labelNames arrays in src/metrics/registry.ts never contain
 * elements ending in '_id'. Catches tenant_id, project_id, agent_id,
 * session_id, and any future *_id addition.
 *
 * Static-grep only (D-27). Live /metrics parse deferred to Phase 19 (OBSV-02).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCardinality } from '../check-prometheus-cardinality.js';

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
