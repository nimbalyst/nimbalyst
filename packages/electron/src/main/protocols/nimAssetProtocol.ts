/**
 * `nim-asset://` custom protocol — local-image bridge for the renderer.
 *
 * Issue #146: the main BrowserWindow currently runs with `webSecurity: false`
 * because four components render local images via `<img src="file://...">`,
 * and `file://` is cross-origin to the renderer's `http://localhost:5273` /
 * `file:///.../index.html` origins. To restore `webSecurity: true`, we serve
 * those images through a registered custom scheme that the renderer can load
 * same-origin.
 *
 * URL shape:
 *   `nim-asset://local/<base64url-encoded-absolute-path>`
 *
 * The handler decodes the absolute path, resolves it (defending against
 * `..` and symlink escapes), and only serves it if:
 *   1. The resolved path lives under one of the allowlisted root prefixes
 *      (open workspace paths + `<userData>/chat-attachments`).
 *   2. The file extension is in the image allowlist.
 *
 * Both gates are required. The allowlist is populated dynamically as
 * workspaces are registered/unregistered.
 */
import { protocol, app, net } from "electron";
import { realpath } from "fs/promises";
import { resolve, sep, extname } from "path";
import { pathToFileURL } from "url";

export const NIM_ASSET_SCHEME = "nim-asset";
export const NIM_ASSET_HOST = "local";

const IMAGE_EXTENSIONS = new Set<string>([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
]);

const allowedRoots = new Set<string>();

/**
 * Add a root prefix that `nim-asset://` is allowed to serve files from. Idempotent.
 * The path is resolved (but not realpath'd -- realpath happens at request time
 * so newly-created symlinks within the root are still resolved correctly).
 */
export function addNimAssetRoot(rootAbsolutePath: string): void {
  if (!rootAbsolutePath) return;
  allowedRoots.add(resolve(rootAbsolutePath));
}

/**
 * Remove a previously-added root. Idempotent.
 */
export function removeNimAssetRoot(rootAbsolutePath: string): void {
  if (!rootAbsolutePath) return;
  allowedRoots.delete(resolve(rootAbsolutePath));
}

/**
 * For tests.
 */
export function clearNimAssetRoots(): void {
  allowedRoots.clear();
}

/**
 * For tests.
 */
export function getNimAssetRoots(): string[] {
  return [...allowedRoots];
}

/**
 * Encode an absolute path into the `nim-asset://local/<encoded>` URL.
 * Used by the renderer-side helper to build URLs that round-trip cleanly.
 */
export function encodeNimAssetUrl(absolutePath: string): string {
  const encoded = Buffer.from(absolutePath, "utf8").toString("base64url");
  return `${NIM_ASSET_SCHEME}://${NIM_ASSET_HOST}/${encoded}`;
}

/**
 * Pure-function path validator. Exposed for unit tests.
 *
 * Rejects with `null` if:
 *   - `requestedAbsPath` is empty / not absolute / contains null bytes
 *   - resolved path escapes every allowed root
 *   - file extension is not in the image allowlist
 *
 * Returns the resolved (but NOT yet realpath'd) absolute path on success.
 * Realpath checking is async and happens in the request handler.
 */
export function validateNimAssetPath(
  requestedAbsPath: string,
  roots: Iterable<string>,
): string | null {
  if (!requestedAbsPath) return null;
  if (requestedAbsPath.includes("\0")) return null;

  // Reject `..` traversal explicitly. We split on both POSIX and Windows
  // separators because the renderer may emit a mixed-separator path
  // (e.g. on Windows, `C:\Users\me\doc/assets/img.png`) -- a
  // `normalize() === input` check would over-reject those legitimate
  // paths, so we look for `..` segments directly.
  const segments = requestedAbsPath.split(/[/\\]+/);
  if (segments.includes("..")) return null;

  const resolved = resolve(requestedAbsPath);

  const ext = extname(resolved).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;

  let matched = false;
  for (const root of roots) {
    const rootResolved = resolve(root);
    if (resolved === rootResolved || resolved.startsWith(rootResolved + sep)) {
      matched = true;
      break;
    }
  }
  if (!matched) return null;

  return resolved;
}

/**
 * Register the `nim-asset` scheme as standard/secure with Chromium. Must be
 * called BEFORE `app.whenReady` resolves -- per Electron docs, schemes must
 * be registered as privileged before the app is ready.
 */
export function registerNimAssetSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: NIM_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false,
        // Avoid the default same-origin restriction: the scheme is treated
        // as standard/secure, which is enough for `<img src=>` to load it
        // from any origin in the renderer.
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Wire up the actual handler. Call once after `app.whenReady`. Adds the
 * userData/chat-attachments root automatically.
 */
export function registerNimAssetProtocolHandler(): void {
  // Auto-allow chat-attachments (the renderer's AttachmentPreview component
  // points at files under here).
  const userData = app.getPath("userData");
  addNimAssetRoot(`${userData}${sep}chat-attachments`);

  protocol.handle(NIM_ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);

      if (url.host !== NIM_ASSET_HOST) {
        return new Response("Not found", { status: 404 });
      }

      // url.pathname starts with "/<encoded>"; trim the leading slash.
      const encoded = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (!encoded) {
        return new Response("Bad request", { status: 400 });
      }

      let decoded: string;
      try {
        decoded = Buffer.from(encoded, "base64url").toString("utf8");
      } catch {
        return new Response("Bad request", { status: 400 });
      }

      const resolved = validateNimAssetPath(decoded, allowedRoots);
      if (!resolved) {
        return new Response("Forbidden", { status: 403 });
      }

      // Defend against symlinks pointing outside the root by realpath'ing
      // and re-checking. realpath throws if the file does not exist.
      let real: string;
      try {
        real = await realpath(resolved);
      } catch {
        return new Response("Not found", { status: 404 });
      }

      let realInsideRoot = false;
      for (const root of allowedRoots) {
        const rootResolved = await realpath(root).catch(() => resolve(root));
        if (real === rootResolved || real.startsWith(rootResolved + sep)) {
          realInsideRoot = true;
          break;
        }
      }
      if (!realInsideRoot) {
        return new Response("Forbidden", { status: 403 });
      }

      // Hand the read off to net.fetch on the file:// URL. This streams the
      // file with the right content-type and avoids reading into a Buffer.
      return net.fetch(pathToFileURL(real).toString());
    } catch (err) {
      console.error("[nim-asset] handler error:", err);
      return new Response("Internal error", { status: 500 });
    }
  });
}
