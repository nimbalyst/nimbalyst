// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  appendActivity,
  MAX_ACTIVITY_VALUE_CHARS,
  computeReadinessForItems,
  createTrackerCoreContext,
  dbRowToRecord,
  type ReadinessAccessors,
  type TrackerTypeModel,
} from "../index";

describe("tracker-core host parity", () => {
  it("classifies tracker metadata as system data while preserving genuine fields", () => {
    const record = dbRowToRecord({
      id: "bug-1",
      type: "bug",
      type_tags: JSON.stringify(["bug"]),
      workspace: "/workspace",
      archived: 0,
      created: "2026-08-31T12:00:00.000Z",
      updated: "2026-08-31T12:00:00.000Z",
      data: JSON.stringify({
        title: "Classify me",
        severity: "high",
        linkedPullRequests: [{ remote: "nimbalyst/nimbalyst", number: 42 }],
        linkedIssues: [{ remote: "nimbalyst/nimbalyst", number: 41 }],
        triagedAt: "2026-08-31T13:00:00.000Z",
        triagedBy: { email: "reviewer@example.com", displayName: "Reviewer" },
        derivedSignals: [{ kind: "external-signal" }],
        comments: [{
          id: "comment-1",
          authorIdentity: { email: null, displayName: "Reviewer", gitName: null, gitEmail: null },
          body: "Unedited",
          createdAt: 1,
          updatedAt: null,
          deleted: false,
        }],
      }),
    });

    expect(record.fields).toEqual({ title: "Classify me", severity: "high" });
    expect(record.system).toMatchObject({
      linkedPullRequests: [{ remote: "nimbalyst/nimbalyst", number: 42 }],
      linkedIssues: [{ remote: "nimbalyst/nimbalyst", number: 41 }],
      triagedAt: "2026-08-31T13:00:00.000Z",
      triagedBy: { email: "reviewer@example.com", displayName: "Reviewer" },
      comments: [{
        id: "comment-1",
        authorIdentity: { email: null, displayName: "Reviewer", gitName: null, gitEmail: null },
        body: "Unedited",
        createdAt: 1,
        deleted: false,
      }],
    });
  });

  it("isolates two type-model contexts in the same process", () => {
    const model = (closedCategory: "done" | "started"): TrackerTypeModel => ({
      type: "work",
      roles: { workflowStatus: "state", title: "name" },
      fields: [
        {
          name: "state",
          type: "select",
          default: "open",
          options: [
            { value: "open", category: "unstarted" },
            { value: "closed", category: closedCategory },
          ],
        },
        {
          name: "waitingFor",
          type: "relationship",
          relationshipTypeKey: "depends-on",
        },
      ],
    });
    const doneContext = createTrackerCoreContext(() => model("done"));
    const openContext = createTrackerCoreContext(() => model("started"));
    const items = [
      {
        id: "blocker",
        type: "work",
        fields: { name: "Blocker", state: "closed" },
      },
      {
        id: "dependent",
        type: "work",
        fields: { name: "Dependent", state: "open", waitingFor: ["blocker"] },
      },
    ];
    const accessors: ReadinessAccessors<(typeof items)[number]> = {
      getId: (item) => item.id,
      getType: (item) => item.type,
      getStatus: (item) => String(item.fields.state),
      getTitle: (item) => String(item.fields.name),
      getFieldValue: (item, fieldName) =>
        item.fields[fieldName as keyof typeof item.fields],
      getReference: (item) => ({ ref: item.id, refStatus: "unassigned" }),
    };

    expect(
      computeReadinessForItems(doneContext, items, accessors).get("dependent")
        ?.state
    ).toBe("ready");
    expect(
      computeReadinessForItems(openContext, items, accessors).get("dependent")
        ?.state
    ).toBe("blocked");
  });
});

describe("appendActivity value cap", () => {
  const author = { email: "a@example.com", displayName: "A" };

  // NIM-7336: a 40 KB description edited a few times put a shared item over the
  // 256 KiB wire limit, because every entry carried the whole old and new text.
  it("bounds long old and new values, including a coalesced edit, and leaves short ones alone", () => {
    const data: Record<string, any> = {};
    const longText = "x".repeat(40_000);
    appendActivity(data, author, "updated", { field: "description", oldValue: longText, newValue: longText });
    appendActivity(data, author, "updated", { field: "description", oldValue: longText, newValue: `${longText}y` });
    appendActivity(data, author, "updated", { field: "priority", oldValue: "low", newValue: "high" });

    const [description, priority] = data.activity;
    expect(data.activity).toHaveLength(2);
    expect(description.oldValue.length).toBe(MAX_ACTIVITY_VALUE_CHARS);
    expect(description.newValue.length).toBe(MAX_ACTIVITY_VALUE_CHARS);
    expect(description.newValue.endsWith("…")).toBe(true);
    expect(priority).toMatchObject({ oldValue: "low", newValue: "high" });
  });
});
