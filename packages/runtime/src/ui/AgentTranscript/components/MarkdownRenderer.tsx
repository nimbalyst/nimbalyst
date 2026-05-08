import React, { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';

// Defense-in-depth against KaTeX's history of XSS / DoS advisories. Agent-
// supplied math is untrusted, so disable anything that can elevate it (\href,
// \url, custom macros) and bound the work the renderer can be coerced into
// doing on a single equation.
const KATEX_SAFE_OPTIONS = {
  trust: false,
  strict: 'ignore' as const,
  throwOnError: false,
  output: 'html' as const,
  maxSize: 25,
  maxExpand: 100,
  macros: {},
};

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

// Wrapper for any element that might overflow horizontally.
// Uses IntersectionObserver to defer scrollWidth measurement until visible,
// and ResizeObserver to re-check on size changes - avoids forced reflow during
// initial session load when many code blocks render off-screen.
const OverflowWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [wordWrap, setWordWrap] = useState(false);
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
  /** Optional: Navigate to a session by ID (for @@session reference links) */
  onOpenSession?: (sessionId: string) => void;
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
    // Keep web links (https:, mailto:, etc.) as external links.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmedHref)) {
      return null;
    }
    candidate = safeDecodeURIComponent(stripQueryAndHash(trimmedHref));
  }

  const cleanedPath = stripLineAndColumnSuffix(candidate);
  if (!cleanedPath) {
    return null;
  }

  return isAbsoluteFilePath(cleanedPath) ? cleanedPath : null;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  isUser = false,
  isSystemMessage = false,
  onOpenFile,
  onOpenSession
}) => {
  return (
    <div
      className={`markdown-content text-[0.9375rem] leading-relaxed max-w-full overflow-x-hidden break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${isUser ? 'font-medium' : 'font-normal'} ${isSystemMessage ? 'opacity-85 font-mono text-[0.95em]' : ''}`}
      style={{
        color: 'var(--nim-text)'
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, KATEX_SAFE_OPTIONS]]}
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
              return isSingleLine ? syntaxBlock : <OverflowWrapper>{syntaxBlock}</OverflowWrapper>;
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
            return isSingleLine ? codeBlock : <OverflowWrapper>{codeBlock}</OverflowWrapper>;
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
          a: ({ href, children }) => {
            const filePath = onOpenFile ? resolveTranscriptFilePathFromHref(href) : null;
            const isSessionLink = onOpenSession && href && SESSION_UUID_RE.test(href.trim());
            const isInternalLink = filePath || isSessionLink;
            return (
              <a
                href={href}
                target={isInternalLink ? undefined : '_blank'}
                rel={isInternalLink ? undefined : 'noopener noreferrer'}
                onClick={(event) => {
                  if (isSessionLink) {
                    event.preventDefault();
                    onOpenSession(href!.trim());
                  } else if (filePath && onOpenFile) {
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
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
