/**
 * Ambient type shim for the slice of @nimbalyst/runtime that this extension
 * imports. The host injects the real implementation at runtime, exactly like
 * the electronAPI shim in the gemini-antigravity extension and the globals
 * shim in mockuplm.
 *
 * PRE-EXISTING ISSUE (not introduced by the gemini-antigravity branch):
 * TranscriptMathHost.tsx imports two functions from the package root
 * @nimbalyst/runtime. With moduleResolution bundler, tsc resolves that
 * specifier through the runtime package "exports" field, which points types
 * at ./dist/index.d.ts. When dist is not built the workspace typecheck fails
 * with TS2307 Cannot find module @nimbalyst/runtime.
 *
 * A tsconfig paths mapping to ../../runtime/src/index.ts (the convention used
 * by packages/electron) does resolve the module, but it then deep-compiles the
 * entire runtime barrel under this extension's stricter tsconfig and pulls in
 * runtime-internal type support (prettier ambient decls, env.d.ts window
 * augmentations, the @nimbalyst/extension-sdk/agents subpath) that this small
 * extension has no reason to recompile. This ambient declaration is the
 * smallest fix: it types only the two functions actually used here, does not
 * depend on a built dist, and keeps this package's own strict settings intact.
 *
 * Must NOT contain a top-level import or export; that would turn this file
 * into a module and the declaration would stop being ambient.
 */
declare module '@nimbalyst/runtime' {
  /**
   * A single transcript markdown contribution. Plugins are typed as unknown to
   * avoid pinning a unified/react-markdown version, mirroring the real runtime
   * type at packages/runtime/src/ui/AgentTranscript/contributions.
   */
  export interface TranscriptMarkdownContribution {
    remarkPlugins?: ReadonlyArray<unknown>;
    rehypePlugins?: ReadonlyArray<unknown>;
    components?: Readonly<Record<string, unknown>>;
    styles?: ReadonlyArray<unknown>;
  }

  export function setTranscriptMarkdownContributions(
    source: string,
    next?: TranscriptMarkdownContribution,
  ): void;

  export function clearTranscriptMarkdownContributions(source: string): void;
}
