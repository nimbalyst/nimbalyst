// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { appendAttachmentGitignore, ATTACHMENT_GITIGNORE_ENTRY } from '../attachmentGitignore';
import { createScratchRepo, type ScratchRepo } from '../../testSupport/gitTestSandbox';

const fixtures: string[] = [];
const repos: ScratchRepo[] = [];

async function makeFixture(git = true): Promise<string> {
  if (git) {
    const repo = createScratchRepo();
    repos.push(repo);
    expect(await fs.realpath(path.normalize(repo.git('rev-parse', '--show-toplevel').trim()))).toBe(repo.path);
    return repo.path;
  }
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-gitignore-'));
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const repo of repos.splice(0)) repo.cleanup();
  await Promise.all(fixtures.splice(0).map((fixture) => fs.rm(fixture, { recursive: true, force: true })));
});

describe('attachmentGitignore', () => {
  it('appends once and preserves unrelated lines', async () => {
    const fixture = await makeFixture();
    await fs.writeFile(path.join(fixture, '.gitignore'), 'dist/\n# keep me\n');

    expect((await appendAttachmentGitignore(fixture, true)).appended).toBe(true);
    expect((await appendAttachmentGitignore(fixture, true)).appended).toBe(false);

    const contents = await fs.readFile(path.join(fixture, '.gitignore'), 'utf-8');
    expect(contents).toBe(`dist/\n# keep me\n${ATTACHMENT_GITIGNORE_ENTRY}\n`);
    expect(contents.match(new RegExp(ATTACHMENT_GITIGNORE_ENTRY.replace('/', '\\/'), 'g'))).toHaveLength(1);
  });

  it('does nothing when unchecked', async () => {
    const fixture = await makeFixture();
    expect((await appendAttachmentGitignore(fixture, false)).appended).toBe(false);
    await expect(fs.stat(path.join(fixture, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does nothing outside a git repository', async () => {
    const fixture = await makeFixture(false);
    const result = await appendAttachmentGitignore(fixture, true);
    expect(result).toMatchObject({ appended: false, status: { isGitRepo: false } });
  });
});
