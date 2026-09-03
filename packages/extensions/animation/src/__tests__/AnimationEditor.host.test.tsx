import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AnimationEditor } from "../components/AnimationEditor";

const VALID_DOCUMENT = JSON.stringify({
  version: 1,
  stage: { width: 500, height: 300, fps: 25 },
  parts: { box: { type: "node", x: 20, y: 20, w: 100, h: 60 } },
  steps: [
    { id: "idle", duration: 800 },
    { id: "active", duration: 1000, set: { box: { state: "active" } } },
  ],
});

beforeAll(() => {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: {
      escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&"),
    },
  });
});

interface HostWriteEdit {
  label: string;
  actor: "user" | "agent";
  changes: Array<{
    path: string;
    expectedSha256: string | null;
    content: string | null;
  }>;
}

/** Menu items are addressed by label; their order is presentation, not contract. */
function clickMenuItem(
  items: Array<{ label: string; onClick: () => void }>,
  label: string
) {
  const item = items.find((entry) => entry.label === label);
  if (!item) {
    throw new Error(
      `No menu item "${label}"; got ${items.map((i) => i.label).join(", ")}`
    );
  }
  item.onClick();
}

function hostHarness(
  options: {
    content?: string;
    readOnly?: boolean;
    isActive?: boolean;
    /** Omit to build a host with no filesystem, as an older host would be. */
    existingExport?: { sha256: string } | null;
    withFs?: boolean;
    /** Markup returned for `htmlFile` reads, keyed by resolved path. */
    partials?: Record<string, string>;
    supports?: (capability: string) => boolean;
  } = {}
) {
  let saveRequested: (() => void | Promise<void>) | null = null;
  let readOnlyChanged: ((readOnly: boolean) => void) | null = null;
  let currentReadOnly = options.readOnly ?? false;
  const menuItems: Array<{ label: string; onClick: () => void }> = [];

  const fsRead = vi.fn(async (paths: string[]) =>
    paths.map((path) => {
      const partial = options.partials?.[path];
      return {
        path,
        exists: partial !== undefined || Boolean(options.existingExport),
        content: partial ?? null,
        sha256: options.existingExport?.sha256 ?? null,
      };
    })
  );
  // Typed parameters, so `fsWrite.mock.calls[0][0]` is inspectable rather than
  // an empty tuple.
  const fsWrite = vi.fn(async (_edit: HostWriteEdit) => ({ id: "receipt" }));

  const host = {
    ...(options.withFs === false
      ? {}
      : { fs: { read: fsRead, write: fsWrite } }),
    ...(options.supports
      ? { capabilities: { supports: options.supports } }
      : {}),
    registerMenuItems: vi.fn((items: typeof menuItems) => {
      menuItems.length = 0;
      menuItems.push(...items);
    }),
    filePath: "/workspace/example.anim.json",
    fileName: "example.anim.json",
    theme: "dark",
    isActive: options.isActive ?? true,
    visible: true,
    get readOnly() {
      return currentReadOnly;
    },
    loadContent: vi.fn(async () => options.content ?? VALID_DOCUMENT),
    saveContent: vi.fn(async () => undefined),
    setDirty: vi.fn(),
    onSaveRequested: vi.fn((callback: () => void | Promise<void>) => {
      saveRequested = callback;
      return () => {
        saveRequested = null;
      };
    }),
    onFileChanged: vi.fn(() => () => undefined),
    onThemeChanged: vi.fn(() => () => undefined),
    onVisibilityChanged: vi.fn(() => () => undefined),
    onReadOnlyChanged: vi.fn((callback: (readOnly: boolean) => void) => {
      readOnlyChanged = callback;
      return () => {
        readOnlyChanged = null;
      };
    }),
    setEditorContextItems: vi.fn(),
    registerEditorAPI: vi.fn(),
  };

  return {
    host,
    menuItems,
    fsRead,
    fsWrite,
    requestSave: async () => {
      if (!saveRequested) throw new Error("Save callback was not registered.");
      await saveRequested();
    },
    setReadOnly: (next: boolean) => {
      currentReadOnly = next;
      readOnlyChanged?.(next);
    },
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "electronAPI");
  document
    .querySelectorAll("[data-animation-test-input]")
    .forEach((element) => element.remove());
});

describe("AnimationEditor host contract", () => {
  it("refuses to overwrite malformed source through the save callback", async () => {
    const harness = hostHarness({ content: "{ not valid JSON" });
    const view = render(<AnimationEditor host={harness.host} />);

    await waitFor(() =>
      expect(view.container.querySelector(".anim-badge-error")).not.toBeNull()
    );
    await expect(harness.requestSave()).rejects.toThrow(/parse errors/i);
    expect(harness.host.saveContent).not.toHaveBeenCalled();
  });

  it("keeps retiming inert while a host is read-only", async () => {
    const harness = hostHarness({ readOnly: true });
    const view = render(<AnimationEditor host={harness.host} />);
    await waitFor(() =>
      expect(view.container.querySelector(".anim-boundary")).not.toBeNull()
    );

    const track = view.container.querySelector(".anim-track") as HTMLElement;
    Object.defineProperty(track, "clientWidth", {
      configurable: true,
      value: 900,
    });
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 900,
      bottom: 100,
      left: 0,
      width: 900,
      height: 100,
      toJSON: () => ({}),
    });

    const boundary = view.container.querySelector(
      ".anim-boundary"
    ) as HTMLElement;
    fireEvent.pointerDown(boundary, { clientX: 400 });
    fireEvent.pointerMove(window, { clientX: 600 });
    fireEvent.pointerUp(window, { clientX: 600 });

    expect(harness.host.setDirty).not.toHaveBeenCalledWith(true);
    expect(boundary.getAttribute("aria-disabled")).toBe("true");
    await expect(harness.requestSave()).rejects.toThrow(/read-only/i);
    expect(harness.host.saveContent).not.toHaveBeenCalled();
  });

  it("scopes playback shortcuts to the active animation editor", async () => {
    const harness = hostHarness();
    const view = render(<AnimationEditor host={harness.host} />);
    const playButton = await waitFor(() => {
      const button = view.container.querySelector(
        ".anim-tbtn-play"
      ) as HTMLButtonElement | null;
      expect(button).not.toBeNull();
      return button!;
    });

    const outside = document.createElement("input");
    outside.dataset.animationTestInput = "true";
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(outside, { code: "Space", key: " " });
    expect(playButton.title).toBe("Play");

    const root = view.container.querySelector(".anim-editor") as HTMLElement;
    root.focus();
    fireEvent.keyDown(window, { code: "Space", key: " " });
    expect(playButton.title).toBe("Pause");
  });
});

describe("export menu item", () => {
  it.each([
    ["HTML", "Export as HTML…", "/workspace/example.html"],
    ["MP4", "Export as MP4…", "/workspace/example.mp4"],
    ["GIF", "Export as GIF…", "/workspace/example.gif"],
  ])(
    "reveals a successful %s export in the file manager",
    async (_, label, outputPath) => {
      const invoke = vi.fn(async (channel: string) =>
        channel.startsWith("export:animation")
          ? { success: true, result: { outputPath } }
          : { success: true }
      );
      Object.defineProperty(globalThis, "electronAPI", {
        configurable: true,
        value: { invoke },
      });
      const harness = hostHarness({ existingExport: null });
      render(<AnimationEditor host={harness.host} />);

      await waitFor(() => expect(harness.menuItems.length).toBeGreaterThan(0));
      await act(async () => {
        clickMenuItem(harness.menuItems, label);
      });

      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("show-in-finder", outputPath)
      );
    }
  );

  it("overwrites an existing export instead of colliding with it", async () => {
    // The host write is compare-and-swap: passing null for a file that already
    // exists is rejected. Reading first is the only thing that makes a second
    // export of the same animation succeed, and nothing on screen would show
    // that it had regressed.
    const harness = hostHarness({ existingExport: { sha256: "abc123" } });
    render(<AnimationEditor host={harness.host} />);

    await waitFor(() => expect(harness.menuItems.length).toBeGreaterThan(0));
    clickMenuItem(harness.menuItems, "Export as HTML…");

    await waitFor(() => expect(harness.fsWrite).toHaveBeenCalledTimes(1));
    expect(harness.fsRead).toHaveBeenCalledWith(["/workspace/example.html"]);
    expect(harness.fsWrite.mock.calls[0][0]).toMatchObject({
      actor: "user",
      changes: [{ path: "/workspace/example.html", expectedSha256: "abc123" }],
    });
    expect(harness.fsWrite.mock.calls[0][0].changes[0].content).toContain(
      'data-part="box"'
    );
  });

  it("requires the file not to exist when there is no prior export", async () => {
    const harness = hostHarness({ existingExport: null });
    render(<AnimationEditor host={harness.host} />);

    await waitFor(() => expect(harness.menuItems.length).toBeGreaterThan(0));
    clickMenuItem(harness.menuItems, "Export as HTML…");

    await waitFor(() => expect(harness.fsWrite).toHaveBeenCalledTimes(1));
    expect(harness.fsWrite.mock.calls[0][0].changes[0].expectedSha256).toBeNull();
  });

  it("registers nothing on a host that cannot honour it", async () => {
    // A menu entry that throws when clicked is worse than no menu entry.
    const noFs = hostHarness({ withFs: false });
    render(<AnimationEditor host={noFs.host} />);
    await waitFor(() => expect(noFs.host.registerEditorAPI).toHaveBeenCalled());
    expect(noFs.host.registerMenuItems).not.toHaveBeenCalled();

    const noCapability = hostHarness({
      supports: (capability) => capability !== "menuItems",
    });
    render(<AnimationEditor host={noCapability.host} />);
    await waitFor(() =>
      expect(noCapability.host.registerEditorAPI).toHaveBeenCalled()
    );
    expect(noCapability.host.registerMenuItems).not.toHaveBeenCalled();
  });

  it("reports a failed write instead of claiming success", async () => {
    const harness = hostHarness({ existingExport: null });
    harness.fsWrite.mockRejectedValueOnce(new Error("Disk is full"));
    const view = render(<AnimationEditor host={harness.host} />);

    await waitFor(() => expect(harness.menuItems.length).toBeGreaterThan(0));
    clickMenuItem(harness.menuItems, "Export as HTML…");

    await waitFor(() =>
      expect(view.container.querySelector(".anim-badge-error")?.textContent).toBe(
        "Disk is full"
      )
    );
  });
});

describe("htmlFile partials", () => {
  const DOC_WITH_PARTIAL = JSON.stringify({
    version: 1,
    stage: { width: 200, height: 100, fps: 25 },
    parts: {
      card: {
        type: "html",
        x: 0,
        y: 0,
        w: 100,
        h: 40,
        htmlFile: "./parts/card.html",
        vars: { who: "Ada" },
      },
    },
    steps: [{ id: "one", duration: 400 }],
  });

  it("reads the partial and repaints the stage once it arrives", async () => {
    // The read is async and lands after the document is already on screen, so
    // the scene has to be rewritten on the asset change as well as on the
    // document change. Miss that and the partial loads but never paints --
    // which looks exactly like a partial that failed to load.
    const harness = hostHarness({
      content: DOC_WITH_PARTIAL,
      partials: { "/workspace/parts/card.html": "<b>hello {{who}}</b>" },
    });
    const view = render(<AnimationEditor host={harness.host} />);

    await waitFor(() =>
      expect(harness.fsRead).toHaveBeenCalledWith(["/workspace/parts/card.html"])
    );

    const frame = view.container.querySelector(
      "iframe.anim-stage-frame"
    ) as HTMLIFrameElement;
    await waitFor(() => {
      expect(frame.contentDocument?.body.innerHTML).toContain("hello Ada");
    });
  });

  it("warns when the host cannot read files at all", async () => {
    // Without this the parts just draw nothing, which is indistinguishable from
    // markup that is simply wrong.
    const harness = hostHarness({ content: DOC_WITH_PARTIAL, withFs: false });
    const view = render(<AnimationEditor host={harness.host} />);
    await waitFor(() =>
      expect(view.container.textContent).toContain("1 warning")
    );
  });

  it("reports an unreadable partial as a warning rather than failing to open", async () => {
    const harness = hostHarness({ content: DOC_WITH_PARTIAL, partials: {} });
    const view = render(<AnimationEditor host={harness.host} />);

    await waitFor(() =>
      expect(view.container.textContent).toContain("1 warning")
    );
    expect(view.container.querySelector("iframe.anim-stage-frame")).not.toBeNull();
  });
});
