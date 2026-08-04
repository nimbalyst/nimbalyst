// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const startTutorial = vi.fn();
const getTutorialStatus = vi.fn();
const getRecentWorkspaces = vi.fn();
const getWorkspaceStats = vi.fn();

(window as unknown as { electronAPI: unknown }).electronAPI = {
  getResolvedThemeSync: () => "dark",
  onThemeChange: vi.fn(),
  workspaceManager: {
    getRecentWorkspaces,
    getWorkspaceStats,
  },
  tutorial: {
    getStatus: getTutorialStatus,
    start: startTutorial,
  },
};

const { WorkspaceManager } = await import("../WorkspaceManager");

beforeEach(() => {
  getRecentWorkspaces.mockResolvedValue([]);
  getTutorialStatus.mockResolvedValue({ success: true, exists: false });
  getWorkspaceStats.mockResolvedValue({
    fileCount: 1,
    markdownCount: 1,
    totalSize: 10,
    recentFiles: [],
  });
  startTutorial.mockResolvedValue({
    success: true,
    reused: false,
    workspacePath: "/Documents/Nimbalyst Tutorial",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceManager tutorial actions", () => {
  it("starts the tutorial from the welcome card CTA", async () => {
    render(<WorkspaceManager />);

    fireEvent.click(
      await screen.findByTestId("workspace-manager-welcome-tutorial-cta")
    );

    await waitFor(() => expect(startTutorial).toHaveBeenCalledOnce());
  });

  it("shows Open tutorial in both locations when a materialized tutorial exists", async () => {
    getTutorialStatus.mockResolvedValue({
      success: true,
      exists: true,
      workspacePath: "/Documents/Nimbalyst Tutorial",
    });
    startTutorial.mockResolvedValue({
      success: true,
      reused: true,
      workspacePath: "/Documents/Nimbalyst Tutorial",
    });

    render(<WorkspaceManager />);

    expect(
      (await screen.findByTestId("workspace-manager-sidebar-tutorial-button"))
        .textContent
    ).toContain("Open tutorial");
    expect(
      screen.getByTestId("workspace-manager-welcome-tutorial-cta")
        .textContent
    ).toContain("Open tutorial");
    expect(
      within(
        screen.getByTestId("workspace-manager-welcome-tutorial-cta")
      ).queryByText("New")
    ).toBeNull();

    expect(startTutorial).not.toHaveBeenCalled();
  });

  it("renders the welcome card only while no workspace is selected", async () => {
    getRecentWorkspaces.mockResolvedValue([
      {
        path: "/projects/alpha",
        name: "alpha",
        lastOpened: 1700000000000,
        exists: true,
        markdownCount: 2,
      },
    ]);

    render(<WorkspaceManager />);

    expect(
      await screen.findByTestId("workspace-manager-welcome-card")
    ).not.toBeNull();

    fireEvent.click(await screen.findByText("alpha"));

    await waitFor(() =>
      expect(
        screen.queryByTestId("workspace-manager-welcome-card")
      ).toBeNull()
    );
  });

  it("surfaces a tutorial start failure in the manager error toast", async () => {
    getTutorialStatus.mockResolvedValue({ success: true, exists: false });
    startTutorial.mockResolvedValue({
      success: false,
      error: "Tutorial template directory does not exist",
    });

    render(<WorkspaceManager />);
    fireEvent.click(
      await screen.findByTestId("workspace-manager-sidebar-tutorial-button")
    );

    expect(
      await screen.findByText("Tutorial template directory does not exist")
    ).not.toBeNull();
  });
});
