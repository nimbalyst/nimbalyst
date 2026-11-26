// @vitest-environment node
/**
 * PM-26: the build fails when a utility-process entry's static import closure
 * reaches `electron`, `electron-log`, `src/main/utils/logger` or
 * `src/main/utils/store`, re-enters the main entry, or uses a dynamic import.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import {
  findUtilityEntryViolations,
  utilityEntryGraphGuard,
  type GraphBundle,
  type GraphChunk,
} from '../../../../scripts/utilityEntryGraphGuard';

function chunk(fileName: string, fields: Partial<GraphChunk> = {}): GraphChunk {
  return {
    type: 'chunk', fileName, name: fileName.replace(/^chunks\//, '').replace(/(-[\w]+)?\.js$/, ''),
    isEntry: false, imports: [], dynamicImports: [], moduleIds: [], code: '', ...fields,
  };
}

function bundleOf(...chunks: GraphChunk[]): GraphBundle {
  return Object.fromEntries(chunks.map((c) => [c.fileName, c]));
}

const repo = '/repo/packages/electron';
const cleanRunner = () => [
  chunk('gitRunner.js', { name: 'gitRunner', isEntry: true, imports: ['chunks/gitRunnerProtocol-a1.js', 'child_process'], moduleIds: [`${repo}/src/main/services/git/gitRunnerEntry.ts`] }),
  chunk('chunks/gitRunnerProtocol-a1.js', { moduleIds: [`${repo}/src/main/services/git/gitRunnerProtocol.ts`] }),
];
const mainEntry = chunk('index.js', {
  name: 'index', isEntry: true, imports: ['chunks/gitRunnerProtocol-a1.js', 'electron'],
  moduleIds: [`${repo}/src/main/index.ts`, `${repo}/src/main/utils/logger.ts`, `${repo}/node_modules/electron-log/src/main.js`],
  code: 'const electron = require("electron");',
});

describe('PM-26: utility entry graph guard', () => {
  it('passes a closure of plain modules, whatever the main entry imports', () => {
    expect(findUtilityEntryViolations(bundleOf(mainEntry, ...cleanRunner()), ['gitRunner'])).toEqual([]);
  });

  it.each([
    ['src/main/utils/logger', `${repo}/src/main/utils/logger.ts`],
    ['src/main/utils/store', `${repo}/src/main/utils/store.ts`],
    ['electron-log', `${repo}/node_modules/.pnpm/electron-log@5.4.3/node_modules/electron-log/src/main/index.js`],
    ['electron', `${repo}/node_modules/electron/index.js`],
    ['src/main/utils/logger', 'C:\\repo\\packages\\electron\\src\\main\\utils\\logger.ts'],
  ])('fails when a shared chunk in the closure contains %s', (label, moduleId) => {
    const [entry, shared] = cleanRunner();
    shared.imports = ['chunks/helper-b2.js'];
    const helper = chunk('chunks/helper-b2.js', { moduleIds: [`${repo}/src/main/services/helper.ts`, moduleId] });
    const violations = findUtilityEntryViolations(bundleOf(mainEntry, entry, shared, helper), ['gitRunner']);
    expect(violations).toEqual([expect.objectContaining({ entry: 'gitRunner', chunk: 'chunks/helper-b2.js' })]);
    expect(violations[0].reason).toContain(label);
    expect(violations[0].reason).toContain(moduleId);
  });

  it('fails on an external import of electron or electron-log anywhere in the closure', () => {
    const [entry, shared] = cleanRunner();
    shared.imports = ['electron', 'electron-log/main'];
    const reasons = findUtilityEntryViolations(bundleOf(entry, shared), ['gitRunner']).map((v) => v.reason);
    expect(reasons).toEqual([expect.stringContaining('electron'), expect.stringContaining('electron-log')]);
  });

  it('fails on require("electron") left in emitted code', () => {
    const [entry, shared] = cleanRunner();
    shared.code = 'try { module.exports = require( "electron" ); } catch {}';
    expect(findUtilityEntryViolations(bundleOf(entry, shared), ['gitRunner'])).toEqual([
      expect.objectContaining({ chunk: 'chunks/gitRunnerProtocol-a1.js', reason: expect.stringContaining('require("electron")') }),
    ]);
  });

  it('fails when the closure re-enters the main entry chunk', () => {
    const [entry, shared] = cleanRunner();
    shared.imports = ['index.js'];
    expect(findUtilityEntryViolations(bundleOf(mainEntry, entry, shared), ['gitRunner']).map((v) => v.reason))
      .toContain('imports the index entry chunk');
  });

  it('fails on a dynamic import in the closure', () => {
    const [entry, shared] = cleanRunner();
    shared.dynamicImports = ['chunks/lazy-c3.js'];
    expect(findUtilityEntryViolations(bundleOf(entry, shared, chunk('chunks/lazy-c3.js')), ['gitRunner']))
      .toEqual([expect.objectContaining({ reason: expect.stringContaining('dynamic import') })]);
  });

  it('fails when the named entry is missing from the bundle', () => {
    expect(findUtilityEntryViolations(bundleOf(mainEntry), ['gitRunner']))
      .toEqual([expect.objectContaining({ entry: 'gitRunner', reason: expect.stringContaining('missing') })]);
  });

  describe('fixture build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-utility-guard-'));
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    function write(relative: string, content: string): string {
      const file = path.join(dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    }

    async function buildFixture(helperSource: string): Promise<unknown> {
      write('src/main/utils/logger.ts', 'import { app } from "electron";\nexport const logger = { info: (m: string) => console.log(app.name, m) };\n');
      write('src/main/helper.ts', helperSource);
      write('src/main/protocol.ts', 'export const VERSION = 1;\n');
      const index = write('src/main/index.ts', 'import { logger } from "./utils/logger";\nimport { VERSION } from "./protocol";\nlogger.info(String(VERSION));\n');
      const runner = write('src/main/gitRunnerEntry.ts', 'import { VERSION } from "./protocol";\nimport { work } from "./helper";\nwork(VERSION);\n');
      return build({
        configFile: false,
        root: dir,
        logLevel: 'silent',
        plugins: [utilityEntryGraphGuard(['gitRunner'])],
        build: {
          write: false,
          minify: false,
          copyPublicDir: false,
          modulePreload: false,
          rollupOptions: {
            input: { index, gitRunner: runner },
            external: ['electron'],
            preserveEntrySignatures: 'strict',
            output: { format: 'cjs', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
          },
        },
      });
    }

    it('builds when the runner closure stays clean', async () => {
      await expect(buildFixture('export function work(v: number) { return v + 1; }\n')).resolves.toBeDefined();
    });

    it('fails the build and names the module when the runner transitively imports the logger', async () => {
      await expect(buildFixture('import { logger } from "./utils/logger";\nexport function work(v: number) { logger.info(String(v)); }\n'))
        .rejects.toThrow(/gitRunner.*src\/main\/utils\/logger/s);
    });
  });
});
