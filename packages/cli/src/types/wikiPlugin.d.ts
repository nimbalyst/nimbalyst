/**
 * Types for `@nimbalyst/wiki-plugin/session-inputs`, the knowledge
 * extension's session-inputs server that `nim hook session-inputs` runs
 * (commands/hook.ts). The sources live outside this package's rootDir, so tsc reads
 * these ambient declarations while scripts/build.mjs and vitest.config.ts
 * alias the specifier to its source. Keep this a subset of its exports.
 */
declare module '@nimbalyst/wiki-plugin/session-inputs' {
  /** packages/extensions/knowledge/src/sessionInputs/server.ts */
  export function main(): void;
}
