/**
 * Renderer-side helpers for building `nim-asset://` URLs.
 *
 * Issue #146: replaces `<img src="file://${path}">` so the main BrowserWindow
 * can run with `webSecurity: true`. The main-process protocol handler
 * (`packages/electron/src/main/protocols/nimAssetProtocol.ts`) decodes the
 * encoded absolute path, validates it against an allowlist of root prefixes,
 * checks the file extension is in the image allowlist, and serves the file.
 *
 * URL shape: `nim-asset://local/<base64url-of-absolute-path>`.
 *
 * Encoding the absolute path with base64url avoids any need to URL-encode
 * slashes / spaces / non-ASCII characters in the path, and the encoded
 * segment is opaque to the URL parser.
 */

const SCHEME = "nim-asset";
const HOST = "local";

function toBase64Url(input: string): string {
  // base64url is base64 with `-`/`_` substitutions and trailing `=` stripped.
  // Browsers don't expose btoa for raw bytes, so we go through TextEncoder.
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build a `nim-asset://` URL for the given absolute filesystem path.
 *
 * The main-process handler is responsible for verifying the path lives
 * under one of the allowlisted root prefixes (open workspaces +
 * userData/chat-attachments). The renderer does NOT need to know which
 * root it belongs to.
 */
export function nimAssetUrl(absoluteFilePath: string): string {
  if (!absoluteFilePath) return "";
  return `${SCHEME}://${HOST}/${toBase64Url(absoluteFilePath)}`;
}
