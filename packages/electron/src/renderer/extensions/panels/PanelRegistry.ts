/**
 * Panel Registry
 *
 * Tracks registered extension panels and provides lookups.
 * Syncs with ExtensionLoader to stay up-to-date as extensions load/unload.
 */

import type { ComponentType } from 'react';
import { getExtensionLoader, type LoadedPanel, type PanelHostProps, type PanelGutterButtonProps } from '@nimbalyst/runtime';
import { registerCommand, unregisterExtension } from '../commands/ExtensionCommandRegistry';

// ============================================================================
// Types
// ============================================================================

/**
 * Panel information for the gutter and content area.
 */
export interface RegisteredPanel {
  /** Full panel ID (extensionId.panelId) */
  id: string;

  /** Extension that provides this panel */
  extensionId: string;

  /** Display title */
  title: string;

  /** Icon for gutter button */
  icon: string;

  /** Placement mode */
  placement: 'sidebar' | 'fullscreen' | 'floating' | 'bottom';

  /** Whether this panel supports AI tools */
  aiSupported: boolean;

  /** Sort order for gutter buttons */
  order: number;

  /**
   * Release channel this extension requires. When 'alpha', the gutter button
   * gets an alpha badge so users can tell it's not a stable feature.
   */
  requiredReleaseChannel?: 'stable' | 'alpha';

  /**
   * Help tooltip from the panel contribution.
   * Injected into the HelpContent system automatically.
   */
  tooltip?: string;

  /** Main panel component */
  component: ComponentType<PanelHostProps>;

  /** Optional custom gutter button */
  gutterButton?: ComponentType<PanelGutterButtonProps>;

  /** Optional settings component for panel header */
  settingsComponent?: ComponentType<PanelHostProps>;
}

// ============================================================================
// Registry State
// ============================================================================

let registeredPanels: RegisteredPanel[] = [];
const listeners = new Set<() => void>();

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the panel registry and sync with ExtensionLoader.
 */
export function initializePanelRegistry(): void {
  const loader = getExtensionLoader();

  // Initial sync
  syncPanels();

  // Subscribe to extension changes
  loader.subscribe(syncPanels);
}

/**
 * Get all registered panels.
 */
export function getRegisteredPanels(): RegisteredPanel[] {
  return registeredPanels;
}

/**
 * Get panels by placement type.
 */
export function getPanelsByPlacement(placement: 'sidebar' | 'fullscreen' | 'floating' | 'bottom'): RegisteredPanel[] {
  return registeredPanels.filter(p => p.placement === placement);
}

/**
 * Get a panel by its full ID.
 */
export function getPanelById(panelId: string): RegisteredPanel | undefined {
  return registeredPanels.find(p => p.id === panelId);
}

/**
 * Subscribe to panel registry changes.
 */
export function subscribeToPanelRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ============================================================================
// Internal Functions
// ============================================================================

// Track extension IDs we've registered toggle commands for
const panelToggleCommandExtensions = new Set<string>();

function syncPanels(): void {
  const loader = getExtensionLoader();
  const loadedPanels = loader.getPanels();

  // Unregister toggle commands for extensions no longer loaded
  const currentExtensionIds = new Set(loadedPanels.map(p => p.extensionId));
  for (const extId of panelToggleCommandExtensions) {
    if (!currentExtensionIds.has(extId)) {
      unregisterExtension(extId);
      panelToggleCommandExtensions.delete(extId);
    }
  }

  // Build a map of extensionId -> requiredReleaseChannel for badge rendering
  const channelByExtension = new Map<string, 'stable' | 'alpha' | undefined>();
  for (const ext of loader.getLoadedExtensions()) {
    channelByExtension.set(ext.manifest.id, ext.manifest.requiredReleaseChannel);
  }

  registeredPanels = loadedPanels.map(p =>
    convertToRegisteredPanel(p, channelByExtension.get(p.extensionId))
  );

  // Auto-register panel toggle commands for new panels
  for (const panel of registeredPanels) {
    if (panelToggleCommandExtensions.has(panel.extensionId)) continue;

    const commandId = `${panel.id}.toggle`;
    registerCommand(
      commandId,
      panel.extensionId,
      `Toggle ${panel.title} Panel`,
      () => {
        window.dispatchEvent(
          new CustomEvent('nimbalyst:toggle-panel', { detail: { panelId: panel.id } })
        );
      }
    );
  }

  // Mark extensions as registered (per extension, not per panel — one registration pass per ext)
  for (const panel of registeredPanels) {
    panelToggleCommandExtensions.add(panel.extensionId);
  }

  // Sort by order
  registeredPanels.sort((a, b) => a.order - b.order);

  // Notify listeners
  notifyListeners();

  console.log(`[PanelRegistry] Synced ${registeredPanels.length} panel(s)`);
}

function convertToRegisteredPanel(
  loaded: LoadedPanel,
  requiredReleaseChannel: 'stable' | 'alpha' | undefined
): RegisteredPanel {
  return {
    id: loaded.id,
    extensionId: loaded.extensionId,
    title: loaded.contribution.title,
    icon: loaded.contribution.icon,
    placement: loaded.contribution.placement,
    aiSupported: loaded.contribution.aiSupported ?? false,
    order: loaded.contribution.order ?? 100,
    requiredReleaseChannel,
    tooltip: loaded.contribution.tooltip,
    component: loaded.component,
    gutterButton: loaded.gutterButton,
    settingsComponent: loaded.settingsComponent,
  };
}

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error('[PanelRegistry] Error in listener:', error);
    }
  }
}
