import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import {
  useTranscriptMarkdownContributions,
  useTranscriptMarkdownStyles,
} from '../contributions';
import { useAtomValue } from 'jotai';
import { escapeCurrencyDollars } from '../utils/escapeCurrencyDollars';
import { rehypeAutolinkFilePaths } from '../markdown/rehypeAutolinkFilePaths';
import { rehypeAutolinkTrackerRefs } from '../markdown/rehypeAutolinkTrackerRefs';
import { rehypeAutolinkSessionRefs } from '../markdown/rehypeAutolinkSessionRefs';
import { TrackerReferenceChip } from '../../../plugins/TrackerLinkPlugin';
import { TRACKER_REFERENCE_URN_SCHEME } from '../../../plugins/TrackerLinkPlugin/TrackerReferenceNode';
import { trackerIssueKeyPrefixesAtom } from '../../../plugins/TrackerPlugin/trackerDataAtoms';
import { SessionReferenceChip } from '../session/SessionReferenceChip';
import { sessionRefMapAtom } from '../session/sessionRefAtoms';

// Inject MarkdownRenderer styles once (for syntax highlighting, scrollbar, and overflow wrapper)
const injectMarkdownRendererStyles = () => {
  const styleId = 'markdown-renderer-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    /* Wrap toggle visibility */
    .wrap-toggle {
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .overflow-wrapper:hover .wrap-toggle {
      opacity: 1;
    }

    /* Word wrap enabled state */
    .overflow-wrapper.word-wrap-enabled .overflow-content {
      overflow-x: visible;
    }
    .overflow-wrapper.word-wrap-enabled .overflow-content code,
    .overflow-wrapper.word-wrap-enabled .overflow-content pre,
    .overflow-wrapper.word-wrap-enabled .overflow-content div {
      white-space: pre-wrap !important;
      word-break: break-word !important;
      overflow-wrap: break-word !important;
    }

    /* Reset token backgrounds - prevent boxes from default Prism theme */
    .markdown-content .token {
      background: none !important;
    }

    /* Syntax highlighting token colors using CSS variables */
    .markdown-content .token.comment,
    .markdown-content .token.prolog,
    .markdown-content .token.doctype,
    .markdown-content .token.cdata {
      color: var(--nim-text-faint);
      font-style: italic;
    }
    .markdown-content .token.punctuation {
      color: var(--nim-text-muted);
    }
    .markdown-content .token.property,
    .markdown-content .token.tag,
    .markdown-content .token.boolean,
    .markdown-content .token.number,
    .markdown-content .token.constant,
    .markdown-content .token.symbol,
    .markdown-content .token.deleted {
      color: var(--nim-primary);
    }
    .markdown-content .token.selector,
    .markdown-content .token.attr-name,
    .markdown-content .token.string,
    .markdown-content .token.char,
    .markdown-content .token.builtin,
    .markdown-content .token.inserted {
      color: var(--nim-text);
    }
    .markdown-content .token.operator,
    .markdown-content .token.entity,
    .markdown-content .token.url,
    .markdown-content .language-css .token.string,
    .markdown-content .style .token.string {
      color: var(--nim-text-muted);
    }
    .markdown-content .token.atrule,
    .markdown-content .token.attr-value,
    .markdown-content .token.keyword {
      color: var(--nim-primary);
      font-weight: 500;
    }
    .markdown-content .token.function,
    .markdown-content .token.class-name {
      color: var(--nim-text);
      font-weight: 500;
    }
    .markdown-content .token.regex,
    .markdown-content .token.important,
    .markdown-content .token.variable {
      color: var(--nim-primary);
    }

    /* Code block scrollbar styling */
    .markdown-content pre[class*="language-"]::-webkit-scrollbar {
      height: 8px;
    }
    .markdown-content pre[class*="language-"]::-webkit-scrollbar-track {
      background: var(--nim-bg-secondary);
      border-radius: 4px;
    }
    .markdown-content pre[class*="language-"]::-webkit-scrollbar-thumb {
      background: var(--nim-scrollbar-thumb);
      border-radius: 4px;
    }
    .markdown-content pre[class*="language-"]::-webkit-scrollbar-thumb:hover {
      background: var(--nim-scrollbar-thumb-hover);
    }
  `;
  document.head.appendChild(style);
};

// Initialize styles on module load
if (typeof document !== 'undefined') {
  injectMarkdownRendererStyles();
}

// Wrap preference for transcript code blocks, persisted across remounts.
// react-markdown re-renders on every streaming chunk and reconciles by
// sibling index, not content, so a code block whose position shifts (a new
// paragraph appears above it, a message appends, etc.) gets unmounted and
// remounted with fresh local state. That's the "wrap deselects itself"
// symptom.
//
// Identity is keyed by `${messageId}:${nodeOffset}`. The message id is
// passed in from MessageSegment; node.position.start.offset comes from
// react-markdown's override API and is the byte offset of the code fence
// in the original markdown source. Together they're stable from first
// render through end of stream, which closes the early-streaming hole
// that a content-prefix key would leave open. Falls back to a counter
// for callers that don't have a message id (NewFilePreview, tool result
// renderers, etc.) so the cache still helps in those paths without
// risking cross-message bleed (counter values are uniquely allocated
// per mount, so the only carrier of state restoration in the fallback
// path is the same-instance re-render case).
const WRAP_PREFERENCE_CAP = 200;
const wrapPreferenceByKey = new Map<string, boolean>();

function setWrapPreference(key: string, value: boolean) {
  if (!key) return;
  if (wrapPreferenceByKey.has(key)) {
    wrapPreferenceByKey.delete(key);
  } else if (wrapPreferenceByKey.size >= WRAP_PREFERENCE_CAP) {
    const firstKey = wrapPreferenceByKey.keys().next().value;
    if (firstKey !== undefined) wrapPreferenceByKey.delete(firstKey);
  }
  wrapPreferenceByKey.set(key, value);
}

let _wrapFallbackCounter = 0;
function nextFallbackKey(): string {
  _wrapFallbackCounter += 1;
  return `cb:fallback:${_wrapFallbackCounter}`;
}

// Wrapper for any element that might overflow horizontally.
// Uses IntersectionObserver to defer scrollWidth measurement until visible,
// and ResizeObserver to re-check on size changes - avoids forced reflow during
// initial session load when many code blocks render off-screen.
const OverflowWrapper: React.FC<{
  children: React.ReactNode;
  /** Stable id for wrap-preference persistence across remounts. Compose
   *  from messageId + AST node offset at the call site. */
  persistKey?: string;
}> = ({ children, persistKey }) => {
  // Freeze the key once per mount so the same wrap-preference slot is used
  // for the lifetime of this instance. Re-mounts re-evaluate useMemo and
  // pick up the persisted preference (if any) for the resolved key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const wrapKey = useMemo(() => persistKey || nextFallbackKey(), []);
  const [wordWrap, setWordWrapState] = useState<boolean>(
    () => wrapPreferenceByKey.get(wrapKey) ?? false
  );
  const setWordWrap = useCallback((next: boolean) => {
    setWordWrapState(next);
    setWrapPreference(wrapKey, next);
  }, [wrapKey]);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasBeenVisible = useRef(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const checkOverflow = () => {
      if (contentRef.current) {
        setIsOverflowing(contentRef.current.scrollWidth > contentRef.current.clientWidth + 1);
      }
    };

    // Only measure once visible - avoids forced reflow for off-screen code blocks
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          hasBeenVisible.current = true;
          checkOverflow();
        }
      },
      { rootMargin: '100px' }
    );
    io.observe(el);

    // Re-check on resize (only when already visible)
    const ro = new ResizeObserver(() => {
      if (hasBeenVisible.current) {
        checkOverflow();
      }
    });
    ro.observe(el);

    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, [children]);

  return (
    <div className={`overflow-wrapper relative ${wordWrap ? 'word-wrap-enabled' : ''}`}>
      <div ref={contentRef} className="overflow-content max-w-full overflow-x-auto whitespace-pre">
        {children}
      </div>
      {(isOverflowing || wordWrap) && (
        <label className="wrap-toggle flex items-center gap-1 absolute top-1 right-1 text-[0.6875rem] text-[var(--nim-text-faint)] cursor-pointer select-none bg-[var(--nim-bg-secondary)] py-0.5 px-1.5 rounded">
          <input
            type="checkbox"
            checked={wordWrap}
            onChange={(e) => setWordWrap(e.target.checked)}
            className="w-3 h-3 m-0 cursor-pointer accent-[var(--nim-primary)]"
          />
          <span className="leading-none">Wrap</span>
        </label>
      )}
    </div>
  );
};

/** Matches a UUID (v4-style hex with dashes) used as session reference hrefs. */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MarkdownRendererProps {
  content: string;
  isUser?: boolean;
  isSystemMessage?: boolean;
  /** Optional: Open local file links directly in the editor */
  onOpenFile?: (filePath: string) => void;
  /**
   * @deprecated Session UUID references now render as a `SessionReferenceChip`
   * that opens the session via the `open-ai-session` event. Still accepted so
   * existing callers typecheck; no longer used for link handling.
   */
  onOpenSession?: (sessionId: string) => void;
  /** Optional: Stable identifier (typically the message id) used to scope
   *  per-block UI preferences (e.g. the OverflowWrapper Wrap toggle) so
   *  preferences survive react-markdown remounts during streaming. */
  messageId?: string | number;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripQueryAndHash(value: string): string {
  let result = value;
  const hashIndex = result.indexOf('#');
  if (hashIndex >= 0) {
    result = result.slice(0, hashIndex);
  }
  const queryIndex = result.indexOf('?');
  if (queryIndex >= 0) {
    result = result.slice(0, queryIndex);
  }
  return result;
}

function stripLineAndColumnSuffix(filePath: string): string {
  // Supports /path/file.ts:42 and /path/file.ts:42:7 references.
  return filePath.replace(/:(\d+)(?::(\d+))?$/, '');
}

function isAbsoluteFilePath(filePath: string): boolean {
  return (
    filePath.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(filePath) ||
    filePath.startsWith('\\\\')
  );
}

/**
 * Matches a Windows drive-letter absolute path, tolerating a single spurious
 * leading slash (`/D:/...`) that some link sources prepend. Capture group 1 is
 * the normalized path without the leading slash (e.g. `D:/work/foo.pas`).
 */
const WINDOWS_DRIVE_PATH_RE = /^\/?([A-Za-z]:[\\/].*)$/;

/**
 * react-markdown's `defaultUrlTransform` treats a Windows drive letter (`D:`)
 * as a URL scheme. Since `d:` isn't an allowed protocol it blanks the href to
 * `''`, which made Windows file links render as `<a href="">` and open a blank
 * window on click (GitHub #744). It likewise blanks our `nimbalyst://` tracker
 * reference URNs, which made `[NIM-123](nimbalyst://NIM-123)` links fall through
 * to a blank `<a>` (the tracker-chip check in the `a` renderer never saw the
 * href) and open an empty window on click. Preserve Windows absolute paths and
 * tracker reference URNs verbatim, and delegate everything else to the default
 * so `javascript:`/`data:` links stay sanitized.
 */
export function transcriptUrlTransform(url: string): string {
  if (
    WINDOWS_DRIVE_PATH_RE.test(url) ||
    url.startsWith('\\\\') ||
    url.trim().startsWith(TRACKER_REFERENCE_URN_SCHEME)
  ) {
    return url;
  }
  return defaultUrlTransform(url);
}

/**
 * Returns the tracker reference key for a `nimbalyst://<key>` href, or null.
 */
export function parseTrackerReferenceHref(href?: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed.startsWith(TRACKER_REFERENCE_URN_SCHEME)) return null;
  const key = trimmed.slice(TRACKER_REFERENCE_URN_SCHEME.length);
  return key.length > 0 ? key : null;
}

/**
 * Resolve href to an openable local file path when it looks like a filesystem link.
 * Returns null for non-file/external links.
 */
export function resolveTranscriptFilePathFromHref(href?: string): string | null {
  if (!href) return null;

  const trimmedHref = href.trim();
  if (!trimmedHref || trimmedHref.startsWith('#')) {
    return null;
  }

  let candidate = trimmedHref;

  if (/^file:\/\//i.test(trimmedHref)) {
    try {
      const parsedUrl = new URL(trimmedHref);
      candidate = safeDecodeURIComponent(stripQueryAndHash(parsedUrl.pathname));
      // file:///C:/Users/... => /C:/Users/... (normalize for Windows absolute path)
      if (/^\/[A-Za-z]:[\\/]/.test(candidate)) {
        candidate = candidate.slice(1);
      }
    } catch {
      return null;
    }
  } else {
    // A Windows drive-letter absolute path (`D:\...`, `D:/...`, or the
    // leading-slash-mangled `/D:/...`) superficially looks like a URI with a
    // `d:` scheme. Detect and normalize it (dropping the spurious leading
    // slash) before the external-scheme rejection below, otherwise these
    // links are treated as external URLs and open a blank window (#744).
    const windowsDrive = trimmedHref.match(WINDOWS_DRIVE_PATH_RE);
    if (windowsDrive) {
      candidate = safeDecodeURIComponent(stripQueryAndHash(windowsDrive[1]));
    } else {
      // Keep web links (https:, mailto:, etc.) as external links.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmedHref)) {
        return null;
      }
      candidate = safeDecodeURIComponent(stripQueryAndHash(trimmedHref));
    }
  }

  let cleanedPath = stripLineAndColumnSuffix(candidate);
  if (!cleanedPath) {
    return null;
  }

  // Claude Code emits markdown links of the form
  // `/abs/path/<real absolute path>` (e.g.
  // `/abs/path/C:/Users/foo/file.ts:42` on Windows or
  // `/abs/path//Users/foo/file.ts:42` on macOS). The `/abs/path/`
  // prefix is a Claude Code marker, not a real filesystem segment;
  // strip it so the rest of the renderer routes the link through
  // `workspace:open-file` with the actual on-disk path. Fixes #240.
  if (cleanedPath.startsWith('/abs/path/')) {
    cleanedPath = cleanedPath.slice('/abs/path/'.length);
  }

  return isAbsoluteFilePath(cleanedPath) ? cleanedPath : null;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  isUser = false,
  isSystemMessage = false,
  onOpenFile,
  messageId
}) => {
  // Stable per-block key for the OverflowWrapper wrap-preference cache.
  // Combines the message id (so different messages can never share a slot)
  // with the source-position offset of the code-fence node in the parsed
  // markdown AST (so different blocks within the same message also don't
  // share). react-markdown 10 passes the AST node to each override.
  const codeBlockPersistKey = useCallback((node: unknown): string | undefined => {
    if (messageId == null) return undefined;
    const offset = (node as { position?: { start?: { offset?: number } } } | null | undefined)
      ?.position?.start?.offset;
    if (typeof offset !== 'number') return undefined;
    return `cb:${String(messageId)}:${offset}`;
  }, [messageId]);

  // Extension-contributed markdown plugins/components are merged on top of
  // the core baseline. The transcript registry handles deduping styles and
  // keeps the React tree subscribed to extension enable/disable events.
  const contributions = useTranscriptMarkdownContributions();
  useTranscriptMarkdownStyles(contributions.styles);

  // Core ships only `remark-gfm` as the baseline; KaTeX, syntax themes, and
  // any other domain-specific behavior now arrives via the transcript
  // markdown contribution registry (see
  // `packages/extensions/math` for the canonical KaTeX contributor).
  const remarkPlugins = useMemo<PluggableList>(
    () => [remarkGfm, ...contributions.remarkPlugins] as PluggableList,
    [contributions.remarkPlugins],
  );
  // Distinct issue-key prefixes actually used in this workspace (e.g. `NIM`),
  // so bare tracker keys in prose auto-link without matching `UTF-8`-style
  // tokens. Sorted+joined into a stable dep so the plugin memo only rebuilds
  // when the set of prefixes changes, not on every tracker-store update.
  const trackerPrefixSet = useAtomValue(trackerIssueKeyPrefixesAtom);
  const trackerPrefixKey = useMemo(
    () => Array.from(trackerPrefixSet).sort().join(','),
    [trackerPrefixSet],
  );
  // Known session ids so bare UUIDs in prose/tool results auto-link to a chip
  // without turning unrelated UUIDs into dead session links. Sorted+joined so
  // the plugin memo only rebuilds when the set of ids changes, not on every
  // session-store update (e.g. a processing bit flipping).
  const sessionRefMap = useAtomValue(sessionRefMapAtom);
  const sessionIdKey = useMemo(
    () => Array.from(sessionRefMap.keys()).sort().join(','),
    [sessionRefMap],
  );
  const rehypePlugins = useMemo<PluggableList>(
    () => [
      // Autolink bare file paths into clickable file-open links. Only useful
      // when there is a file-open handler to route the click to.
      ...(onOpenFile ? [rehypeAutolinkFilePaths] : []),
      // Autolink bare tracker keys (`NIM-123`) into live status chips, gated on
      // the prefixes this workspace actually uses.
      ...(trackerPrefixKey
        ? [[rehypeAutolinkTrackerRefs, { prefixes: trackerPrefixKey.split(',') }]]
        : []),
      // Autolink bare session UUIDs into live session chips, gated on the set
      // of known session ids.
      ...(sessionIdKey
        ? [[rehypeAutolinkSessionRefs, { sessionIds: sessionIdKey.split(',') }]]
        : []),
      ...contributions.rehypePlugins,
    ] as PluggableList,
    [contributions.rehypePlugins, onOpenFile, trackerPrefixKey, sessionIdKey],
  );

  // Pre-escape currency-pattern dollar signs so `remark-math` does not
  // collapse `$7M ... $40M`-style text as inline LaTeX in the transcript.
  // Mirrors the pandoc rules from the Lexical-editor fix in commit baf60b4e9.
  // See nimbalyst/nimbalyst#462.
  const processedContent = useMemo(() => escapeCurrencyDollars(content), [content]);

  return (
    <div
      className={`markdown-content text-[0.9375rem] leading-relaxed max-w-full overflow-x-hidden break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${isUser ? 'font-medium' : 'font-normal'} ${isSystemMessage ? 'opacity-85 font-mono text-[0.95em]' : ''}`}
      style={{
        color: 'var(--nim-text)'
      }}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={transcriptUrlTransform}
        components={{
          // Code blocks with syntax highlighting
          code({ node, inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';
            const codeString = String(children).replace(/\n$/, '');
            const isSingleLine = !codeString.includes('\n');

            // True inline code (backticks in text)
            if (inline) {
              return (
                <code
                  className={className}
                  style={{
                    backgroundColor: 'var(--nim-bg-tertiary)',
                    padding: '0.125rem 0.375rem',
                    borderRadius: '0.25rem',
                    fontSize: '0.875em',
                    fontFamily: 'var(--font-mono, monospace)',
                    color: 'var(--nim-text)'
                  }}
                  {...props}
                >
                  {children}
                </code>
              );
            }

            const codeStyle: React.CSSProperties = {
              backgroundColor: 'var(--nim-bg-tertiary)',
              padding: isSingleLine ? '0.25rem 0.5rem' : '0.75rem',
              borderRadius: isSingleLine ? '0.25rem' : '0.375rem',
              fontSize: '0.8125rem',
              lineHeight: isSingleLine ? '1.4' : '1.5',
              margin: isSingleLine ? 0 : '0.5rem 0'
            };

            // Code block with language - use syntax highlighting
            if (language) {
              const syntaxBlock = (
                <SyntaxHighlighter
                  style={{} as any}
                  customStyle={codeStyle}
                  language={language}
                  PreTag="div"
                  codeTagProps={{
                    style: {
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: 'inherit',
                      background: 'none'
                    }
                  }}
                  {...props}
                >
                  {codeString}
                </SyntaxHighlighter>
              );
              // Only wrap multi-line blocks with OverflowWrapper
              return isSingleLine
                ? syntaxBlock
                : <OverflowWrapper persistKey={codeBlockPersistKey(node)}>{syntaxBlock}</OverflowWrapper>;
            }

            // Code block without language
            const codeBlock = (
              <code
                className={className}
                style={{
                  display: isSingleLine ? 'inline-block' : 'block',
                  ...codeStyle,
                  fontFamily: 'var(--font-mono, monospace)',
                  color: 'var(--nim-text)'
                }}
                {...props}
              >
                {children}
              </code>
            );
            // Only wrap multi-line blocks with OverflowWrapper
            return isSingleLine
              ? codeBlock
              : <OverflowWrapper persistKey={codeBlockPersistKey(node)}>{codeBlock}</OverflowWrapper>;
          },
          // Remove default pre wrapper - we handle styling in code component
          pre: ({ children }) => <>{children}</>,
          // Headings
          h1: ({ children }) => (
            <h1 style={{
              fontSize: '1.875rem',
              fontWeight: 700,
              marginTop: '1.5rem',
              marginBottom: '1rem',
              color: 'var(--nim-text)',
              borderBottom: '1px solid var(--nim-border)',
              paddingBottom: '0.5rem'
            }}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 style={{
              fontSize: '1.5rem',
              fontWeight: 600,
              marginTop: '1.25rem',
              marginBottom: '0.75rem',
              color: 'var(--nim-text)'
            }}>
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 style={{
              fontSize: '1.25rem',
              fontWeight: 600,
              marginTop: '1rem',
              marginBottom: '0.5rem',
              color: 'var(--nim-text)'
            }}>
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 style={{
              fontSize: '1.125rem',
              fontWeight: 600,
              marginTop: '1rem',
              marginBottom: '0.5rem',
              color: 'var(--nim-text)'
            }}>
              {children}
            </h4>
          ),
          h5: ({ children }) => (
            <h5 style={{
              fontSize: '1rem',
              fontWeight: 600,
              marginTop: '0.75rem',
              marginBottom: '0.5rem',
              color: 'var(--nim-text)'
            }}>
              {children}
            </h5>
          ),
          h6: ({ children }) => (
            <h6 style={{
              fontSize: '0.875rem',
              fontWeight: 600,
              marginTop: '0.75rem',
              marginBottom: '0.5rem',
              color: 'var(--nim-text)'
            }}>
              {children}
            </h6>
          ),
          // Paragraphs
          p: ({ children }) => (
            <p style={{
              marginTop: '0.5rem',
              marginBottom: '0.5rem',
              lineHeight: '1.625',
              color: 'var(--nim-text)',
              ...(isUser && { whiteSpace: 'pre-wrap' })
            }}>
              {children}
            </p>
          ),
          // Links
          a: ({ href, children, node }: any) => {
            // Tracker reference links (`nimbalyst://NIM-123`) render as a live
            // status chip instead of an anchor.
            const trackerKey = parseTrackerReferenceHref(href);
            if (trackerKey) {
              return <TrackerReferenceChip referenceKey={trackerKey} />;
            }
            // Session references (a bare session UUID href) render as a live
            // session chip that resolves the title/phase and opens the session
            // on click. Autolinked bare UUIDs and author-written UUID links both
            // land here.
            const sessionRefId =
              href && SESSION_UUID_RE.test(href.trim()) ? href.trim() : null;
            if (sessionRefId) {
              return <SessionReferenceChip sessionId={sessionRefId} />;
            }
            // Paths wrapped by `rehypeAutolinkFilePaths` carry a marker with the
            // raw match (possibly with a :line:col suffix). They may be
            // workspace-relative, which the markdown-href resolver rejects, so
            // resolve them directly here and strip the location suffix before
            // opening.
            const autolinkedPath = node?.properties?.dataFilePath as string | undefined;
            const resolvedAutolink =
              onOpenFile && autolinkedPath ? stripLineAndColumnSuffix(autolinkedPath) : null;
            const filePath =
              resolvedAutolink ?? (onOpenFile ? resolveTranscriptFilePathFromHref(href) : null);
            const isInternalLink = Boolean(filePath);
            return (
              <a
                href={href}
                target={isInternalLink ? undefined : '_blank'}
                rel={isInternalLink ? undefined : 'noopener noreferrer'}
                onClick={(event) => {
                  if (filePath && onOpenFile) {
                    event.preventDefault();
                    onOpenFile(filePath);
                  }
                }}
                style={{
                  color: 'var(--nim-primary)',
                  textDecoration: 'underline',
                  cursor: 'pointer'
                }}
              >
                {children}
              </a>
            );
          },
          // Lists
          ul: ({ children }) => (
            <ul style={{
              marginTop: '0.5rem',
              marginBottom: '0.5rem',
              paddingLeft: '1.5rem',
              listStyleType: 'disc',
              color: 'var(--nim-text)'
            }}>
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol style={{
              marginTop: '0.5rem',
              marginBottom: '0.5rem',
              paddingLeft: '1.5rem',
              listStyleType: 'decimal',
              color: 'var(--nim-text)'
            }}>
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li style={{
              marginTop: '0.25rem',
              marginBottom: '0.25rem',
              lineHeight: '1.625'
            }}>
              {children}
            </li>
          ),
          // Blockquotes
          blockquote: ({ children }) => (
            <blockquote style={{
              borderLeft: '4px solid var(--nim-border)',
              paddingLeft: '1rem',
              marginLeft: '0',
              marginTop: '0.75rem',
              marginBottom: '0.75rem',
              color: 'var(--nim-text-muted)',
              fontStyle: 'italic'
            }}>
              {children}
            </blockquote>
          ),
          // Tables
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', marginTop: '0.75rem', marginBottom: '0.75rem' }}>
              <table style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.875rem',
                border: '1px solid var(--nim-border)'
              }}>
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead style={{
              backgroundColor: 'var(--nim-bg-secondary)',
              borderBottom: '2px solid var(--nim-border)'
            }}>
              {children}
            </thead>
          ),
          tbody: ({ children }) => (
            <tbody>
              {children}
            </tbody>
          ),
          tr: ({ children }) => (
            <tr style={{
              borderBottom: '1px solid var(--nim-border)'
            }}>
              {children}
            </tr>
          ),
          th: ({ children }) => (
            <th style={{
              padding: '0.75rem',
              textAlign: 'left',
              fontWeight: 600,
              color: 'var(--nim-text)'
            }}>
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td style={{
              padding: '0.75rem',
              color: 'var(--nim-text)'
            }}>
              {children}
            </td>
          ),
          // Horizontal rule
          hr: () => (
            <hr style={{
              border: 'none',
              borderTop: '1px solid var(--nim-border)',
              marginTop: '1rem',
              marginBottom: '1rem'
            }} />
          ),
          // Strong/Bold
          strong: ({ children }) => (
            <strong style={{
              fontWeight: 700,
              color: 'var(--nim-text)'
            }}>
              {children}
            </strong>
          ),
          // Emphasis/Italic
          em: ({ children }) => (
            <em style={{
              fontStyle: 'italic',
              color: 'var(--nim-text)'
            }}>
              {children}
            </em>
          ),
          // Strikethrough (GFM)
          del: ({ children }) => (
            <del style={{
              textDecoration: 'line-through',
              color: 'var(--nim-text-faint)'
            }}>
              {children}
            </del>
          ),
          // Extension overrides applied last so they can replace any of the
          // core component handlers above.
          ...contributions.components,
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};
