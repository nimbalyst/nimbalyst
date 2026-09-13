import type { Store } from "jotai/vanilla/store";
import type { DocumentFeedbackIndexUpdate } from "../../../shared/documentFeedbackIndex";
import {
  documentFeedbackIndexesAtom,
  documentFeedbackTargetKey,
} from "../atoms/documentFeedback";

export function initDocumentFeedbackListeners(store: Store): () => void {
  return window.electronAPI.on(
    "document-feedback-index:changed",
    (update: DocumentFeedbackIndexUpdate) => {
      if (
        !update?.workspacePath ||
        !update.orgId ||
        !update.teamMemberId ||
        !Array.isArray(update.state?.entries)
      )
        return;
      const key = documentFeedbackTargetKey(update);
      store.set(documentFeedbackIndexesAtom, (all) => {
        const previous = all[key];
        if (
          previous?.teamMemberId === update.teamMemberId &&
          previous.state.epoch === update.state.epoch &&
          previous.state.sequence >= update.state.sequence
        )
          return all;
        return { ...all, [key]: update };
      });
    }
  );
}
