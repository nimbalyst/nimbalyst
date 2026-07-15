# Windows pre-push gate

Local Windows pushes build the extension SDK, runtime, and memory-engine
artifacts before running the full workspace typecheck. The full Vitest suite
runs unconditionally everywhere -- CI, macOS, Linux -- except that local
Windows pushes exclude a specific, named list of known-failing suites (see
`scripts/windows-known-failing-suites.mjs`), re-verified live against a
current Windows run rather than copied from a stale baseline. Any suite not
on that explicit list, including new ones added later, still runs and blocks
a local Windows push on failure.

The exclusion is implemented in `vitest.config.ts` (spliced into each
project's own `exclude` array when `NIMBALYST_PREPUSH_GATE=1` is set), not a
vitest CLI `--exclude` flag. This repo's vitest config uses `test.projects`
(separate jsdom/node projects), and each project defines its own `exclude`
array -- a CLI `--exclude` never reaches either project's file discovery, so
it silently excludes nothing. `scripts/prepush-test-gate.mjs` sets the env
var only for its own spawned vitest process; every other invocation (`npx
vitest`, CI, a targeted single-file run) is unaffected.

CI runs Ubuntu only (`.github/workflows/ci.yml` has no Windows runner), so
this exclusion does not reduce actual test coverage -- these suites were
never validated on Windows by CI in the first place. It only stops a
pre-existing, Windows-platform-specific failure set from blocking local
Windows development.

As of 2026-07-15, 18 suites are excluded (see the list file for the current,
verified set). 3 suites from the original 2026-07-13 baseline
(`MigrationOrchestrator.test.ts`, `MigrationOrchestrator.fixtureRoundtrip.test.ts`,
`ElectronFileSystemService.security.test.ts`) pass reliably in isolation and
were removed from the deterministic-exclusion list.

## Worker-concurrency cap for SQLite/PGLite contention

Running the full suite concurrently on Windows at the default (CPU-count)
worker concurrency deterministically fails a handful of additional suites
beyond the 18 above, clustered around SQLite/PGLite-backed tests
(`MigrationOrchestrator`, `PGLiteToSQLiteMigrator`, `ClaudeCodeImport`) plus
one heavy jsdom suite -- reproduced across repeated full runs, with
`errno 44` unhandled rejections. Every one of these passes 100% when re-run
in isolation, which rules out a real regression. A single retry, and even a
second retry, did NOT clear it (the same file failed on every attempt) --
which ruled out ordinary transient flakiness and pointed at persistent
resource contention (too many workers racing for the same native SQLite
binding / file handles) instead.

Capping concurrency (`--maxWorkers 4`, Windows-local only -- see
`buildVitestArgs` in `scripts/prepush-test-gate.mjs`) eliminates the
contention outright: verified clean (0 failures) across repeated full runs.
This is a smaller, cheaper fix than expanding the exclusion list to chase
suites whose specific identity varies run to run depending on scheduling --
and unlike retry, it addresses the actual mechanism rather than papering
over a symptom.

The manifest check, dependency-override check, prerequisite builds, and full
workspace typecheck remain mandatory everywhere, including local Windows.
