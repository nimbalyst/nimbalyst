import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@nimbalyst/extension-sdk", async () => {
  const actual = await vi.importActual<
    typeof import("@nimbalyst/extension-sdk")
  >("@nimbalyst/extension-sdk");
  return {
    ...actual,
    useEditorLifecycle: () => ({
      markDirty: vi.fn(),
      isLoading: false,
      error: null,
      theme: "dark",
      diffState: null,
    }),
    useCollaborativeEditor: vi.fn(),
  };
});

import { MockupEditor } from "../components/MockupEditor";

describe("MockupEditor editor API", () => {
  it("registers readiness for hidden-editor tools and unregisters on unmount", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    } as never);
    const registerEditorAPI = vi.fn();
    const host = {
      filePath: "/workspace/dashboard.mockup.html",
      fileName: "dashboard.mockup.html",
      isActive: false,
      readOnly: false,
      registerEditorAPI,
      onReadOnlyChanged: vi.fn(() => () => undefined),
      onThemeChanged: vi.fn(() => () => undefined),
      onSaveRequested: vi.fn(() => () => undefined),
      onDiffRequested: vi.fn(() => () => undefined),
      onContentChanged: vi.fn(() => () => undefined),
      loadContent: vi.fn(async () => "<html><body>Dashboard</body></html>"),
      saveContent: vi.fn(async () => undefined),
      setDirty: vi.fn(),
      reportDiffResult: vi.fn(),
    } as never;

    const view = render(<MockupEditor host={host} />);

    expect(registerEditorAPI).toHaveBeenCalledWith(
      expect.objectContaining({
        getCurrentHtml: expect.any(Function),
        exportToPngBlob: expect.any(Function),
      })
    );

    view.unmount();
    expect(registerEditorAPI).toHaveBeenLastCalledWith(null);
  });
});
