import { atom } from "jotai";
import { atomFamily } from "../debug/atomFamilyRegistry";

// Authoritative list projection includes archived launches. Keep it separate
// from partially hydrated child metadata and user-filtered session lists.
export const sessionLaunchCountsAtom = atom<Record<string, number>>({});

export const sessionLaunchCountAtom = atomFamily((sessionId: string) =>
  atom((get) => get(sessionLaunchCountsAtom)[sessionId] ?? 0)
);
