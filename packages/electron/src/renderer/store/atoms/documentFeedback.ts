import { atom } from "jotai";
import { atomFamily } from "../debug/atomFamilyRegistry";
import type { DocumentFeedbackIndexUpdate } from "../../../shared/documentFeedbackIndex";
import {
  documentFeedbackTargetKey,
  documentFeedbackViewerKey,
} from "../../../shared/documentFeedbackIndex";

/** Only central index events write this scope/identity registry. */
export const documentFeedbackIndexesAtom = atom<
  Record<string, DocumentFeedbackIndexUpdate>
>({});
export const documentFeedbackIndexAtomFamily = atomFamily((key: string) =>
  atom((get) => get(documentFeedbackIndexesAtom)[key])
);
export { documentFeedbackTargetKey, documentFeedbackViewerKey };
