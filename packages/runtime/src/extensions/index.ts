/**
 * Extension System
 *
 * Platform-agnostic extension loading system for Nimbalyst.
 * Extensions can provide custom editors, AI tools, and more.
 */

// Types
export type {
  ExtensionManifest,
  ExtensionPermissions,
  ExtensionContributions,
  ExtensionConfigurationContribution,
  ConfigurationProperty,
  CustomEditorContribution,
  DocumentHeaderContribution,
  CommandContribution,
  NewFileMenuContribution,
  SlashCommandContribution,
  AgentWorkflowsContribution,
  ClaudePluginContribution,
  ClaudePluginCommand,
  ClaudePluginAgent,
  ExtensionModule,
  JSONSchema,
  JSONSchemaProperty,
  ExtensionAITool,
  AIToolContext,
  ExtensionToolResult,
  ExtensionContext,
  ExtensionServices,
  ExtensionFileSystemService,
  ExtensionUIService,
  ExtensionAIService,
  ExtensionConfigurationService,
  ExtensionContextProvider,
  Disposable,
  LoadedExtension,
  ExtensionLoadResult,
  DiscoveredExtension,
  // Panel types
  PanelContribution,
  SettingsPanelContribution,
  LoadedPanel,
  PanelHostProps,
  PanelGutterButtonProps,
  PanelHost,
  PanelAIContext,
  PanelExport,
  SettingsPanelProps,
  ExtensionStorage,
  ExtensionFileStorage,
  ExtensionDataAccess,
  ExecOptions,
  ExecResult,
  // Theme types
  ThemeContribution,
  ThemeColorKey,
} from './types';

// Platform Service
export type { ExtensionPlatformService } from './ExtensionPlatformService';
export {
  setExtensionPlatformService,
  getExtensionPlatformService,
  hasExtensionPlatformService,
} from './ExtensionPlatformService';

// Loader
export {
  ExtensionLoader,
  getExtensionLoader,
  initializeExtensions,
  setEnabledStateProvider,
  setConfigurationServiceProvider,
} from './ExtensionLoader';
export type { ConfigurationServiceProvider } from './ExtensionLoader';

// AI Tools Bridge
export {
  initializeExtensionAIToolsBridge,
  registerExtensionTools,
  unregisterExtensionTools,
  getExtensionTools,
  setOnToolsChangedCallback,
  getMCPToolDefinitions,
  executeExtensionTool,
  setOffscreenMountCallback,
  setEnsureEditorCallback,
} from './ExtensionAIToolsBridge';
export type { MCPToolDefinition } from './ExtensionAIToolsBridge';

// Voice context provider registry (Core hook 2)
export {
  registerVoiceContextProvider,
  unregisterVoiceContextProvidersForExtension,
  collectVoiceSessionContext,
  _clearVoiceContextProvidersForTest,
} from './VoiceContextProviderRegistry';
export type { CollectVoiceContextOptions } from './VoiceContextProviderRegistry';

// Extension Editor API Registry
export {
  registerEditorAPI,
  unregisterEditorAPI,
  getEditorAPI as getExtensionEditorAPI,
  hasEditorAPI as hasExtensionEditorAPI,
  flushEditorSave,
  getRegisteredPaths as getRegisteredEditorPaths,
} from './ExtensionEditorAPIRegistry';

// Editor Host
export type {
  EditorHost,
  EditorHostProps,
  EditorMenuItem,
  EditorContext,
  DiffConfig,
  DiffResult,
  CollaborationContext,
  CollaborationStatus,
  CollaboratorInfo,
  RevisionSnapshotAdapter,
  StandardAwarenessState,
} from './editorHost';

// Editor Lifecycle Hook
export { useEditorLifecycle } from './useEditorLifecycle';
export type {
  UseEditorLifecycleOptions,
  UseEditorLifecycleResult,
  DiffState,
} from './useEditorLifecycle';

// Collaborative Editor Hook
export { useCollaborativeEditor, COLLAB_INIT_ORIGIN } from './useCollaborativeEditor';
export type {
  UseCollaborativeEditorConfig,
  UseCollaborativeEditorResult,
} from './useCollaborativeEditor';

// Collab content adapter factory + cross-process reconstruction (re-exported
// from the SDK so the Electron main process can use them via @nimbalyst/runtime
// without depending on @nimbalyst/extension-sdk directly).
export {
  createTextCollabContentAdapter,
  reconstructCollabContentAdapterFromDescriptor,
  TEXT_COLLAB_DEFAULT_FIELD,
  type TextCollabContentAdapterOptions,
  type CollabAdapterDescriptor,
  type TextCollabAdapterDescriptor,
} from '@nimbalyst/extension-sdk';

// Extension Storage
export {
  createExtensionStorage,
  setStorageBackend,
  getStorageBackend,
  cleanupExtensionStorage,
} from './ExtensionStorage';
export type { StorageBackend } from './ExtensionStorage';
