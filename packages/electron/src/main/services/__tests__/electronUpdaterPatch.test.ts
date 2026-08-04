// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  filterAtomFeedToAppVersionTags,
  missingReleaseTag,
} from '../electronUpdaterPatch';

// Regression coverage for two alpha-channel update outages, both caused by
// GitHub's releases.atom feed listing bare tags rather than actual Releases:
//
//  - a pushed `extension-sdk-v0.2.0` tag landed at the top of the feed, and
//  - v0.72.0's release build failed after the tag was pushed, so the tag was
//    in the feed with no `latest-mac.yml` behind it.
//
// In both cases electron-updater picked the top entry and 404ed every alpha
// user's update check.

const feed = (...tags: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<feed>
${tags
  .map(
    (tag) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <title>Release ${tag}</title>
    <link rel="alternate" type="text/html" href="https://github.com/nimbalyst/nimbalyst/releases/tag/${tag}"/>
  </entry>`
  )
  .join('\n')}
</feed>`;

describe('filterAtomFeedToAppVersionTags', () => {
  it('drops entries with non-app-version tags and keeps app version entries', () => {
    const filtered = filterAtomFeedToAppVersionTags(
      feed('extension-sdk-v0.2.0', 'v0.60.4')
    );
    expect(filtered).not.toContain('extension-sdk-v0.2.0');
    expect(filtered).toContain('v0.60.4');
  });

  it('drops tags a previous attempt proved have no release assets', () => {
    const filtered = filterAtomFeedToAppVersionTags(
      feed('v0.72.0', 'v0.71.3'),
      new Set(['v0.72.0'])
    );
    expect(filtered).not.toContain('v0.72.0');
    expect(filtered).toContain('v0.71.3');
  });
});

describe('missingReleaseTag', () => {
  it('extracts the tag from a channel-file-not-found error', () => {
    // Verbatim shape of what a v0.72.0 alpha client saw.
    const error = Object.assign(
      new Error(
        'Cannot find latest-mac.yml in the latest release artifacts ' +
          '(https://github.com/nimbalyst/nimbalyst/releases/download/v0.72.0/latest-mac.yml): ' +
          'HttpError: 404 "method: GET url: ..."'
      ),
      { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }
    );
    expect(missingReleaseTag(error)).toBe('v0.72.0');
  });

  it('ignores unrelated failures so they surface instead of silently retrying', () => {
    expect(
      missingReleaseTag(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      )
    ).toBeNull();
    expect(missingReleaseTag(new Error('no code at all'))).toBeNull();
    expect(missingReleaseTag(undefined)).toBeNull();
  });
});
