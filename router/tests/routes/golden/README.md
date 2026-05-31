# Route-level golden fixtures

This directory holds captured wire-body snapshots for route regression tests.
Each `<scenario>.json` is loaded by its sibling integration test and asserted
`toEqual` against a fresh body produced via `app.inject` with deterministic ids
(`vi.useFakeTimers()` + `vi.setSystemTime(new Date(0))` + `opts.idOverride`).

Regenerate intentionally with `UPDATE_GOLDEN=1 npm test -- <test-name>`.
Convention introduced in Phase 16 (P9-02 regression fixture).
