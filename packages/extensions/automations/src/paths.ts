/**
 * Automation files live at `<project>/nimbalyst-local/automations/<id>.md`.
 * A window can have several projects open, so every relative path an
 * automation names (output location, history) belongs to the project that
 * holds its file, not to the window's first project (#1299).
 */

const AUTOMATIONS_DIR = /[\\/]nimbalyst-local[\\/]automations[\\/]/g;

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:/.test(path);
}

/**
 * The project root an absolute automation file path lives under, or undefined
 * for a relative path (the host then uses the window's first project).
 */
export function projectRootOf(filePath: string): string | undefined {
  if (!isAbsolute(filePath)) return undefined;
  let lastIndex = -1;
  for (const match of filePath.matchAll(AUTOMATIONS_DIR)) lastIndex = match.index ?? -1;
  if (lastIndex <= 0) return undefined;
  return filePath.slice(0, lastIndex);
}

/** Anchor a project-relative path at `projectRoot`; absolute paths pass through. */
export function inProject(projectRoot: string | undefined, path: string): string {
  if (!projectRoot || isAbsolute(path)) return path;
  return `${projectRoot}/${path}`;
}
