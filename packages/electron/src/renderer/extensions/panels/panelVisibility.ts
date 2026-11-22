/**
 * Which loaded panels the app shows.
 *
 * An extension whose manifest sets `requiresDeveloperMode` keeps its panels,
 * and with them its gutter buttons and toggle commands, out of the app while
 * Developer Mode is off. The extension stays loaded and stays listed in
 * Settings > Extensions, so it can still be turned off there.
 */
export function panelsVisibleInMode<T extends { extensionId: string }>(
  panels: readonly T[],
  manifests: ReadonlyArray<{ id: string; requiresDeveloperMode?: boolean }>,
  developerMode: boolean
): T[] {
  if (developerMode) return [...panels];
  const gated = new Set(manifests.filter((m) => m.requiresDeveloperMode === true).map((m) => m.id));
  return panels.filter((panel) => !gated.has(panel.extensionId));
}
