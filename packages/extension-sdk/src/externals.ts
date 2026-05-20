/**
 * Libraries that MUST be externalized by extensions.
 *
 * These libraries are provided by the Nimbalyst host and must not be bundled
 * by extensions. Bundling them would cause runtime errors due to:
 * - React: Multiple instances break hooks ("rendered more hooks than previous render")
 * - Lexical: Extensions contribute nodes to the host's editor instance
 *
 * Extensions should bundle their own utility libraries (zustand, lodash, etc.)
 * for version independence.
 */
export const REQUIRED_EXTERNALS = [
  // React core - multiple instances break hooks
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',

  // Lexical - extensions contribute nodes to host's editor
  'lexical',
  '@lexical/react/LexicalComposerContext',
  '@lexical/react/useLexicalEditable',
  '@lexical/react/useLexicalNodeSelection',
  '@lexical/utils',
  '@lexical/markdown',

  // yJS - collaboration bindings share the host's Y.Doc instance.
  // `instanceof Y.Doc` checks fail if an extension bundles its own yjs
  // copy, so this MUST be externalized (same constraint as React).
  'yjs',
] as const;

/**
 * Regex patterns for externals that match multiple modules.
 */
export const EXTERNAL_PATTERNS = [
  /^@lexical\//,
  /^@nimbalyst\/runtime/,
  // y-protocols ships submodules like `y-protocols/awareness` and
  // `y-protocols/sync`. All of them must resolve to the host's copy.
  /^y-protocols(\/.*)?$/,
] as const;

/**
 * Combined externals for rollup configuration.
 * Use this in rollupOptions.external
 */
export const ROLLUP_EXTERNALS = [
  ...REQUIRED_EXTERNALS,
  ...EXTERNAL_PATTERNS,
  '@nimbalyst/editor-context',
] as const;

export type RequiredExternal = (typeof REQUIRED_EXTERNALS)[number];
