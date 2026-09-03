// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildTrackerRadar,
  getRecentTeammateActivity,
  resolveRadarWindow,
  type TrackerIdentity,
  type TrackerRecord,
} from "../index";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-02T20:00:00.000Z");

const me: TrackerIdentity = {
  email: "me@example.com",
  displayName: "Me",
  gitName: null,
  gitEmail: null,
};

const dana: TrackerIdentity = {
  email: "dana@example.com",
  displayName: "Dana",
  gitName: null,
  gitEmail: null,
};

function record(
  id: string,
  options: {
    type?: string;
    status?: string;
    activity?: unknown[];
    comments?: unknown[];
    createdByAgent?: boolean;
    updatedAt?: string;
    lastModifiedBy?: TrackerIdentity | null;
  } = {}
): TrackerRecord {
  return {
    id,
    issueKey: `NIM-${id}`,
    primaryType: options.type ?? "bug",
    typeTags: [options.type ?? "bug"],
    source: "native",
    archived: false,
    syncStatus: "synced",
    system: {
      workspace: "/ws",
      createdAt: new Date(NOW - 7 * HOUR).toISOString(),
      updatedAt: options.updatedAt ?? new Date(NOW - HOUR).toISOString(),
      createdByAgent: options.createdByAgent,
      lastModifiedBy: options.lastModifiedBy,
      activity: options.activity as TrackerRecord["system"]["activity"],
      comments: options.comments as TrackerRecord["system"]["comments"],
    },
    fields: { title: `Item ${id}`, status: options.status ?? "in-progress" },
  };
}

function event(
  id: string,
  actor: TrackerIdentity | undefined,
  at: number | string,
  action: "created" | "updated" | "commented" | "status_changed" = "updated",
  field?: string,
  oldValue?: string,
  newValue?: string
) {
  return {
    id,
    authorIdentity: actor,
    timestamp: at,
    action,
    field,
    oldValue,
    newValue,
  };
}

describe("buildTrackerRadar", () => {
  it("normalizes malformed activity, unions comments, and keeps flat bars useful", () => {
    const item = record("1", {
      activity: [
        event("created", me, new Date(NOW - 6 * HOUR).toISOString(), "created"),
        event(
          "review",
          me,
          NOW - 4 * HOUR,
          "status_changed",
          "status",
          "in-progress",
          "in-review"
        ),
        event(
          "automation",
          undefined,
          new Date(NOW - 3 * HOUR).toISOString(),
          "updated",
          "labels"
        ),
        event("commented-copy", dana, NOW - 2 * HOUR, "commented"),
      ],
      comments: [
        {
          id: "comment-1",
          authorIdentity: dana,
          body: "Reproduced on SQLite too",
          createdAt: NOW - 2 * HOUR,
        },
      ],
    });

    const radar = buildTrackerRadar([item], {
      nowMs: NOW,
      windowHours: 8,
      currentIdentity: me,
    });

    expect(radar.lanes.map((lane) => lane.actor.displayName)).toEqual([
      "Me",
      "Dana",
      "Automation",
    ]);
    expect(radar.lanes[0]?.marks[0]).toMatchObject({
      kind: "thread",
      itemIds: ["1"],
    });
    expect(radar.lanes[0]?.marks[0]?.segments).toEqual([
      expect.objectContaining({ state: "in-progress" }),
      expect.objectContaining({ state: "in-review" }),
    ]);
    expect(radar.lanes[1]?.marks[0]?.events).toEqual([
      expect.objectContaining({
        source: "comment",
        body: "Reproduced on SQLite too",
      }),
    ]);
    expect(radar.lanes[2]?.marks[0]?.events[0]?.timestamp).toBe(NOW - 3 * HOUR);
    expect(radar.ties[0]?.type).toBe("review");
  });

  it("collapses bulk runs, stacks concurrent work, and derives actionable hand-offs", () => {
    const run = [0, 1, 2].map((offset) =>
      record(String(offset + 1), {
        activity: [
          event(
            `run-${offset}`,
            dana,
            NOW - 5 * HOUR + offset * 60_000,
            "updated",
            "area"
          ),
        ],
      })
    );
    const shared = record("4", {
      activity: [
        event("me-start", me, NOW - 3 * HOUR, "created"),
        event(
          "dana-review",
          dana,
          NOW - HOUR,
          "status_changed",
          "status",
          "in-review",
          "done"
        ),
      ],
      status: "done",
    });
    const overlapping = record("5", {
      activity: [
        event("me-overlap", me, NOW - 35 * 60_000),
        event("dana-overlap", dana, NOW - 10 * 60_000),
      ],
    });
    const concurrent = record("6", {
      activity: [
        event("dana-concurrent", dana, NOW - 12 * 60_000, "updated", "title"),
      ],
    });

    const radar = buildTrackerRadar([...run, shared, overlapping, concurrent], {
      nowMs: NOW,
      windowHours: 8,
      currentIdentity: me,
    });
    const danaLane = radar.lanes.find(
      (lane) => lane.actor.email === dana.email
    );

    expect(danaLane?.marks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "run",
          itemIds: ["1", "2", "3"],
          label: "Set area on 3 bugs",
        }),
      ])
    );
    expect(radar.ties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: "4", type: "review" }),
        expect.objectContaining({ itemId: "5", type: "overlap" }),
      ])
    );
    expect(radar.waitingOnYou).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: "4",
          actor: expect.objectContaining({ displayName: "Dana" }),
        }),
      ])
    );
    expect(
      Math.max(
        ...radar.lanes.flatMap((lane) => lane.marks.map((mark) => mark.row))
      )
    ).toBeGreaterThanOrEqual(1);
  });

  it("keeps bulk field updates out of the needs-you digest", () => {
    const bulkUpdated = record("7", {
      activity: [
        event("mine", me, NOW - 12 * HOUR, "created"),
        event("sweep", dana, NOW - HOUR, "updated", "area"),
      ],
    });
    const commented = record("8", {
      activity: [event("mine", me, NOW - 12 * HOUR, "created")],
      comments: [
        {
          id: "comment-8",
          authorIdentity: dana,
          body: "Can you take another look?",
          createdAt: NOW - 30 * 60_000,
        },
      ],
    });

    const radar = buildTrackerRadar([bulkUpdated, commented], {
      nowMs: NOW,
      windowHours: 8,
      currentIdentity: me,
    });

    expect(radar.waitingOnYou).toEqual([
      expect.objectContaining({ itemId: "8", reason: "commented" }),
    ]);
  });

  it("clamps the since-you-left window and reports recent teammate activity", () => {
    expect(
      resolveRadarWindow({ nowMs: NOW, lastSeenAt: NOW - 30 * 60_000 })
    ).toMatchObject({
      windowHours: 2,
      source: "since-left",
    });
    expect(
      resolveRadarWindow({ nowMs: NOW, lastSeenAt: NOW - 10 * 24 * HOUR })
    ).toMatchObject({
      windowHours: 72,
      source: "since-left",
    });

    const activity = getRecentTeammateActivity(
      record("6", {
        activity: [
          event("mine", me, NOW - 2 * HOUR),
          event("theirs", dana, NOW - 40 * 60_000, "commented"),
        ],
      }),
      me,
      NOW,
      8
    );

    expect(activity).toMatchObject({
      actor: dana,
      action: "commented",
      relativeLabel: "40m ago",
    });
  });
});
