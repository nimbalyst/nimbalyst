import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js';
import log from 'electron-log/main';

const PATCH_FLAG = Symbol.for('@nimbalyst/electron-updater-atom-filter');
const EXCLUDED_TAGS = Symbol.for('@nimbalyst/electron-updater-excluded-tags');

type HttpRequestFn = (
  url: URL,
  headers: Record<string, string> | null,
  cancellationToken: unknown
) => Promise<unknown>;

type GetLatestVersionFn = () => Promise<unknown>;

interface GitHubProviderProto {
  httpRequest?: HttpRequestFn;
  getLatestVersion?: GetLatestVersionFn;
  [PATCH_FLAG]?: boolean;
}

interface GitHubProviderInstance {
  [EXCLUDED_TAGS]?: Set<string>;
}

// Tags that look like app releases: `v0.60.1`, `v1.0.0-alpha.1`, etc.
// Anything else (e.g. `extension-sdk-v0.2.0`) is treated as feed noise
// and dropped before electron-updater parses it.
const APP_RELEASE_TAG_PATTERN = /^v\d/;

// How many feed entries we're willing to skip before giving up. A handful of
// consecutive tags without releases means something is broken enough that the
// user should see the error rather than have us walk back through history.
const MAX_TAG_FALLBACKS = 3;

/**
 * Harden electron-updater's GitHub provider against release-feed entries that
 * cannot actually be updated to.
 *
 * Two failure modes, both fatal to every update check until someone fixes the
 * repo by hand:
 *
 * 1. Non-app tags. GitHub's `releases.atom` includes every pushed tag, not
 *    just actual GitHub Releases, and `GitHubProvider` picks the topmost
 *    `<entry>`. An `extension-sdk-v*` tag at the top 404s the whole check.
 *    Handled by filtering the feed (see `filterAtomFeedToAppVersionTags`).
 *
 * 2. App tags with no published release. If a release build fails after the
 *    tag is pushed, the tag is in the feed but `latest-mac.yml` was never
 *    uploaded. Every client on the channel 404s until the tag is deleted.
 *    This is what broke v0.72.0. Handled by retrying the lookup with that
 *    tag excluded from the feed, so clients fall back to the last release
 *    that actually shipped assets.
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
    const excluded = (this as GitHubProviderInstance)[EXCLUDED_TAGS];
    return filterAtomFeedToAppVersionTags(result, excluded);
  };

  const originalGetLatestVersion = proto.getLatestVersion;
  if (typeof originalGetLatestVersion === 'function') {
    proto.getLatestVersion = async function patchedGetLatestVersion() {
      const self = this as GitHubProviderInstance;
      const excluded = new Set<string>();
      try {
        for (let attempt = 0; ; attempt++) {
          self[EXCLUDED_TAGS] = excluded;
          try {
            return await originalGetLatestVersion.call(this);
          } catch (error) {
            const tag =
              attempt < MAX_TAG_FALLBACKS ? missingReleaseTag(error) : null;
            if (tag === null || excluded.has(tag)) {
              throw error;
            }
            excluded.add(tag);
            log.warn(
              `[autoUpdater] ${tag} is in the release feed but has no published update metadata; ` +
                'skipping it and retrying with the next entry'
            );
          }
        }
      } finally {
        delete self[EXCLUDED_TAGS];
      }
    };
  } else {
    log.warn(
      '[autoUpdater] Could not install missing-release fallback: GitHubProvider has no getLatestVersion'
    );
  }

  proto[PATCH_FLAG] = true;
}

/**
 * Pull the release tag out of electron-updater's "channel file not found"
 * error, or return null for any other failure.
 *
 * The message embeds the full asset URL, whose shape
 * (`/releases/download/<tag>/<file>`) is fixed by GitHub, not by
 * electron-updater's formatting.
 *
 * Exported for unit tests.
 */
export function missingReleaseTag(error: unknown): string | null {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code !== 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
    return null;
  }
  if (typeof message !== 'string') {
    return null;
  }
  const match = message.match(/\/releases\/download\/([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Strip atom-feed `<entry>` blocks whose `<link href=".../tag/{tag}">`
 * tag does not match the app's `v<number>...` scheme, plus any tag in
 * `excludedTags` (tags a previous attempt proved have no release assets).
 *
 * Exported for unit tests.
 */
export function filterAtomFeedToAppVersionTags(
  xml: string,
  excludedTags?: Set<string>
): string {
  let dropped = 0;
  let excluded = 0;
  const filtered = xml.replace(/<entry>[\s\S]*?<\/entry>/g, (entry) => {
    const hrefMatch = entry.match(/<link[^>]*href="[^"]*\/tag\/([^"]+)"/);
    if (!hrefMatch) {
      return entry;
    }
    const tag = hrefMatch[1];
    if (excludedTags?.has(tag)) {
      excluded += 1;
      return '';
    }
    if (APP_RELEASE_TAG_PATTERN.test(tag)) {
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
  if (excluded > 0) {
    log.info(
      `[autoUpdater] Filtered ${excluded} atom feed entries with no published release`
    );
  }
  return filtered;
}
