/**
 * Central listener for gutter badges set by extension backend modules
 * (`ctx.services.panels.setGutterBadge`, main/extensions/backendPanelBadges.ts).
 *
 * Main broadcasts `extension-panels:gutter-badge` to every window with the
 * module's workspace. A window shows a backend badge only while that
 * workspace is active, so this keeps the latest backend value per
 * (workspace, panel) and re-applies it when the multi-project rail switches
 * workspaces. On mount it replays the badges main already holds, because a
 * module can set one before this window existed.
 *
 * Writes go into the same panelGutterBadges store the panel's own
 * `host.setGutterBadge` uses; whichever writes last wins.
 */
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../atoms/openProjects';
import {
  setPanelGutterBadge,
  type PanelGutterBadgeTone,
} from '../../extensions/panels/panelGutterBadges';

const BADGE_CHANNEL = 'extension-panels:gutter-badge';
const LIST_CHANNEL = 'extension-panels:get-gutter-badges';
// A module can badge its panel before this renderer has loaded the extension.
const HOLD = { holdUntilRegistered: true } as const;

interface BackendBadgeUpdate {
  workspacePath: string;
  panelId: string;
  value: number | null;
  tone: PanelGutterBadgeTone;
}

export function initPanelGutterBadgeListeners(): () => void {
  const api = window.electronAPI;
  if (!api?.on) return () => {};

  const byWorkspace = new Map<string, Map<string, BackendBadgeUpdate>>();

  const apply = (update: BackendBadgeUpdate) => {
    if (!update?.workspacePath || !update.panelId) return;
    let panels = byWorkspace.get(update.workspacePath);
    if (update.value === null) {
      panels?.delete(update.panelId);
    } else {
      if (!panels) byWorkspace.set(update.workspacePath, (panels = new Map()));
      panels.set(update.panelId, update);
    }
    if (update.workspacePath === store.get(activeWorkspacePathAtom)) {
      setPanelGutterBadge(update.panelId, update.value, update.tone, HOLD);
    }
  };

  let shownWorkspace = store.get(activeWorkspacePathAtom);
  const offActive = store.sub(activeWorkspacePathAtom, () => {
    const next = store.get(activeWorkspacePathAtom);
    if (next === shownWorkspace) return;
    const leaving = shownWorkspace ? byWorkspace.get(shownWorkspace) : undefined;
    const entering = next ? byWorkspace.get(next) : undefined;
    shownWorkspace = next;
    for (const panelId of leaving?.keys() ?? []) {
      if (!entering?.has(panelId)) setPanelGutterBadge(panelId, null);
    }
    for (const badge of entering?.values() ?? []) {
      setPanelGutterBadge(badge.panelId, badge.value, badge.tone, HOLD);
    }
  });

  // Keys a live broadcast already covered; the replay snapshot is older.
  const live = new Set<string>();
  const offBadge = api.on(BADGE_CHANNEL, (update: BackendBadgeUpdate) => {
    live.add(`${update?.workspacePath}\u001f${update?.panelId}`);
    apply(update);
  });

  let disposed = false;
  void Promise.resolve(api.invoke?.(LIST_CHANNEL))
    .then((rows: BackendBadgeUpdate[] | undefined) => {
      if (disposed || !Array.isArray(rows)) return;
      for (const row of rows) {
        if (!live.has(`${row.workspacePath}\u001f${row.panelId}`)) apply(row);
      }
    })
    // No handler until the privileged host exists; nothing to replay then.
    .catch(() => {});

  return () => {
    disposed = true;
    offBadge?.();
    offActive();
  };
}
