import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js';
import log from 'electron-log/main';

const PATCH_FLAG = Symbol.for('@nimbalyst/electron-updater-atom-filter');

type HttpRequestFn = (
  url: URL,
  headers: Record<string, string> | null,
  cancellationToken: unknown
) => Promise<unknown>;

interface GitHubProviderProto {
  httpRequest?: HttpRequestFn;
  [PATCH_FLAG]?: boolean;
}

// Tags that look like app releases: `v0.60.1`, `v1.0.0-alpha.1`, etc.
// Anything else (e.g. `extension-sdk-v0.2.0`) is treated as feed noise
// and dropped before electron-updater parses it.
const APP_RELEASE_TAG_PATTERN = /^v\d/;

/**
 * Drop atom-feed entries whose tag doesn't look like an app release.
 *
 * Why: GitHub's `releases.atom` includes every pushed tag, not just
 * actual GitHub Releases. electron-updater's `GitHubProvider` picks
 * the topmost `<entry>` from that feed, so a stray non-app tag at
 * the top 404s the entire update check (it asks for `latest-mac.yml`
 * under a tag that has no release assets). We saw this when an
 * `extension-sdk-v*` tag landed at the top of the feed.
 *
 * Applies to GitHubProvider only; other electron-updater providers
 * are untouched.
 */
export function installAtomFeedFilter(): void {
  const proto = GitHubProvider.prototype as unknown as GitHubProviderProto;
  if (proto[PATCH_FLAG]) {
    return;
  }

  const parentProto = Object.getPrototypeOf(GitHubProvider.prototype) as {
    httpRequest: HttpRequestFn;
  };
  const parentHttpRequest = parentProto.httpRequest;
  if (typeof parentHttpRequest !== 'function') {
    log.warn(
      '[autoUpdater] Could not install atom-feed filter: GitHubProvider has no inherited httpRequest'
    );
    return;
  }

  proto.httpRequest = async function patchedHttpRequest(url, headers, ct) {
    const result = await parentHttpRequest.call(this, url, headers, ct);
    if (typeof result !== 'string') {
      return result;
    }
    const pathname = (url as URL)?.pathname;
    if (typeof pathname !== 'string' || !pathname.endsWith('.atom')) {
      return result;
    }
    return filterAtomFeedToAppVersionTags(result);
  };

  proto[PATCH_FLAG] = true;
}

/**
 * Strip atom-feed `<entry>` blocks whose `<link href=".../tag/{tag}">`
 * tag does not match the app's `v<number>...` scheme.
 *
 * Exported for unit tests.
 */
export function filterAtomFeedToAppVersionTags(xml: string): string {
  let dropped = 0;
  const filtered = xml.replace(/<entry>[\s\S]*?<\/entry>/g, (entry) => {
    const hrefMatch = entry.match(/<link[^>]*href="[^"]*\/tag\/([^"]+)"/);
    if (!hrefMatch) {
      return entry;
    }
    if (APP_RELEASE_TAG_PATTERN.test(hrefMatch[1])) {
      return entry;
    }
    dropped += 1;
    return '';
  });
  if (dropped > 0) {
    log.info(
      `[autoUpdater] Filtered ${dropped} non-app-version atom feed entries`
    );
  }
  return filtered;
}
