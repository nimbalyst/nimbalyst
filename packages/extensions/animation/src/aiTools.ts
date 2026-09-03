/**
 * Animation AI tools.
 *
 * Export is deliberately `filesystem` access rather than `editor-read`: an agent
 * should be able to export any `.anim.json` in the workspace without the file
 * being open, and the exporter needs nothing from a mounted editor beyond the
 * document itself, which it can parse from disk.
 */

import { parseDocument, type Problem } from "./core/parse";
import { totalDuration } from "./core/timeline";
import type { AnimDocument } from "./core/types";
import { buildStandaloneDocument } from "./render/standalone";
import { loadHtmlAssets, type HtmlAssets } from "./core/htmlParts";
import { FALLBACK_TOKENS } from "./render/stageCss";
import {
  getElectronInvoke,
  revealExport,
  resolveExportPath,
  type ElectronInvoke,
} from "./core/revealExport";

interface ExportParams {
  filePath: string;
  outputPath?: string;
}

interface GifExportParams extends ExportParams {
  fps?: number;
  maxWidth?: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read, parse and sanity-check a document before either exporter touches it.
 *
 * Both exporters refuse a document with parse errors: it would render as an
 * empty or half-drawn stage, which reads as a broken exporter rather than a
 * broken document.
 */
async function loadExportable(
  rawPath: string | undefined,
  context: ExportToolContext
): Promise<
  | {
      doc: AnimDocument;
      filePath: string;
      warnings: string[];
      assets: HtmlAssets;
    }
  | { success: false; error: string; problems?: string[] }
> {
  const filePath = rawPath?.trim();
  if (!filePath) {
    return { success: false, error: "filePath is required." };
  }

  let source: string;
  try {
    source = await context.extensionContext.services.filesystem.readFile(
      filePath
    );
  } catch (error) {
    return {
      success: false,
      error: `Could not read ${filePath}: ${describe(error)}`,
    };
  }

  const { doc, problems } = parseDocument(source);
  const text = (problem: Problem) =>
    problem.path ? `${problem.path}: ${problem.message}` : problem.message;

  const errors = problems.filter((problem) => problem.level === "error");
  if (errors.length > 0) {
    return {
      success: false,
      error: `${filePath} has ${errors.length} parse error(s) and was not exported.`,
      problems: errors.map(text),
    };
  }

  if (doc.steps.length === 0) {
    return {
      success: false,
      error: `${filePath} has no steps, so there is nothing to animate.`,
    };
  }

  // `htmlFile` partials are read here rather than at render time so all three
  // exporters and the editor preview draw from the same resolved markup.
  const { assets, errors: assetErrors } = await loadHtmlAssets(
    doc,
    filePath,
    (path) => context.extensionContext.services.filesystem.readFile(path)
  );

  return {
    doc,
    filePath,
    assets,
    warnings: [
      ...problems.filter((problem) => problem.level === "warning").map(text),
      ...assetErrors,
    ],
  };
}

/**
 * Only the slice of the host's tool context this file touches.
 *
 * Typed structurally rather than imported from `@nimbalyst/extension-sdk` so
 * the extension keeps an empty dependency list; the SDK types are not on this
 * package's resolution path.
 */
interface ExportToolContext {
  workspacePath?: string;
  extensionContext: {
    services: {
      filesystem: {
        readFile(path: string): Promise<string>;
        writeFile(path: string, content: string): Promise<void>;
      };
    };
  };
}

/** `a/b/thing.anim.json` -> `a/b/thing.<ext>`. */
function siblingPath(filePath: string, extension: string): string {
  return filePath.replace(/(\.anim)?\.json$/i, "") + extension;
}

/** `a/b/thing.anim.json` -> `thing`. */
function titleFor(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace(/(\.anim)?\.json$/i, "");
}

export const aiTools = [
  {
    name: "export_html",
    access: { kind: "filesystem" } as const,
    description: `Export a .anim.json animation as a self-contained HTML file that plays and loops on its own, with no external dependencies.

Use this when the user wants to share an animation, embed it in docs, or view it outside Nimbalyst.

The exported file keeps real playback rather than baked frames, so transitions and edge packets still move. Click the page to pause.

Note: this produces HTML, not a GIF or a video. There is no GIF/MP4 export yet.

Example usage:
- "Export the cache animation so I can share it"
- "Turn docs/consensus.anim.json into a standalone page"`,
    parameters: {
      type: "object" as const,
      properties: {
        filePath: {
          type: "string",
          description:
            "Absolute or workspace-relative path to the .anim.json file to export.",
        },
        outputPath: {
          type: "string",
          description:
            "Where to write the .html file. Defaults to the input path with the extension replaced.",
        },
      },
      required: ["filePath"],
    },
    handler: async (params: ExportParams, context: ExportToolContext) => {
      const loaded = await loadExportable(params.filePath, context);
      if ("error" in loaded) return loaded;
      const { doc, filePath, warnings, assets } = loaded;

      const outputPath = resolveExportPath(
        params.outputPath?.trim() || siblingPath(filePath, ".html"),
        context.workspacePath
      );
      const html = buildStandaloneDocument(doc, FALLBACK_TOKENS, {
        assets,
        title: titleFor(filePath),
      });

      try {
        await context.extensionContext.services.filesystem.writeFile(
          outputPath,
          html
        );
      } catch (error) {
        return {
          success: false,
          error: `Could not write ${outputPath}: ${describe(error)}`,
        };
      }

      await revealExport(outputPath);

      return {
        success: true,
        outputPath,
        durationMs: totalDuration(doc),
        steps: doc.steps.length,
        parts: Object.keys(doc.parts).length,
        bytes: html.length,
        warnings,
      };
    },
  },
  {
    name: "export_gif",
    access: { kind: "filesystem" } as const,
    description: `Export a .anim.json animation as an animated GIF, for places that cannot run HTML: a GitHub issue, a README, a chat message, a slide.

Recording plays the animation in an offscreen window and captures it in real time, so it takes roughly as long as the animation runs. Prefer export_html when the destination can display a web page: it is instant, sharper, and a fraction of the size.

Example usage:
- "Make a GIF of the consensus animation for the README"
- "Export it as a GIF I can paste into the issue"`,
    parameters: {
      type: "object" as const,
      properties: {
        filePath: {
          type: "string",
          description:
            "Absolute or workspace-relative path to the .anim.json file to export.",
        },
        outputPath: {
          type: "string",
          description:
            "Where to write the .gif. Defaults to the input path with the extension replaced.",
        },
        fps: {
          type: "number",
          description:
            "Target frames per second, 2 to 30. Defaults to 12. Lower means a smaller file.",
        },
        maxWidth: {
          type: "number",
          description:
            "Width of the output in pixels, 160 to 1600. Defaults to 960. GIFs grow quickly with size.",
        },
      },
      required: ["filePath"],
    },
    handler: async (params: GifExportParams, context: ExportToolContext) => {
      const loaded = await loadExportable(params.filePath, context);
      if ("error" in loaded) return loaded;
      const { doc, filePath, warnings, assets } = loaded;

      const invoke: ElectronInvoke | null = getElectronInvoke();
      if (!invoke) {
        return {
          success: false,
          error:
            "GIF export needs the desktop app; no IPC bridge is available here.",
        };
      }

      const outputPath = resolveExportPath(
        params.outputPath?.trim() || siblingPath(filePath, ".gif"),
        context.workspacePath
      );

      // Capture hooks let the recorder start the clock at t=0 rather than
      // trusting page-load timing; without them the GIF starts mid-animation.
      const html = buildStandaloneDocument(doc, FALLBACK_TOKENS, {
        assets,
        title: titleFor(filePath),
        captureHooks: true,
      });

      const response = await invoke("export:animationGif", {
        html,
        outputPath,
        width: doc.stage.width,
        height: doc.stage.height,
        durationMs: totalDuration(doc),
        fps: params.fps,
        maxWidth: params.maxWidth,
      });

      if (!response?.success) {
        return {
          success: false,
          error: response?.error ?? "GIF export failed.",
        };
      }

      await revealExport(outputPath);

      return { success: true, warnings, ...(response.result as object) };
    },
  },
  {
    name: "export_mp4",
    access: { kind: "filesystem" } as const,
    description: `Export a .anim.json animation as an H.264 MP4. This is the right format for social posts, and for anywhere else that can play a video.

Prefer this over export_gif whenever the destination plays video. Sites that accept a GIF transcode it to H.264 on upload, so a GIF pays a 256-colour quantization and then gets re-encoded from the quantized result; the MP4 is full colour and lands roughly a tenth of the size.

Recording plays the animation in an offscreen window and captures it in real time, so it takes roughly as long as the animation runs.

Example usage:
- "Export it as an MP4 I can post"
- "Make a video of the consensus animation for the launch thread"`,
    parameters: {
      type: "object" as const,
      properties: {
        filePath: {
          type: "string",
          description:
            "Absolute or workspace-relative path to the .anim.json file to export.",
        },
        outputPath: {
          type: "string",
          description:
            "Where to write the .mp4. Defaults to the input path with the extension replaced.",
        },
        fps: {
          type: "number",
          description:
            "Target frames per second, 2 to 60. Defaults to 30. Capture is real-time, so a slow machine may not reach the target; the video stays the right length either way.",
        },
        maxWidth: {
          type: "number",
          description:
            "Width of the output in pixels, 160 to 1920. Defaults to 1440. Upload at about twice the size it will display at: H.264 subsamples colour, which softens small coloured text.",
        },
      },
      required: ["filePath"],
    },
    handler: async (params: GifExportParams, context: ExportToolContext) => {
      const loaded = await loadExportable(params.filePath, context);
      if ("error" in loaded) return loaded;
      const { doc, filePath, warnings, assets } = loaded;

      const invoke: ElectronInvoke | null = getElectronInvoke();
      if (!invoke) {
        return {
          success: false,
          error:
            "MP4 export needs the desktop app; no IPC bridge is available here.",
        };
      }

      const outputPath = resolveExportPath(
        params.outputPath?.trim() || siblingPath(filePath, ".mp4"),
        context.workspacePath
      );

      const html = buildStandaloneDocument(doc, FALLBACK_TOKENS, {
        assets,
        title: titleFor(filePath),
        captureHooks: true,
      });

      const response = await invoke("export:animationMp4", {
        html,
        outputPath,
        width: doc.stage.width,
        height: doc.stage.height,
        durationMs: totalDuration(doc),
        fps: params.fps,
        maxWidth: params.maxWidth,
      });

      if (!response?.success) {
        return {
          success: false,
          error: response?.error ?? "MP4 export failed.",
        };
      }

      await revealExport(outputPath);

      return { success: true, warnings, ...(response.result as object) };
    },
  },
];
