/**
 * Pure, host-neutral layout model for the Team Work Radar tracker view.
 *
 * Radar consumes only tracker records that already sync. Browser and desktop
 * hosts may add presence or local enrichment, but every field beyond the
 * tracker event spine is optional by design.
 */

import type {
  TrackerActivity,
  TrackerComment,
  TrackerIdentity,
} from "./types.js";
import type { TrackerRecord } from "./trackerRecord.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_WINDOW_HOURS = 24;
const MIN_WINDOW_HOURS = 2;
const MAX_WINDOW_HOURS = 72;
const DEFAULT_RUN_GAP_MS = 10 * 60 * 1000;
const DEFAULT_OVERLAP_MS = HOUR_MS;
const DEFAULT_STALLED_MS = 3 * DAY_MS;
const POINT_SPAN_MS = 8 * 60 * 1000;

export type RadarActivityAction = TrackerActivity["action"];
export type RadarEventSource = "activity" | "comment" | "fallback";

export interface RadarEvent {
  id: string;
  itemId: string;
  actor: TrackerIdentity;
  actorKey: string;
  action: RadarActivityAction;
  timestamp: number;
  source: RadarEventSource;
  field?: string;
  oldValue?: string;
  newValue?: string;
  note?: string;
  body?: string;
}

export interface RadarSegment {
  state: string;
  startAt: number;
  endAt: number;
}

export interface RadarPresence {
  status: "online" | "away" | "offline";
  lastHeartbeatAt?: number;
}

export interface RadarLaneEnrichment {
  liveSessions?: number;
  unpushedCommits?: number;
  divergence?: string;
}

export interface RadarMark {
  id: string;
  kind: "thread" | "run";
  actorKey: string;
  itemIds: string[];
  items: TrackerRecord[];
  primaryType: string;
  label: string;
  state: string;
  startAt: number;
  endAt: number;
  lastActivityAt: number;
  row: number;
  events: RadarEvent[];
  segments: RadarSegment[];
  agentDriven: boolean;
  hasCommit: boolean;
  truncatedStart: boolean;
}

export interface RadarStalledItem {
  itemId: string;
  issueKey?: string;
  title: string;
  state: string;
  lastActivityAt: number;
}

export interface RadarLane {
  actor: TrackerIdentity;
  actorKey: string;
  isCurrentUser: boolean;
  isAutomation: boolean;
  summary: string;
  lastActivityAt: number;
  marks: RadarMark[];
  subRowCount: number;
  stalled: RadarStalledItem[];
  presence?: RadarPresence;
  enrichment?: RadarLaneEnrichment;
}

export type RadarTieType = "overlap" | "hand-off" | "review";

export interface RadarTie {
  itemId: string;
  issueKey?: string;
  title: string;
  type: RadarTieType;
  fromActorKey: string;
  toActorKey: string;
  fromAt: number;
  toAt: number;
}

export interface RadarActionItem {
  itemId: string;
  issueKey?: string;
  title: string;
  actor: TrackerIdentity;
  at: number;
  reason: "commented" | "reviewed" | "handed-off" | "updated";
}

export interface TrackerRadarModel {
  windowStart: number;
  windowEnd: number;
  windowHours: number;
  windowSource: "preset" | "since-left" | "default";
  lanes: RadarLane[];
  ties: RadarTie[];
  waitingOnYou: RadarActionItem[];
  youHandedOff: RadarActionItem[];
}

export interface RadarWindowOptions {
  nowMs?: number;
  windowHours?: number;
  lastSeenAt?: number;
}

export interface ResolvedRadarWindow {
  startAt: number;
  endAt: number;
  windowHours: number;
  source: "preset" | "since-left" | "default";
}

export interface BuildTrackerRadarOptions extends RadarWindowOptions {
  currentIdentity?: TrackerIdentity | null;
  presenceByActorKey?: Readonly<Record<string, RadarPresence>>;
  enrichmentByActorKey?: Readonly<Record<string, RadarLaneEnrichment>>;
  runGapMs?: number;
  runMinItems?: number;
  overlapMs?: number;
  stalledAfterMs?: number;
  getTitle?: (record: TrackerRecord) => string;
  getStatus?: (record: TrackerRecord) => string;
}

export interface RecentTeammateActivity {
  actor: TrackerIdentity;
  action: RadarActivityAction;
  at: number;
  relativeLabel: string;
  summary: string;
}

const AUTOMATION_IDENTITY: TrackerIdentity = {
  email: null,
  displayName: "Automation",
  gitName: null,
  gitEmail: null,
};

function normalizedHours(value: number): number {
  return Math.min(MAX_WINDOW_HOURS, Math.max(MIN_WINDOW_HOURS, value));
}

export function resolveRadarWindow(
  options: RadarWindowOptions = {}
): ResolvedRadarWindow {
  const endAt = options.nowMs ?? Date.now();
  if (Number.isFinite(options.windowHours)) {
    const windowHours = normalizedHours(Number(options.windowHours));
    return {
      startAt: endAt - windowHours * HOUR_MS,
      endAt,
      windowHours,
      source: "preset",
    };
  }
  if (Number.isFinite(options.lastSeenAt)) {
    const elapsedHours =
      Math.max(0, endAt - Number(options.lastSeenAt)) / HOUR_MS;
    const windowHours = normalizedHours(elapsedHours);
    return {
      startAt: endAt - windowHours * HOUR_MS,
      endAt,
      windowHours,
      source: "since-left",
    };
  }
  return {
    startAt: endAt - DEFAULT_WINDOW_HOURS * HOUR_MS,
    endAt,
    windowHours: DEFAULT_WINDOW_HOURS,
    source: "default",
  };
}

function normalizeIdentity(value: unknown): TrackerIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<TrackerIdentity>;
  const displayName =
    typeof candidate.displayName === "string"
      ? candidate.displayName.trim()
      : "";
  const email =
    typeof candidate.email === "string" && candidate.email.trim()
      ? candidate.email.trim()
      : null;
  const gitName =
    typeof candidate.gitName === "string" && candidate.gitName.trim()
      ? candidate.gitName.trim()
      : null;
  const gitEmail =
    typeof candidate.gitEmail === "string" && candidate.gitEmail.trim()
      ? candidate.gitEmail.trim()
      : null;
  if (!displayName && !email && !gitName && !gitEmail) return null;
  return {
    email,
    displayName: displayName || email || gitName || "Unknown",
    gitName,
    gitEmail,
  };
}

export function trackerRadarActorKey(
  identity: TrackerIdentity | null | undefined
): string {
  if (!identity) return "automation";
  if (identity.email) return `email:${identity.email.trim().toLowerCase()}`;
  if (identity.gitEmail)
    return `git-email:${identity.gitEmail.trim().toLowerCase()}`;
  if (identity.gitName)
    return `git-name:${identity.gitName.trim().toLowerCase()}`;
  const name = identity.displayName.trim().toLowerCase();
  return name ? `name:${name}` : "automation";
}

function sameActor(
  a: TrackerIdentity | null | undefined,
  b: TrackerIdentity | null | undefined
): boolean {
  return trackerRadarActorKey(a) === trackerRadarActorKey(b);
}

function timeValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string"
    ? value
    : value == null
    ? undefined
    : String(value);
}

function defaultTitle(record: TrackerRecord): string {
  const title = record.fields.title ?? record.fields.name;
  return typeof title === "string" && title.trim()
    ? title.trim()
    : record.issueKey ?? record.id;
}

function defaultStatus(record: TrackerRecord): string {
  const status = record.fields.status ?? record.fields.state;
  return typeof status === "string" && status.trim() ? status.trim() : "active";
}

/** Normalize the historical malformed writer shapes before any layout logic. */
export function normalizeTrackerRadarEvents(
  record: TrackerRecord
): RadarEvent[] {
  const comments = Array.isArray(record.system.comments)
    ? record.system.comments
    : [];
  const commentKeys = new Set<string>();
  const events: RadarEvent[] = [];

  for (const rawComment of comments as unknown as TrackerComment[]) {
    if (!rawComment || typeof rawComment !== "object" || rawComment.deleted)
      continue;
    const timestamp = timeValue(rawComment.createdAt);
    if (timestamp === null) continue;
    const actor =
      normalizeIdentity(rawComment.authorIdentity) ?? AUTOMATION_IDENTITY;
    const actorKey = trackerRadarActorKey(actor);
    commentKeys.add(`${actorKey}:${timestamp}`);
    events.push({
      id:
        typeof rawComment.id === "string" && rawComment.id
          ? rawComment.id
          : `comment:${record.id}:${timestamp}`,
      itemId: record.id,
      actor,
      actorKey,
      action: "commented",
      timestamp,
      source: "comment",
      body: typeof rawComment.body === "string" ? rawComment.body : undefined,
    });
  }

  const activity = Array.isArray(record.system.activity)
    ? record.system.activity
    : [];
  for (const [index, raw] of (activity as unknown[]).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    const timestamp = timeValue(candidate.timestamp);
    if (timestamp === null) continue;
    const actor =
      normalizeIdentity(candidate.authorIdentity) ?? AUTOMATION_IDENTITY;
    const actorKey = trackerRadarActorKey(actor);
    const action =
      typeof candidate.action === "string"
        ? (candidate.action as RadarActivityAction)
        : "updated";
    if (action === "commented" && commentKeys.has(`${actorKey}:${timestamp}`))
      continue;
    events.push({
      id:
        typeof candidate.id === "string" && candidate.id
          ? candidate.id
          : `activity:${record.id}:${timestamp}:${index}`,
      itemId: record.id,
      actor,
      actorKey,
      action,
      timestamp,
      source: "activity",
      field: stringValue(candidate.field),
      oldValue: stringValue(candidate.oldValue),
      newValue: stringValue(candidate.newValue),
      note: stringValue(candidate.note),
    });
  }

  if (events.length === 0) {
    const timestamp = timeValue(record.system.updatedAt);
    if (timestamp !== null) {
      const actor =
        normalizeIdentity(
          record.system.lastModifiedBy ?? record.system.authorIdentity
        ) ?? AUTOMATION_IDENTITY;
      events.push({
        id: `fallback:${record.id}:${timestamp}`,
        itemId: record.id,
        actor,
        actorKey: trackerRadarActorKey(actor),
        action: "updated",
        timestamp,
        source: "fallback",
      });
    }
  }

  return events.sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)
  );
}

function buildSegments(
  events: RadarEvent[],
  currentState: string
): RadarSegment[] {
  if (events.length === 0) return [];
  const changes = events.filter((event) => event.action === "status_changed");
  if (changes.length === 0) {
    return [
      {
        state: currentState,
        startAt: events[0]!.timestamp,
        endAt: events[events.length - 1]!.timestamp,
      },
    ];
  }
  let state = changes[0]!.oldValue || currentState;
  let startAt = events[0]!.timestamp;
  const segments: RadarSegment[] = [];
  for (const change of changes) {
    segments.push({ state, startAt, endAt: change.timestamp });
    state = change.newValue || state;
    startAt = change.timestamp;
  }
  segments.push({
    state,
    startAt,
    endAt: events[events.length - 1]!.timestamp,
  });
  return segments;
}

function markSignature(mark: RadarMark): string {
  const event = mark.events[mark.events.length - 1]!;
  return `${event.action}:${event.field ?? ""}`;
}

function pluralType(type: string, count: number): string {
  if (count === 1) return type;
  if (type.endsWith("s")) return type;
  if (type.endsWith("y")) return `${type.slice(0, -1)}ies`;
  return `${type}s`;
}

function runLabel(mark: RadarMark, count: number): string {
  const event = mark.events[mark.events.length - 1]!;
  const target = `${count} ${pluralType(mark.primaryType, count)}`;
  if (event.action === "status_changed") return `Moved ${target}`;
  if (event.action === "commented") return `Commented on ${target}`;
  if (event.action === "created") return `Created ${target}`;
  if (event.field) return `Set ${event.field} on ${target}`;
  return `Updated ${target}`;
}

function collapseRuns(
  marks: RadarMark[],
  runGapMs: number,
  runMinItems: number
): RadarMark[] {
  const sorted = [...marks].sort(
    (a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id)
  );
  const output: RadarMark[] = [];
  let cursor = 0;
  while (cursor < sorted.length) {
    const first = sorted[cursor]!;
    const group = [first];
    let index = cursor + 1;
    while (index < sorted.length) {
      const next = sorted[index]!;
      const previous = group[group.length - 1]!;
      if (
        next.primaryType !== first.primaryType ||
        markSignature(next) !== markSignature(first) ||
        next.startAt - previous.endAt >= runGapMs
      )
        break;
      group.push(next);
      index += 1;
    }
    const itemIds = [...new Set(group.flatMap((mark) => mark.itemIds))];
    if (itemIds.length >= runMinItems) {
      const events = group
        .flatMap((mark) => mark.events)
        .sort((a, b) => a.timestamp - b.timestamp);
      const items = group.flatMap((mark) => mark.items);
      output.push({
        id: `run:${first.actorKey}:${first.primaryType}:${
          events[0]!.timestamp
        }`,
        kind: "run",
        actorKey: first.actorKey,
        itemIds,
        items,
        primaryType: first.primaryType,
        label: runLabel(first, itemIds.length),
        state: group[group.length - 1]!.state,
        startAt: Math.min(...group.map((mark) => mark.startAt)),
        endAt: Math.max(...group.map((mark) => mark.endAt)),
        lastActivityAt: Math.max(...group.map((mark) => mark.lastActivityAt)),
        row: 0,
        events,
        segments: [],
        agentDriven: group.some((mark) => mark.agentDriven),
        hasCommit: group.some((mark) => mark.hasCommit),
        truncatedStart: group.some((mark) => mark.truncatedStart),
      });
    } else {
      output.push(...group);
    }
    cursor = index;
  }
  return output.sort(
    (a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id)
  );
}

function assignRows(marks: RadarMark[]): number {
  const rowEnds: number[] = [];
  for (const mark of marks) {
    const visualEnd = Math.max(mark.endAt, mark.startAt + POINT_SPAN_MS);
    let row = rowEnds.findIndex((end) => end <= mark.startAt);
    if (row < 0) row = rowEnds.length;
    mark.row = row;
    rowEnds[row] = visualEnd;
  }
  return Math.max(1, rowEnds.length);
}

function laneSummary(marks: RadarMark[], stalledCount: number): string {
  const states = marks.map((mark) => mark.state.toLowerCase());
  const completed = states.filter(
    (state) => state === "done" || state === "completed" || state === "closed"
  ).length;
  const reviewing = states.filter(
    (state) => state === "in-review" || state === "review"
  ).length;
  const runs = marks.filter((mark) => mark.kind === "run").length;
  const parts: string[] = [];
  if (completed) parts.push(`${completed} completed`);
  if (reviewing) parts.push(`${reviewing} in review`);
  if (runs) parts.push(`${runs} sweep${runs === 1 ? "" : "s"}`);
  if (stalledCount) parts.push(`${stalledCount} stalled`);
  if (parts.length === 0)
    parts.push(`${new Set(marks.flatMap((mark) => mark.itemIds)).size} active`);
  return parts.join(" · ");
}

function closestEventDistance(a: RadarEvent[], b: RadarEvent[]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const left of a) {
    for (const right of b)
      distance = Math.min(distance, Math.abs(left.timestamp - right.timestamp));
  }
  return distance;
}

function actionReason(event: RadarEvent): RadarActionItem["reason"] {
  if (event.action === "commented") return "commented";
  if (event.action === "status_changed") return "reviewed";
  return event.action === "created" ? "handed-off" : "updated";
}

export function buildTrackerRadar(
  records: readonly TrackerRecord[],
  options: BuildTrackerRadarOptions = {}
): TrackerRadarModel {
  const window = resolveRadarWindow(options);
  const currentActorKey = options.currentIdentity
    ? trackerRadarActorKey(options.currentIdentity)
    : null;
  const getTitle = options.getTitle ?? defaultTitle;
  const getStatus = options.getStatus ?? defaultStatus;
  const eventsByItem = new Map<string, RadarEvent[]>();
  const recordById = new Map(records.map((record) => [record.id, record]));
  const marksByActor = new Map<string, RadarMark[]>();
  const actorByKey = new Map<string, TrackerIdentity>();

  for (const record of records) {
    const allEvents = normalizeTrackerRadarEvents(record);
    eventsByItem.set(record.id, allEvents);
    const visible = allEvents.filter(
      (event) =>
        event.timestamp >= window.startAt && event.timestamp <= window.endAt
    );
    const byActor = new Map<string, RadarEvent[]>();
    for (const event of visible) {
      actorByKey.set(event.actorKey, event.actor);
      const list = byActor.get(event.actorKey) ?? [];
      list.push(event);
      byActor.set(event.actorKey, list);
    }
    for (const [actorKey, events] of byActor) {
      const state = getStatus(record);
      const startAt = events[0]!.timestamp;
      const endAt = events[events.length - 1]!.timestamp;
      const mark: RadarMark = {
        id: `thread:${actorKey}:${record.id}`,
        kind: "thread",
        actorKey,
        itemIds: [record.id],
        items: [record],
        primaryType: record.primaryType,
        label: getTitle(record),
        state,
        startAt,
        endAt,
        lastActivityAt: endAt,
        row: 0,
        events,
        segments: buildSegments(events, state),
        agentDriven: record.system.createdByAgent === true,
        hasCommit: Boolean(
          record.system.linkedCommitSha || record.system.linkedCommits?.length
        ),
        truncatedStart:
          (record.system.activity?.length ?? 0) >= 100 &&
          allEvents[0]?.timestamp === startAt,
      };
      const list = marksByActor.get(actorKey) ?? [];
      list.push(mark);
      marksByActor.set(actorKey, list);
    }
  }

  const ties: RadarTie[] = [];
  for (const [itemId, events] of eventsByItem) {
    const record = recordById.get(itemId)!;
    const human = events.filter(
      (event) =>
        event.timestamp >= window.startAt &&
        event.timestamp <= window.endAt &&
        event.actorKey !== "automation"
    );
    const byActor = new Map<string, RadarEvent[]>();
    for (const event of human) {
      const list = byActor.get(event.actorKey) ?? [];
      list.push(event);
      byActor.set(event.actorKey, list);
    }
    const actorEntries = [...byActor.entries()];
    for (let leftIndex = 0; leftIndex < actorEntries.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < actorEntries.length;
        rightIndex += 1
      ) {
        const [leftKey, leftEvents] = actorEntries[leftIndex]!;
        const [rightKey, rightEvents] = actorEntries[rightIndex]!;
        const leftFirst = leftEvents[0]!.timestamp;
        const rightFirst = rightEvents[0]!.timestamp;
        const [fromActorKey, fromEvents, toActorKey, toEvents] =
          leftFirst <= rightFirst
            ? [leftKey, leftEvents, rightKey, rightEvents]
            : [rightKey, rightEvents, leftKey, leftEvents];
        const overlap =
          closestEventDistance(leftEvents, rightEvents) <=
          (options.overlapMs ?? DEFAULT_OVERLAP_MS);
        const review = toEvents.some(
          (event) =>
            event.action === "commented" || event.action === "status_changed"
        );
        ties.push({
          itemId,
          issueKey: record.issueKey,
          title: getTitle(record),
          type: overlap ? "overlap" : review ? "review" : "hand-off",
          fromActorKey,
          toActorKey,
          fromAt: fromEvents[fromEvents.length - 1]!.timestamp,
          toAt: toEvents[0]!.timestamp,
        });
      }
    }
  }

  const waitingOnYou: RadarActionItem[] = [];
  const youHandedOff: RadarActionItem[] = [];
  if (currentActorKey) {
    for (const [itemId, events] of eventsByItem) {
      const human = events.filter(
        (event) =>
          event.actorKey !== "automation" && event.timestamp <= window.endAt
      );
      const currentEvents = human.filter(
        (event) => event.actorKey === currentActorKey
      );
      const latestCurrent = currentEvents[currentEvents.length - 1];
      if (!latestCurrent) continue;
      const visibleHuman = human.filter(
        (event) => event.timestamp >= window.startAt
      );
      const latest = visibleHuman[visibleHuman.length - 1];
      if (!latest) continue;
      const record = recordById.get(itemId)!;
      const otherActors = visibleHuman.filter(
        (event) => event.actorKey !== currentActorKey
      );
      if (otherActors.length === 0) continue;
      const actionableOtherEvents = otherActors.filter(
        (event) =>
          event.timestamp > latestCurrent.timestamp &&
          (event.action === "commented" || event.action === "status_changed")
      );
      const actionableOther =
        actionableOtherEvents[actionableOtherEvents.length - 1];
      if (actionableOther) {
        waitingOnYou.push({
          itemId,
          issueKey: record.issueKey,
          title: getTitle(record),
          actor: actionableOther.actor,
          at: actionableOther.timestamp,
          reason: actionReason(actionableOther),
        });
      } else if (latest.actorKey === currentActorKey) {
        const other = otherActors[otherActors.length - 1]!;
        youHandedOff.push({
          itemId,
          issueKey: record.issueKey,
          title: getTitle(record),
          actor: other.actor,
          at: latest.timestamp,
          reason: actionReason(latest),
        });
      }
    }
  }

  const stalledByActor = new Map<string, RadarStalledItem[]>();
  const stalledBefore =
    window.endAt - (options.stalledAfterMs ?? DEFAULT_STALLED_MS);
  for (const record of records) {
    const state = getStatus(record).toLowerCase();
    if (state !== "in-progress" && state !== "in-review") continue;
    const events = eventsByItem.get(record.id) ?? [];
    const last = events[events.length - 1];
    const lastAt = last?.timestamp ?? timeValue(record.system.updatedAt);
    if (lastAt === null || lastAt === undefined || lastAt > stalledBefore)
      continue;
    const actor =
      last?.actor ??
      normalizeIdentity(record.system.lastModifiedBy) ??
      AUTOMATION_IDENTITY;
    const actorKey = trackerRadarActorKey(actor);
    actorByKey.set(actorKey, actor);
    const list = stalledByActor.get(actorKey) ?? [];
    list.push({
      itemId: record.id,
      issueKey: record.issueKey,
      title: getTitle(record),
      state,
      lastActivityAt: lastAt,
    });
    stalledByActor.set(actorKey, list);
  }

  const actorKeys = new Set([...marksByActor.keys(), ...stalledByActor.keys()]);
  const lanes = [...actorKeys]
    .map((actorKey): RadarLane => {
      const collapsed = collapseRuns(
        marksByActor.get(actorKey) ?? [],
        options.runGapMs ?? DEFAULT_RUN_GAP_MS,
        options.runMinItems ?? 3
      );
      const subRowCount = assignRows(collapsed);
      const stalled = (stalledByActor.get(actorKey) ?? []).sort(
        (a, b) => b.lastActivityAt - a.lastActivityAt
      );
      const actor = actorByKey.get(actorKey) ?? AUTOMATION_IDENTITY;
      return {
        actor,
        actorKey,
        isCurrentUser: actorKey === currentActorKey,
        isAutomation: actorKey === "automation",
        summary: laneSummary(collapsed, stalled.length),
        lastActivityAt: Math.max(
          0,
          ...collapsed.map((mark) => mark.lastActivityAt),
          ...stalled.map((item) => item.lastActivityAt)
        ),
        marks: collapsed,
        subRowCount,
        stalled,
        presence: options.presenceByActorKey?.[actorKey],
        enrichment: options.enrichmentByActorKey?.[actorKey],
      };
    })
    .sort((a, b) => {
      if (a.isCurrentUser !== b.isCurrentUser) return a.isCurrentUser ? -1 : 1;
      if (a.isAutomation !== b.isAutomation) return a.isAutomation ? 1 : -1;
      return (
        b.lastActivityAt - a.lastActivityAt ||
        a.actor.displayName.localeCompare(b.actor.displayName)
      );
    });

  return {
    windowStart: window.startAt,
    windowEnd: window.endAt,
    windowHours: window.windowHours,
    windowSource: window.source,
    lanes,
    ties: ties.sort((a, b) => b.toAt - a.toAt),
    waitingOnYou: waitingOnYou.sort((a, b) => b.at - a.at),
    youHandedOff: youHandedOff.sort((a, b) => b.at - a.at),
  };
}

export function formatRadarRelativeTime(at: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - at);
  if (elapsed < 60_000) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  return `${Math.floor(elapsed / DAY_MS)}d ago`;
}

export function getRecentTeammateActivity(
  record: TrackerRecord,
  currentIdentity: TrackerIdentity | null | undefined,
  nowMs = Date.now(),
  windowHours = DEFAULT_WINDOW_HOURS
): RecentTeammateActivity | null {
  if (!currentIdentity) return null;
  const startAt = nowMs - normalizedHours(windowHours) * HOUR_MS;
  const teammateEvents = normalizeTrackerRadarEvents(record)
    .filter((event) => event.timestamp >= startAt && event.timestamp <= nowMs)
    .filter(
      (event) =>
        event.actorKey !== "automation" &&
        !sameActor(event.actor, currentIdentity)
    );
  const latest = teammateEvents[teammateEvents.length - 1];
  if (!latest) return null;
  const verb =
    latest.action === "status_changed"
      ? "changed status"
      : latest.action === "commented"
      ? "commented"
      : latest.action === "created"
      ? "created this item"
      : "updated this item";
  const relativeLabel = formatRadarRelativeTime(latest.timestamp, nowMs);
  return {
    actor: latest.actor,
    action: latest.action,
    at: latest.timestamp,
    relativeLabel,
    summary: `${latest.actor.displayName} ${verb} ${relativeLabel}`,
  };
}
