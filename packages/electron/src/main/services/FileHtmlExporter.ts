/**
 * Exports a workspace file as a self-contained HTML page.
 *
 * Used by the file sharing feature to render markdown files into
 * viewable HTML before client-side encryption and upload.
 *
 * The generated HTML includes:
 * - Inlined CSS (dark + light theme via CSS variables)
 * - Pre-rendered markdown (via `marked`)
 * - Syntax-highlighted code blocks (via `highlight.js`)
 * - Theme toggle button
 * - Nimbalyst brand bar
 */
import { Marked, type Tokens } from 'marked';
import hljs from 'highlight.js';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Markdown setup - separate Marked instance to avoid conflicting with
// SessionHtmlExporter's global marked config
// ---------------------------------------------------------------------------

const fileMarked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code(token: Tokens.Code) {
      const { text, lang } = token;
      if (lang && hljs.getLanguage(lang)) {
        const highlighted = hljs.highlight(text, { language: lang }).value;
        return `<pre class="hljs"><code class="language-${escapeHtml(lang)}">${highlighted}</code></pre>`;
      }
      const auto = hljs.highlightAuto(text);
      return `<pre class="hljs"><code>${auto.value}</code></pre>`;
    },
    codespan(token: Tokens.Codespan) {
      return `<code class="inline-code">${escapeHtml(token.text)}</code>`;
    },
  } as any,
});

// ---------------------------------------------------------------------------
// Image inlining — resolve local image paths to base64 data URIs
// ---------------------------------------------------------------------------

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/**
 * Replace local image `src` attributes in rendered HTML with inline base64
 * data URIs so shared pages can display them without access to the local FS.
 */
function inlineLocalImages(html: string, fileDir: string): string {
  return html.replace(/<img\s([^>]*?)src="([^"]+)"([^>]*?)>/g, (_match, before, src, after) => {
    // Skip absolute URLs and data URIs
    if (/^(https?:|data:|\/\/)/.test(src)) return _match;

    const imagePath = path.resolve(fileDir, decodeURIComponent(src));
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      const ext = path.extname(imagePath).toLowerCase();
      const mimeType = IMAGE_MIME_TYPES[ext] || 'application/octet-stream';
      const base64 = imageBuffer.toString('base64');
      return `<img ${before}src="data:${mimeType};base64,${base64}"${after}>`;
    } catch {
      // File not found — keep original src so it degrades visibly
      return _match;
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Strip YAML frontmatter from markdown content.
 * Returns { frontmatter, body } where frontmatter is the raw YAML string
 * (without delimiters) and body is the remaining markdown.
 */
function stripFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (match) {
    return { frontmatter: match[1], body: match[2] };
  }
  return { frontmatter: null, body: content };
}

function getNimbalystIconSvg(): string {
  return `<svg class="nimbalyst-icon" width="24" height="24" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="m196.4 23.3c-.5 8.3-12.4 6.9-14.8 14.9-1.8 6.1 9.8 9.9 6 15-4.9 6.7-14.2-.9-20.5 4.6-4.8 4.2 2.9 13.6-3.1 15.9-7.8 2.9-11.5-8.4-19.7-7.2-6.3.9-4.9 13-11.2 11.7-8.1-1.7-5.1-13.3-12.7-16.7-5.8-2.7-11.2 8.3-15.7 3.8C99 59.3 107.7 51.2 103.2 44.3 99.8 38.9 89.3 45.2 87.9 39 86.1 30.8 97.9 28.8 97.9 20.5 97.9 14.1 85.7 13.8 87.9 7.8 90.8 0 101.8 4.6 106.3-2.4c3.5-5.4-6.6-12.2-1.5-16.1 6.6-5 13.4 4.9 20.9 1.4 5.8-2.7 1-13.9 7.4-14.4 8.3-.6 8.6 11.3 16.9 12.5 6.3.9 8.4-11.1 14-8.1 7.3 3.9 1.1 14.2 7.4 19.6 4.8 4.2 13.1-4.8 16.2.8 4 7.3-6.7 12.6-4.4 20.5 1.8 6.1 13.6 3 13.2 9.4z" fill="#6395ff" transform="matrix(7.6 0 0 7.6-560 327)"/><text x="306" y="669" font-family="system-ui,sans-serif" font-size="528" font-weight="bold" fill="#fff">#</text></svg>`;
}

// ---------------------------------------------------------------------------
// HTML document builder
// ---------------------------------------------------------------------------

function buildFileHtml(fileName: string, contentHtml: string, rawMarkdownB64: string): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fileName)}</title>
${getStylesheet()}
</head>
<body>
<div class="container">

  <div class="brand-bar">
    <a href="https://nimbalyst.com" target="_blank" rel="noopener" class="brand-link">
      ${getNimbalystIconSvg()}
      <span class="brand-text">Shared from <strong>Nimbalyst</strong></span>
    </a>
    <div class="brand-actions">
      <button onclick="downloadMarkdown()" class="download-btn" title="Download as Markdown">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v9m0 0L4.5 7.5M8 11l3.5-3.5M2 13h12"/></svg>
        <span>.md</span>
      </button>
      <button onclick="toggleTheme()" class="theme-toggle" title="Toggle light/dark theme">
        <span class="theme-icon-dark">&#9789;</span>
        <span class="theme-icon-light">&#9788;</span>
      </button>
    </div>
  </div>

  <article class="document">
    ${contentHtml}
  </article>

  <footer class="footer">
    <a href="https://nimbalyst.com" target="_blank" rel="noopener" class="brand-link">
      ${getNimbalystIconSvg()}
      <span class="brand-text">Shared from <strong>Nimbalyst</strong></span>
    </a>
  </footer>

</div>
<script>
var _mdData = "${rawMarkdownB64}";
var _mdName = "${escapeHtml(fileName)}";
function downloadMarkdown() {
  var bytes = Uint8Array.from(atob(_mdData), function(c) { return c.charCodeAt(0); });
  var blob = new Blob([bytes], { type: 'text/markdown;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = _mdName;
  a.click();
  URL.revokeObjectURL(a.href);
}
function toggleTheme() {
  var root = document.documentElement;
  if (root.classList.contains('dark')) {
    root.classList.replace('dark', 'light');
  } else {
    root.classList.replace('light', 'dark');
  }
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function getStylesheet(): string {
  return `<style>
:root.dark {
  --bg: #1a1a1a;
  --bg-secondary: #2d2d2d;
  --bg-tertiary: #3a3a3a;
  --bg-hover: #4a4a4a;
  --text: #e4e4e7;
  --text-muted: #a1a1aa;
  --text-faint: #71717a;
  --primary: #60a5fa;
  --success: #4ade80;
  --error: #ef4444;
  --warning: #fbbf24;
  --border: #3f3f46;
  --code-bg: #1e1e1e;
}
:root.light {
  --bg: #ffffff;
  --bg-secondary: #f4f4f5;
  --bg-tertiary: #e4e4e7;
  --bg-hover: #d4d4d8;
  --text: #18181b;
  --text-muted: #52525b;
  --text-faint: #71717a;
  --primary: #2563eb;
  --success: #16a34a;
  --error: #dc2626;
  --warning: #d97706;
  --border: #d4d4d8;
  --code-bg: #f4f4f5;
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 15px; line-height: 1.7;
  -webkit-font-smoothing: antialiased;
}
.container { max-width: 48rem; margin: 0 auto; padding: 1.5rem 1rem; }

/* Brand bar */
.brand-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.5rem 0; margin-bottom: 1.5rem;
  border-bottom: 1px solid var(--border);
}
.brand-link {
  display: flex; align-items: center; gap: 0.5rem;
  text-decoration: none; color: var(--text-muted); transition: color 0.15s;
}
.brand-link:hover { color: var(--primary); }
.brand-text { font-size: 0.8125rem; }
.brand-text strong { color: var(--text); font-weight: 600; }
.brand-link:hover .brand-text strong { color: var(--primary); }
.nimbalyst-icon { width: 24px; height: 24px; flex-shrink: 0; }
.brand-actions { display: flex; align-items: center; gap: 0.375rem; }
.theme-toggle, .download-btn {
  background: var(--bg-secondary); border: 1px solid var(--border);
  border-radius: 0.375rem; padding: 0.25rem 0.5rem; font-size: 0.875rem;
  color: var(--text-muted); cursor: pointer; transition: background 0.15s, color 0.15s;
}
.theme-toggle:hover, .download-btn:hover { background: var(--bg-hover); color: var(--text); }
.download-btn { display: flex; align-items: center; gap: 0.25rem; font-family: inherit; font-size: 0.75rem; font-weight: 500; }
.download-btn svg { flex-shrink: 0; }
.dark .theme-icon-light { display: none; }
.light .theme-icon-dark { display: none; }

/* Document content */
.document { font-size: 0.9375rem; line-height: 1.7; }
.document h1, .document h2, .document h3,
.document h4, .document h5, .document h6 {
  margin: 1.5rem 0 0.75rem 0; font-weight: 600; color: var(--text);
}
.document h1 { font-size: 1.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
.document h2 { font-size: 1.25rem; }
.document h3 { font-size: 1.0625rem; }
.document p { margin: 0.5rem 0; }
.document ul, .document ol { margin: 0.5rem 0; padding-left: 1.5rem; }
.document li { margin: 0.25rem 0; }
.document blockquote {
  margin: 0.75rem 0; padding: 0.5rem 1rem;
  border-left: 3px solid var(--primary); color: var(--text-muted);
  background: var(--bg-secondary); border-radius: 0 0.375rem 0.375rem 0;
}
.document a { color: var(--primary); text-decoration: underline; }
.document table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; font-size: 0.875rem; }
.document th, .document td { border: 1px solid var(--border); padding: 0.5rem 0.75rem; text-align: left; }
.document th { background: var(--bg-tertiary); font-weight: 600; }
.document img { max-width: 100%; border-radius: 0.375rem; }
.document hr { border: none; border-top: 1px solid var(--border); margin: 1.5rem 0; }
.inline-code {
  background: var(--bg-tertiary); padding: 0.125rem 0.375rem; border-radius: 0.25rem;
  font-size: 0.8125rem; font-family: 'SF Mono', 'Fira Code', Menlo, Consolas, monospace;
}
pre.hljs {
  background: var(--code-bg); border: 1px solid var(--border); border-radius: 0.5rem;
  padding: 0.75rem 1rem; overflow-x: auto; font-size: 0.8125rem; line-height: 1.5;
  margin: 0.75rem 0; font-family: 'SF Mono', 'Fira Code', Menlo, Consolas, monospace;
}
pre.hljs code { background: transparent; padding: 0; border-radius: 0; font-size: inherit; }

/* Highlight.js token styling */
pre.hljs .hljs-comment, pre.hljs .hljs-quote { color: var(--text-faint); font-style: italic; }
pre.hljs .hljs-keyword, pre.hljs .hljs-selector-tag, pre.hljs .hljs-built_in, pre.hljs .hljs-type { color: var(--primary); font-weight: 500; }
pre.hljs .hljs-string, pre.hljs .hljs-title, pre.hljs .hljs-section, pre.hljs .hljs-attribute { color: var(--success); }
pre.hljs .hljs-number, pre.hljs .hljs-literal, pre.hljs .hljs-variable, pre.hljs .hljs-template-variable { color: var(--warning); }
pre.hljs .hljs-regexp, pre.hljs .hljs-link { color: var(--error); }
pre.hljs .hljs-meta { color: var(--text-muted); }

/* Footer */
.footer {
  margin-top: 2rem; padding-top: 1rem;
  border-top: 1px solid var(--border);
}

@media (max-width: 640px) {
  .container { padding: 1rem 0.5rem; }
  pre.hljs { font-size: 0.75rem; padding: 0.5rem; }
}
</style>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a markdown file to a self-contained HTML string.
 *
 * @param filePath - Absolute path to the file (used for display name only)
 * @param content - Raw file content (markdown)
 */
export function exportFileToHtml(filePath: string, content: string): string {
  const fileName = path.basename(filePath);
  const fileDir = path.dirname(filePath);
  const { body } = stripFrontmatter(content);
  const rawHtml = fileMarked.parse(body) as string;
  const contentHtml = inlineLocalImages(rawHtml, fileDir);
  const rawMarkdownB64 = Buffer.from(content).toString('base64');
  return buildFileHtml(fileName, contentHtml, rawMarkdownB64);
}
