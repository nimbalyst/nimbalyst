// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { GitStatusService, parseGitRemoteUrl } from '../GitStatusService';

const temporaryRepos: string[] = [];

function createRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), 'nim-github-remote-'));
  temporaryRepos.push(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  return repo;
}

function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args]);
}

afterEach(() => {
  for (const repo of temporaryRepos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
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
    git(repo, 'remote', 'add', 'origin', 'https://github.com/contributor/project.git');
    git(repo, 'remote', 'add', 'upstream', 'https://github.com/maintainer/project.git');
    git(repo, 'remote', 'add', 'review', 'https://github.com/reviewer/project.git');
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(repo, 'config', 'branch.main.remote', 'review');
    git(repo, 'config', 'remote.upstream.gh-resolved', 'base');

    await expect(new GitStatusService().parseGitHubRemote(repo)).resolves.toEqual({
      host: 'github.com',
      remote: 'maintainer/project',
    });
  });

  it('falls back to the current branch tracking remote', async () => {
    const repo = createRepository();
    git(repo, 'remote', 'add', 'origin', 'https://github.com/contributor/project.git');
    git(repo, 'remote', 'add', 'upstream', 'https://github.com/maintainer/project.git');
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/feature');
    git(repo, 'config', 'branch.feature.remote', 'upstream');

    await expect(new GitStatusService().parseGitHubRemote(repo)).resolves.toEqual({
      host: 'github.com',
      remote: 'maintainer/project',
    });
  });

  it('falls back to origin when no preferred remote is configured', async () => {
    const repo = createRepository();
    git(repo, 'remote', 'add', 'origin', 'git@github.com:contributor/project.git');

    await expect(new GitStatusService().parseGitHubRemote(repo)).resolves.toEqual({
      host: 'github.com',
      remote: 'contributor/project',
    });
  });
});
