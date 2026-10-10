#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const typesRoot = path.join(packageRoot, 'types');
const internalRoot = path.join(typesRoot, 'internal');
const publicEntries = ['commenting-ui', 'docs-ui', 'feedback-ui', 'trackers-ui', 'quick-open', 'inbox', 'pages'].map((entryName) => ({
  generated: path.join(internalRoot, `collab-bundle/src/${entryName}.d.ts`),
  public: path.join(typesRoot, `${entryName}.d.ts`),
}));
const require = createRequire(import.meta.url);

fs.rmSync(internalRoot, { recursive: true, force: true });

const tsc = spawnSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '-p', path.join(packageRoot, 'tsconfig.types.json')],
  { cwd: packageRoot, stdio: 'inherit' },
);
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

function declarationFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? declarationFiles(target)
      : entry.name.endsWith('.d.ts') ? [target] : [];
  });
}

/**
 * Extension-SDK subpaths whose published name differs from the source filename
 * (see the `exports` map in packages/extension-sdk/package.json). Without these
 * the rewrite below looks for `src/file-tree.d.ts`, finds nothing, and the
 * whole types build fails on any bundled module that imports one. Mirrored in
 * the `paths` block of tsconfig.json so tsc resolves them the same way.
 */
const EXTENSION_SDK_SOURCE_NAMES = {
  'file-tree': 'fileDirectoryTree',
  'file-mask': 'fileMask',
};

function internalTarget(specifier) {
  // A bare `@nimbalyst/tracker-schema` is not installed in the hosts; left as-is,
  // every label, predicate and schema type reaching them silently became `any`.
  // The bundle resolves it to the browser barrel (see vite.config.ts).
  if (specifier === '@nimbalyst/tracker-schema') return path.join(internalRoot, 'tracker-schema/src/browser.d.ts');
  // Every collab-client subpath the bundle reaches is a directory with an
  // index, as vite.config.ts and tsconfig.json resolve it.
  const collabClient = specifier.match(/^@nimbalyst\/collab-client\/([a-z-]+(?:\/[A-Za-z-]+)*)$/);
  if (collabClient) {
    return path.join(internalRoot, 'collab-client/src', collabClient[1], 'index.d.ts');
  }
  const runtime = specifier.match(/^@nimbalyst\/runtime\/(.+)$/);
  if (runtime) {
    const direct = path.join(internalRoot, 'runtime/src', `${runtime[1]}.d.ts`);
    return fs.existsSync(direct)
      ? direct
      : path.join(internalRoot, 'runtime/src', runtime[1], 'index.d.ts');
  }
  // The extension SDK reaches the published types the same way, so the public
  // `EditorHost` is the SDK's own declaration rather than a hand-kept copy.
  const extensionSdk = specifier.match(/^@nimbalyst\/extension-sdk\/(.+)$/);
  if (extensionSdk) {
    const subpath = EXTENSION_SDK_SOURCE_NAMES[extensionSdk[1]] ?? extensionSdk[1];
    const direct = path.join(internalRoot, 'extension-sdk/src', `${subpath}.d.ts`);
    return fs.existsSync(direct)
      ? direct
      : path.join(internalRoot, 'extension-sdk/src', subpath, 'index.d.ts');
  }
  return null;
}

function relativeDeclarationSpecifier(fromFile, targetFile) {
  const relative = path.relative(path.dirname(fromFile), targetFile)
    .replaceAll(path.sep, '/')
    .replace(/\.d\.ts$/, '');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

for (const declarationFile of declarationFiles(internalRoot)) {
  if (publicEntries.some((entry) => entry.generated === declarationFile)) continue;
  const source = fs.readFileSync(declarationFile, 'utf8');
  const rewritten = source.replace(
    /(['"])(@nimbalyst\/(?:collab-client|runtime|extension-sdk)\/[^'"]+|@nimbalyst\/tracker-schema)\1/g,
    (match, quote, specifier) => {
      const target = internalTarget(specifier);
      if (!target || !fs.existsSync(target)) {
        throw new Error(`No emitted declaration target for ${specifier} imported by ${declarationFile}`);
      }
      return `${quote}${relativeDeclarationSpecifier(declarationFile, target)}${quote}`;
    },
  );
  fs.writeFileSync(declarationFile, rewritten);
}

for (const entry of publicEntries) {
  let publicTypes = fs.readFileSync(entry.generated, 'utf8');
  publicTypes = publicTypes.replace(
    /(['"])(@nimbalyst\/(?:collab-client|runtime|extension-sdk)\/[^'"]+|@nimbalyst\/tracker-schema)\1/g,
    (match, quote, specifier) => {
      const target = internalTarget(specifier);
      if (!target || !fs.existsSync(target)) {
        throw new Error(`No emitted declaration target for ${specifier} imported by ${entry.generated}`);
      }
      return `${quote}${relativeDeclarationSpecifier(entry.public, target)}${quote}`;
    },
  );
  fs.writeFileSync(entry.public, publicTypes);
}
fs.rmSync(path.join(internalRoot, 'collab-bundle'), { recursive: true, force: true });
