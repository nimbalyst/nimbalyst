import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLLAB_BUNDLE_FORBIDDEN_DEPENDENCIES,
  findEagerEntryFiles,
  findBundledSingletons,
  findEmbeddedLaneViolations,
  findEntrySeparationViolations,
} from '../check-collab-bundle.mjs';
import { findBrowserDependencyViolations } from '../browser-bundle-graph.mjs';

test('classifies every forbidden browser-boundary category', () => {
  const violations = findBrowserDependencyViolations([
    'electron',
    'node:crypto',
    'path',
    '/repo/packages/runtime/src/ai/server/providers/SecretProvider.ts',
    '/repo/packages/runtime/src/editor/plugins/SpeechToTextPlugin/index.ts',
    '/repo/packages/extension-sdk/src/index.ts',
  ], COLLAB_BUNDLE_FORBIDDEN_DEPENDENCIES);

  assert.deepEqual(
    violations.map(({ name }) => name),
    [
      'Electron',
      'Node builtins',
      'filesystem',
      'secrets-bearing modules',
      'desktop-only editor plugins',
      'extension SDK leakage',
    ],
  );
});

test('allows the draggable block handle into the browser bundle', () => {
  const violations = findBrowserDependencyViolations([
    '/repo/packages/runtime/src/editor/plugins/DraggableBlockPlugin/index.tsx',
  ], COLLAB_BUNDLE_FORBIDDEN_DEPENDENCIES);

  assert.deepEqual(violations, []);
});

test('fails loudly when React, Lexical, or Yjs is bundled', () => {
  const violations = findBundledSingletons([
    { id: '/repo/node_modules/react/index.js', external: false },
    { id: '/repo/node_modules/@lexical/yjs/LexicalYjs.mjs', external: false },
    { id: '/repo/node_modules/yjs/dist/yjs.mjs', external: false },
    { id: 'react', external: true },
  ]);

  assert.deepEqual(violations.map(({ name }) => name), ['React', 'Lexical', 'Yjs']);
});

test('fails loudly when Jotai or the runtime store resolves through two embedded lanes', () => {
  const violations = findEmbeddedLaneViolations([
    { id: '/repo/node_modules/jotai/esm/index.mjs', external: false },
    { id: '/repo/packages/collab-client/node_modules/jotai/esm/index.mjs', external: false },
    { id: '/repo/packages/runtime/src/store/index.ts', external: false },
    { id: '/repo/node_modules/@nimbalyst/runtime/dist/store/index.js', external: false },
  ]);

  assert.deepEqual(violations.map(({ name }) => name), ['Jotai', 'runtime store']);
});

test('keeps editor and docs-ui dependency closures separate', () => {
  const cleanReport = {
    chunks: [
      {
        fileName: 'editor.js', name: 'editor', isEntry: true,
        imports: [], dynamicImports: [], exports: [],
        modules: ['/repo/packages/runtime/src/editor/NimbalystEditor.tsx'],
      },
      {
        fileName: 'docs-ui.js', name: 'docs-ui', isEntry: true,
        imports: [], dynamicImports: [], exports: ['createCollabDocsSession'], modules: [
          '/repo/packages/collab-client/src/docs-ui/index.ts',
          '/repo/packages/collab-client/src/docs/session.ts',
          '/repo/packages/runtime/src/store/index.ts',
          '/repo/node_modules/jotai/esm/index.mjs',
        ],
      },
    ],
  };
  assert.deepEqual(findEntrySeparationViolations(cleanReport), []);

  cleanReport.chunks[1].exports = [];
  assert.deepEqual(
    findEntrySeparationViolations(cleanReport),
    ['docs-ui entry does not export createCollabDocsSession'],
  );
  cleanReport.chunks[1].exports = ['createCollabDocsSession'];

  cleanReport.chunks[1].modules.push('/repo/packages/runtime/src/editor/Editor.tsx');
  assert.deepEqual(
    findEntrySeparationViolations(cleanReport),
    ['docs-ui entry pulls the editor/codec graph'],
  );
});

test('eager entry closure follows static imports but stops at dynamic imports', () => {
  const report = {
    chunks: [
      {
        fileName: 'editor.js', name: 'editor', isEntry: true,
        imports: ['chunks/editor-core.js'], dynamicImports: ['chunks/lazy-from-entry.js'], modules: [],
      },
      {
        fileName: 'chunks/editor-core.js', name: 'editor-core', isEntry: false,
        imports: ['chunks/static-transitive.js', 'react'],
        dynamicImports: ['chunks/large-lazy-feature.js'], modules: [],
      },
      {
        fileName: 'chunks/static-transitive.js', name: 'static-transitive', isEntry: false,
        imports: [], dynamicImports: [], modules: [],
      },
      {
        fileName: 'chunks/large-lazy-feature.js', name: 'large-lazy-feature', isEntry: false,
        imports: [], dynamicImports: [], modules: [],
      },
    ],
  };

  assert.deepEqual(
    findEagerEntryFiles(report, 'editor'),
    ['editor.js', 'chunks/editor-core.js', 'chunks/static-transitive.js'],
  );
});
