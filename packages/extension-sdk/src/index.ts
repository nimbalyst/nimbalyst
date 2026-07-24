/**
 * Nimbalyst Extension SDK
 *
 * This package provides utilities for building Nimbalyst extensions:
 * - Vite configuration helpers
 * - TypeScript types
 * - Build validation
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import react from '@vitejs/plugin-react';
 * import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';
 *
 * export default createExtensionConfig({
 *   entry: './src/index.tsx',
 *   plugins: [
 *     react({ jsxRuntime: 'automatic', jsxImportSource: 'react' }),
 *   ],
 * });
 * ```
 *
 * @packageDocumentation
 */

// Re-export externals
export {
  REQUIRED_EXTERNALS,
  EXTERNAL_PATTERNS,
  ROLLUP_EXTERNALS,
  type RequiredExternal,
} from './externals.js';

// Re-export types
export * from './types/index.js';

// Re-export hooks
export {
  useEditorLifecycle,
  type UseEditorLifecycleOptions,
  type UseEditorLifecycleResult,
  type DiffState,
} from './useEditorLifecycle.js';

export {
  useCollaborativeEditor,
  COLLAB_INIT_ORIGIN,
  type UseCollaborativeEditorConfig,
  type UseCollaborativeEditorResult,
} from './useCollaborativeEditor.js';

export {
  createTextCollabContentAdapter,
  reconstructCollabContentAdapterFromDescriptor,
  TEXT_COLLAB_DEFAULT_FIELD,
  type TextCollabContentAdapterOptions,
} from './collab/createTextCollabContentAdapter.js';

// Re-export host-provided editor context and UI helpers for extensions.
export {
  useDocumentPath,
  type DocumentPathContextValue,
} from './documentPath.js';
export { MaterialSymbol } from './MaterialSymbol.js';

// Re-export host-owned tracker reference UI. Extensions persist only reference
// keys while Nimbalyst owns live resolution, previews, selection, and opening.
export {
  TrackerReferenceChip,
  TrackerReferencePicker,
  navigateToTrackerReference,
  useResolvedTrackerReference,
  type ResolvedTrackerReference,
  type TrackerReferenceChipProps,
  type TrackerReferencePickerProps,
} from './trackerReferences.js';

// Re-export read-only host factory (for web viewers and testing)
export {
  createReadOnlyHost,
  type ReadOnlyHost,
  type ReadOnlyHostOptions,
} from './createReadOnlyHost.js';

// Re-export clipboard utilities
export { copyToClipboard, readClipboard } from './clipboard.js';

// Re-export cross-platform file tree utilities for host and extension UIs.
export {
  buildFileDirectoryTree,
  getFileDirectoryPaths,
  getFilePathBasename,
  getWorkspaceRelativeFilePath,
  normalizeFilePath,
  type FileDirectoryNode,
} from './fileDirectoryTree.js';

// Re-export validation
export {
  validateExtensionBundle,
  printValidationResult,
  type ValidationResult,
} from './validate.js';

export {
  validateBackendModules,
  assertBackendModulesValid,
  effectiveModulePermissions,
  validateAgentProviders,
  assertAgentProvidersValid,
  extractBackendModuleIds,
  MAX_AGENT_PROVIDERS_PER_EXTENSION,
  type BackendModuleValidationIssue,
  type AgentProviderValidationIssue,
} from './manifestValidation.js';

// Re-export agent-provider host surface (matches the
// `@nimbalyst/extension-sdk/agents` subpath import documented in
// the Phase 4 SDK design).
//
// The protocol `ToolResult` is re-exported as `ProtocolToolResult`
// on the root barrel to avoid colliding with the deprecated
// extension-tool `ToolResult` from `./types/extension.ts`. The two
// shapes are unrelated; consumers importing from the subpath
// (`@nimbalyst/extension-sdk/agents`) get the canonical
// `ToolResult` name unchanged.
export type {
  AgentProtocol,
  ProtocolEvent,
  ProtocolMessage,
  ProtocolSession,
  SessionOptions,
  ProtocolEventType,
  ToolResult as ProtocolToolResult,
  MCPServerConfig,
  RawProtocolSession,
  AgentProtocolHost,
  PermissionMode,
  McpToolDefinition,
} from './agents/index.js';
