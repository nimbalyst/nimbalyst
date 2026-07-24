/** Shared zero-budget policy for the Electron main-process module graph. */
export const MAIN_BUNDLE_GRAPH_CATEGORIES = [
  { name: 'react-dom', test: (p) => /(^|\/)react-dom(\/|$)/.test(p) },
  { name: 'runtime/src/editor', test: (p) => p.includes('runtime/src/editor/') },
  { name: '@lexical/*', test: (p) => p.includes('@lexical/') },
  { name: 'prismjs', test: (p) => p.includes('prismjs') },
  { name: '.tsx modules', test: (p) => p.endsWith('.tsx') },
  {
    name: 'renderer/ files',
    // Our renderer tree only -- electron-log ships its own `src/renderer/`
    // preload shim, which main legitimately bundles.
    test: (p) => p.includes('electron/src/renderer/') && !p.includes('node_modules'),
  },
];

export function normalizeMainBundleModuleId(moduleId) {
  return moduleId
    .replace(/\\/g, '/')
    .replace(/\?.*$/, '')
    .replace(/^(\.\.\/)+/, '');
}

export function findMainBundleGraphViolations(moduleIds) {
  const normalized = moduleIds.map(normalizeMainBundleModuleId);
  return MAIN_BUNDLE_GRAPH_CATEGORIES.map((category) => ({
    name: category.name,
    hits: normalized.filter(category.test),
  })).filter((category) => category.hits.length > 0);
}
