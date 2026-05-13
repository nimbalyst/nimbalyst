// Resolve `import 'prismjs'` to the prismjs instance loaded synchronously by
// the classic <script src="./prism.js"> tag in index.html. Without this shim,
// Vite's prebundling re-bundles prismjs core via esbuild's __commonJS wrapper
// and re-runs the IIFE on the ESM side, creating a SECOND Prism instance and
// overwriting window.Prism — which orphans every language registration that
// the prism-* chunks already made on the classic-script instance.
//
// The classic script loads first (synchronous, blocks parsing) so window.Prism
// is guaranteed to be set before any module evaluates, including the prism-*
// language chunks (which reference the bare `Prism` global) and any
// `import 'prismjs'` in user code.

declare global {
  interface Window {
    // prismjs has no TypeScript types in this repo; the global is the same
    // object the prism-* component scripts decorate with `.languages.*`.
    Prism: any;
  }
}

const Prism: any = window.Prism;

if (!Prism) {
  throw new Error(
    '[prismGlobalShim] window.Prism is undefined. The classic <script src="./prism.js"> tag in index.html did not run before this module evaluated. Check that viteStaticCopy is copying prismjs/prism.js to the renderer output.'
  );
}

export default Prism;
