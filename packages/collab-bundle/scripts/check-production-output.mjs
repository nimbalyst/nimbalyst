#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(packageRoot, 'dist');
const artifactExtensions = new Set(['.css', '.js', '.json', '.map']);

const artifactFiles = fs.readdirSync(distRoot, { recursive: true })
  .filter((relativePath) => artifactExtensions.has(path.extname(relativePath)));

const forbiddenOutput = [
  { label: 'development JSX runtime', pattern: 'react/jsx-dev-runtime' },
  { label: 'absolute macOS user path', pattern: '/Users/' },
];

const violations = forbiddenOutput.flatMap(({ label, pattern }) => artifactFiles.flatMap((relativePath) => {
  const source = fs.readFileSync(path.join(distRoot, relativePath), 'utf8');
  return source.includes(pattern) ? [`${label}: ${relativePath}`] : [];
}));

if (violations.length > 0) {
  throw new Error(`production bundle contains forbidden output:\n${violations.join('\n')}`);
}

/**
 * Registrations that must survive tree-shaking.
 *
 * A host that mounts the collaborative editor without these node classes does
 * not merely lose a chip: `@lexical/yjs` throws `Node <type> is not registered`
 * from inside the observer that `Y.applyUpdate` fires, the binding aborts, and
 * the document never paints. This package declares a narrow `sideEffects` field,
 * so a side-effect-only import of its own source is legal for the bundler to
 * delete — which is exactly what happened to `./referenceNodes`, shipping a
 * console that could not open any document containing a tracker reference.
 * Neither vite dev nor vitest tree-shakes, so only the built artifact shows it.
 */
const requiredOutput = [
  { label: 'tracker reference node registration', pattern: '@nimbalyst/tracker-link' },
  { label: 'document reference node registration', pattern: '@nimbalyst/document-link' },
];

const missing = requiredOutput.flatMap(({ label, pattern }) => (
  artifactFiles.some((relativePath) => (
    fs.readFileSync(path.join(distRoot, relativePath), 'utf8').includes(pattern)
  )) ? [] : [`${label} (looked for \`${pattern}\`)`]
));

if (missing.length > 0) {
  throw new Error(
    'production bundle is missing registrations that must survive tree-shaking:\n'
    + `${missing.join('\n')}\n`
    + 'Documents containing these node types will fail to paint. Import a binding '
    + 'and call it rather than relying on a bare side-effect import.',
  );
}

console.log(
  `[collab-bundle] production output clean (${artifactFiles.length} assets; no react/jsx-dev-runtime or /Users/ paths; `
  + `${requiredOutput.length} reference-node registrations present).`,
);
