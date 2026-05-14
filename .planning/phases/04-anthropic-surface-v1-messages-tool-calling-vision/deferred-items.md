# Deferred Items — Phase 04

Out-of-scope discoveries surfaced during plan execution. Each item lists the
plan that found it + the next-best home for the fix.

## 04-02: Flaky `hotreload.vram.test.ts` recovery assertion

**Found during:** Plan 04-02 full-suite regression check.

**Test:** `tests/integration/hotreload.vram.test.ts` →
`recovery: after failed VRAM reload, valid reload succeeds and advances createdAtSec`

**Symptom:** Pre-existing flakiness — assertion `errorCount >= 1` fails on roughly
2 of every 5 full-suite runs (the test waits ≤300ms for fs.watch to fire after a
writeFileSync; the watcher debounce + WSL2 fs.watch latency races the timeout).
The test passes when run in isolation and passes most of the time in the suite.

**Scope check:** Unrelated to Plan 04-02. The flakiness sits in Plan 02-05's
`watchRegistry`-on-WSL2 polling fallback. Plan 04-02 introduced NO changes to
`registry.ts` / fs watching / hot-reload code.

**Recommended fix:** Either (a) bump the per-write race window from 300ms to 1000ms,
or (b) inject a synthetic fs-event into the watcher to deflake the test. Either way
this is Plan 02-05 / hot-reload subsystem work, not Phase 4.

