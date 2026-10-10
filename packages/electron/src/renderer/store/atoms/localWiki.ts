/**
 * What the Local section knows about its wiki folder, written by the section's
 * data source on every snapshot read (never by a component).
 */
import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';

export interface LocalWikiStatus {
  /** Absolute wiki folder, once main has resolved it. */
  root: string | null;
  /** The folder relative to the project root. */
  location: string | null;
  /** False until the folder exists. */
  exists: boolean;
  /** Database Personal pages the Export action would copy. */
  unexportedPageCount: number;
  /** Problems the last scan reported and did not fix. */
  issueCount: number;
  /** Types whose file did not load, by type id, with the reason. */
  brokenTypes: Readonly<Record<string, string>>;
}

export const EMPTY_LOCAL_WIKI_STATUS: LocalWikiStatus = {
  root: null,
  location: null,
  exists: false,
  unexportedPageCount: 0,
  issueCount: 0,
  brokenTypes: {},
};

export const localWikiStatusAtomFamily = atomFamily((_workspacePath: string) => atom<LocalWikiStatus>(EMPTY_LOCAL_WIKI_STATUS));
