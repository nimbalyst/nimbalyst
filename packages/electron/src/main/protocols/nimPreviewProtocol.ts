/**
 * `nim-preview://` custom protocol -- safe workspace HTML preview.
 *
 * The `nim-asset://` scheme only serves images. To preview workspace HTML
 * files (with their CSS/JS/font/image assets) inside the BrowserSessionService's
 * WebContentsView, we need a scheme that can serve any of the typical web MIME
 * types while still being workspace-scoped.
 *
 * URL shape:
 *   `nim-preview://<hex-workspace-root>/<relative-path>`
 * (see `encodeNimPreviewUrl` for why the root lives in the host, and the
 * decoder for the two legacy `workspace`-host forms still accepted)
 *
 * The handler decodes the workspace root, resolves the path within it, and
 * only serves the file if:
 *   1. The resolved (and realpath'd) absolute path lives strictly under the
 *      decoded workspace root.
 *   2. The workspace root is on the active allowlist (populated as workspaces
 *      open/close, same lifecycle as `nim-asset://`).
 *   3. The file extension is in the preview-content allowlist.
 *
 * This is *not* a general-purpose HTTP server: it does not accept POSTs, does
 * not run any code, and refuses requests that escape the workspace via
 * symlink. It only exists to give chromium a same-origin URL it can navigate
 * to for in-app HTML preview.
 */

import { protocol, net, type Session } from 'electron';
import { realpath } from 'fs/promises';
import { resolve, sep, extname, join } from 'path';
import { pathToFileURL } from 'url';

export const NIM_PREVIEW_SCHEME = 'nim-preview';
/** Host of the two legacy URL forms; current URLs carry the hex root as host. */
export const NIM_PREVIEW_HOST = 'workspace';

/**
 * Allowed file extensions. These are the things a static-site preview
 * realistically needs. Notable exclusions:
 *   - `.mjs` / `.cjs` are deliberately allowed alongside `.js` so modern
 *     bundler output (ES modules) loads.
 *   - source maps are excluded -- they leak filesystem layout and the
 *     preview surface doesn't need them.
 *   - `.json`, `.txt` are excluded; if a page tries to fetch one we'd rather
 *     fail closed than expose project metadata via the same-origin surface.
 */
const PREVIEW_EXTENSIONS = new Set<string>([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.bmp',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp4',
  '.webm',
  '.ogg',
  '.mp3',
  '.wav',
]);

const allowedWorkspaceRoots = new Set<string>();

export function addNimPreviewWorkspaceRoot(rootAbsolutePath: string): void {
  if (!rootAbsolutePath) return;
  allowedWorkspaceRoots.add(resolve(rootAbsolutePath));
}

export function removeNimPreviewWorkspaceRoot(rootAbsolutePath: string): void {
  if (!rootAbsolutePath) return;
  allowedWorkspaceRoots.delete(resolve(rootAbsolutePath));
}

export function clearNimPreviewWorkspaceRoots(): void {
  allowedWorkspaceRoots.clear();
}

export function getNimPreviewWorkspaceRoots(): string[] {
  return [...allowedWorkspaceRoots];
}

/**
 * Encode an absolute workspace root + relative file path into a preview URL:
 *   `nim-preview://<hex-workspace-root>/<relative-path>`
 *
 * The workspace root is the URL *host*, so the page's origin itself carries
 * it and every asset reference style resolves correctly: page-relative
 * (`./app.js`) keeps the path, root-relative (`/app.js`) resolves against
 * the origin -- which is the root.
 *
 * Hex (not base64url) because URL hosts are case-normalized to lowercase by
 * Chromium's canonicalizer; base64url is case-sensitive and would corrupt.
 *
 * The original design carried the root in the URL *username*
 * (`nim-preview://<root>@workspace/<path>`). That format is dead on
 * Electron 41 (issue #612): `protocol.handle` strips credentials before the
 * handler sees the URL, partitioned sessions refuse to navigate to
 * credentialed URLs at all (ERR_FAILED), and no Referer header is sent on
 * custom-scheme requests that could recover the root. The decoder keeps
 * accepting the old `workspace`-host forms for URLs persisted before the
 * switch.
 */
export function encodeNimPreviewUrl(workspaceRoot: string, relativePath: string): string {
  const encodedRoot = Buffer.from(resolve(workspaceRoot), 'utf8').toString('hex');
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = cleaned.split('/').map((s) => encodeURIComponent(s));
  return `${NIM_PREVIEW_SCHEME}://${encodedRoot}/${segments.join('/')}`;
}

function decodeRelativePath(pathname: string): string {
  return pathname
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s))
    .join('/');
}

function decodePreviewRequest(url: URL): { workspaceRoot: string; relativePath: string } | null {
  // Current format: nim-preview://<hex-root>/<rel-path>
  if (url.host !== NIM_PREVIEW_HOST) {
    if (!/^[0-9a-f]+$/.test(url.host) || url.host.length % 2 !== 0) {
      return null;
    }
    const relativePath = decodeRelativePath(url.pathname);
    if (!relativePath) return null;
    return {
      workspaceRoot: Buffer.from(url.host, 'hex').toString('utf8'),
      relativePath,
    };
  }

  // Legacy username form: nim-preview://<base64url-root>@workspace/<rel-path>
  if (url.username) {
    const relativePath = decodeRelativePath(url.pathname);
    if (!relativePath) return null;
    return {
      workspaceRoot: decodeBase64UrlRoot(decodeURIComponent(url.username)),
      relativePath,
    };
  }

  // Legacy path-prefixed form: nim-preview://workspace/<base64url-root>/<rel-path>
  const trimmed = url.pathname.replace(/^\/+/, '');
  const firstSlash = trimmed.indexOf('/');
  if (firstSlash < 0) {
    return null;
  }
  return {
    workspaceRoot: decodeBase64UrlRoot(decodeURIComponent(trimmed.substring(0, firstSlash))),
    relativePath: decodeRelativePath(trimmed.substring(firstSlash + 1)),
  };
}

function decodeBase64UrlRoot(encodedRoot: string): string {
  return Buffer.from(encodedRoot, 'base64url').toString('utf8');
}

/**
 * Windows filesystems are case-insensitive and drive-letter casing varies
 * between path sources (`D:\` from the open-folder dialog vs `d:\` from an
 * AI-agent-typed tool argument), so path comparisons there must ignore case.
 * Issue #612: in-workspace files were rejected over exactly this divergence.
 */
const PATHS_CASE_INSENSITIVE = process.platform === 'win32';

/** Compare two resolved absolute paths for equality. Exposed for unit tests. */
export function previewPathsEqual(
  a: string,
  b: string,
  caseInsensitive: boolean = PATHS_CASE_INSENSITIVE,
): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * True when resolved absolute `candidate` is `root` itself or strictly under
 * it (directory-boundary match, never substring). Exposed for unit tests.
 */
export function previewPathInsideRoot(
  root: string,
  candidate: string,
  caseInsensitive: boolean = PATHS_CASE_INSENSITIVE,
): boolean {
  if (previewPathsEqual(candidate, root, caseInsensitive)) return true;
  const prefix = root + sep;
  return caseInsensitive
    ? candidate.toLowerCase().startsWith(prefix.toLowerCase())
    : candidate.startsWith(prefix);
}

/**
 * Pure-function path validator. Exposed for unit tests.
 *
 * Returns the resolved absolute path on success (not yet realpath'd), or
 * `null` if any guard fails.
 */
export function validateNimPreviewPath(
  workspaceRoot: string,
  relativePath: string,
  roots: Iterable<string>,
): string | null {
  if (!workspaceRoot || !relativePath) return null;
  if (workspaceRoot.includes('\0') || relativePath.includes('\0')) return null;

  const rootResolved = resolve(workspaceRoot);

  let matched = false;
  for (const root of roots) {
    if (previewPathsEqual(resolve(root), rootResolved)) {
      matched = true;
      break;
    }
  }
  if (!matched) return null;

  // Detect `..` segments before joining; resolve() would happily eat them and
  // produce a path outside the root.
  const segments = relativePath.split(/[/\\]+/).filter(Boolean);
  if (segments.includes('..')) return null;

  const candidate = resolve(join(rootResolved, ...segments));
  if (!previewPathInsideRoot(rootResolved, candidate)) {
    return null;
  }

  const ext = extname(candidate).toLowerCase();
  if (!PREVIEW_EXTENSIONS.has(ext)) return null;

  return candidate;
}

export function registerNimPreviewSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: NIM_PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false,
        corsEnabled: true,
        // Required for ES-module script imports to resolve relative paths.
        codeCache: true,
      },
    },
  ]);
}

async function handleNimPreviewRequest(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parsed = decodePreviewRequest(url);
    if (!parsed) {
      return new Response('Bad request', { status: 400 });
    }
    const { workspaceRoot, relativePath } = parsed;

    const resolvedPath = validateNimPreviewPath(workspaceRoot, relativePath, allowedWorkspaceRoots);
    if (!resolvedPath) {
      return new Response('Forbidden', { status: 403 });
    }

    let real: string;
    try {
      real = await realpath(resolvedPath);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    const realRoot = await realpath(resolve(workspaceRoot)).catch(() => resolve(workspaceRoot));
    if (!previewPathInsideRoot(realRoot, real)) {
      return new Response('Forbidden', { status: 403 });
    }

    return net.fetch(pathToFileURL(real).toString());
  } catch (err) {
    console.error('[nim-preview] handler error:', err);
    return new Response('Internal error', { status: 500 });
  }
}

export function registerNimPreviewProtocolHandler(): void {
  protocol.handle(NIM_PREVIEW_SCHEME, handleNimPreviewRequest);
}

const sessionsWithHandler = new WeakSet<Session>();

/**
 * `protocol.handle` above only covers the default session. WebContentsViews
 * created from a custom partition (BrowserSessionService) get their own
 * session where the scheme would otherwise be unhandled -- blank preview on
 * macOS, and on Windows Chromium hands the unknown scheme to the OS, which
 * shows the "look for an app in the Store" popup (issue #612). Every session
 * that will navigate to nim-preview:// must be registered here.
 */
export function ensureNimPreviewProtocolForSession(ses: Session): void {
  if (sessionsWithHandler.has(ses)) return;
  sessionsWithHandler.add(ses);
  // Guards the default session (registered via registerNimPreviewProtocolHandler):
  // handle() throws on an already-handled scheme.
  if (ses.protocol.isProtocolHandled(NIM_PREVIEW_SCHEME)) return;
  ses.protocol.handle(NIM_PREVIEW_SCHEME, handleNimPreviewRequest);
}
