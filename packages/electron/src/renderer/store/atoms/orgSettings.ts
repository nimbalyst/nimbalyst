import { atom } from 'jotai';

import type { OrgSettings } from '../../../shared/orgSettings';
import { DEFAULT_ORG_SETTINGS } from '../../../shared/orgSettings';
import { atomFamily } from '../debug/atomFamilyRegistry';

export type OrgSettingsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface OrgSettingsLoadState {
  status: OrgSettingsStatus;
  error?: string;
}

/**
 * One organization's settings, defaulted until the real ones load.
 *
 * Gating reads this before the fetch resolves, so the initial value has to be
 * the permissive default: starting from "rooms off" would blink the sidebar's
 * whole rooms section out and back on every time the window opens.
 */
export const orgSettingsAtomFamily = atomFamily(
  (_orgId: string) => atom<OrgSettings>(DEFAULT_ORG_SETTINGS),
);

export const orgSettingsLoadStateAtomFamily = atomFamily(
  (_orgId: string) => atom<OrgSettingsLoadState>({ status: 'idle' }),
);
