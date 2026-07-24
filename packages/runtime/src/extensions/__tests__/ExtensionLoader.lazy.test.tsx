import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentType, JSX } from "react";
import type {
  EditorHost,
  EditorHostProps,
  ExtensionManifest,
  ExtensionModule,
} from "@nimbalyst/extension-sdk";
import {
  ExtensionLoader,
  getExtensionLoader,
  initializeExtensions,
  resetExtensionInitialization,
  shouldDeferExtensionBundle,
} from "../ExtensionLoader";
import {
  setExtensionPlatformService,
  type ExtensionPlatformService,
} from "../ExtensionPlatformService";

const manifest: ExtensionManifest = {
  id: "com.nimbalyst.lazy-test",
  name: "Lazy Test Editor",
  version: "1.0.0",
  main: "dist/index.js",
  contributions: {
    customEditors: [
      {
        filePatterns: ["*.lazy"],
        displayName: "Lazy Test Editor",
        component: "LazyEditor",
      },
    ],
    fileIcons: { "*.lazy": "hourglass" },
    newFileMenu: [
      {
        extension: ".lazy",
        displayName: "Lazy document",
        icon: "hourglass",
        defaultContent: "{}",
      },
    ],
    configuration: { properties: {} },
  },
};

function makePlatform(
  loadModule: () => Promise<ExtensionModule>
): ExtensionPlatformService {
  return {
    getExtensionsDirectory: vi.fn(async () => "/extensions"),
    getAllExtensionsDirectories: vi.fn(async () => ["/extensions"]),
    listDirectories: vi.fn(async () => []),
    readFile: vi.fn(async (filePath: string) => {
      if (filePath.endsWith("manifest.json")) return JSON.stringify(manifest);
      return "";
    }),
    writeFile: vi.fn(async () => undefined),
    fileExists: vi.fn(async () => true),
    loadModule: vi.fn(loadModule),
    injectStyles: vi.fn(() => () => undefined),
    resolvePath: (root: string, relative: string) => `${root}/${relative}`,
    findFiles: vi.fn(async () => []),
    isExtensionVisibleForChannel: vi.fn(async () => true),
  };
}

const host = {
  filePath: "/workspace/example.lazy",
  fileName: "example.lazy",
} as unknown as EditorHost;

function ReadyEditor(): JSX.Element {
  return <div>Lazy editor ready</div>;
}

describe("ExtensionLoader deferred editor bundles", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("only defers editor code whose other contributions are manifest-only", () => {
    expect(shouldDeferExtensionBundle(manifest)).toBe(true);
    expect(
      shouldDeferExtensionBundle({
        ...manifest,
        contributions: { ...manifest.contributions, aiTools: ["inspect"] },
      })
    ).toBe(false);
    expect(
      shouldDeferExtensionBundle({
        ...manifest,
        contributions: {
          ...manifest.contributions,
          panels: [
            {
              id: "panel",
              title: "Panel",
              icon: "view_sidebar",
              placement: "sidebar",
            },
          ],
        },
      })
    ).toBe(false);
    expect(
      shouldDeferExtensionBundle({
        ...manifest,
        contributions: { ...manifest.contributions, customEditors: [] },
      })
    ).toBe(false);
  });

  it("keeps collaboration-capable editors eager so their collab codec registers at startup", () => {
    // Editor-only manifest that would otherwise defer, but declares collab.
    const collabManifest: ExtensionManifest = {
      ...manifest,
      contributions: {
        ...manifest.contributions,
        customEditors: [
          {
            filePatterns: ["*.lazy"],
            displayName: "Lazy Test Editor",
            component: "LazyEditor",
            collaboration: { supported: true },
          },
        ],
      },
    };
    expect(shouldDeferExtensionBundle(collabManifest)).toBe(false);

    // collaboration.supported: false must NOT force eager.
    expect(
      shouldDeferExtensionBundle({
        ...manifest,
        contributions: {
          ...manifest.contributions,
          customEditors: [
            {
              filePatterns: ["*.lazy"],
              displayName: "Lazy Test Editor",
              component: "LazyEditor",
              collaboration: { supported: false },
            },
          ],
        },
      })
    ).toBe(true);

    // Only one of several editors declaring collab is enough to stay eager.
    expect(
      shouldDeferExtensionBundle({
        ...manifest,
        contributions: {
          ...manifest.contributions,
          customEditors: [
            {
              filePatterns: ["*.a"],
              displayName: "A",
              component: "A",
            },
            {
              filePatterns: ["*.b"],
              displayName: "B",
              component: "B",
              collaboration: { supported: true },
            },
          ],
        },
      })
    ).toBe(false);
  });

  it("registers editor and new-file metadata without evaluating the module", () => {
    const platform = makePlatform(async () => ({
      components: { LazyEditor: ReadyEditor },
    }));
    setExtensionPlatformService(platform);
    const loader = new ExtensionLoader();

    loader.registerDeferredExtension({ path: "/extensions/lazy", manifest });

    expect(platform.loadModule).not.toHaveBeenCalled();
    expect(loader.getExtensionLoadState(manifest.id)).toBe("deferred");
    expect(loader.getCustomEditors()).toHaveLength(1);
    expect(loader.findEditorForExtension(".lazy")?.extensionId).toBe(
      manifest.id
    );
    expect(loader.getNewFileMenuContributions()).toEqual([
      expect.objectContaining({ extensionId: manifest.id }),
    ]);
  });

  it("keeps eligible bundles inert during startup initialization", async () => {
    const platform = makePlatform(async () => ({
      components: { LazyEditor: ReadyEditor },
    }));
    platform.listDirectories = vi.fn(async () => ["lazy"]);
    setExtensionPlatformService(platform);
    resetExtensionInitialization();

    await initializeExtensions();

    const loader = getExtensionLoader();
    expect(platform.loadModule).not.toHaveBeenCalled();
    expect(loader.getExtensionLoadState(manifest.id)).toBe("deferred");
    expect(loader.findEditorForExtension(".lazy")).toBeDefined();

    await loader.unloadAll();
    resetExtensionInitialization();
  });

  it("shows a loading placeholder and shares one activation across concurrent mounts", async () => {
    let resolveModule!: (module: ExtensionModule) => void;
    const modulePromise = new Promise<ExtensionModule>((resolve) => {
      resolveModule = resolve;
    });
    const platform = makePlatform(() => modulePromise);
    setExtensionPlatformService(platform);
    const loader = new ExtensionLoader();
    loader.registerDeferredExtension({ path: "/extensions/lazy", manifest });

    const Editor = loader.getCustomEditors()[0]
      .component as ComponentType<EditorHostProps>;
    render(
      <>
        <Editor host={host} />
        <Editor host={{ ...host, filePath: "/workspace/second.lazy" }} />
      </>
    );

    expect(screen.getAllByText("Loading Lazy Test Editor…")).toHaveLength(2);
    await waitFor(() => expect(platform.loadModule).toHaveBeenCalledTimes(1));
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining(
        `Load #1 start ${manifest.id} (trigger=editor:/workspace/example.lazy)`
      )
    );

    await act(async () => {
      resolveModule({ components: { LazyEditor: ReadyEditor } });
      await modulePromise;
    });

    await waitFor(() => {
      expect(screen.getAllByText("Lazy editor ready")).toHaveLength(2);
    });
    expect(console.info).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`Load #1 complete ${manifest.id} .*elapsedMs=`)
      )
    );
    expect(loader.getExtensionLoadState(manifest.id)).toBe("loaded");
    expect(loader.getCustomEditors()[0].component).toBe(ReadyEditor);
    expect(platform.loadModule).toHaveBeenCalledTimes(1);
  });

  it("keeps the registration retryable after a load failure", async () => {
    const platform = makePlatform(
      vi
        .fn()
        .mockRejectedValueOnce(new Error("broken bundle"))
        .mockResolvedValueOnce({ components: { LazyEditor: ReadyEditor } })
    );
    setExtensionPlatformService(platform);
    const loader = new ExtensionLoader();
    loader.registerDeferredExtension({ path: "/extensions/lazy", manifest });

    const Editor = loader.getCustomEditors()[0]
      .component as ComponentType<EditorHostProps>;
    render(<Editor host={host} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "broken bundle"
    );
    expect(loader.getExtensionLoadState(manifest.id)).toBe("deferred");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Lazy editor ready")).toBeTruthy();
    expect(platform.loadModule).toHaveBeenCalledTimes(2);
  });

  it("removes deferred registrations on disable and eagerly replaces them on dev reload", async () => {
    const platform = makePlatform(async () => ({
      components: { LazyEditor: ReadyEditor },
    }));
    setExtensionPlatformService(platform);
    const loader = new ExtensionLoader();
    loader.registerDeferredExtension({ path: "/extensions/lazy", manifest });

    loader.disableExtension(manifest.id);
    expect(loader.getExtensionLoadState(manifest.id)).toBe("unknown");
    expect(loader.getCustomEditors()).toEqual([]);

    loader.registerDeferredExtension({ path: "/extensions/lazy", manifest });
    const result = await loader.loadExtensionFromPath("/extensions/lazy");
    expect(result.success).toBe(true);
    expect(loader.getExtensionLoadState(manifest.id)).toBe("loaded");
    expect(platform.loadModule).toHaveBeenCalledTimes(1);
  });
});
