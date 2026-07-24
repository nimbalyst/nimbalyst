export interface ParsedCollabAssetUri {
  documentId: string;
  assetId: string;
}

export function buildCollabAssetUri(documentId: string, assetId: string): string {
  return `collab-asset://doc/${encodeURIComponent(documentId)}/asset/${encodeURIComponent(assetId)}`;
}

export function parseCollabAssetUri(uri: string): ParsedCollabAssetUri | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'collab-asset:' || url.hostname !== 'doc') {
      return null;
    }

    const match = url.pathname.match(/^\/([^/]+)\/asset\/([^/]+)$/);
    if (!match) {
      return null;
    }

    return {
      documentId: decodeURIComponent(match[1]),
      assetId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

export function isCollabAssetUri(uri: string): boolean {
  return parseCollabAssetUri(uri) !== null;
}
