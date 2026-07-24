/**
 * Test-only stub for `monaco-editor` / `@monaco-editor/react` / `y-monaco`.
 *
 * Monaco's ESM entry imports raw `.css`, which Node's externalized-dependency
 * loader cannot handle ("Unknown file extension .css"). Nothing in the
 * electron package's unit tests renders Monaco -- it is only reachable
 * transitively through the `@nimbalyst/runtime/editor` barrel -- so the whole
 * module is stubbed for tests.
 */
const notAvailable = () => {
  throw new Error('monaco is stubbed in unit tests');
};

export default notAvailable;
export const editor = {};
export const DiffEditor = notAvailable;
export const Editor = notAvailable;
export const loader = { config: () => {}, init: () => Promise.reject(new Error('stubbed')) };
export const MonacoBinding = notAvailable;
