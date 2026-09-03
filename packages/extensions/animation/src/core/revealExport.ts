export interface ElectronInvokeResponse {
  success: boolean;
  error?: string;
  result?: unknown;
}

export type ElectronInvoke = (
  channel: string,
  payload: unknown
) => Promise<ElectronInvokeResponse | undefined>;

/** The generic IPC passthrough the preload exposes in the desktop app. */
export function getElectronInvoke(): ElectronInvoke | null {
  const api = (globalThis as { electronAPI?: { invoke?: unknown } })
    .electronAPI;
  return typeof api?.invoke === "function"
    ? (api.invoke as ElectronInvoke)
    : null;
}

/** Resolve a tool's workspace-relative output before native export or reveal. */
export function resolveExportPath(
  outputPath: string,
  workspacePath?: string
): string {
  const absolute =
    outputPath.startsWith("/") ||
    outputPath.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(outputPath);
  if (absolute || !workspacePath) return outputPath;

  const separator = workspacePath.includes("\\") ? "\\" : "/";
  const root = workspacePath.replace(/[\\/]+$/, "");
  const relative = outputPath
    .replace(/^[\\/]+/, "")
    .replace(/[\\/]/g, separator);
  return `${root}${separator}${relative}`;
}

/**
 * Reveal a completed export in Finder, Explorer, or the platform equivalent.
 *
 * Export is already complete when this runs, so a missing bridge or a file
 * manager error is deliberately non-fatal: it must not turn a written file
 * into a reported export failure.
 */
export async function revealExport(outputPath: string): Promise<void> {
  const invoke = getElectronInvoke();
  if (!invoke) return;

  try {
    const response = await invoke("show-in-finder", outputPath);
    if (response && !response.success) {
      console.warn(
        `[Animation] Exported ${outputPath}, but could not reveal it: ${
          response.error ?? "unknown error"
        }`
      );
    }
  } catch (error) {
    console.warn(
      `[Animation] Exported ${outputPath}, but could not reveal it: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
