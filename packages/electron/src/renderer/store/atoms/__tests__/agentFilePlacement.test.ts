// @vitest-environment node
import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentFilePlacementAtom,
  normalizeAgentFilePlacement,
} from "../agentFilePlacement";
import {
  moveWorkstreamEditorAtom,
  revealWorkstreamEditorAtom,
} from "../agentFileViewer";
import {
  initWorkstreamState,
  workstreamStateAtom,
  workstreamRightPanelModeAtom,
  setWorkstreamRightPanelModeAtom,
} from "../workstreamState";

describe("Agent file placement", () => {
  let store: ReturnType<typeof createStore>;
  beforeEach(() => {
    store = createStore();
    initWorkstreamState("/placement-test");
  });

  it("defaults old or malformed preferences to above", () => {
    for (const value of [undefined, null, {}, "sideways"])
      expect(normalizeAgentFilePlacement(value)).toBe("above");
    expect(normalizeAgentFilePlacement("right")).toBe("right");
  });

  it("moves the tab group globally, preserves other pane selections, and restores the previous mode", () => {
    store.set(workstreamStateAtom("a"), {
      rightPanelMode: "review",
      filesSidebarVisible: false,
    });
    store.set(workstreamStateAtom("b"), { rightPanelMode: "session-chat" });
    store.set(moveWorkstreamEditorAtom, {
      workstreamId: "a",
      placement: "right",
    });
    expect(store.get(agentFilePlacementAtom)).toBe("right");
    expect(store.get(workstreamStateAtom("a"))).toMatchObject({
      rightPanelMode: "file-viewer",
      filesSidebarVisible: true,
    });
    expect(store.get(workstreamRightPanelModeAtom("b"))).toBe("session-chat");
    store.set(moveWorkstreamEditorAtom, {
      workstreamId: "a",
      placement: "above",
    });
    expect(store.get(workstreamRightPanelModeAtom("a"))).toBe("review");
    expect(store.get(workstreamStateAtom("a")).layoutMode).toBe("split");
  });

  it("selecting File viewer sets the personal preference; other modes keep it and explicit opens reveal it", () => {
    store.set(setWorkstreamRightPanelModeAtom, {
      workstreamId: "a",
      mode: "file-viewer",
    });
    expect(store.get(agentFilePlacementAtom)).toBe("right");
    store.set(setWorkstreamRightPanelModeAtom, {
      workstreamId: "a",
      mode: "review",
    });
    expect(store.get(agentFilePlacementAtom)).toBe("right");
    store.set(workstreamStateAtom("a"), { filesSidebarVisible: false });
    store.set(revealWorkstreamEditorAtom, "a");
    expect(store.get(workstreamStateAtom("a"))).toMatchObject({
      rightPanelMode: "file-viewer",
      filesSidebarVisible: true,
    });
    store.set(agentFilePlacementAtom, "above"); // Same update as a different window's broadcast.
    expect(store.get(workstreamRightPanelModeAtom("a"))).toBe("review");
  });
});
