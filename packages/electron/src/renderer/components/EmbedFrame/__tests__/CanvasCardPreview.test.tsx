import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { atom, createStore, Provider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasCardPreviewProps } from "@nimbalyst/runtime/canvas/canvasCallbacks";

const readFile = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>());
const version = atom(0);
vi.mock("../../../store/atoms/fileWatch", () => ({
  fileChangedOnDiskAtomFamily: () => version,
}));
vi.mock("../embeddedFileIo", () => ({
  readFileFromDisk: readFile,
  workspaceAbsolutePath: (path: string) => `/ws/${path}`,
}));
vi.mock("../canvasMockupPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../canvasMockupPreview")>()),
  rasterizeCanvasMockupPreview: async (src: string) => src,
}));

import { CanvasCardPreview } from "../CanvasCardPreview";
import { canvasMockupPreview } from "../canvasMockupPreview";

const props: CanvasCardPreviewProps = {
  nodeId: "card",
  reference: { kind: "file", path: "screen.mockup.html" },
  label: "Screen",
  detail: "cold",
  width: 900,
  height: 700,
  children: <div>Full editor</div>,
};
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("canvas mockup previews", () => {
  it("does not read offscreen cards until they first approach the viewport", async () => {
    let observe!: (entries: { isIntersecting: boolean }[]) => void;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof observe) {
          observe = callback;
        }
        observe() {}
        disconnect = disconnect;
      }
    );
    readFile.mockResolvedValue("<h1>Visible</h1>");
    render(<CanvasCardPreview {...props} />);
    act(() => observe([{ isIntersecting: false }]));
    expect(readFile).not.toHaveBeenCalled();
    act(() => observe([{ isIntersecting: true }]));
    await screen.findByRole("img");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalled();
  });

  it("keeps one image across cold/warm transitions and refreshes on a file change", async () => {
    const store = createStore();
    readFile.mockResolvedValue("<style>body{color:red}</style><h1>First</h1>");
    const view = render(
      <Provider store={store}>
        <CanvasCardPreview {...props} />
      </Provider>
    );
    const image = await screen.findByRole("img");
    expect(decodeURIComponent(image.getAttribute("src")!)).toContain("First");
    view.rerender(
      <Provider store={store}>
        <CanvasCardPreview {...props} detail="warm" />
      </Provider>
    );
    expect(screen.getByRole("img")).toBe(image);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Full editor")).toBeNull();
    view.rerender(
      <Provider store={store}>
        <CanvasCardPreview {...props} width={1000} />
      </Provider>
    );
    await waitFor(() =>
      expect(
        decodeURIComponent(screen.getByRole("img").getAttribute("src")!)
      ).toContain("0 0 1000 700")
    );
    expect(readFile).toHaveBeenCalledTimes(1);
    readFile.mockResolvedValue("<h1>Changed</h1>");
    act(() => store.set(version, 1));
    await waitFor(() =>
      expect(
        decodeURIComponent(screen.getByRole("img").getAttribute("src")!)
      ).toContain("Changed")
    );
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("discards an older file read after the reference changes", async () => {
    let resolveOld!: (value: string) => void;
    readFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    readFile.mockResolvedValue("<h1>New file</h1>");
    const view = render(<CanvasCardPreview {...props} />);
    view.rerender(
      <CanvasCardPreview
        {...props}
        reference={{ kind: "file", path: "new.mockup.html" }}
      />
    );
    await screen.findByRole("img");
    await act(async () => resolveOld("<h1>Old file</h1>"));
    expect(
      decodeURIComponent(screen.getByRole("img").getAttribute("src")!)
    ).toContain("New file");
  });

  it("delegates editing, shared references and other formats to the existing renderer", () => {
    const view = render(<CanvasCardPreview {...props} detail="hot" />);
    screen.getByText("Full editor");
    view.rerender(
      <CanvasCardPreview
        {...props}
        reference={{ kind: "file", path: "notes.md" }}
      />
    );
    screen.getByText("Full editor");
    view.rerender(
      <CanvasCardPreview
        {...props}
        reference={{ kind: "doc", uri: "nimbalyst://doc/org/doc" }}
      />
    );
    screen.getByText("Full editor");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("creates a bounded inert image while retaining inline layout and styles", () => {
    const src = canvasMockupPreview(
      '<style>.panel{background:red}</style><script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://example.org"><iframe src="https://example.org"></iframe><div class="panel" onclick="alert(2)">Panel</div>',
      900,
      700
    );
    const svg = new DOMParser().parseFromString(
      decodeURIComponent(src.split(",")[1]),
      "image/svg+xml"
    );
    expect(svg.querySelector("parsererror")).toBeNull();
    expect(svg.documentElement.getAttribute("width")).toBe("640");
    expect(svg.querySelectorAll("script,iframe,meta,[onclick]")).toHaveLength(
      0
    );
    expect(svg.querySelector(".panel")?.textContent).toBe("Panel");
    expect(svg.querySelector("style")?.textContent).toContain("background:red");
    const portrait = new DOMParser().parseFromString(
      decodeURIComponent(
        canvasMockupPreview("<h1>Tall</h1>", 400, 2000).split(",")[1]
      ),
      "image/svg+xml"
    );
    expect(portrait.documentElement.getAttribute("width")).toBe("128");
    expect(portrait.documentElement.getAttribute("height")).toBe("640");
    expect(() => canvasMockupPreview("", 0, 100)).toThrow("positive");
  });
});
