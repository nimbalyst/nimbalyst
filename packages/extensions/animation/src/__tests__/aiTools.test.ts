// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { aiTools } from "../aiTools";
import { resolveExportPath } from "../core/revealExport";

const VALID_DOCUMENT = JSON.stringify({
  version: 1,
  stage: { width: 500, height: 300, fps: 25 },
  parts: { box: { type: "node", x: 20, y: 20, w: 100, h: 60 } },
  steps: [{ id: "idle", duration: 800 }],
});

function tool(name: string) {
  const found = aiTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing animation tool ${name}`);
  return found;
}

function context() {
  return {
    workspacePath: "/workspace",
    extensionContext: {
      services: {
        filesystem: {
          readFile: vi.fn(async () => VALID_DOCUMENT),
          writeFile: vi.fn(async () => undefined),
        },
      },
    },
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "electronAPI");
});

describe("animation export tools", () => {
  it.each([
    ["export_html", "exports/example.html", null],
    ["export_mp4", "exports/example.mp4", "export:animationMp4"],
    ["export_gif", "exports/example.gif", "export:animationGif"],
  ])(
    "reveals a successful workspace-relative %s export in the file manager",
    async (name, outputPath, exportChannel) => {
      const absoluteOutputPath = `/workspace/${outputPath}`;
      const invoke = vi.fn(async (channel: string) =>
        channel === exportChannel
          ? { success: true, result: { outputPath: absoluteOutputPath } }
          : { success: true }
      );
      Object.defineProperty(globalThis, "electronAPI", {
        configurable: true,
        value: { invoke },
      });

      const toolContext = context();
      const result = await tool(name).handler(
        { filePath: "/workspace/example.anim.json", outputPath },
        toolContext
      );

      expect(result.success).toBe(true);
      if (exportChannel) {
        expect(invoke).toHaveBeenCalledWith(
          exportChannel,
          expect.objectContaining({ outputPath: absoluteOutputPath })
        );
      } else {
        expect(
          toolContext.extensionContext.services.filesystem.writeFile
        ).toHaveBeenCalledWith(absoluteOutputPath, expect.any(String));
      }
      expect(invoke).toHaveBeenCalledWith("show-in-finder", absoluteOutputPath);
    }
  );

  it("does not reveal a failed recording", async () => {
    const invoke = vi.fn(async () => ({ success: false, error: "No encoder" }));
    Object.defineProperty(globalThis, "electronAPI", {
      configurable: true,
      value: { invoke },
    });

    const result = await tool("export_mp4").handler(
      {
        filePath: "/workspace/example.anim.json",
        outputPath: "/workspace/example.mp4",
      },
      context()
    );

    expect(result.success).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith(
      "show-in-finder",
      "/workspace/example.mp4"
    );
  });
});

describe("resolveExportPath", () => {
  it.each([
    ["exports/example.mp4", "/workspace", "/workspace/exports/example.mp4"],
    [
      "exports/example.mp4",
      "C:\\workspace",
      "C:\\workspace\\exports\\example.mp4",
    ],
    ["/tmp/example.mp4", "/workspace", "/tmp/example.mp4"],
    ["C:\\exports\\example.mp4", "C:\\workspace", "C:\\exports\\example.mp4"],
  ])(
    "resolves %s against the active workspace",
    (outputPath, workspacePath, expected) => {
      expect(resolveExportPath(outputPath, workspacePath)).toBe(expected);
    }
  );
});
