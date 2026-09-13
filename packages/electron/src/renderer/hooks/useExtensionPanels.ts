import { useEffect } from 'react';
import { useAtom, useAtomValue, useStore } from 'jotai';
import { getPanelById } from '../extensions/panels/PanelRegistry';
import {
  activeExtensionPanelAtom,
  activeExtensionBottomPanelAtom,
  extensionPanelStateAtomFamily,
} from '../store/atoms/extensionPanels';
import { loadActiveExtensionPanel, persistActiveExtensionPanel } from '../utils/activeExtensionPanelPersistence';

export function useExtensionPanels(workspacePath: string | null, extensionsReady: boolean) {
  const store = useStore();
  const [activeExtensionPanel, setActiveExtensionPanel] = useAtom(activeExtensionPanelAtom);
  const [activeExtensionBottomPanel, setActiveExtensionBottomPanel] = useAtom(activeExtensionBottomPanelAtom);
  const stateAtom = extensionPanelStateAtomFamily(workspacePath ?? '');
  const { panelId, hydrated } = useAtomValue(stateAtom);

  useEffect(() => {
    // Wait for eager extensions to register before resolving a saved sidebar.
    if (!workspacePath || !extensionsReady || store.get(stateAtom).hydrated) return;
    let cancelled = false;
    void loadActiveExtensionPanel(workspacePath, (id) => getPanelById(id)?.placement === 'sidebar')
      .then((restored) => {
        if (cancelled) return;
        const current = store.get(stateAtom);
        // A deep link or panel click wins over a saved selection, including
        // navigation that arrived before extensions were ready to hydrate.
        store.set(stateAtom, {
          ...current,
          panelId: current.revision === 0 ? restored : current.panelId,
          hydrated: true,
        });
      });
    return () => { cancelled = true; };
  }, [workspacePath, extensionsReady, stateAtom, store]);

  useEffect(() => {
    if (!workspacePath || !hydrated) return;
    void persistActiveExtensionPanel(workspacePath, panelId);
  }, [workspacePath, panelId, hydrated]);

  return { activeExtensionPanel, setActiveExtensionPanel, activeExtensionBottomPanel, setActiveExtensionBottomPanel };
}
