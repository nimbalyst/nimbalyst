/**
 * Minimal ambient types for refractor v3 (CommonJS, no bundled types).
 *
 * We deliberately avoid `@types/refractor` here because it pulls in
 * `@types/prismjs`, whose global `Prism` declaration conflicts with the
 * `Window.Prism: any` shim in `prismGlobalShim.ts`. We only need the handful of
 * methods used by PrFileDiff / react-diff-view's `tokenize`.
 */
declare module 'refractor' {
  /** A hast node as produced by refractor v3's `highlight()` (opaque to us). */
  export interface RefractorNode {
    type: string;
    [key: string]: unknown;
  }

  export interface Refractor {
    highlight(value: string, language: string): RefractorNode[];
    register(grammar: unknown): void;
    registered(language: string): boolean;
    alias(name: string | Record<string, string | string[]>, alias?: string | string[]): void;
    listLanguages(): string[];
  }

  const refractor: Refractor;
  export default refractor;
}
