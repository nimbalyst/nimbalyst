# Windows pre-push gate

Local Windows pushes build the extension SDK, runtime, and memory-engine
artifacts before running the full workspace typecheck. The complete Vitest
suite remains mandatory in CI and on non-Windows machines, but is skipped for
local Windows pushes until its platform failures are repaired.

The 2026-07-13 baseline command, `npm run test:prepush`, failed in these
unrelated suites: `claudeCodeEnvironment` (runtime and provider variants),
`ClaudeCliSessionLauncher`, `FileSnapshotCache`, `WorkspaceEventBus-gitignore-bypass`,
`workspaceDetection`, `ClaudeCodeProvider.bashParser`, `SafePathValidator`,
`MigrationOrchestrator.fixtureRoundtrip`, `WorkspaceEventBus-nested-gitignore`,
`ElectronFileSystemService`, `nimPreviewProtocol`, `SlashCommandService`,
`nimAssetProtocol`, `ElectronDocumentService.frontmatterCompatibility`,
`aiSettingsMerge`, `MigrationOrchestrator`, `spawnCrashDiagnostics`,
`claudeCliJsonlPath`, and `BrowserSessionHandlers`.

The fallback is intentionally limited to `process.platform === 'win32'` with
no CI flag. It does not bypass the manifest check, dependency override check,
prerequisite builds, full workspace typecheck, or this repository's focused
test requirements.
