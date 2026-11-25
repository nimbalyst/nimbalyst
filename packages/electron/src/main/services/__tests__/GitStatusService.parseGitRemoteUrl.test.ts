// @vitest-environment node

import { afterEach, describe, it, expect } from 'vitest';
import { GitStatusService, parseGitRemoteUrl } from '../GitStatusService';
import { createScratchRepo, type ScratchRepo } from '../testSupport/gitTestSandbox';

const temporaryRepos: ScratchRepo[] = [];

function createRepository(): ScratchRepo {
  const repo = createScratchRepo();
  temporaryRepos.push(repo);
  return repo;
}

afterEach(() => {
  for (const repo of temporaryRepos.splice(0)) repo.cleanup();
});

describe('parseGitRemoteUrl', () => {
  it('parses SSH shorthand', () => {
    expect(parseGitRemoteUrl('git@github.com:nimbalyst/nimbalyst.git')).toEqual({
      host: 'github.com',
      remote: 'nimbalyst/nimbalyst',
    });
  });

  it('parses SSH shorthand without the .git suffix', () => {
    expect(parseGitRemoteUrl('git@github.com:owner/repo')).toEqual({
      host: 'github.com',
      remote: 'owner/repo',
    });
  });

  it('parses ssh:// URLs', () => {
    expect(parseGitRemoteUrl('ssh://git@github.com/owner/repo.git')).toEqual({
      host: 'github.com',
      remote: 'owner/repo',
    });
  });

  it('parses https URLs with and without .git', () => {
    expect(parseGitRemoteUrl('https://github.com/owner/repo.git')).toEqual({
      host: 'github.com',
      remote: 'owner/repo',
    });
    expect(parseGitRemoteUrl('https://github.com/owner/repo')).toEqual({
      host: 'github.com',
      remote: 'owner/repo',
    });
  });

  it('parses GitHub Enterprise hosts (SSH + HTTPS)', () => {
    expect(parseGitRemoteUrl('git@ghe.example.com:team/app.git')).toEqual({
      host: 'ghe.example.com',
      remote: 'team/app',
    });
    expect(parseGitRemoteUrl('https://ghe.example.com/team/app.git')).toEqual({
      host: 'ghe.example.com',
      remote: 'team/app',
    });
  });

  it('returns null for empty or non-repo URLs', () => {
    expect(parseGitRemoteUrl('')).toBeNull();
    expect(parseGitRemoteUrl('https://github.com/owner')).toBeNull();
  });
});

describe('GitStatusService.parseGitHubRemote', () => {
  it('prefers the remote selected by gh over the tracking remote and origin', async () => {
    const repo = createRepository();
    repo.git('remote', 'add', 'origin', 'https://github.com/contributor/project.git');
    repo.git('remote', 'add', 'upstream', 'https://github.com/maintainer/project.git');
    repo.git('remote', 'add', 'review', 'https://github.com/reviewer/project.git');
    repo.git('symbolic-ref', 'HEAD', 'refs/heads/main');
    repo.git('config', 'branch.main.remote', 'review');
    repo.git('config', 'remote.upstream.gh-resolved', 'base');

    await expect(new GitStatusService().parseGitHubRemote(repo.path)).resolves.toEqual({
      host: 'github.com',
      remote: 'maintainer/project',
    });
  });

  it('falls back to the current branch tracking remote', async () => {
    const repo = createRepository();
    repo.git('remote', 'add', 'origin', 'https://github.com/contributor/project.git');
    repo.git('remote', 'add', 'upstream', 'https://github.com/maintainer/project.git');
    repo.git('symbolic-ref', 'HEAD', 'refs/heads/feature');
    repo.git('config', 'branch.feature.remote', 'upstream');

    await expect(new GitStatusService().parseGitHubRemote(repo.path)).resolves.toEqual({
      host: 'github.com',
      remote: 'maintainer/project',
    });
  });

  it('falls back to origin when no preferred remote is configured', async () => {
    const repo = createRepository();
    repo.git('remote', 'add', 'origin', 'git@github.com:contributor/project.git');

    await expect(new GitStatusService().parseGitHubRemote(repo.path)).resolves.toEqual({
      host: 'github.com',
      remote: 'contributor/project',
    });
  });
});
