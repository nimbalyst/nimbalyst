/**
 * Extension System Types
 *
 * Shared extension contracts come from @nimbalyst/extension-sdk.
 * Runtime keeps only the loaded-instance shapes that are internal to the host.
 */

import type { ComponentType } from 'react';
import type {
  ExtensionContext,
  ExtensionManifest,
  ExtensionModule,
  PanelContribution,
  PanelGutterButtonProps,
  PanelHostProps,
} from '@nimbalyst/extension-sdk';

export type {
  ExtensionManifest,
  ExtensionPermissions,
  ExtensionContributions,
  ExtensionConfigurationContribution,
  ConfigurationProperty,
  CustomEditorContribution,
  DocumentHeaderContribution,
  CommandContribution,
  KeybindingContribution,
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
  ExtensionAIToolAccess,
  AIToolContext,
  ExtensionToolResult,
  ExtensionContext,
  ExtensionServices,
  ExtensionFileSystemService,
  ExtensionUIService,
  ExtensionAIService,
  ExtensionConfigurationService,
  ExtensionContextProvider,
  VoiceContextProvider,
  VoiceContextProviderInput,
  Disposable,
  PanelContribution,
  SettingsPanelContribution,
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
  ThemeContribution,
  ThemeColorKey,
  ExtensionAIModel,
  ChatCompletionMessage,
  ChatCompletionOptions,
  ChatCompletionResult,
  ChatCompletionStreamChunk,
  ChatCompletionStreamOptions,
  ChatCompletionStreamHandle,
  ResponseFormat,
} from '@nimbalyst/extension-sdk';

/**
 * A loaded extension instance.
 */
export interface LoadedExtension {
  /** The extension's manifest */
  manifest: ExtensionManifest;

  /** The loaded module */
  module: ExtensionModule;

  /** Context provided to the extension */
  context: ExtensionContext;

  /** Function to remove injected styles */
  disposeStyles?: () => void;

  /**
   * Functions returned by `registerThemeContribution` for each theme this
   * extension declared. Invoked on unload to remove the themes from the
   * runtime registry.
   */
  themeUnregisters?: Array<() => void>;

  /** Whether the extension is currently enabled */
  enabled: boolean;

  /** Dispose and unload the extension */
  dispose(): Promise<void>;
}

/**
 * Extension loading result.
 */
export type ExtensionLoadResult =
  | { success: true; extension: LoadedExtension }
  | { success: false; error: string; manifestPath?: string };

/**
 * Extension discovery result.
 */
export interface DiscoveredExtension {
  /** Path to the extension directory */
  path: string;

  /** Parsed manifest */
  manifest: ExtensionManifest;
}

/**
 * A loaded panel instance (internal use).
 */
export interface LoadedPanel {
  /** Full panel ID (extensionId.panelId) */
  id: string;

  /** Extension that provides this panel */
  extensionId: string;

  /** Panel contribution from manifest */
  contribution: PanelContribution;

  /** Panel component */
  component: ComponentType<PanelHostProps>;

  /** Optional custom gutter button component */
  gutterButton?: ComponentType<PanelGutterButtonProps>;

  /** Optional settings component */
  settingsComponent?: ComponentType<PanelHostProps>;
}
