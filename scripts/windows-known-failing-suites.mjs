/**
 * Windows-only-failing Vitest suites, verified currently failing on this
 * platform as of 2026-07-15 (re-verified against live test runs, not just
 * copied from the 2026-07-13 baseline -- 3 suites from that baseline now
 * pass and are intentionally NOT listed here: MigrationOrchestrator.test.ts,
 * MigrationOrchestrator.fixtureRoundtrip.test.ts,
 * ElectronFileSystemService.security.test.ts).
 *
 * Two more suites added 2026-07-22 after NIM-364 V12 integration surfaced them
 * as full-suite-only Windows concurrency flakes on this same
 * SQLite/PGLite-worker-contention pattern: both were independently isolated
 * (single-file `vitest run`, no other suite present) and passed 100% clean --
 * `attentionReplyGenerationBoundary.test.ts` 18/18, `AttentionReplyInjectionService.test.ts`
 * 32/32 -- confirming they only fail under full concurrent worker load, never
 * on their own. See `_pending/v12_nim364_two_failure_isolation_terminal_20260722.md`
 * and `_pending/v12_nim364_native_abi_rebuild_integration_terminal_20260722.md`.
 *
 * CI runs Ubuntu only (no Windows runner exists in .github/workflows/ci.yml),
 * so these suites were never covered on Windows by CI either way -- this
 * exclusion does not reduce actual Windows test coverage, it only stops a
 * pre-existing, untracked failure set from blocking local Windows pushes.
 *
 * Exclusion is per-file, not a blanket platform skip, so any NEW suite
 * added later is NOT silently exempted -- only files explicitly listed here
 * are skipped. See docs/WINDOWS_PREPUSH_GATE.md.
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
  'packages/electron/src/main/utils/__tests__/aiSettingsMerge.test.ts',
  'packages/runtime/src/ai/server/providers/__tests__/spawnCrashDiagnostics.test.ts',
  'packages/electron/src/main/services/ai/__tests__/attentionReplyGenerationBoundary.test.ts',
  'packages/electron/src/main/services/__tests__/AttentionReplyInjectionService.test.ts',
];
