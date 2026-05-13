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
} from './editorHost';

// Editor Lifecycle Hook
export { useEditorLifecycle } from './useEditorLifecycle';
export type {
  UseEditorLifecycleOptions,
  UseEditorLifecycleResult,
  DiffState,
} from './useEditorLifecycle';

// Extension Storage
export {
  createExtensionStorage,
  setStorageBackend,
  getStorageBackend,
  cleanupExtensionStorage,
} from './ExtensionStorage';
export type { StorageBackend } from './ExtensionStorage';
