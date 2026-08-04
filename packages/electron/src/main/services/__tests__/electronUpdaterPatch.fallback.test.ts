// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Drives electron-updater's real GitHubProvider.getLatestVersion() with the
// HTTP layer stubbed, reproducing the v0.72.0 outage: the tag was pushed, the
// release build failed, so releases.atom advertised v0.72.0 while
// latest-mac.yml only ever existed under v0.71.3. Without the patch this
// throws ERR_UPDATER_CHANNEL_FILE_NOT_FOUND, which is exactly what alpha
// users saw on every update check.

const RELEASED_TAG = 'v0.71.3';
const TAGGED_BUT_UNRELEASED = 'v0.72.0';

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <entry>
    <id>tag:github.com,2008:Repository/1/${TAGGED_BUT_UNRELEASED}</id>
    <title>Release ${TAGGED_BUT_UNRELEASED}</title>
    <link rel="alternate" type="text/html" href="https://github.com/nimbalyst/nimbalyst/releases/tag/${TAGGED_BUT_UNRELEASED}"/>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1/${RELEASED_TAG}</id>
    <title>Release ${RELEASED_TAG}</title>
    <link rel="alternate" type="text/html" href="https://github.com/nimbalyst/nimbalyst/releases/tag/${RELEASED_TAG}"/>
  </entry>
</feed>`;

const CHANNEL_YML = `version: 0.71.3
files:
  - url: Nimbalyst-macOS-arm64.zip
    sha512: abc
    size: 1
path: Nimbalyst-macOS-arm64.zip
sha512: abc
releaseDate: '2026-07-28T14:38:44.000Z'
`;

let GitHubProvider: any;
let HttpError: any;
let requestedPaths: string[];

function makeProvider() {
  const provider = Object.create(GitHubProvider.prototype);
  provider.options = { provider: 'github', owner: 'nimbalyst', repo: 'nimbalyst' };
  provider.baseUrl = new URL('https://github.com/');
  provider.baseApiUrl = new URL('https://api.github.com/');
  provider.updater = {
    allowPrerelease: true,
    channel: 'alpha',
    currentVersion: '0.71.2',
    fullChangelog: false,
  };
  provider.runtimeOptions = { isUseMultipleRangeRequest: false, platform: 'darwin' };
  provider.executor = {
    request: async (options: { path: string }) => {
      requestedPaths.push(options.path);
      if (options.path.endsWith('.atom')) {
        return ATOM_FEED;
      }
      if (options.path.includes(`/download/${RELEASED_TAG}/`)) {
        return CHANNEL_YML;
      }
      // Any asset under a tag whose release was never published.
      throw new HttpError(404, 'Not Found');
    },
  };
  return provider;
}

beforeAll(async () => {
  GitHubProvider = (
    await import('electron-updater/out/providers/GitHubProvider.js')
  ).GitHubProvider;
  HttpError = (await import('builder-util-runtime')).HttpError;
});

describe('GitHubProvider missing-release fallback', () => {
  it('404s on the unreleased tag before the patch is installed', async () => {
    requestedPaths = [];
    await expect(makeProvider().getLatestVersion()).rejects.toMatchObject({
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    });
    expect(requestedPaths.some((p) => p.includes(TAGGED_BUT_UNRELEASED))).toBe(true);
  });

  it('falls back to the last tag that actually published assets', async () => {
    const { installAtomFeedFilter } = await import('../electronUpdaterPatch');
    installAtomFeedFilter();

    requestedPaths = [];
    const result = await makeProvider().getLatestVersion();

    expect(result.tag).toBe(RELEASED_TAG);
    expect(result.version).toBe('0.71.3');
    // The unreleased tag is tried once, then dropped from the feed on retry.
    expect(
      requestedPaths.filter((p) => p.includes(`/download/${TAGGED_BUT_UNRELEASED}/`))
    ).not.toHaveLength(0);
  });
});
