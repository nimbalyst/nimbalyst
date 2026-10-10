import { atom } from 'jotai';
import { atomFamily } from '../../store/debug/atomFamilyRegistry';
import type { PlacedViewHandoff } from '@nimbalyst/collab-client/trackers-ui/page';

/** Window-local exploration, isolated by workspace and the page's actual scope. */
export const temporaryTypeViewKey = (workspace: string, scopeKey: string, typeId: string): string => JSON.stringify([workspace, scopeKey, typeId]);
export const temporaryTypeViewAtom = atomFamily((_key: string) => atom<PlacedViewHandoff | null>(null));
