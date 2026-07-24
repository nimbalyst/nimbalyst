/**
 * markdownAssetScanner -- pure helpers for finding local image references in a
 * markdown document and resolving them to absolute filesystem paths inside a
 * workspace.
 *
 * Used by the `document-sync:migrate-local-assets` handler to walk a markdown
 * file before it is seeded into a collab Y.Doc, so each pasted image can be
 * uploaded through the encrypted collab-asset path and the markdown rewritten
 * to a `collab-asset://` URI.
 *
 * Why this is pure: keeping resolution and rewriting side-effect-free lets us
 * cover the path-traversal guard, the URL-shape coverage matrix, and the
 * deduplication logic with unit tests without touching `fs` or the network.
 */
import * as path from 'path';

// Markdown image syntax. The "ref" we want is the URL inside the parens of
// `![alt](url)`. We deliberately do NOT match plain links `[label](url)`
// because non-image local files are out of scope for Phase 3a.
//
// The negative lookbehind on `!` is implicit -- we require it at the start
// of the match. The capture groups:
//   1: alt text including brackets
//   2: the URL (no whitespace, no nested parens)
const IMG_REF_REGEX = /(!\[[^\]]*\])\(([^)\s]+)\)/g;

/** Extensions we are willing to migrate. SVG is included for parity with the */
/** existing storeAsset() output; the SSRF/XSS concern is documented in the   */
/** plan and is pre-existing for collab assets in general.                    */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export interface ResolvedAssetRef {
  kind: 'resolved';
  /** The ref string as it appears in the markdown (preserved verbatim). */
  ref: string;
  /** Absolute path on disk, inside the workspace. */
  absolutePath: string;
  /** MIME type derived from the file extension. */
  mimeType: string;
  /** Basename used as the user-visible filename. */
  fileName: string;
}

export interface RejectedAssetRef {
  kind: 'rejected';
  ref: string;
  reason: string;
}

export interface SkippedAssetRef {
  kind: 'skip';
  ref: string;
  /** Why this ref was not in scope (already remote, unsupported scheme, etc.). */
  reason: string;
}

export type AssetRefResolution = ResolvedAssetRef | RejectedAssetRef | SkippedAssetRef;

/**
 * Find every unique markdown image ref in the document, in document order.
 * Duplicate refs (same URL appearing in multiple places) collapse to a single
 * entry -- the substitution map applied later will replace every occurrence.
 */
export function scanMarkdownImageRefs(markdown: string): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const match of markdown.matchAll(IMG_REF_REGEX)) {
    const ref = match[2];
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

function getExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return ext;
}

function isInsideWorkspace(absolutePath: string, workspacePath: string): boolean {
  const normalizedWorkspace = path.resolve(workspacePath);
  const normalizedPath = path.resolve(absolutePath);
  const rel = path.relative(normalizedWorkspace, normalizedPath);
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Resolve a single ref to its absolute filesystem path, or classify why it
 * is out of scope. Does not touch the filesystem -- callers verify existence
 * separately so a missing file can be reported per-ref.
 *
 * Supported shapes (Phase 3a):
 *   - `assets/<name>.<ext>`            relative to dirname(sourceFilePath)
 *   - `.nimbalyst/assets/<name>.<ext>` relative to workspacePath
 *   - `file:///abs/path/to/<name>.<ext>` absolute file URL inside workspace
 *
 * All other shapes (`http(s)`, `collab-asset://`, `data:`, bare-relative
 * non-`assets/` paths, etc.) return `kind: 'skip'`.
 */
export function resolveAssetRef(
  ref: string,
  sourceFilePath: string,
  workspacePath: string,
): AssetRefResolution {
  if (!ref) {
    return { kind: 'skip', ref, reason: 'empty ref' };
  }

  // Skip well-known non-local shapes.
  if (/^(https?:|data:|blob:|collab-asset:)/i.test(ref)) {
    return { kind: 'skip', ref, reason: 'remote or non-filesystem scheme' };
  }

  let absolutePath: string;
  if (ref.startsWith('file://')) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(ref);
    } catch {
      return { kind: 'rejected', ref, reason: 'malformed file:// URL' };
    }
    try {
      absolutePath = decodeURIComponent(parsedUrl.pathname);
    } catch {
      return { kind: 'rejected', ref, reason: 'undecodable file:// URL' };
    }
  } else if (ref.startsWith('.nimbalyst/assets/')) {
    absolutePath = path.join(workspacePath, ref);
  } else if (ref.startsWith('assets/')) {
    const sourceDir = path.dirname(sourceFilePath);
    absolutePath = path.join(sourceDir, ref);
  } else {
    return { kind: 'skip', ref, reason: 'unsupported local ref shape' };
  }

  if (!isInsideWorkspace(absolutePath, workspacePath)) {
    return { kind: 'rejected', ref, reason: 'path traversal: outside workspace' };
  }

  const extension = getExtension(absolutePath);
  if (!IMAGE_EXTENSIONS.has(extension)) {
    return { kind: 'skip', ref, reason: `unsupported extension: ${extension || '(none)'}` };
  }

  return {
    kind: 'resolved',
    ref,
    absolutePath,
    mimeType: MIME_BY_EXTENSION[extension],
    fileName: path.basename(absolutePath),
  };
}

/**
 * Replace `![alt](ref)` occurrences whose ref is a key in `substitutions`
 * with the corresponding value. Refs not in the map are left untouched, so
 * partial-success migrations carry the remaining (broken) refs forward
 * unchanged for explicit reporting.
 *
 * The replacement walks markdown via the same image-ref regex used by
 * `scanMarkdownImageRefs`, which means we will never substitute a substring
 * of a different ref by accident -- the ref equality is exact and scoped to
 * the parenthesized URL of an `![...]( ... )` match.
 */
export function rewriteMarkdownImageRefs(
  markdown: string,
  substitutions: Map<string, string>,
): string {
  if (substitutions.size === 0) return markdown;
  return markdown.replace(IMG_REF_REGEX, (full, alt: string, ref: string) => {
    const replacement = substitutions.get(ref);
    if (!replacement) return full;
    return `${alt}(${replacement})`;
  });
}
