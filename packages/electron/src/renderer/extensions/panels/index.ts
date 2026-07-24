/**
 * Extension Panels Module
 *
 * Provides panel registration, hosting, and rendering for extension panels.
 */

export {
  initializePanelRegistry,
  getRegisteredPanels,
  getPanelsByPlacement,
  getPanelById,
  subscribeToPanelRegistry,
  type RegisteredPanel,
} from './PanelRegistry';

export { createPanelHost } from './PanelHostImpl';

export { PanelContainer } from './PanelContainer';

export { usePanels } from './usePanels';

export {
  electronStorageBackend,
  initializeElectronStorageBackend,
  updateWorkspacePath,
} from './ElectronStorageBackend';
