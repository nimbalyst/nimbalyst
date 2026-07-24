import { describe, expect, it } from 'vitest';
import { selectReleaseAsset, type GitHubReleaseAsset } from '../extensionReleaseAsset';

function asset(name: string): GitHubReleaseAsset {
  return { name, browser_download_url: `https://example.test/${name}` };
}

describe('selectReleaseAsset', () => {
  describe('without a subdir', () => {
    it('returns null when there are no assets', () => {
      expect(selectReleaseAsset([], { repoName: 'rose-pine-nimbalyst' })).toBeNull();
    });

    it('returns null when no asset is a .nimext or .zip', () => {
      const got = selectReleaseAsset(
        [asset('source.tar.gz'), asset('README.md')],
        { repoName: 'rose-pine-nimbalyst' },
      );
      expect(got).toBeNull();
    });

    it('picks the single .nimext asset when one is present', () => {
      const target = asset('rose-pine-0.2.0.nimext');
      const got = selectReleaseAsset([target, asset('README.md')], { repoName: 'rose-pine-nimbalyst' });
      expect(got).toBe(target);
    });

    it('prefers the .nimext that contains the repo name when multiple exist', () => {
      const a = asset('something-else-0.1.0.nimext');
      const target = asset('rose-pine-nimbalyst-0.2.0.nimext');
      const got = selectReleaseAsset([a, target], { repoName: 'rose-pine-nimbalyst' });
      expect(got).toBe(target);
    });

    it('falls back to the first .nimext when none match the repo name', () => {
      const target = asset('foo-0.1.0.nimext');
      const other = asset('bar-0.2.0.nimext');
      const got = selectReleaseAsset([target, other], { repoName: 'rose-pine-nimbalyst' });
      expect(got).toBe(target);
    });

    it('falls back to a .zip when no .nimext is present', () => {
      const target = asset('release.zip');
      const got = selectReleaseAsset(
        [asset('source.tar.gz'), target],
        { repoName: 'rose-pine-nimbalyst' },
      );
      expect(got).toBe(target);
    });

    it('prefers the .zip that contains the repo name when multiple exist', () => {
      const a = asset('source.zip');
      const target = asset('rose-pine-nimbalyst.zip');
      const got = selectReleaseAsset([a, target], { repoName: 'rose-pine-nimbalyst' });
      expect(got).toBe(target);
    });

    it('prefers .nimext over .zip even when the zip would name-match', () => {
      const zipMatch = asset('rose-pine-nimbalyst.zip');
      const nimextNoMatch = asset('build.nimext');
      const got = selectReleaseAsset([zipMatch, nimextNoMatch], { repoName: 'rose-pine-nimbalyst' });
      expect(got).toBe(nimextNoMatch);
    });

    it('is case-insensitive on the file extension', () => {
      const target = asset('Bundle.NIMEXT');
      const got = selectReleaseAsset([target], { repoName: 'whatever' });
      expect(got).toBe(target);
    });
  });

  describe('with a subdir (monorepo URL)', () => {
    it('returns null when no asset name starts with the subdir', () => {
      const got = selectReleaseAsset(
        [asset('rose-pine-0.1.0.nimext'), asset('other-pkg.zip')],
        { repoName: 'monorepo', subdir: 'crystal-dark' },
      );
      expect(got).toBeNull();
    });

    it('picks a .nimext whose name starts with the subdir', () => {
      const target = asset('crystal-dark-0.3.0.nimext');
      const got = selectReleaseAsset(
        [asset('rose-pine-0.1.0.nimext'), target],
        { repoName: 'monorepo', subdir: 'crystal-dark' },
      );
      expect(got).toBe(target);
    });

    it('falls back to a .zip whose name starts with the subdir when no nimext matches', () => {
      const target = asset('crystal-dark.zip');
      const got = selectReleaseAsset(
        [asset('rose-pine.nimext'), target],
        { repoName: 'monorepo', subdir: 'crystal-dark' },
      );
      expect(got).toBe(target);
    });

    it('is case-insensitive on the subdir match', () => {
      const target = asset('Crystal-Dark-0.1.0.nimext');
      const got = selectReleaseAsset([target], { repoName: 'monorepo', subdir: 'crystal-dark' });
      expect(got).toBe(target);
    });

    it('matches against the last path segment for nested subdirs', () => {
      // GitHub release asset names are flat (no slashes), so for a URL like
      // .../tree/main/packages/extensions/mockuplm we must match against
      // "mockuplm", not the full "packages/extensions/mockuplm".
      const target = asset('mockuplm-0.4.0.nimext');
      const got = selectReleaseAsset(
        [asset('rose-pine-0.1.0.nimext'), target],
        { repoName: 'monorepo', subdir: 'packages/extensions/mockuplm' },
      );
      expect(got).toBe(target);
    });

    it('handles a trailing slash on the subdir', () => {
      const target = asset('mockuplm-0.4.0.nimext');
      const got = selectReleaseAsset(
        [target],
        { repoName: 'monorepo', subdir: 'packages/extensions/mockuplm/' },
      );
      expect(got).toBe(target);
    });

    it('returns null when no asset starts with the last segment of a nested subdir', () => {
      const got = selectReleaseAsset(
        [asset('rose-pine-0.1.0.nimext'), asset('crystal-dark.zip')],
        { repoName: 'monorepo', subdir: 'packages/extensions/mockuplm' },
      );
      expect(got).toBeNull();
    });
  });
});
