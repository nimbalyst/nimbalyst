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
        paths: [{
          name: 'jotai/utils',
          importNames: ['atomFamily'],
          message: 'Import atomFamily from \'../debug/atomFamilyRegistry\' (or correct relative path) instead of \'jotai/utils\'. This ensures automatic registration for the Developer Dashboard > AtomFamily Stats.'
        }]
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
