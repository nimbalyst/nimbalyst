/**
 * `nim-preview://` custom protocol -- safe workspace HTML preview.
 *
 * The `nim-asset://` scheme only serves images. To preview workspace HTML
 * files (with their CSS/JS/font/image assets) inside the BrowserSessionService's
 * WebContentsView, we need a scheme that can serve any of the typical web MIME
 * types while still being workspace-scoped.
 *
 * URL shape:
 *   `nim-preview://<base64url-workspace-root>@workspace/<relative-path>`
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

import { protocol, net } from 'electron';
import { realpath } from 'fs/promises';
import { resolve, sep, extname, join } from 'path';
import { pathToFileURL } from 'url';

export const NIM_PREVIEW_SCHEME = 'nim-preview';
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
 * Encode an absolute workspace root + relative file path into a preview URL.
 *
 * The workspace root is stored in the URL username so root-relative asset
 * paths preserve it. Example:
 *   base document: `nim-preview://<root>@workspace/site/index.html`
 *   `<script src="/app.js">` resolves to
 *   `nim-preview://<root>@workspace/app.js`
 *
 * Relative paths continue to work normally because the relative path is
 * appended raw (after URL-encoding each segment).
 */
export function encodeNimPreviewUrl(workspaceRoot: string, relativePath: string): string {
  const encodedRoot = Buffer.from(resolve(workspaceRoot), 'utf8').toString('base64url');
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = cleaned.split('/').map((s) => encodeURIComponent(s));
  return `${NIM_PREVIEW_SCHEME}://${encodedRoot}@${NIM_PREVIEW_HOST}/${segments.join('/')}`;
}

function decodePreviewRequest(url: URL): { encodedRoot: string; relativePath: string } | null {
  if (url.host !== NIM_PREVIEW_HOST) {
    return null;
  }

  // New format: nim-preview://<encoded-root>@workspace/<rel-path>
  if (url.username) {
    const relativePath = url.pathname
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
      .map((s) => decodeURIComponent(s))
      .join('/');
    if (!relativePath) return null;
    return {
      encodedRoot: decodeURIComponent(url.username),
      relativePath,
    };
  }

  // Backward compatibility with the original path-prefixed form:
  // nim-preview://workspace/<encoded-root>/<rel-path>
  const trimmed = url.pathname.replace(/^\/+/, '');
  const firstSlash = trimmed.indexOf('/');
  if (firstSlash < 0) {
    return null;
  }
  return {
    encodedRoot: decodeURIComponent(trimmed.substring(0, firstSlash)),
    relativePath: trimmed
      .substring(firstSlash + 1)
      .split('/')
      .filter(Boolean)
      .map((s) => decodeURIComponent(s))
      .join('/'),
  };
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
    if (resolve(root) === rootResolved) {
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
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
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

export function registerNimPreviewProtocolHandler(): void {
  protocol.handle(NIM_PREVIEW_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const parsed = decodePreviewRequest(url);
      if (!parsed) {
        return new Response('Bad request', { status: 400 });
      }
      const { encodedRoot, relativePath } = parsed;

      let workspaceRoot: string;
      try {
        workspaceRoot = Buffer.from(encodedRoot, 'base64url').toString('utf8');
      } catch {
        return new Response('Bad request', { status: 400 });
      }

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
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        return new Response('Forbidden', { status: 403 });
      }

      return net.fetch(pathToFileURL(real).toString());
    } catch (err) {
      console.error('[nim-preview] handler error:', err);
      return new Response('Internal error', { status: 500 });
    }
  });
}
