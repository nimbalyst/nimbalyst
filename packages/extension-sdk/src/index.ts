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

// Re-export host-provided editor context and UI helpers for extensions.
export {
  useDocumentPath,
  type DocumentPathContextValue,
} from './documentPath.js';
export { MaterialSymbol } from './MaterialSymbol.js';

// Re-export read-only host factory (for web viewers and testing)
export {
  createReadOnlyHost,
  type ReadOnlyHost,
  type ReadOnlyHostOptions,
} from './createReadOnlyHost.js';

// Re-export clipboard utilities
export { copyToClipboard, readClipboard } from './clipboard.js';

// Re-export validation
export {
  validateExtensionBundle,
  printValidationResult,
  type ValidationResult,
} from './validate.js';
