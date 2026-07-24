/**
 * Re-export useEditorLifecycle from the extension SDK.
 * The canonical implementation lives in @nimbalyst/extension-sdk.
 * Runtime re-exports it so existing internal imports continue to work.
 */
export {
  useEditorLifecycle,
  type UseEditorLifecycleOptions,
  type UseEditorLifecycleResult,
  type DiffState,
} from '@nimbalyst/extension-sdk';
