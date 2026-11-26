// @vitest-environment node
/**
 * PM-27: the packaged-app check fails the build when a utility-process entry
 * (or a chunk it requires) is missing from app.asar. The listing comes from
 * `@electron/asar`, as in afterPack, because `fs.existsSync` cannot see
 * inside the archive.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import asar from '@electron/asar';

const require_ = createRequire(import.meta.url);
const { UTILITY_PROCESS_ENTRIES, findMissingUtilityEntries } = require_('../packaged-utility-entries.js') as {
  UTILITY_PROCESS_ENTRIES: string[];
  findMissingUtilityEntries(files: string[], readFile: (file: string) => string): string[];
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-packaged-entries-'));
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

async function packagedTree(name: string, files: Record<string, string>): Promise<{ list: string[]; read: (file: string) => string }> {
  const source = path.join(scratch, name);
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    fs.writeFileSync(path.join(source, relative), content);
  }
  const archive = path.join(scratch, `${name}.asar`);
  await asar.createPackage(source, archive);
  return {
    list: asar.listPackage(archive, { isPack: false }),
    read: (file) => asar.extractFile(archive, file.replace(/^[\\/]/, '')).toString('utf8'),
  };
}

describe('PM-27: packaged utility-process entries', () => {
  it('lists the git runner bundle', () => {
    expect(UTILITY_PROCESS_ENTRIES).toContain('out/main/gitRunner.js');
  });

  it('passes when the runner and the chunks it requires are in app.asar', async () => {
    const tree = await packagedTree('complete', {
      'out/main/index.js': 'require("./chunks/gitRunnerProtocol-Ab12.js");',
      'out/main/gitRunner.js': '"use strict";\nconst protocol = require("./chunks/gitRunnerProtocol-Ab12.js");\nconst child_process = require("child_process");\n',
      'out/main/chunks/gitRunnerProtocol-Ab12.js': 'exports.v = 1;',
    });
    expect(findMissingUtilityEntries(tree.list, tree.read)).toEqual([]);
  });

  it('fails when the runner file is missing', async () => {
    const tree = await packagedTree('no-runner', { 'out/main/index.js': '' });
    expect(findMissingUtilityEntries(tree.list, tree.read)).toEqual(['out/main/gitRunner.js']);
  });

  it('fails when a chunk the runner requires is missing', async () => {
    const tree = await packagedTree('no-chunk', {
      'out/main/index.js': '',
      'out/main/gitRunner.js': 'const p = require("./chunks/gitRunnerProtocol-Ab12.js");',
    });
    expect(findMissingUtilityEntries(tree.list, tree.read)).toEqual(['out/main/chunks/gitRunnerProtocol-Ab12.js (required by out/main/gitRunner.js)']);
  });
});
