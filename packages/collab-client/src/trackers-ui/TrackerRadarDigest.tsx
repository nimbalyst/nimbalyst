import React, { useState } from "react";
import { MaterialSymbol } from "@nimbalyst/runtime/ui/icons/MaterialSymbol";
import type { TrackerRecord } from "@nimbalyst/runtime/core/TrackerRecord";
import { getRecordTitle } from "@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors";
import {
  formatRadarRelativeTime,
  trackerRadarActorKey,
  type RadarActionItem,
  type RadarEvent,
  type RadarLane,
  type RadarMark,
  type RadarStalledItem,
  type TrackerRadarModel,
} from "@nimbalyst/tracker-core";

export interface DigestMove {
  event: RadarEvent;
  lane: RadarLane;
  item: TrackerRecord;
}

export interface DigestSweep {
  lane: RadarLane;
  mark: RadarMark;
}

export interface DigestStalled {
  lane: RadarLane;
  item: RadarStalledItem;
}

interface TrackerRadarDigestProps {
  radar: TrackerRadarModel;
  needsYou: RadarActionItem[];
  moved: DigestMove[];
  sweeps: DigestSweep[];
  stalled: DigestStalled[];
  eventByAction: ReadonlyMap<string, RadarEvent>;
  laneByActorKey: ReadonlyMap<string, RadarLane>;
  filterLabel?: string;
  selectedItemId?: string | null;
  onClearFilter: () => void;
  onItemSelect?: (itemId: string) => void;
  onOpenDocument?: (itemId: string) => void;
}

function statusTone(state: string): string {
  const normalized = state.toLowerCase();
  if (["done", "completed", "closed"].includes(normalized)) {
    return "bg-[var(--nim-success)]/15 text-[var(--nim-success)]";
  }
  if (normalized === "blocked") {
    return "bg-[var(--nim-error)]/15 text-[var(--nim-error)]";
  }
  if (normalized === "in-review" || normalized === "review") {
    return "bg-[var(--nim-warning)]/15 text-[var(--nim-warning)]";
  }
  if (normalized === "in-progress" || normalized === "active") {
    return "bg-[var(--nim-primary)]/15 text-[var(--nim-primary)]";
  }
  return "bg-nim-tertiary text-nim-muted";
}

function statusLabel(state: string): string {
  return state.replace(/[-_]/g, " ");
}

function actorInitials(lane: RadarLane): string {
  return (
    lane.actor.displayName
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "A"
  );
}

function itemKey(item: TrackerRecord): string {
  return item.issueKey ?? item.primaryType;
}

function Avatar({ lane }: { lane: RadarLane }) {
  const tone = lane.isCurrentUser
    ? "bg-[var(--nim-primary)]/20 text-[var(--nim-primary)]"
    : lane.isAutomation
    ? "bg-nim-tertiary text-nim-muted"
    : "bg-[var(--nim-accent)]/20 text-[var(--nim-accent)]";
  return (
    <span
      className={`flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${tone}`}
    >
      {lane.isAutomation ? (
        <MaterialSymbol icon="smart_toy" size={14} />
      ) : (
        actorInitials(lane)
      )}
    </span>
  );
}

function StatusTransition({ from, to }: { from?: string; to?: string }) {
  const previous = from ?? "status";
  const next = to ?? "updated";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(
          previous
        )}`}
      >
        {statusLabel(previous)}
      </span>
      <MaterialSymbol
        icon="arrow_forward"
        size={12}
        className="text-nim-faint"
      />
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone(
          next
        )}`}
      >
        {statusLabel(next)}
      </span>
    </span>
  );
}

function SectionHeading({
  id,
  icon,
  title,
  count,
  actionable = false,
}: {
  id: string;
  icon: string;
  title: string;
  count: number;
  actionable?: boolean;
}) {
  return (
    <h2
      id={id}
      className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-nim-faint"
    >
      <MaterialSymbol icon={icon} size={14} />
      {title}
      <span
        className={`rounded-full px-2 py-0.5 ${
          actionable
            ? "bg-[var(--nim-warning)]/15 text-[var(--nim-warning)]"
            : "bg-nim-tertiary text-nim-muted"
        }`}
      >
        {count}
      </span>
    </h2>
  );
}

export function TrackerRadarDigest({
  radar,
  needsYou,
  moved,
  sweeps,
  stalled,
  eventByAction,
  laneByActorKey,
  filterLabel,
  selectedItemId,
  onClearFilter,
  onItemSelect,
  onOpenDocument,
}: TrackerRadarDigestProps) {
  const [expandedSweepId, setExpandedSweepId] = useState<string | null>(null);
  const openItem = (itemId: string) =>
    (onOpenDocument ?? onItemSelect)?.(itemId);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-8 pt-2">
      {filterLabel ? (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-[var(--nim-primary)]/10 px-3 py-2 text-[11px] text-nim-muted">
          Showing activity for{" "}
          <strong className="text-nim">{filterLabel}</strong>
          <button
            type="button"
            className="ml-auto text-[var(--nim-primary)] hover:underline"
            onClick={onClearFilter}
          >
            Show everyone
          </button>
        </div>
      ) : null}

      <section className="mt-5" aria-labelledby="radar-needs-you">
        <SectionHeading
          id="radar-needs-you"
          icon="inbox"
          title="Needs you"
          count={needsYou.length}
          actionable
        />
        {needsYou.length === 0 ? (
          <div className="rounded-lg border border-dashed border-nim px-3 py-4 text-center text-[11px] text-nim-faint">
            You are caught up. No teammate comments or status changes are
            waiting on you.
          </div>
        ) : (
          <div className="space-y-2">
            {needsYou.map((action) => {
              const actorKey = trackerRadarActorKey(action.actor);
              const lane = laneByActorKey.get(actorKey)!;
              const event = eventByAction.get(
                `${action.itemId}:${actorKey}:${action.at}`
              );
              return (
                <article
                  key={`${action.itemId}:${action.at}`}
                  className={`grid grid-cols-[28px_minmax(0,1fr)_auto] gap-3 rounded-lg border border-l-[3px] border-nim border-l-[var(--nim-warning)] bg-nim-secondary/45 p-3 ${
                    selectedItemId === action.itemId
                      ? "ring-1 ring-[var(--nim-primary)]"
                      : ""
                  }`}
                >
                  <Avatar lane={lane} />
                  <button
                    type="button"
                    className="min-w-0 text-left"
                    onClick={() => onItemSelect?.(action.itemId)}
                  >
                    <span className="text-xs leading-5 text-nim">
                      <strong>{action.actor.displayName}</strong>{" "}
                      {action.reason === "commented" ? "commented on" : "moved"}{" "}
                      your{" "}
                      <span className="font-mono text-[10px] text-[var(--nim-primary)]">
                        {action.issueKey ?? "item"}
                      </span>{" "}
                      <span className="text-nim-muted">{action.title}</span>
                    </span>
                    {event?.action === "commented" && event.body ? (
                      <span className="mt-2 block rounded-r-md border-l-2 border-nim bg-nim px-3 py-2 text-[11px] leading-5 text-nim-muted">
                        {event.body}
                      </span>
                    ) : null}
                    {event?.action === "status_changed" ? (
                      <span className="mt-2 block">
                        <StatusTransition
                          from={event.oldValue}
                          to={event.newValue}
                        />
                      </span>
                    ) : null}
                  </button>
                  <div className="flex flex-col items-end gap-2">
                    <span className="text-[10px] text-nim-faint">
                      {formatRadarRelativeTime(action.at, radar.windowEnd)}
                    </span>
                    <button
                      type="button"
                      className="rounded border border-nim px-2 py-1 text-[10px] text-nim-muted hover:bg-nim-hover hover:text-nim"
                      onClick={() => openItem(action.itemId)}
                    >
                      Open
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {moved.length > 0 ? (
        <section className="mt-5" aria-labelledby="radar-moved">
          <SectionHeading
            id="radar-moved"
            icon="swap_horiz"
            title="Moved"
            count={moved.length}
          />
          <div className="overflow-hidden rounded-lg border border-nim bg-nim-secondary/35">
            {moved.map(({ event, lane, item }) => (
              <button
                key={event.id}
                type="button"
                className={`grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-b border-nim px-3 py-2.5 text-left last:border-b-0 hover:bg-nim-hover ${
                  selectedItemId === item.id ? "bg-[var(--nim-primary)]/10" : ""
                }`}
                onClick={() => onItemSelect?.(item.id)}
                onDoubleClick={() => openItem(item.id)}
              >
                <Avatar lane={lane} />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-nim">
                    <span className="font-mono text-[10px] text-[var(--nim-primary)]">
                      {itemKey(item)}
                    </span>
                    <span className="truncate text-nim-muted">
                      {getRecordTitle(item)}
                    </span>
                    <StatusTransition
                      from={event.oldValue}
                      to={event.newValue}
                    />
                  </span>
                  <span className="mt-1 block text-[10px] text-nim-faint">
                    {lane.isCurrentUser ? "You" : lane.actor.displayName}
                    {item.system.createdByAgent ? ", via an agent" : ""}
                  </span>
                </span>
                <span className="text-[10px] text-nim-faint">
                  {formatRadarRelativeTime(event.timestamp, radar.windowEnd)}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {sweeps.length > 0 ? (
        <section className="mt-5" aria-labelledby="radar-sweeps">
          <SectionHeading
            id="radar-sweeps"
            icon="layers"
            title="Sweeps"
            count={sweeps.length}
          />
          <div className="space-y-2">
            {sweeps.map(({ lane, mark }) => {
              const expanded = expandedSweepId === mark.id;
              const examples = mark.items.slice(0, 3).map(itemKey).join(", ");
              return (
                <div
                  key={mark.id}
                  className="overflow-hidden rounded-lg border border-dashed border-nim bg-nim-secondary/25"
                >
                  <button
                    type="button"
                    aria-expanded={expanded}
                    className="grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left hover:bg-nim-hover"
                    onClick={() =>
                      setExpandedSweepId((current) =>
                        current === mark.id ? null : mark.id
                      )
                    }
                  >
                    <Avatar lane={lane} />
                    <span className="min-w-0 text-[11px] text-nim">
                      <strong>
                        {lane.isCurrentUser ? "You" : lane.actor.displayName}
                      </strong>{" "}
                      {mark.label.toLowerCase()}{" "}
                      <span className="text-nim-faint">
                        · {examples}
                        {mark.items.length > 3
                          ? ` and ${mark.items.length - 3} more`
                          : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-nim-faint">
                      {formatRadarRelativeTime(
                        mark.lastActivityAt,
                        radar.windowEnd
                      )}
                      <MaterialSymbol
                        icon={expanded ? "expand_less" : "expand_more"}
                        size={14}
                      />
                    </span>
                  </button>
                  {expanded ? (
                    <div className="border-t border-nim bg-nim">
                      {mark.items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="flex w-full items-center gap-2 border-b border-nim px-12 py-2 text-left text-[11px] last:border-b-0 hover:bg-nim-hover"
                          onClick={() => onItemSelect?.(item.id)}
                          onDoubleClick={() => openItem(item.id)}
                        >
                          <span className="shrink-0 font-mono text-[10px] text-[var(--nim-primary)]">
                            {itemKey(item)}
                          </span>
                          <span className="truncate text-nim-muted">
                            {getRecordTitle(item)}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {stalled.length > 0 ? (
        <section className="mt-5" aria-labelledby="radar-stalled">
          <SectionHeading
            id="radar-stalled"
            icon="schedule"
            title="Stalled"
            count={stalled.length}
          />
          <div className="overflow-hidden rounded-lg border border-nim bg-nim-secondary/35">
            {stalled.map(({ lane, item }) => (
              <button
                key={item.itemId}
                type="button"
                className={`grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-b border-nim px-3 py-2.5 text-left last:border-b-0 hover:bg-nim-hover ${
                  selectedItemId === item.itemId
                    ? "bg-[var(--nim-primary)]/10"
                    : ""
                }`}
                onClick={() => onItemSelect?.(item.itemId)}
                onDoubleClick={() => openItem(item.itemId)}
              >
                <Avatar lane={lane} />
                <span className="min-w-0 text-[11px] text-nim">
                  <span className="font-mono text-[10px] text-[var(--nim-primary)]">
                    {item.issueKey ?? item.state}
                  </span>{" "}
                  <span className="text-nim-muted">{item.title}</span>
                  <span className="mt-1 block text-[10px] text-nim-faint">
                    {statusLabel(item.state)} · no activity for{" "}
                    {formatRadarRelativeTime(
                      item.lastActivityAt,
                      radar.windowEnd
                    )}
                  </span>
                </span>
                <span className="text-[10px] text-nim-faint">
                  {lane.isCurrentUser ? "You" : lane.actor.displayName}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
