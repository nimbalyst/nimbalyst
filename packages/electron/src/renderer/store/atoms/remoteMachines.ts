import { atom } from "jotai";
import { atomFamily } from "../debug/atomFamilyRegistry";

/** Empty host means this desktop; workspace paths on the viewer stay unchanged. */
export const selectedMachineAtom = atomFamily((_workspace: string) =>
  atom<string>("")
);
export const machineSessionSelectionsAtom = atomFamily((_workspace: string) =>
  atom<Record<string, string>>({})
);
