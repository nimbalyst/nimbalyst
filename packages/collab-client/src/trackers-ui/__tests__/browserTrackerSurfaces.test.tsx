/**
 * The two ways a browser host can silently render the wrong answer.
 *
 * Both are invisible on screen, and both come from the same missing lane: a
 * view whose clause the host cannot answer shows zero rows, and a personal
 * tracker the host cannot carry items for shows an empty grid. Each looks like
 * a sync that has not arrived yet. Neither prints a warning.
 */

import React from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TrackerRecord } from "@nimbalyst/runtime/core/TrackerRecord";
import type { TrackerDataModel } from "@nimbalyst/runtime/plugins/TrackerPlugin/models";
import {
  createDefaultViewDefinition,
  type SavedViewDefinition,
} from "@nimbalyst/collab-client/trackers";
import {
  BROWSER_TRACKER_UI_CAPABILITIES,
  DESKTOP_TRACKER_UI_CAPABILITIES,
  PersonalClauseNotice,
  resolveViewMode,
  TrackerNavigation,
  TrackerRadarView,
  TrackersUIProvider,
  useTrackerViewRows,
  type TrackerUICapabilities,
} from "../index";

function record(
  id: string,
  fields: Record<string, unknown> = { title: id }
): TrackerRecord {
  return {
    id,
    primaryType: "bug",
    typeTags: ["bug"],
    issueKey: id.toUpperCase(),
    fields,
    system: {
      workspace: "/w",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  } as unknown as TrackerRecord;
}

function SearchCompositionProbe() {
  const definition: SavedViewDefinition = {
    ...createDefaultViewDefinition(),
    statusScope: "open",
    columnFilters: {
      combinator: "and",
      clauses: [{ field: "priority", op: "=", value: "high" }],
    },
  };
  const { rows } = useTrackerViewRows(
    [
      record("matching", {
        title: "Release blocker",
        status: "to-do",
        priority: "high",
      }),
      record("closed", {
        title: "Release complete",
        status: "done",
        priority: "high",
      }),
      record("wrong-view", {
        title: "Release polish",
        status: "to-do",
        priority: "low",
      }),
      record("wrong-search", {
        title: "Documentation blocker",
        status: "to-do",
        priority: "high",
      }),
    ],
    definition,
    { identity: null, searchTerm: "release" }
  );
  return (
    <span data-testid="composed-row-ids">
      {rows.map((row) => row.id).join(",")}
    </span>
  );
}

/** A team-shared view built on the author's own star list. */
const favoritesView: SavedViewDefinition = {
  ...createDefaultViewDefinition(),
  statusScope: "all",
  columnFilters: {
    combinator: "and",
    clauses: [{ field: "favorite", op: "=", value: true }],
  },
};

function ViewRowsProbe({ definition }: { definition: SavedViewDefinition }) {
  const { rows, personalClauses } = useTrackerViewRows(
    [record("a"), record("b")],
    definition,
    { identity: null }
  );
  return (
    <>
      <span data-testid="row-count">{rows.length}</span>
      <PersonalClauseNotice clauses={personalClauses} />
    </>
  );
}

function renderProbe(capabilities: TrackerUICapabilities) {
  return render(
    <TrackersUIProvider identity={null} capabilities={capabilities}>
      <ViewRowsProbe definition={favoritesView} />
    </TrackersUIProvider>
  );
}

describe("a shared view built on a personal-lane clause", () => {
  it("drops the clause and says so, rather than rendering zero rows, where there is no personal lane", () => {
    renderProbe(BROWSER_TRACKER_UI_CAPABILITIES);
    expect(screen.getByTestId("row-count").textContent).toBe("2");
    expect(
      screen.getByTestId("tracker-personal-clause-notice").textContent
    ).toContain("your favorites");
  });

  it("evaluates the clause, and says nothing, on a host that has the lane", () => {
    renderProbe(DESKTOP_TRACKER_UI_CAPABILITIES);
    // Nothing is favorited in this fixture, so the honest desktop answer is zero
    // rows -- and no marker, because nothing was dropped.
    expect(screen.getByTestId("row-count").textContent).toBe("0");
    expect(screen.queryByTestId("tracker-personal-clause-notice")).toBeNull();
  });
});

describe("shared view row composition", () => {
  it("applies search, saved-view filters, and lifecycle scope in one row selection", () => {
    render(
      <TrackersUIProvider
        identity={null}
        capabilities={BROWSER_TRACKER_UI_CAPABILITIES}
      >
        <SearchCompositionProbe />
      </TrackersUIProvider>
    );
    expect(screen.getByTestId("composed-row-ids").textContent).toBe("matching");
  });
});

describe("resolveViewMode", () => {
  // Timeline and tag board were extracted so a browser host could draw them;
  // the triage inbox stays out because its snooze suppression is personal
  // state. Both facts are one table row here rather than a rendered surface --
  // the decision is what regresses, and every host reads it from this function.
  it.each([
    ["list", "list", false],
    ["table", "table", false],
    ["kanban", "kanban", false],
    ["timeline", "timeline", false],
    ["radar", "radar", false],
    ["tag-board", "tag-board", false],
    ["inbox", "list", true],
  ] as const)(
    "resolves %s to %s on a browser host",
    (requested, mode, substituted) => {
      expect(
        resolveViewMode(requested, BROWSER_TRACKER_UI_CAPABILITIES)
      ).toEqual({ mode, substituted });
    }
  );

  it("draws every mode, substituting none, on a host that has the personal lane", () => {
    expect(resolveViewMode("inbox", DESKTOP_TRACKER_UI_CAPABILITIES)).toEqual({
      mode: "inbox",
      substituted: false,
    });
  });
});

describe("browser Radar parity", () => {
  it("renders synced activity with every local enrichment field absent", () => {
    const now = Date.now();
    const item = record("radar", {
      title: "Shared work",
      status: "in-progress",
    });
    item.system.activity = [
      {
        id: "activity-1",
        authorIdentity: {
          email: "dana@example.com",
          displayName: "Dana",
          gitName: null,
          gitEmail: null,
        },
        action: "updated",
        timestamp: now - 60_000,
      },
    ];
    render(<TrackerRadarView items={[item]} currentIdentity={null} />);

    expect(screen.getByTestId("tracker-radar")).toBeTruthy();
    expect(screen.getByLabelText("People")).toBeTruthy();
    expect(screen.getAllByText("Dana").length).toBeGreaterThan(0);
    expect(screen.getByText(/Shared work/)).toBeTruthy();
  });

  it("filters the digest when a person card is selected", () => {
    const now = Date.now();
    const danaWork = record("dana-work", {
      title: "Dana work",
      status: "in-review",
    });
    danaWork.system.activity = [
      {
        id: "activity-dana",
        authorIdentity: {
          email: "dana@example.com",
          displayName: "Dana",
          gitName: null,
          gitEmail: null,
        },
        action: "status_changed",
        oldValue: "in-progress",
        newValue: "in-review",
        timestamp: now - 60_000,
      },
    ];
    const samWork = record("sam-work", { title: "Sam work", status: "done" });
    samWork.system.activity = [
      {
        id: "activity-sam",
        authorIdentity: {
          email: "sam@example.com",
          displayName: "Sam",
          gitName: null,
          gitEmail: null,
        },
        action: "status_changed",
        oldValue: "in-review",
        newValue: "done",
        timestamp: now - 120_000,
      },
    ];
    render(
      <TrackerRadarView items={[danaWork, samWork]} currentIdentity={null} />
    );

    const moved = screen
      .getByRole("heading", { name: /Moved/ })
      .closest("section")!;
    expect(within(moved).getByText("Dana work")).toBeTruthy();
    expect(within(moved).getByText("Sam work")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Dana.*Last active/ }));

    expect(within(moved).getByText("Dana work")).toBeTruthy();
    expect(within(moved).queryByText("Sam work")).toBeNull();
  });
});

const trackerModel = (
  type: string,
  sharing: "team" | "personal"
): TrackerDataModel =>
  ({
    type,
    displayName: type,
    displayNamePlural: `${type}s`,
    icon: "check",
    color: "#000",
    modes: { inline: true, fullDocument: false },
    idPrefix: type.toUpperCase(),
    idFormat: "uuid",
    fields: [],
    sharing,
  } as TrackerDataModel);

function renderNavigation(capabilities: TrackerUICapabilities) {
  render(
    <TrackersUIProvider identity={null} capabilities={capabilities}>
      <TrackerNavigation
        trackerTypes={[
          trackerModel("bug", "team"),
          trackerModel("notes", "personal"),
        ]}
        navigationEntries={[
          {
            entryId: "folder:d",
            kind: "folder",
            folderId: "d",
            name: "Delivery",
            sortKey: "a0",
            ownership: "team",
          },
          {
            entryId: "type:bug",
            kind: "type-placement",
            trackerType: "bug",
            folderId: "d",
            sortKey: "a0",
          },
          {
            entryId: "type:notes",
            kind: "type-placement",
            trackerType: "notes",
            folderId: "d",
            sortKey: "a1",
          },
        ]}
        savedViews={[]}
        activeSavedViewId={null}
        selectedType="all"
        expandedFolderIds={["d"]}
        onToggleFolder={() => {}}
        onSelectType={() => {}}
        onApplyView={() => {}}
        onDeleteView={() => {}}
        onToggleShareView={() => {}}
      />
    </TrackersUIProvider>
  );
  return screen
    .getAllByTestId("tracker-nav-type")
    .map((element) => element.dataset.trackerType);
}

describe("tracker navigation", () => {
  it("omits a personal tracker where there is no personal lane to fill it", () => {
    // `notes` is filed in a team folder and would render as a selectable
    // tracker with nothing in it -- no room carries personal items, so the
    // empty result reads as a sync that has not arrived.
    expect(renderNavigation(BROWSER_TRACKER_UI_CAPABILITIES)).toEqual([
      "all",
      "bug",
    ]);
  });

  it("lists it on a host that has the lane", () => {
    expect(renderNavigation(DESKTOP_TRACKER_UI_CAPABILITIES)).toEqual([
      "all",
      "bug",
      "notes",
    ]);
  });
});
