import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const theme = 'packages/runtime/src/editor/themes/NimbalystTheme.css';
const renderer = 'packages/electron/src/renderer/index.css';
const projectGraph = 'packages/extensions/project-graph/src/styles.css';
export const tokenChecks = [
  { source: 'packages/electron/src/renderer/components/WorkspaceManager/WorkspaceManager.tsx', definitions: [theme, renderer] },
  { source: 'packages/electron/src/renderer/components/UnifiedOnboarding/UnifiedOnboarding.css', definitions: [theme] },
  { source: projectGraph, definitions: [theme, renderer] },
];
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');
export function undefinedTokens(source, definitions) {
  const defined = new Set([...stripComments(definitions).matchAll(/(--nim-[a-z0-9-]+)\s*:/g)].map(match => match[1]));
  if (defined.size === 0) throw new Error('No canonical theme tokens found');
  return [...new Set([...stripComments(source).matchAll(/var\(\s*(--nim-[a-z0-9-]+)/g)].map(match => match[1]))].filter(token => !defined.has(token)).sort();
}
export function checkUiInvariants(read = (file) => readFileSync(path.join(root, file), 'utf8')) {
  const failures = [];
  for (const check of tokenChecks) {
    const source = read(check.source);
    const definitions = check.definitions.map(read).join('\n');
    if (new Set([...definitions.matchAll(/(--nim-[a-z0-9-]+)\s*:/g)].map(match => match[1])).size <= 10) throw new Error('Canonical theme definitions are incomplete');
    if (!/var\(\s*--nim-/.test(stripComments(source))) throw new Error(`No theme references found in ${check.source}`);
    const missing = undefinedTokens(source, definitions);
    for (const token of missing) failures.push(`${check.source}: undefined ${token}`);
  }
  // A portal root has no hit-test area; descendants must opt out as well or
  // Windows treats their clicks as title-bar drags.
  if (!/\[data-floating-ui-portal\],\s*\[data-floating-ui-portal\] \*\s*\{[^}]*-webkit-app-region:\s*no-drag/.test(stripComments(read(renderer)))) {
    failures.push(`${renderer}: floating portals and descendants must opt out of window drag`);
  }
  const styles = read(projectGraph);
  for (const selector of ['.pg-toolbar-group', '.pg-label-pill', '.pg-canvas-zoom', '.pg-minimap', '.pg-legend', '.pg-canvas-tip', '.pg-node-tooltip']) {
    const declaration = styles.match(new RegExp(`${selector.replaceAll('.', '\\.')}\\s*\\{([^}]+)\\}`))?.[1] ?? '';
    if (!/background:\s*var\(--pg-floating(?:-strong)?\)/.test(declaration) || /background:\s*(?:#|rgba?\()/.test(declaration)) failures.push(`${projectGraph}: ${selector} must use the floating theme surface`);
  }
  return failures;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = checkUiInvariants();
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  else console.log('UI static invariants passed.');
}
