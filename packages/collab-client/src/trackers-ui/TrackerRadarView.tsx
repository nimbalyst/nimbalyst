/** Team activity as a ranked, since-you-left digest. */

import React, { useEffect, useMemo, useState } from "react";
import { MaterialSymbol } from "@nimbalyst/runtime/ui/icons/MaterialSymbol";
import type { TrackerIdentity } from "@nimbalyst/runtime/core/DocumentService";
import type { TrackerRecord } from "@nimbalyst/runtime/core/TrackerRecord";
import {
  getRecordStatus,
  getRecordTitle,
} from "@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors";
import {
  buildTrackerRadar,
  formatRadarRelativeTime,
  trackerRadarActorKey,
  type RadarEvent,
  type RadarLane,
  type RadarLaneEnrichment,
  type RadarPresence,
} from "@nimbalyst/tracker-core";
import {
  TrackerRadarDigest,
  type DigestMove,
  type DigestStalled,
  type DigestSweep,
} from "./TrackerRadarDigest";

export interface TrackerRadarViewProps {
  items: TrackerRecord[];
  currentIdentity?: TrackerIdentity | null;
  /** Own presence heartbeat; when present the initial range is since this instant. */
  lastSeenAt?: number;
  presenceByActorKey?: Readonly<Record<string, RadarPresence>>;
  enrichmentByActorKey?: Readonly<Record<string, RadarLaneEnrichment>>;
  selectedItemId?: string | null;
  onItemSelect?: (itemId: string) => void;
  onOpenDocument?: (itemId: string) => void;
}

type WindowChoice = "since-left" | 2 | 8 | 24 | 72;

function presenceTone(lane: RadarLane): string {
  if (lane.presence?.status === "online") return "bg-[var(--nim-success)]";
  if (lane.presence?.status === "away") return "bg-[var(--nim-warning)]";
  return "bg-[var(--nim-text-faint)]";
}

function itemKey(item: TrackerRecord): string {
  return item.issueKey ?? item.primaryType;
}

function latestMark(lane: RadarLane) {
  return lane.marks.reduce<(typeof lane.marks)[number] | undefined>(
    (latest, mark) =>
      !latest || mark.lastActivityAt > latest.lastActivityAt ? mark : latest,
    undefined
  );
}

function personStory(lane: RadarLane): string {
  const latest = latestMark(lane);
  const live = lane.enrichment?.liveSessions;
  const prefix = live
    ? `${live} session${live === 1 ? "" : "s"} live`
    : latest
    ? "Last active"
    : "No recent activity";
  if (!latest) return `${prefix} · ${lane.summary}`;
  const work =
    latest.kind === "run"
      ? latest.label
      : `${itemKey(latest.items[0]!)} ${latest.label}`;
  return `${prefix} on ${work} · ${lane.summary}`;
}

function windowContext(radar: ReturnType<typeof buildTrackerRadar>): string {
  if (radar.windowSource === "since-left") {
    const leftAt = new Date(radar.windowStart).toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    return `Since you left ${leftAt} · ${Math.round(radar.windowHours)}h`;
  }
  const duration =
    radar.windowHours < 24
      ? `${radar.windowHours}h`
      : `${radar.windowHours / 24}d`;
  return `Last ${duration}`;
}

export function TrackerRadarView({
  items,
  currentIdentity,
  lastSeenAt,
  presenceByActorKey,
  enrichmentByActorKey,
  selectedItemId,
  onItemSelect,
  onOpenDocument,
}: TrackerRadarViewProps) {
  const [windowChoice, setWindowChoice] = useState<WindowChoice>(() =>
    lastSeenAt ? "since-left" : 24
  );
  const [windowManuallyChosen, setWindowManuallyChosen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [actorFilter, setActorFilter] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (lastSeenAt && !windowManuallyChosen) setWindowChoice("since-left");
  }, [lastSeenAt, windowManuallyChosen]);

  const radar = useMemo(
    () =>
      buildTrackerRadar(items, {
        nowMs,
        ...(windowChoice === "since-left"
          ? { lastSeenAt }
          : { windowHours: windowChoice }),
        currentIdentity,
        presenceByActorKey,
        enrichmentByActorKey,
        getTitle: getRecordTitle,
        getStatus: getRecordStatus,
      }),
    [
      currentIdentity,
      enrichmentByActorKey,
      items,
      lastSeenAt,
      nowMs,
      presenceByActorKey,
      windowChoice,
    ]
  );
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items]
  );
  const laneByActorKey = useMemo(
    () => new Map(radar.lanes.map((lane) => [lane.actorKey, lane])),
    [radar.lanes]
  );
  const selectedLane = actorFilter
    ? laneByActorKey.get(actorFilter)
    : undefined;
  const matchesActor = (actorKey: string) =>
    !actorFilter || actorFilter === actorKey;

  const eventByAction = useMemo(() => {
    const result = new Map<string, RadarEvent>();
    for (const lane of radar.lanes) {
      for (const mark of lane.marks) {
        for (const event of mark.events) {
          result.set(
            `${event.itemId}:${event.actorKey}:${event.timestamp}`,
            event
          );
        }
      }
    }
    return result;
  }, [radar.lanes]);
  const needsYou = radar.waitingOnYou.filter(
    (action) =>
      !actorFilter ||
      selectedLane?.isCurrentUser ||
      trackerRadarActorKey(action.actor) === actorFilter
  );
  const moved = radar.lanes
    .flatMap((lane): DigestMove[] =>
      lane.marks.flatMap((mark) =>
        mark.events
          .filter(
            (event) =>
              event.action === "status_changed" && matchesActor(event.actorKey)
          )
          .map((event) => ({
            event,
            lane,
            item: itemById.get(event.itemId)!,
          }))
          .filter((move) => Boolean(move.item))
      )
    )
    .sort((a, b) => b.event.timestamp - a.event.timestamp);
  const sweeps = radar.lanes
    .flatMap((lane): DigestSweep[] =>
      lane.marks
        .filter((mark) => mark.kind === "run" && matchesActor(lane.actorKey))
        .map((mark) => ({ lane, mark }))
    )
    .sort((a, b) => b.mark.lastActivityAt - a.mark.lastActivityAt);
  const stalled = radar.lanes
    .flatMap((lane): DigestStalled[] =>
      lane.stalled
        .filter(() => matchesActor(lane.actorKey))
        .map((item) => ({ lane, item }))
    )
    .sort((a, b) => b.item.lastActivityAt - a.item.lastActivityAt);

  if (radar.lanes.length === 0) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 bg-nim text-sm text-nim-muted"
        data-testid="tracker-radar-empty"
      >
        <MaterialSymbol icon="radar" size={28} className="text-nim-faint" />
        <span>No activity in this window.</span>
        <span className="text-xs text-nim-faint">
          Try a wider range to catch up on the team.
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-nim"
      data-testid="tracker-radar"
      data-window-hours={radar.windowHours}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-nim px-4 py-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-nim">
          <MaterialSymbol
            icon="radar"
            size={16}
            className="text-[var(--nim-primary)]"
          />
          Radar
        </div>
        <span className="text-[11px] text-nim-muted">
          {windowContext(radar)}
        </span>
        <div
          className="ml-auto flex items-center rounded-md border border-nim bg-nim-secondary p-0.5"
          aria-label="Radar window"
        >
          {(
            [
              ["since-left", "Since you left"],
              [2, "2h"],
              [8, "8h"],
              [24, "24h"],
              [72, "3d"],
            ] as const
          ).map(([value, label]) => {
            if (value === "since-left" && !lastSeenAt) return null;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={windowChoice === value}
                className={`rounded px-2 py-1 text-[10px] transition-colors ${
                  windowChoice === value
                    ? "bg-[var(--nim-primary)] text-white"
                    : "text-nim-muted hover:bg-nim-hover hover:text-nim"
                }`}
                onClick={() => {
                  setWindowManuallyChosen(true);
                  setWindowChoice(value);
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section
          className="border-b border-nim bg-nim-secondary/35 px-4 py-3"
          aria-label="People"
        >
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2.5">
            {radar.lanes.map((lane) => {
              const active = actorFilter === lane.actorKey;
              const tone = active
                ? "border-[var(--nim-primary)] bg-[var(--nim-primary)]/10"
                : lane.isCurrentUser
                ? "border-[var(--nim-primary)]/30 bg-[var(--nim-primary)]/5 hover:bg-[var(--nim-primary)]/10"
                : "border-nim bg-nim hover:bg-nim-hover";
              return (
                <button
                  key={lane.actorKey}
                  type="button"
                  aria-pressed={active}
                  className={`rounded-lg border p-3 text-left transition-colors ${tone}`}
                  onClick={() =>
                    setActorFilter((current) =>
                      current === lane.actorKey ? null : lane.actorKey
                    )
                  }
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`size-2 shrink-0 rounded-full ${presenceTone(
                        lane
                      )}`}
                    />
                    <strong className="truncate text-xs text-nim">
                      {lane.isCurrentUser ? "You" : lane.actor.displayName}
                    </strong>
                    <span className="ml-auto shrink-0 text-[10px] text-nim-faint">
                      {formatRadarRelativeTime(
                        lane.lastActivityAt,
                        radar.windowEnd
                      )}
                    </span>
                  </span>
                  <span className="mt-1.5 block text-[11px] leading-4 text-nim-muted">
                    {personStory(lane)}
                  </span>
                  {lane.enrichment?.unpushedCommits ? (
                    <span className="mt-1 block text-[10px] text-nim-faint">
                      {lane.enrichment.unpushedCommits} unpushed ·{" "}
                      {lane.enrichment.divergence ?? "local"}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>

        <TrackerRadarDigest
          radar={radar}
          needsYou={needsYou}
          moved={moved}
          sweeps={sweeps}
          stalled={stalled}
          eventByAction={eventByAction}
          laneByActorKey={laneByActorKey}
          filterLabel={
            actorFilter
              ? selectedLane?.isCurrentUser
                ? "you"
                : selectedLane?.actor.displayName
              : undefined
          }
          selectedItemId={selectedItemId}
          onClearFilter={() => setActorFilter(null)}
          onItemSelect={onItemSelect}
          onOpenDocument={onOpenDocument}
        />
      </div>
    </div>
  );
}
