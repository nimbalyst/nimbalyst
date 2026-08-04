/**
 * Suites that remain nonportable on local Windows as of 2026-08-04.
 *
 * The list is consumed only when NIMBALYST_PREPUSH_GATE=1, which is set by
 * scripts/prepush-test-gate.mjs for a non-CI Windows push. New or unlisted
 * suites remain mandatory. CI and non-Windows runs exclude none of these.
 */
export const WINDOWS_KNOWN_FAILING_SUITES = [
  'packages/runtime/src/ai/server/providers/__tests__/claudeCodeEnvironment.test.ts',
  'packages/runtime/src/electron/__tests__/claudeCodeEnvironment.test.ts',
  'packages/electron/src/main/services/ai/__tests__/ClaudeCliSessionLauncher.test.ts',
  'packages/electron/src/main/file/__tests__/FileSnapshotCache.test.ts',
  'packages/electron/src/main/file/__tests__/WorkspaceEventBus-gitignore-bypass.test.ts',
  'packages/electron/src/main/utils/__tests__/workspaceDetection.test.ts',
  'packages/runtime/src/ai/server/providers/__tests__/ClaudeCodeProvider.bashParser.test.ts',
  'packages/electron/src/main/security/__tests__/SafePathValidator.test.ts',
  'packages/electron/src/main/file/__tests__/WorkspaceEventBus-nested-gitignore.test.ts',
  'packages/electron/src/main/ipc/__tests__/BrowserSessionHandlers.test.ts',
  'packages/electron/src/main/protocols/__tests__/nimAssetProtocol.test.ts',
  'packages/electron/src/main/protocols/__tests__/nimPreviewProtocol.test.ts',
  'packages/electron/src/main/services/__tests__/ElectronDocumentService.frontmatterCompatibility.test.ts',
  'packages/electron/src/main/services/__tests__/ElectronFileSystemService.test.ts',
  'packages/electron/src/main/services/__tests__/SlashCommandService.test.ts',
  'packages/electron/src/main/services/ai/__tests__/claudeCliJsonlPath.test.ts',
  'packages/runtime/src/ai/server/providers/__tests__/spawnCrashDiagnostics.test.ts',
];
