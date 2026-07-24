/**
 * Encode a filesystem path (or URL path) so it is safe to drop into a markdown
 * link destination: `[label](<here>)`.
 *
 * A bare CommonMark link destination ends at the first space and breaks on
 * parentheses, so a path like `/D:/My Project/design.mockup.html` truncates to
 * `/D:/My` and the link dies (GH #693 / NIM-964). Windows paths with spaces are
 * common (`Program Files (x86)`, user-named project folders), so this bites a
 * lot of auto-generated file links.
 *
 * We percent-encode exactly the destination-breaking characters — space and
 * parentheses — and leave path separators, drive-letter colons, and everything
 * else untouched so the path stays human-readable. Existing literal `%` is
 * encoded first so the transform is lossless. The transcript and file-open
 * resolvers already `decodeURIComponent` an href, so the encoded form
 * round-trips back to the real on-disk path on click.
 *
 * Example: `/D:/My Project/x.html` -> `/D:/My%20Project/x.html`.
 */
export function encodeMarkdownLinkPath(path: string): string {
  return path
    // Encode existing percent signs first so decoding is lossless.
    .replace(/%/g, '%25')
    .replace(/ /g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}
