/**
 * Permissions Atoms
 *
 * Lightweight version counter incremented every time the main process emits
 * a `permissions:changed` event. Components that need to react use this atom
 * as a useEffect dependency to re-query their permission state.
 *
 * Updated by store/listeners/permissionListeners.ts.
 */

import { atom } from 'jotai';

export const permissionsChangedVersionAtom = atom(0);
