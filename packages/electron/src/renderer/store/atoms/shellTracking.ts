import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';

/** Coverage can change even when the persisted file list remains empty. */
export const shellTrackingRevisionAtom = atomFamily((_sessionId: string) => atom(0));
