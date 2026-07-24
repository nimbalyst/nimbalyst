import { describe, it, expect } from 'vitest';
import { filterAtomFeedToAppVersionTags } from '../electronUpdaterPatch';

// Regression coverage for the alpha-channel update outage where a pushed
// `extension-sdk-v0.2.0` git tag landed at the top of nimbalyst/nimbalyst's
// releases.atom feed. electron-updater's GitHubProvider picked that entry
// as the latest release and asked for `latest-mac.yml` at a tag with no
// release assets, 404ing every alpha user's update check.

describe('filterAtomFeedToAppVersionTags', () => {
  it('drops entries with non-app-version tags and keeps app version entries', () => {
    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <entry>
    <id>tag:github.com,2008:Repository/1/extension-sdk-v0.2.0</id>
    <title>extension-sdk-v0.2.0</title>
    <link rel="alternate" type="text/html" href="https://github.com/nimbalyst/nimbalyst/releases/tag/extension-sdk-v0.2.0"/>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1/v0.60.4</id>
    <title>Release v0.60.4</title>
    <link rel="alternate" type="text/html" href="https://github.com/nimbalyst/nimbalyst/releases/tag/v0.60.4"/>
  </entry>
</feed>`;
    const filtered = filterAtomFeedToAppVersionTags(feed);
    expect(filtered).not.toContain('extension-sdk-v0.2.0');
    expect(filtered).toContain('v0.60.4');
  });
});
