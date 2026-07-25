import type {
  ExtensionManifest,
  ExtensionModule,
  SettingsPanelProps,
} from "@nimbalyst/extension-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionLoader } from "../ExtensionLoader";
import {
  setExtensionPlatformService,
  type ExtensionPlatformService,
} from "../ExtensionPlatformService";

const MemorySettings = (_props: SettingsPanelProps) => null;
const HealthSettings = (_props: SettingsPanelProps) => null;

function makeManifest(): ExtensionManifest {
  return {
    id: "com.example.memory",
    name: "Memory",
    version: "1.0.0",
    main: "dist/index.js",
    contributions: {
      settingsRoutes: [
        {
          id: "health",
          scope: "project",
          label: "Health",
          component: "HealthSettings",
          order: 20,
        },
        {
          id: "memory",
          scope: "project",
          label: "Memory",
          group: "Project",
          icon: "psychology",
          component: "MemorySettings",
          order: 10,
        },
      ],
    },
  };
}

function makePlatform(
  manifest: ExtensionManifest,
  module: ExtensionModule
): ExtensionPlatformService {
  return {
    getExtensionsDirectory: vi.fn(async () => "/extensions"),
    getAllExtensionsDirectories: vi.fn(async () => ["/extensions"]),
    listDirectories: vi.fn(async () => []),
    readFile: vi.fn(async (filePath: string) =>
      filePath.endsWith("manifest.json") ? JSON.stringify(manifest) : ""
    ),
    writeFile: vi.fn(async () => undefined),
    fileExists: vi.fn(async () => true),
    loadModule: vi.fn(async () => module),
    injectStyles: vi.fn(() => () => undefined),
    resolvePath: (root: string, relative: string) => `${root}/${relative}`,
    findFiles: vi.fn(async () => []),
    isExtensionVisibleForChannel: vi.fn(async () => true),
  };
}

describe("ExtensionLoader settings routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("resolves, namespaces, defaults, sorts, and disables routes", async () => {
    const manifest = makeManifest();
    setExtensionPlatformService(
      makePlatform(manifest, {
        settingsPanel: { MemorySettings, HealthSettings },
      })
    );
    const loader = new ExtensionLoader();

    expect(
      (await loader.loadExtensionFromPath("/extensions/memory")).success
    ).toBe(true);
    expect(loader.getSettingsRoutes()).toEqual([
      expect.objectContaining({
        id: "ext:com.example.memory:health",
        extensionId: "com.example.memory",
        scope: "project",
        group: "Extensions",
        icon: "extension",
        order: 20,
        component: HealthSettings,
      }),
      expect.objectContaining({
        id: "ext:com.example.memory:memory",
        group: "Project",
        icon: "psychology",
        order: 10,
        component: MemorySettings,
      }),
    ]);

    loader.disableExtension(manifest.id);
    expect(loader.getSettingsRoutes()).toEqual([]);
  });

  it("warns and skips a route whose component export is missing", async () => {
    const manifest = makeManifest();
    setExtensionPlatformService(
      makePlatform(manifest, {
        settingsPanel: { MemorySettings },
      })
    );
    const loader = new ExtensionLoader();

    await loader.loadExtensionFromPath("/extensions/memory");

    expect(loader.getSettingsRoutes()).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("HealthSettings")
    );
  });

  it("rejects unsupported scopes and duplicate local ids at validation", async () => {
    const invalidManifest = {
      ...makeManifest(),
      contributions: {
        settingsRoutes: [
          {
            id: "memory",
            scope: "account",
            label: "Memory",
            component: "MemorySettings",
          },
          {
            id: "memory",
            scope: "project",
            label: "Again",
            component: "MemorySettings",
          },
        ],
      },
    } as unknown as ExtensionManifest;
    setExtensionPlatformService(
      makePlatform(invalidManifest, {
        settingsPanel: { MemorySettings },
      })
    );

    const result = await new ExtensionLoader().loadExtensionFromPath(
      "/extensions/memory"
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/invalid scope|duplicate id/);
    }
  });
});
