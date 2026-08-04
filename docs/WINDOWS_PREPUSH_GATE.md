# Windows pre-push gate

Local Windows pushes build the extension SDK, runtime, and memory-engine
artifacts before running the full workspace typecheck. Vitest then runs with
at most four workers and excludes only the explicit paths in
`scripts/windows-known-failing-suites.mjs`. Every unlisted suite—including a
new suite added later—still runs and can block the push. CI and non-Windows
runs use the complete suite without exclusions or the worker cap.

The 2026-07-13 baseline command, `npm run test:prepush`, failed in these
unrelated suites: `claudeCodeEnvironment` (runtime and provider variants),
`ClaudeCliSessionLauncher`, `FileSnapshotCache`, `WorkspaceEventBus-gitignore-bypass`,
`workspaceDetection`, `ClaudeCodeProvider.bashParser`, `SafePathValidator`,
`MigrationOrchestrator.fixtureRoundtrip`, `WorkspaceEventBus-nested-gitignore`,
`ElectronFileSystemService`, `nimPreviewProtocol`, `SlashCommandService`,
`nimAssetProtocol`, `ElectronDocumentService.frontmatterCompatibility`,
`aiSettingsMerge`, `MigrationOrchestrator`, `spawnCrashDiagnostics`,
`claudeCliJsonlPath`, and `BrowserSessionHandlers`.

The list was rechecked against current source on 2026-08-04. Seventeen suites
still failed on Windows; `aiSettingsMerge.test.ts` passed and is no longer
excluded. The manifest remains source-controlled and must shrink when a suite
becomes portable rather than silently accumulating stale exemptions.

The exclusions are applied inside each project in `vitest.config.ts` only
when `NIMBALYST_PREPUSH_GATE=1`. A CLI `--exclude` does not reliably reach
project-level discovery. `scripts/prepush-test-gate.mjs` is the only caller
that sets the variable, and only for local Windows with no truthy `CI` flag.

The four-worker cap prevents the SQLite/PGlite file-handle contention seen at
CPU-count concurrency. It is local-Windows-only and does not change CI.

This gate does not bypass the toolchain, fixture-author, manifest/lockfile,
dependency-override, raw-NUL, prerequisite-build, full typecheck, or focused
test checks that precede it in `.githooks/pre-push`.
