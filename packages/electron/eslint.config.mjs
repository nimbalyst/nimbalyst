import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// AST selectors that match `electronAPI.on(...)` regardless of how it's accessed
// (`window.electronAPI.on`, destructured `electronAPI.on`, `api.electronAPI.on`).
// Used by no-restricted-syntax to enforce docs/IPC_LISTENERS.md.
const ELECTRON_API_ON_MESSAGE =
  'Do not call electronAPI.on() outside the sanctioned singleton-listener directories ' +
  '(store/listeners/, store/atoms/, store/sessionStateListeners.ts, services/, plugins/, extensions/panels/). ' +
  'See docs/IPC_LISTENERS.md -- the forbidden pattern is any electronAPI.on() reachable from a React lifecycle, ' +
  'and even module-level subscriptions inside component files leak through HMR/lazy routes/test imports. ' +
  'Add a centralized listener that updates an atom; have the component read the atom.';

const ELECTRON_API_ON_SELECTORS = [
  // window.electronAPI.on(...) and any other `<expr>.electronAPI.on(...)`
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name='on']" +
      "[callee.object.type='MemberExpression'][callee.object.property.name='electronAPI']",
    message: ELECTRON_API_ON_MESSAGE,
  },
  // electronAPI.on(...) where electronAPI is a local identifier (destructured / aliased)
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name='on']" +
      "[callee.object.type='Identifier'][callee.object.name='electronAPI']",
    message: ELECTRON_API_ON_MESSAGE,
  },
];

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    rules: {
      // Enforce importing atomFamily from the tracked wrapper instead of jotai/utils.
      // The wrapper auto-registers every atomFamily for the Developer Dashboard stats view.
      // The registry itself (atomFamilyRegistry.ts) is excluded via the ignores pattern below.
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'jotai/utils',
            importNames: ['atomFamily'],
            message: 'Import atomFamily from \'../debug/atomFamilyRegistry\' (or correct relative path) instead of \'jotai/utils\'. This ensures automatic registration for the Developer Dashboard > AtomFamily Stats.'
          },
          {
            // Renderer code must go through the Enhanced wrappers so frontmatter
            // extraction, list-indent normalization, and our NCR-based
            // literal-emphasis encoding stay applied. Calling upstream's
            // $convertFromMarkdownString or $convertToMarkdownString directly
            // skips those steps and regresses round-trip stability on real
            // Nimbalyst plan documents (see
            // packages/runtime/src/editor/markdown/FORKED_MARKDOWN_IMPORT.md).
            name: '@lexical/markdown',
            importNames: ['$convertFromMarkdownString', '$convertToMarkdownString'],
            message: 'Use $convertFromEnhancedMarkdownString / $convertToEnhancedMarkdownString from @nimbalyst/runtime/editor instead. See packages/runtime/src/editor/markdown/FORKED_MARKDOWN_IMPORT.md for why upstream import/export must not be called directly.',
          },
          // Phase 7 retired these React plugins in favor of `@lexical/*`
          // extensions wired into `NimbalystEditorExtensions`. Importing
          // them again means mounting them inside `LexicalExtensionComposer`
          // alongside the extension that already does the same work, which
          // double-registers commands and history listeners.
          {
            name: '@lexical/react/LexicalHistoryPlugin',
            message: 'HistoryPlugin is replaced by HistoryExtension from @lexical/history, wired in editor/extensions/NimbalystEditorExtensions.ts (Phase 7.2). Do not re-mount the React plugin -- it double-tracks undo/redo.',
          },
          {
            name: '@lexical/react/LexicalListPlugin',
            message: 'ListPlugin is replaced by ListExtension from @lexical/list (Phase 7.2). See editor/extensions/NimbalystEditorExtensions.ts.',
          },
          {
            name: '@lexical/react/LexicalCheckListPlugin',
            message: 'CheckListPlugin is replaced by CheckListExtension from @lexical/list (Phase 7.2). See editor/extensions/NimbalystEditorExtensions.ts.',
          },
          {
            name: '@lexical/react/LexicalTabIndentationPlugin',
            message: 'TabIndentationPlugin is replaced by TabIndentationExtension from @lexical/extension (Phase 7.2). See editor/extensions/NimbalystEditorExtensions.ts.',
          },
          {
            name: '@lexical/react/LexicalHorizontalRulePlugin',
            message: 'HorizontalRulePlugin is replaced by HorizontalRuleExtension from @lexical/extension (Phase 7.2). See editor/extensions/NimbalystEditorExtensions.ts.',
          },
          {
            name: '@lexical/react/LexicalClearEditorPlugin',
            message: 'ClearEditorPlugin is replaced by ClearEditorExtension from @lexical/extension (Phase 7.2). See editor/extensions/NimbalystEditorExtensions.ts.',
          },
          {
            name: '@lexical/react/LexicalLinkPlugin',
            message: 'LinkPlugin is replaced by LinkExtension from @lexical/link (Phase 7.2). See editor/extensions/NimbalystEditorExtensions.ts.',
          },
          {
            // The React-only subclass exists for back-compat. Phase 7.2
            // moved every callsite to the canonical class from
            // @lexical/extension; the subclass would not be registered on
            // the editor and would round-trip to an unknown node type.
            name: '@lexical/react/LexicalHorizontalRuleNode',
            message: 'Import HorizontalRuleNode, $createHorizontalRuleNode, $isHorizontalRuleNode, and INSERT_HORIZONTAL_RULE_COMMAND from @lexical/extension instead (Phase 7.2). The React subclass is not registered on the editor.',
          },
        ],
      }],
      // Ban electronAPI.on() in the renderer by default. Re-enabled for the
      // sanctioned singleton-subscription directories below.
      'no-restricted-syntax': ['error', ...ELECTRON_API_ON_SELECTORS],
    },
  },
  {
    // The registry itself must import the real atomFamily from jotai/utils
    files: ['src/renderer/store/debug/atomFamilyRegistry.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // The extension platform service deliberately re-exposes the entire
    // @lexical/markdown surface to extension code via importShim, so the
    // namespace import has to be allowed here. Extensions are trusted to
    // know the import-fn caveats; first-party code does not get the same
    // free pass.
    files: ['src/renderer/services/ExtensionPlatformServiceImpl.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // Sanctioned singleton-subscription locations -- see docs/IPC_LISTENERS.md
    // "Sanctioned singleton subscriptions" section. These install once at
    // module load (or via an install-once flag) and never react to React
    // lifecycle, so the centralized-listener rule does not apply.
    files: [
      'src/renderer/store/listeners/**/*.ts',
      'src/renderer/store/atoms/terminals.ts',
      'src/renderer/store/atoms/appSettings.ts',
      'src/renderer/store/sessionStateListeners.ts',
      'src/renderer/services/**/*.ts',
      'src/renderer/plugins/registerExtensionSystem.ts',
      'src/renderer/extensions/panels/PanelHostImpl.ts',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    // Disable rules that conflict with the codebase patterns
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    ignores: ['out/**', 'out2/**', 'node_modules/**', 'dist/**'],
  },
);
