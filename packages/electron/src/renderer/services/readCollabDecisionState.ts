import * as Y from "yjs";
import yaml from "js-yaml";
import {
  decisionDefaultVisibility,
  isDecisionAskType,
  type FeedbackAnswer,
  type DocumentDecisionDeliveryState,
  type DecisionVote,
} from "@nimbalyst/collab-protocol";
import { YDocDecisionRepository } from "@nimbalyst/runtime/editor/decisions/YDocDecisionRepository";
import {
  acquireHeadlessCollabDocument,
  assertDecodable,
  HeadlessCollabDocumentError,
  projectCollabDocContent,
  requireCollabCodec,
} from "./HeadlessCollabDocument";

/** Visit only identifiable decision fences; unknown types are private by default. */
function visitDecisionFences(
  doc: Y.Doc,
  callback: (
    node: Y.XmlElement,
    raw: Record<string, unknown>,
    hidden: boolean
  ) => void
) {
  const visit = (value: unknown): void => {
    if (value instanceof Y.XmlElement) {
      const content = value.getAttribute("__content");
      if (
        value.getAttribute("__type") === "decision" &&
        typeof content === "string" &&
        content.length <= 128 * 1024
      ) {
        try {
          const raw = yaml.load(content, {
            schema: yaml.JSON_SCHEMA,
          }) as Record<string, unknown> | null;
          if (
            raw &&
            typeof raw.id === "string" &&
            raw.id.length > 0 &&
            raw.id.length <= 128 &&
            !raw.id.includes("\x1f")
          ) {
            const visibility =
              raw.visibility ??
              (isDecisionAskType(raw.type)
                ? decisionDefaultVisibility(raw.type)
                : "hiddenUntilAnswered");
            callback(value, raw, visibility !== "open");
          }
        } catch {
          /* Malformed blocks have no reliable identity. */
        }
      }
      value.toArray().forEach(visit);
    } else if (value instanceof Y.XmlText) {
      value
        .toDelta()
        .forEach((entry: { insert: unknown }) => visit(entry.insert));
    }
  };
  visit(doc.get("root", Y.XmlText));
}

function privateDecisionIds(
  states: readonly DocumentDecisionDeliveryState[]
): Set<string> {
  const ids = new Set<string>();
  for (const state of states) {
    if (state.privateResponses) ids.add(state.blockId);
    for (const id of state.privateGroupBlockIds ?? []) ids.add(id);
  }
  return ids;
}

/** Read-only supplemental data; never append this projection to editable markdown. */
export function snapshotCollabDecisions(
  doc: Y.Doc,
  states: readonly DocumentDecisionDeliveryState[] = []
) {
  const ids = new Set<string>();
  const duplicates = new Set<string>();
  const hiddenIds = privateDecisionIds(states);
  visitDecisionFences(doc, (_node, raw, hidden) => {
    const id = raw.id as string;
    if (ids.has(id)) duplicates.add(id);
    ids.add(id);
    if (hidden) hiddenIds.add(id);
  });
  for (const id of duplicates) ids.delete(id);
  let truncated = false;
  const text = (value: string | undefined) => {
    if (value === undefined) return undefined;
    if (value.length > 4096) truncated = true;
    return value.slice(0, 4096);
  };
  const list = (values: string[]) => {
    if (values.length > 100) truncated = true;
    return values.slice(0, 100).map((value) => text(value)!);
  };
  // Whitelist fields: repository storage may contain future or private metadata.
  const answer = (value: FeedbackAnswer): FeedbackAnswer => {
    switch (value.type) {
      case "confirm":
        return { type: value.type, value: value.value };
      case "rating":
        return { type: value.type, value: value.value };
      case "singleSelect":
        return {
          type: value.type,
          selectedId: text(value.selectedId)!,
          ...(value.otherText === undefined
            ? {}
            : { otherText: text(value.otherText) }),
        };
      case "multiSelect":
        return { type: value.type, selectedIds: list(value.selectedIds) };
      case "reorder":
        return {
          type: value.type,
          orderedIds: list(value.orderedIds),
          removedIds: list(value.removedIds),
        };
      case "editText":
        return {
          type: value.type,
          text: text(value.text)!,
          edited: value.edited,
        };
    }
  };
  const repository = new YDocDecisionRepository(doc);
  try {
    const snapshot = repository.getSnapshot();
    const blocks: Array<{
      blockId: string;
      humanVotes: unknown[];
      agentRecommendations: unknown[];
      myVote?: unknown;
      canSeeAll?: boolean;
    }> = [];
    let remaining = 64 * 1024;
    const append = (target: unknown[], value: unknown) => {
      const length = JSON.stringify(value).length;
      if (length > remaining) {
        truncated = true;
        return;
      }
      remaining -= length;
      target.push(value);
    };
    const projectVote = (vote: DecisionVote) => ({
      voterId: text(vote.voterId),
      voterName: text(vote.voterName),
      answer: answer(vote.answer),
      at: vote.at,
      note: text(vote.note),
    });
    for (const blockId of ids) {
      if (blocks.length >= 50 || remaining < 512) {
        truncated = true;
        break;
      }
      remaining -= 512;
      const block: (typeof blocks)[number] = {
        blockId,
        humanVotes: [],
        agentRecommendations: [],
      };
      const privateResponses = states.find(
        (state) => state.blockId === blockId
      )?.privateResponses;
      const privateMode = !!privateResponses || hiddenIds.has(blockId);
      const votes = privateMode
        ? privateResponses?.votes ?? []
        : snapshot.votesByBlock[blockId] ?? [];
      // Agent recommendations are public opinions, separate from private ballots.
      const recommendations = snapshot.recommendationsByBlock[blockId] ?? [];
      if (votes.length > 100 || recommendations.length > 100) truncated = true;
      if (privateMode) {
        block.canSeeAll = privateResponses?.canSeeAll ?? false;
        if (privateResponses?.myVote) {
          const own: unknown[] = [];
          append(own, projectVote(privateResponses.myVote));
          if (own.length) block.myVote = own[0];
        }
      }
      for (const vote of votes.slice(0, 100))
        append(block.humanVotes, projectVote(vote));
      for (const recommendation of recommendations.slice(0, 100))
        append(block.agentRecommendations, {
          agentId: text(recommendation.agentId),
          agentName: text(recommendation.agentName),
          onBehalfOfUserId: text(recommendation.onBehalfOfUserId),
          answer: answer(recommendation.answer),
          at: recommendation.at,
          rationale: text(recommendation.rationale),
        });
      blocks.push(block);
    }
    return { readOnly: true as const, blocks, truncated };
  } finally {
    repository.destroy();
  }
}

export async function readCollabDocWithDecisionState(
  documentUri: string,
  workspacePath: string | null | undefined
) {
  if (!workspacePath)
    throw new HeadlessCollabDocumentError(
      "DOCUMENT_NOT_AVAILABLE",
      "No workspace is available to read shared decision state."
    );
  const acquisition = await acquireHeadlessCollabDocument(
    documentUri,
    workspacePath
  );
  try {
    assertDecodable(acquisition, documentUri);
    if (!acquisition.syncProvider?.requestDecision)
      throw new Error(
        "Authorized decision state is unavailable in this connection."
      );
    const result = await acquisition.syncProvider.requestDecision({
      operation: "list",
    });
    if (result.loaded !== true || result.privacyVersion !== 1)
      throw new Error(
        "Authorized decision state is unavailable or does not support private answers."
      );
    const { decisions } = result;
    const decisionState = snapshotCollabDecisions(acquisition.yDoc, decisions);
    // Lets the tool name the page when its body is empty, so an empty read is
    // an explicit answer rather than no output.
    const page = {
      title: acquisition.document?.title,
      documentType: acquisition.documentType,
    };
    // Sanitize an isolated projection, never the live replica or its persisted
    // history. Hidden historical seals may already contain individual ballots.
    const privateIds = privateDecisionIds(decisions);
    visitDecisionFences(acquisition.yDoc, (_node, raw, hidden) => {
      if (hidden) privateIds.add(raw.id as string);
    });
    if (privateIds.size === 0)
      return {
        content: projectCollabDocContent(
          requireCollabCodec(acquisition.documentType),
          acquisition.yDoc
        ),
        decisionState,
        ...page,
      };
    const projection = new Y.Doc();
    try {
      Y.applyUpdate(projection, Y.encodeStateAsUpdate(acquisition.yDoc));
      visitDecisionFences(projection, (node, raw, hidden) => {
        if (!hidden && !privateIds.has(raw.id as string)) return;
        for (const key of [
          "votes",
          "notes",
          "resolvedFrom",
          "score",
          "distribution",
        ])
          delete raw[key];
        node.setAttribute(
          "__content",
          yaml.dump(raw, { lineWidth: -1, noRefs: true })
        );
      });
      const content = projectCollabDocContent(
        requireCollabCodec(acquisition.documentType),
        projection
      );
      return { content, decisionState, ...page };
    } finally {
      projection.destroy();
    }
  } finally {
    acquisition.release();
  }
}
