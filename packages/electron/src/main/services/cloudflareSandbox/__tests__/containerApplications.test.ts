// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../wranglerCli", () => ({
  runWrangler: vi.fn(),
}));

import {
  applicationsForWorker,
  deleteContainerApplication,
  parseContainerApplications,
} from "../containerApplications";
import { runWrangler } from "../wranglerCli";

const SCOPE = {
  configPath: "/tmp/control/wrangler.json",
  profileName: "work",
  cwd: "/tmp/profiles/work",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runWrangler).mockResolvedValue({ stdout: "", stderr: "" });
});

describe("parseContainerApplications", () => {
  it("keeps id and name and drops entries without a real application id", () => {
    const stdout = JSON.stringify([
      { id: "a033a6ac-f267-4792-baac-09437eb1f1fd", name: "w-nimbalystsandbox", version: 1 },
      { id: "not-an-id", name: "w-other" },
      { name: "no-id" },
    ]);

    expect(parseContainerApplications(stdout)).toEqual([
      { id: "a033a6ac-f267-4792-baac-09437eb1f1fd", name: "w-nimbalystsandbox" },
    ]);
  });

  it("refuses output that is not a JSON array rather than treating it as no applications", () => {
    for (const stdout of ["", "{}", "null", "Error: something"]) {
      expect(() => parseContainerApplications(stdout)).toThrow();
    }
  });
});

describe("applicationsForWorker", () => {
  it("matches only applications Cloudflare named for this worker", () => {
    const apps = [
      { id: "1", name: "nimbalyst-sandbox-abc123-nimbalystsandbox" },
      { id: "2", name: "nimbalyst-sandbox-abc123-otherclass" },
      { id: "3", name: "nimbalyst-sandbox-abc1234-nimbalystsandbox" },
      { id: "4", name: "nimbalyst-sandbox-abc123" },
    ];

    expect(
      applicationsForWorker(apps, "nimbalyst-sandbox-abc123").map((a) => a.id)
    ).toEqual(["1", "2"]);
  });
});

describe("deleteContainerApplication", () => {
  it("refuses anything but an application id, so a name can never become a flag", async () => {
    await expect(
      deleteContainerApplication("--help", SCOPE)
    ).rejects.toThrow();
    expect(vi.mocked(runWrangler)).not.toHaveBeenCalled();
  });

  it("scopes the delete to the explicit config and profile", async () => {
    await deleteContainerApplication("a033a6ac-f267-4792-baac-09437eb1f1fd", SCOPE);

    const [args, options] = vi.mocked(runWrangler).mock.calls[0];
    expect(args).toEqual([
      "containers",
      "delete",
      "a033a6ac-f267-4792-baac-09437eb1f1fd",
      "--config",
      SCOPE.configPath,
      "--profile",
      "work",
    ]);
    expect(options).toMatchObject({ cwd: SCOPE.cwd });
  });
});
