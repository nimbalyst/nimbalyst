import path from 'path';

const RUNTIME_BUILTIN_THEMES_SEGMENTS = ['runtime', 'src', 'themes', 'builtin'] as const;

/**
 * Build development candidates from the Electron app path toward the
 * monorepo's sibling runtime package.
 *
 * The normal dev entry reports `packages/electron` as the app path, while an
 * isolated output such as `out2/main/index.js` reports
 * `packages/electron/out2/main`. Walking ancestors keeps theme discovery
 * independent of the selected electron-vite output directory.
 */
export function getDevelopmentBuiltinThemesCandidates(appPath: string): string[] {
  const candidates: string[] = [];
  let currentPath = path.resolve(appPath);

  for (let depth = 0; depth < 6; depth += 1) {
    const parentPath = path.dirname(currentPath);
    candidates.push(path.join(parentPath, ...RUNTIME_BUILTIN_THEMES_SEGMENTS));

    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
  }

  return [...new Set(candidates)];
}

export async function resolveDevelopmentBuiltinThemesDirectory(
  appPath: string,
  exists: (candidatePath: string) => Promise<boolean>,
): Promise<string> {
  const candidates = getDevelopmentBuiltinThemesCandidates(appPath);

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  // Preserve the normal development path in diagnostics when the checkout is
  // incomplete or unavailable.
  return candidates[0];
}
