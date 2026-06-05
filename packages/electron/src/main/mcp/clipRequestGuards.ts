import { IncomingMessage } from "http";

const ALLOWED_CLIP_ORIGIN_PROTOCOLS = new Set([
  "chrome-extension:",
  "moz-extension:",
  "safari-web-extension:",
]);

export function getAllowedClipOrigin(req: IncomingMessage): string | null {
  const originHeader = req.headers["origin"];
  if (typeof originHeader !== "string" || !originHeader.trim()) {
    return null;
  }

  try {
    const originUrl = new URL(originHeader);
    if (!originUrl.hostname) {
      return null;
    }
    if (!ALLOWED_CLIP_ORIGIN_PROTOCOLS.has(originUrl.protocol)) {
      return null;
    }
    return `${originUrl.protocol}//${originUrl.host}`;
  } catch {
    return null;
  }
}

export function hasAllowedClipContentType(req: IncomingMessage): boolean {
  const contentTypeHeader = req.headers["content-type"];
  if (typeof contentTypeHeader !== "string") {
    return false;
  }

  return contentTypeHeader.toLowerCase().startsWith("application/json");
}
