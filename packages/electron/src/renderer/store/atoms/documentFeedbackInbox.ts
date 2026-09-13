import { atom } from "jotai";
import type {
  TeamInboxMaterializedDelivery,
  TeamInboxSnapshot,
} from "@nimbalyst/runtime/sync";
import type { DocumentFeedbackIndexUpdate } from "../../../shared/documentFeedbackIndex";
import { documentFeedbackIndexesAtom } from "./documentFeedback";

export type DocumentFeedbackInboxDelivery = TeamInboxMaterializedDelivery & {
  documentDecisionNeedsResponse?: boolean;
};

export function withDocumentFeedbackState(
  snapshot: TeamInboxSnapshot,
  indexes: Record<string, DocumentFeedbackIndexUpdate>
): TeamInboxSnapshot {
  return {
    ...snapshot,
    deliveries: snapshot.deliveries.map(
      (delivery): DocumentFeedbackInboxDelivery => {
        const source = delivery.source;
        if (
          delivery.unavailable ||
          !source ||
          !("resourceKind" in source) ||
          source.resourceKind !== "document" ||
          !["documentDecisionRequested", "documentDecisionNudged"].includes(
            source.eventClass
          )
        )
          return delivery;
        const index = Object.values(indexes)
          .filter(
            (index) =>
              index.orgId === delivery.orgId &&
              index.teamMemberId === delivery.teamMemberId
          )
          .sort((a, b) => b.state.generation - a.state.generation)[0];
        const entry = index?.state.entries.find(
          (entry) =>
            entry.documentId === source.resourceId &&
            entry.blockId === source.blockId
        );
        return {
          ...delivery,
          documentDecisionNeedsResponse: entry?.needsMyResponse === true,
        };
      }
    ),
  };
}

export function withDocumentFeedbackAtom(
  source: import("jotai").Atom<TeamInboxSnapshot>
) {
  return atom((get) =>
    withDocumentFeedbackState(get(source), get(documentFeedbackIndexesAtom))
  );
}
