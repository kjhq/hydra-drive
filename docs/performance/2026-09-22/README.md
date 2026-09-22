# Responsiveness and idle-work performance: first implementation pass

Measured on September 22, 2026, macOS arm64, Node 24.15.0. Baseline commit: `83bf06286fba5613dc6fcab7945560da9a6e5067`. After: the measured implementation, identified by SHA-256 hashes in [source-manifest.json](./source-manifest.json). These hashes describe the original measurement, before the final explicit-refresh race fix below.

These are reproducible production-code fixtures, not a measurement of whole-app responsiveness, idle CPU percentage, or total Electron RAM. Ratios apply to the named workload and must not be multiplied together.

| Workload                                                                                         |                 Before |       After | Result       |
| ------------------------------------------------------------------------------------------------ | ---------------------: | ----------: | ------------ |
| Register 3,000 navigation nodes and publish subscribed snapshots, median of 3 runs               |            1,103.07 ms |     2.65 ms | 417× faster  |
| Node entries copied by navigation snapshots in that workload                                     |              9,009,000 |       6,000 | 1,501× fewer |
| Preference requests / active listeners for 3,000 synthetic cards, two preference-hook calls each |          6,000 / 6,000 |       1 / 1 | 6,000× fewer |
| Initial library requests / listeners, eight hook consumers                                       |                  8 / 8 |       1 / 1 | 8× fewer     |
| Retained JS heap added by mounted hook fixture, after forced GC                                  |            8,877,292 B | 6,914,436 B | 22.1% lower  |
| Nested achievement discovery, 100 games, 30 unchanged passes                                     |  6,030 directory reads |         201 | 30× fewer    |
| Nested discovery, 100 separate prefixes, 30 unchanged passes                                     |  9,000 directory reads |         300 | 30× fewer    |
| Two watchers reading a 3,000-game library over 30 unchanged passes                               | 60 full database scans |           1 | 60× fewer    |

Discovery elapsed time was 35.57 → 2.66 ms for a shared root and 236.26 → 18.11 ms for separate prefixes. Library reads took 101.60 → 3.00 ms. Browser hook-fixture mount time was 44.58 → 19.31 ms. Those are single-run supporting observations; operation counts are the stronger evidence. Navigation timing is a three-run median. Browser mount timing and heap are fixture-specific and may vary between runs.

## What changed

- Navigation registration appends already-ordered nodes or inserts into sorted order, instead of sorting the growing list on every registration. Structural snapshots are cached; synchronous changes publish once per microtask. Focus state still changes synchronously. Ordinary focus items no longer subscribe to every global focus-ID change.
- Big Picture preference and library hooks share an external store, an in-flight read, and upstream subscriptions. Race handling preserves pushed updates and invalidations received during reads. The last consumer disconnects the upstream listeners.
- Process and achievement watchers share a library snapshot. Relevant database writes, batches, deletions and clears invalidate it; a write racing a read forces a fresh snapshot.
- Static and nested achievement discovery cache folder results, invalidate on filesystem events, and reconcile every 60 seconds. Missing roots share shallow ancestor watches. Rename/error handling replaces shared subscriptions. Unsupported watches fall back to scanning. Inactive roots expire after five minutes, avoiding both permanent retention and fixed-size cache thrashing across large libraries. Maps are shared across games with the same prefix during each watcher pass.

The process polling interval remains unchanged. Achievement-file change checks and game-directory discovery still run; this pass removes repeated library loading and emulator-root discovery. Active-library snapshots and watcher metadata consume some memory in exchange for less repeated I/O. This pass does not establish lower total main-process RAM.

## Evidence and reproduction

Raw output: [responsiveness before](./responsiveness-before.json), [responsiveness after](./responsiveness-after.json), [discovery before](./idle-before.json), [discovery after](./idle-after.json).

Run from the repository root with its installed dependencies and Playwright Chromium available:

```sh
node scripts/benchmark-responsiveness.mjs --ref 83bf06286fba5613dc6fcab7945560da9a6e5067 --output .cache/performance/ui-before.json
node scripts/benchmark-responsiveness.mjs --output .cache/performance/ui-after.json --check
node scripts/benchmark-idle-discovery.mjs --ref 83bf06286fba5613dc6fcab7945560da9a6e5067 --output .cache/performance/idle-before.json
node scripts/benchmark-idle-discovery.mjs --output .cache/performance/idle-after.json --check
node scripts/test.cjs
npm run build
```

Both UI runs execute the actual navigation service and production React hooks from their respective source versions. The browser supplies a synthetic Electron bridge and renders simple hook-consuming cards, not the complete Big Picture page. Both discovery runs execute actual nested-discovery code against temporary files. The database baseline reproduces the prior direct `values().all()` calls against real ClassicLevel; the new run uses the production snapshot. The 30 discovery cycles run back-to-back: they model repeated unchanged work, not 60 seconds of observed idle CPU. Initial scans/watch setup are included. Benchmarks assert discovered game counts, focus behavior, preference/library update propagation, listener cleanup, and database-write visibility.

Validation: **805/805 repository tests passed**, including **19 focused performance/correctness regressions**. Production build and both TypeScript checks passed. Targeted ESLint: no errors, three existing hook-dependency warnings. Two independent reviews were completed; persistent-region remount, cache-thrashing, permission-error and shared-watcher replacement findings were fixed and rechecked. No live user profile, credentials or save data were used by the benchmarks.

Runtime validation was on macOS. Windows/Linux filesystem notification behavior and full-app steady-state CPU/RSS still need platform measurements. If filesystem notifications are unavailable, discovery intentionally keeps polling. Missed events recover at reconciliation, so discovery can be delayed up to that interval.

## Remaining large opportunities

1. Virtualize Big Picture game grids so mounted cards scale with the viewport rather than library size. This is the next strongest candidate for broad responsiveness and renderer memory gains in large libraries; no end-to-end multiplier is established yet.
2. Replace repeated process discovery with a shared process snapshot or event source where supported, measuring CPU and detection latency before changing polling behavior.
3. Reduce whole-page translation observation, and defer large renderer modules/locales and nonessential startup work. Measure affected screens and launch separately.

The first pass is implemented. It is not a completed implementation of the entire performance roadmap.

## Pre-deployment follow-up

Review found that an explicit library refresh after adding a game could join a
pre-mutation request. Public refreshes now invalidate that result and request a
fresh snapshot, while mounted consumers still share their initial read. A race
regression and the responsiveness benchmark's `--check` assertions passed after
the fix. The original measurements and source hashes above are retained as
historical evidence, rather than attributed to the modified source.
