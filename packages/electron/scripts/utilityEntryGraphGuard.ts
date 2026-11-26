/**
 * Build guard for utility-process entries (files main starts with
 * `utilityProcess.fork`, such as `out/main/gitRunner.js`).
 *
 * A utility process is not Electron main: `electron`'s main-process modules
 * are not there, and the main logger and app store would open a second
 * electron-log transport and a second settings file. So the static import
 * closure of such an entry, shared chunks included, must not contain
 * `electron`, `electron-log`, `src/main/utils/logger` or
 * `src/main/utils/store`. It must not re-enter the main entry chunk either
 * (that would evaluate the whole main process inside the child), and it must
 * not use dynamic `import()` (main-process code uses static imports only).
 *
 * `findUtilityEntryViolations` is pure so it can be tested without a build;
 * `utilityEntryGraphGuard` applies it to the emitted bundle in
 * `electron.vite.config.ts`.
 */

/** The parts of a Rollup output chunk the guard reads. */
export interface GraphChunk {
  type: 'chunk';
  fileName: string;
  name: string;
  isEntry: boolean;
  /** File names of statically imported chunks, and external module ids. */
  imports: string[];
  dynamicImports: string[];
  moduleIds?: string[];
  modules?: Record<string, unknown>;
  code?: string;
}

export interface GraphAsset {
  type: 'asset';
  fileName: string;
}

export type GraphBundle = Record<string, GraphChunk | GraphAsset>;

export interface UtilityEntryViolation {
  entry: string;
  chunk: string;
  reason: string;
}

interface ForbiddenModule {
  label: string;
  /** Matched against bundled module ids, with `/` separators. */
  module: RegExp;
  /** Matched against external import ids. */
  external?: RegExp;
}

export const FORBIDDEN_IN_UTILITY_ENTRIES: readonly ForbiddenModule[] = [
  { label: 'electron', module: /\/node_modules\/electron\//, external: /^electron(\/|$)/ },
  { label: 'electron-log', module: /\/node_modules\/electron-log\//, external: /^electron-log(\/|$)/ },
  { label: 'src/main/utils/logger', module: /\/src\/main\/utils\/logger\.[cm]?[jt]s$/ },
  { label: 'src/main/utils/store', module: /\/src\/main\/utils\/store\.[cm]?[jt]s$/ },
];

const REQUIRE_ELECTRON = /\brequire\s*\(\s*["']electron["']\s*\)/;

function moduleIdsOf(chunk: GraphChunk): string[] {
  return chunk.moduleIds ?? Object.keys(chunk.modules ?? {});
}

export function findUtilityEntryViolations(bundle: GraphBundle, entryNames: readonly string[]): UtilityEntryViolation[] {
  const chunks = Object.values(bundle).filter((output): output is GraphChunk => output.type === 'chunk');
  const byFileName = new Map(chunks.map((c) => [c.fileName, c]));
  const violations: UtilityEntryViolation[] = [];

  for (const entryName of entryNames) {
    const entry = chunks.find((c) => c.isEntry && c.name === entryName);
    if (!entry) {
      violations.push({ entry: entryName, chunk: '(none)', reason: `entry chunk "${entryName}" is missing from the bundle` });
      continue;
    }
    const add = (chunk: GraphChunk, reason: string) => violations.push({ entry: entryName, chunk: chunk.fileName, reason });
    const seen = new Set<string>();
    const queue: GraphChunk[] = [entry];
    while (queue.length > 0) {
      const chunk = queue.shift()!;
      if (seen.has(chunk.fileName)) continue;
      seen.add(chunk.fileName);
      if (chunk !== entry && chunk.isEntry) {
        add(chunk, `imports the ${chunk.name} entry chunk`);
        continue;
      }
      if (chunk.dynamicImports.length > 0) add(chunk, `has a dynamic import() of ${chunk.dynamicImports.join(', ')}`);
      for (const id of moduleIdsOf(chunk)) {
        const normalized = id.replace(/\\/g, '/');
        for (const rule of FORBIDDEN_IN_UTILITY_ENTRIES) {
          if (rule.module.test(normalized)) add(chunk, `includes ${rule.label} (${id})`);
        }
      }
      if (chunk.code && REQUIRE_ELECTRON.test(chunk.code)) add(chunk, 'calls require("electron")');
      for (const imported of chunk.imports) {
        const next = byFileName.get(imported);
        if (next) {
          queue.push(next);
          continue;
        }
        for (const rule of FORBIDDEN_IN_UTILITY_ENTRIES) {
          if (rule.external?.test(imported)) add(chunk, `imports ${rule.label} (external "${imported}")`);
        }
      }
    }
  }
  return violations;
}

/** Rollup/Vite plugin: fail the build on any violation for the named entries. */
export function utilityEntryGraphGuard(entryNames: readonly string[]) {
  return {
    name: 'guard-utility-entry-graph',
    generateBundle(this: { error(message: string): never }, _options: unknown, bundle: GraphBundle) {
      const violations = findUtilityEntryViolations(bundle, entryNames);
      if (violations.length > 0) {
        this.error(
          'A utility-process entry reaches modules that only work in Electron main:\n' +
          violations.map((v) => `  ${v.entry}: ${v.chunk} ${v.reason}`).join('\n') + '\n' +
          'Remove the import path from the entry\'s closure (see scripts/utilityEntryGraphGuard.ts).',
        );
      }
      console.log(`[utility-entries] ${entryNames.join(', ')}: import closure clean.`);
    },
  };
}
