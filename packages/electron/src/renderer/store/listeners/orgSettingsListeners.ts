import type { Store } from 'jotai/vanilla/store';

import type { OrgSettingsChangedEvent } from '../../../shared/orgSettings';
import { normalizeOrgSettings } from '../../../shared/orgSettings';
import { getOrgSettings } from '../../services/orgSettingsClient';
// The store singleton, not the `store/index` barrel: components import
// `refreshOrgSettings` directly, and the barrel would drag every renderer atom
// module in behind it.
import { store } from '@nimbalyst/runtime/store';
import {
  orgSettingsAtomFamily,
  orgSettingsLoadStateAtomFamily,
} from '../atoms/orgSettings';
import { setIfChanged } from './atomRevalidation';
import { createRequestSequence } from './requestSequence';

/**
 * Settings reads race their own broadcasts: an admin turns rooms off, the
 * authoritative broadcast applies, and a GET issued beforehand lands after it
 * and turns them back on. Each read takes a token and drops its result unless
 * it is still the latest; applying a broadcast bumps the sequence.
 */
const settingsRequests = createRequestSequence();

function isOrgSettingsChangedEvent(
  value: unknown,
): value is OrgSettingsChangedEvent {
  return (
    !!value
    && typeof value === 'object'
    && typeof (value as Partial<OrgSettingsChangedEvent>).orgId === 'string'
  );
}

/**
 * Load one explicit organization's settings into renderer state.
 *
 * Exported for the org window's startup: the broadcast listener below only
 * refreshes organizations a window has already loaded, so first hydration is
 * an explicit call and both share one state transition.
 *
 * Stale-while-revalidate: settings that already loaded stay applied while the
 * re-read is in flight, and an unchanged answer writes nothing. The org window
 * re-reads on every focus gain, and every gated section reads these atoms.
 */
export async function refreshOrgSettings(
  orgId: string,
  targetStore: Store = store,
): Promise<void> {
  if (!orgId) throw new Error('Organization settings require orgId');
  const loadStateAtom = orgSettingsLoadStateAtomFamily(orgId);
  const token = settingsRequests.next(orgId);
  if (targetStore.get(loadStateAtom).status !== 'ready') {
    setIfChanged(targetStore, loadStateAtom, { status: 'loading' });
  }
  try {
    const settings = await getOrgSettings({ orgId });
    // Superseded while in flight: a newer read or an authoritative broadcast
    // already wrote this org's settings.
    if (!settingsRequests.isLatest(orgId, token)) return;
    setIfChanged(
      targetStore,
      orgSettingsAtomFamily(orgId),
      normalizeOrgSettings(settings),
    );
    setIfChanged(targetStore, loadStateAtom, { status: 'ready' });
  } catch (error) {
    if (settingsRequests.isLatest(orgId, token)) {
      setIfChanged(targetStore, loadStateAtom, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

/**
 * Installs the renderer-wide organization-settings subscription.
 *
 * Components only read atoms; nothing subscribes to the IPC event itself. The
 * broadcast carries the authoritative settings whenever the sender had them
 * (a local save, or a team-sync update forwarded through main), so the common
 * case applies without a round trip.
 */
export function initOrgSettingsListeners(
  targetStore: Store = store,
): () => void {
  return window.electronAPI.on('org:settings-changed', (payload: unknown) => {
    if (!isOrgSettingsChangedEvent(payload)) return;
    const loadStateAtom = orgSettingsLoadStateAtomFamily(payload.orgId);
    if (targetStore.get(loadStateAtom).status === 'idle') return;
    if (payload.settings) {
      // Authoritative: invalidate every read that was already in flight so an
      // older GET cannot re-enable what this broadcast just turned off.
      settingsRequests.bump(payload.orgId);
      setIfChanged(
        targetStore,
        orgSettingsAtomFamily(payload.orgId),
        normalizeOrgSettings(payload.settings),
      );
      setIfChanged(targetStore, loadStateAtom, { status: 'ready' });
      return;
    }
    void refreshOrgSettings(payload.orgId, targetStore).catch((error) => {
      console.error(
        `[OrgSettings] Failed to refresh ${payload.orgId}:`,
        error,
      );
    });
  });
}
