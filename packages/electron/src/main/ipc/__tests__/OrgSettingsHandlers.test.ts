import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type Handler = (
    event: unknown,
    request: Record<string, unknown>
  ) => Promise<unknown>;

  const handlers = new Map<string, Handler>();
  const send = vi.fn();
  const team = {
    getOrgSettings: vi.fn(async () => ({
      version: 1,
      messaging: { roomsEnabled: true, dmsEnabled: true, roomCreation: "members" },
    })),
    updateOrgSettings: vi.fn(async (_orgId: string, settings: unknown) => settings),
  };

  return { handlers, send, team };
});

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: mocks.send } },
      { isDestroyed: () => true, webContents: { send: mocks.send } },
    ],
  },
}));

vi.mock("../../services/TeamService", () => mocks.team);

vi.mock("../../utils/ipcRegistry", () => ({
  safeHandle: vi.fn((channel: string, handler: unknown) => {
    mocks.handlers.set(channel, handler as never);
  }),
}));

import { registerOrgSettingsHandlers } from "../OrgSettingsHandlers";

const settings = {
  version: 1 as const,
  messaging: {
    roomsEnabled: false,
    dmsEnabled: true,
    roomCreation: "admins" as const,
  },
};

describe("OrgSettingsHandlers", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.send.mockClear();
    mocks.team.getOrgSettings.mockClear();
    mocks.team.updateOrgSettings.mockClear();
    registerOrgSettingsHandlers();
  });

  it("reads settings for one organization without broadcasting", async () => {
    await mocks.handlers.get("org:settings:get")?.({}, { orgId: "org-a" });

    expect(mocks.team.getOrgSettings).toHaveBeenCalledWith("org-a");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("broadcasts the saved settings to every live window", async () => {
    const result = await mocks.handlers.get("org:settings:set")?.(
      {},
      { orgId: "org-a", settings },
    );

    expect(mocks.team.updateOrgSettings).toHaveBeenCalledWith("org-a", settings);
    expect(result).toEqual(settings);
    // Destroyed windows are skipped, so exactly one of the two receives it.
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith("org:settings-changed", {
      orgId: "org-a",
      settings,
    });
  });

  it("fans a team-sync update out to the windows that hold no socket", async () => {
    await mocks.handlers.get("org:settings:apply")?.(
      {},
      { orgId: "org-a", settings: { messaging: { dmsEnabled: false } } },
    );

    // The forwarded payload is normalized: a partial one must not reach the
    // renderer with fields missing.
    expect(mocks.send).toHaveBeenCalledWith("org:settings-changed", {
      orgId: "org-a",
      settings: {
        version: 1,
        messaging: { roomsEnabled: true, dmsEnabled: false, roomCreation: "members" },
      },
    });
    expect(mocks.team.updateOrgSettings).not.toHaveBeenCalled();
  });

  it("forwards a settings-less broadcast without fabricating defaults", async () => {
    await mocks.handlers.get("org:settings:apply")?.({}, { orgId: "org-a" });

    // Synthesizing the permissive defaults here would look authoritative to
    // the renderer and re-enable what the organization actually turned off.
    // Without settings the listener re-reads instead.
    expect(mocks.send).toHaveBeenCalledWith("org:settings-changed", {
      orgId: "org-a",
    });
  });

  it("rejects requests without an organization id", async () => {
    await expect(mocks.handlers.get("org:settings:get")?.({}, {}))
      .rejects.toThrow("Organization id is required");
    await expect(mocks.handlers.get("org:settings:set")?.({}, { orgId: "org-a" }))
      .rejects.toThrow("org:settings:set requires settings");
  });
});
