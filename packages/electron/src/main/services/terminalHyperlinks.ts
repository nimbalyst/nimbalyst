/**
 * TEMPORARY WORKAROUND -- remove once coder/ghostty-web#186 is fixed.
 *
 * Replaying a large, hyperlink-dense scrollback into the vendored ghostty-vt
 * (ghostty-web) terminal on restore exhausts its bounded hyperlink string arena
 * (`error.StringAllocOutOfMemory`) and spins the renderer's main thread
 * (see nimbalyst#806). Until the upstream library degrades gracefully on arena
 * exhaustion, we neutralize OSC 8 hyperlinks in *restored* scrollback so ghostty
 * never allocates hyperlink objects for them.
 *
 * We don't drop the link outright -- restored history stays useful by flattening
 * each link to plain text and KEEPING the file path:
 *   file:// links  ->  "<label> (<path>)"   (or just the path when label === path)
 *   other links    ->  the visible label, unchanged
 *
 * OSC 8 format:
 *   ESC ] 8 ; params ; URI  ST   <label>   ESC ] 8 ; ;  ST
 * where ST (string terminator) is BEL (0x07) or ESC \ (0x1b 0x5c).
 */

// A complete OSC 8 link: OPEN(params ; uri) ST <label> CLOSE. Group 1 = URI, group 2 = label.
const OSC8_LINK = /\x1b\]8;[^;\x1b\x07]*;([^\x1b\x07]*)(?:\x07|\x1b\\)([\s\S]*?)\x1b\]8;;(?:\x07|\x1b\\)/g;
// Safety net for any stray / unclosed OSC 8 marker the pass above didn't pair up.
const OSC8_STRAY = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

function fileUriToPath(uri: string): string | null {
    if (!uri.startsWith('file://')) {
        return null;
    }
    // Drop scheme and optional host: file://host/p -> /p, file:///p -> /p
    const afterScheme = uri.slice('file://'.length);
    const firstSlash = afterScheme.indexOf('/');
    let filePath = firstSlash === -1 ? '' : afterScheme.slice(firstSlash);
    try {
        filePath = decodeURIComponent(filePath);
    } catch {
        // Leave percent-encoding in place if the URI is malformed.
    }
    // file:///C:/x -> C:/x
    if (/^\/[A-Za-z]:/.test(filePath)) {
        filePath = filePath.slice(1);
    }
    return filePath;
}

function flattenLink(uri: string, label: string): string {
    const filePath = fileUriToPath(uri);
    if (!filePath) {
        return label;
    }
    if (!label || label === filePath) {
        return filePath;
    }
    return `${label} (${filePath})`;
}

/**
 * Flatten OSC 8 hyperlinks in scrollback to plain text before it is replayed
 * into the terminal on session restore. See the file header for why.
 */
export function flattenReplayHyperlinks(scrollback: string): string {
    if (!scrollback) {
        return scrollback;
    }
    return scrollback
        .replace(OSC8_LINK, (_match, uri: string, label: string) => flattenLink(uri, label))
        .replace(OSC8_STRAY, '');
}
