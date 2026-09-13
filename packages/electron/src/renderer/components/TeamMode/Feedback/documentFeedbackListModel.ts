import {
  documentFeedbackKey,
  type DocumentFeedbackIndexEntry,
  type FeedbackRequestIndexEntry,
} from "@nimbalyst/collab-protocol";
import {
  FEEDBACK_LIST_FILTERS,
  formatFeedbackAge,
  selectFeedbackRows,
  toFeedbackRowView,
  type FeedbackListFilterId,
  type FeedbackListRowView,
} from "./feedbackListModel";

export type UnifiedFeedbackRow = FeedbackListRowView & {
  target:
    | { kind: "request"; requestId: string }
    | { kind: "document"; entry: DocumentFeedbackIndexEntry };
};

export function selectUnifiedFeedbackRows(input: {
  requests: FeedbackRequestIndexEntry[];
  questions: DocumentFeedbackIndexEntry[];
  viewerUserId: string;
  memberNames: Readonly<Record<string, string>>;
  filter: FeedbackListFilterId;
  query: string;
  now: number;
}): {
  rows: UnifiedFeedbackRow[];
  counts: Record<FeedbackListFilterId, number>;
} {
  const legacy = selectFeedbackRows({ ...input, entries: input.requests });
  const rows: UnifiedFeedbackRow[] = legacy.entries.map((entry) => ({
    ...toFeedbackRowView({
      entry,
      viewerUserId: input.viewerUserId,
      memberNames: input.memberNames,
      now: input.now,
    }),
    id: `request:${entry.requestId}`,
    target: { kind: "request", requestId: entry.requestId },
  }));
  const counts = { ...legacy.counts };
  for (const entry of input.questions) {
    const status = entry.sealed
      ? "closed"
      : entry.answeredCount >= entry.quorum
      ? "answered"
      : "open";
    const matches = (filter: FeedbackListFilterId): boolean => {
      switch (filter) {
        case "all":
          return true;
        case "sentByMe":
          return entry.sentBy === input.viewerUserId;
        case "needsMyResponse":
          return entry.needsMyResponse;
        default:
          return status === filter;
      }
    };
    for (const filter of FEEDBACK_LIST_FILTERS)
      if (matches(filter.id)) counts[filter.id]++;
    const authorLabel =
      entry.sentBy === input.viewerUserId
        ? "You"
        : input.memberNames[entry.sentBy] ?? "Teammate";
    if (
      !matches(input.filter) ||
      !`${entry.title} ${authorLabel}`
        .toLowerCase()
        .includes(input.query.trim().toLowerCase())
    )
      continue;
    rows.push({
      id: `document:${documentFeedbackKey(entry)}`,
      title: entry.title,
      authorLabel,
      status,
      statusLabel:
        entry.availability === "blockRemoved"
          ? "Question removed"
          : entry.sealed
          ? "Settled"
          : status === "answered"
          ? "Answered"
          : "Open",
      progressLabel: `${entry.answeredCount} of ${entry.recipientCount} answered`,
      awaitingFirstResponse: entry.answeredCount === 0,
      timeLabel: formatFeedbackAge(entry.updatedAt, input.now),
      needsViewerResponse: entry.needsMyResponse,
      dimmed: entry.sealed || entry.availability === "blockRemoved",
      subjects: [],
      target: { kind: "document", entry },
    });
  }
  const timestamps = new Map<string, number>([
    ...input.requests.map(
      (entry) => [`request:${entry.requestId}`, entry.updatedAt] as const
    ),
    ...input.questions.map(
      (entry) =>
        [`document:${documentFeedbackKey(entry)}`, entry.updatedAt] as const
    ),
  ]);
  rows.sort(
    (a, b) => (timestamps.get(b.id) ?? 0) - (timestamps.get(a.id) ?? 0)
  );
  return { rows, counts };
}

export function documentFeedbackDeepLink(
  entry: DocumentFeedbackIndexEntry
): string {
  const url = new URL(
    `nimbalyst://doc/${encodeURIComponent(entry.documentId)}`
  );
  url.searchParams.set("orgId", entry.orgId);
  url.searchParams.set("projectId", entry.projectId);
  if (entry.availability === "available")
    url.searchParams.set("blockId", entry.blockId);
  return url.toString();
}
