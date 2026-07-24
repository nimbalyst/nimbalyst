/**
 * Exports an AI session as a self-contained HTML file.
 *
 * The generated HTML includes:
 * - Inlined CSS (dark + light theme via CSS variables)
 * - Pre-rendered markdown (via `marked`)
 * - Syntax-highlighted code blocks (via `highlight.js`)
 * - Collapsible tool call cards (native <details>)
 * - Nested sub-agent / teammate tool hierarchies
 * - Privacy banner and path stripping
 */
import { marked, type MarkedOptions, type Tokens } from 'marked';
import hljs from 'highlight.js';
import type { TranscriptViewMessage, SessionData } from '@nimbalyst/runtime/ai/server/types';

// ---------------------------------------------------------------------------
// Markdown setup – configure once
// ---------------------------------------------------------------------------

/** Highlight code fences via highlight.js, returning pre-rendered HTML. */
const markedOptions: MarkedOptions = {
  gfm: true,
  breaks: false,
};

const renderer = new marked.Renderer();

renderer.code = function (this: unknown, token: Tokens.Code) {
  const { text, lang } = token;
  // Skip syntax highlighting for very large code blocks to avoid freezing
  const MAX_HIGHLIGHT_LENGTH = 50_000;
  if (text.length > MAX_HIGHLIGHT_LENGTH) {
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    return `<pre class="hljs"><code${langAttr}>${escapeHtml(text)}</code></pre>`;
  }
  if (lang && hljs.getLanguage(lang)) {
    const highlighted = hljs.highlight(text, { language: lang }).value;
    return `<pre class="hljs"><code class="language-${escapeHtml(lang)}">${highlighted}</code></pre>`;
  }
  // Auto-detect when no language is specified -- skip for moderately large blocks
  // since highlightAuto tries every grammar and is O(n * grammars)
  if (text.length > 10_000) {
    return `<pre class="hljs"><code>${escapeHtml(text)}</code></pre>`;
  }
  const auto = hljs.highlightAuto(text);
  return `<pre class="hljs"><code>${auto.value}</code></pre>`;
};

renderer.codespan = function (this: unknown, token: Tokens.Codespan) {
  return `<code class="inline-code">${escapeHtml(token.text)}</code>`;
};

marked.use({ renderer, ...markedOptions } as any);

// ---------------------------------------------------------------------------
// Tool name formatting (mirrors runtime/ui/AgentTranscript/utils/toolNameFormatter.ts)
// ---------------------------------------------------------------------------

function formatToolDisplayName(toolName?: string): string {
  if (!toolName) return '';
  const trimmed = toolName.trim();
  if (!trimmed) return '';
  const parts = trimmed.split('__').filter((p) => p.length > 0);
  if (parts.length < 3 || parts[0].toLowerCase() !== 'mcp') return trimmed;
  const serverSegment = parts[1];
  const toolSegment = parts.slice(2).join('__');
  if (!serverSegment || !toolSegment) return trimmed;
  const prettify = (s: string) =>
    s
      .split(/[-_]/)
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  const formattedServer = prettify(serverSegment);
  const formattedTool = prettify(toolSegment);
  if (!formattedServer && !formattedTool) return trimmed;
  if (!formattedServer) return formattedTool;
  if (!formattedTool) return `${formattedServer} MCP`;
  return `${formattedTool} \u2013 ${formattedServer}`;
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

function stripAbsolutePaths(content: string, workspacePath: string): string {
  if (!workspacePath) return content;
  const normalized = workspacePath.replace(/\\/g, '/');
  // Strip with trailing slash first, then without
  return content.split(normalized + '/').join('').split(normalized).join('');
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatShortTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Compact Nimbalyst icon SVG for inline use in exports.
 * A simplified version of the app icon (# on a blue splash shape).
 */
function getNimbalystIconSvg(): string {
  return `<svg class="nimbalyst-icon" width="24" height="24" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="m196.4 23.3c-.5 8.3-12.4 6.9-14.8 14.9-1.8 6.1 9.8 9.9 6 15-4.9 6.7-14.2-.9-20.5 4.6-4.8 4.2 2.9 13.6-3.1 15.9-7.8 2.9-11.5-8.4-19.7-7.2-6.3.9-4.9 13-11.2 11.7-8.1-1.7-5.1-13.3-12.7-16.7-5.8-2.7-11.2 8.3-15.7 3.8C99 59.3 107.7 51.2 103.2 44.3 99.8 38.9 89.3 45.2 87.9 39 86.1 30.8 97.9 28.8 97.9 20.5 97.9 14.1 85.7 13.8 87.9 7.8 90.8 0 101.8 4.6 106.3-2.4c3.5-5.4-6.6-12.2-1.5-16.1 6.6-5 13.4 4.9 20.9 1.4 5.8-2.7 1-13.9 7.4-14.4 8.3-.6 8.6 11.3 16.9 12.5 6.3.9 8.4-11.1 14-8.1 7.3 3.9 1.1 14.2 7.4 19.6 4.8 4.2 13.1-4.8 16.2.8 4 7.3-6.7 12.6-4.4 20.5 1.8 6.1 13.6 3 13.2 9.4z" fill="#6395ff" transform="matrix(7.6 0 0 7.6-560 327)"/><text x="306" y="669" font-family="system-ui,sans-serif" font-size="528" font-weight="bold" fill="#fff">#</text></svg>`;
}

function renderMarkdown(raw: string, workspacePath: string): string {
  // Truncate before processing to avoid freezing on huge messages
  const capped = raw.length > 200_000 ? raw.slice(0, 200_000) + '\n\n*... (content truncated for export)*' : raw;
  const stripped = stripAbsolutePaths(capped, workspacePath);
  return marked.parse(stripped) as string;
}

// ---------------------------------------------------------------------------
// Tool result rendering
// ---------------------------------------------------------------------------

function toolStatus(message: TranscriptViewMessage): { didFail: boolean; label: string } {
  const raw = message.toolCall?.result;
  let resultObj: Record<string, unknown> | null = null;
  if (typeof raw === 'string') {
    try { resultObj = JSON.parse(raw) as Record<string, unknown>; } catch { /* not JSON */ }
  }
  const explicitSuccess =
    resultObj && 'success' in resultObj ? resultObj.success !== false : undefined;
  const derivedError =
    (message.isError && message.text) ||
    (resultObj && typeof resultObj.error === 'string' ? (resultObj.error as string) : undefined);
  const didFail = !!message.isError || !!message.toolCall?.isError || explicitSuccess === false || !!derivedError;
  return { didFail, label: didFail ? 'Failed' : 'Succeeded' };
}

function truncateForExport(text: string, maxLength: number = 100_000): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  return `${truncated}\n\n... (truncated ${(text.length - maxLength).toLocaleString()} characters)`;
}

function renderToolResult(result: unknown, workspacePath: string): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') {
    const stripped = truncateForExport(stripAbsolutePaths(result, workspacePath));
    return `<pre class="tool-result-pre">${escapeHtml(stripped)}</pre>`;
  }
  try {
    const json = JSON.stringify(result, null, 2);
    const stripped = truncateForExport(stripAbsolutePaths(json, workspacePath));
    return `<pre class="tool-result-pre">${escapeHtml(stripped)}</pre>`;
  } catch {
    return `<pre class="tool-result-pre">${escapeHtml(truncateForExport(String(result)))}</pre>`;
  }
}

function renderToolArguments(args: unknown, workspacePath: string): string {
  if (!args) return '';
  try {
    const json = JSON.stringify(args, null, 2);
    const stripped = truncateForExport(stripAbsolutePaths(json, workspacePath));
    return `<pre class="tool-args-pre">${escapeHtml(stripped)}</pre>`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

function renderDiffLines(content: string, workspacePath: string): string {
  const stripped = stripAbsolutePaths(truncateForExport(content), workspacePath);
  const lines = stripped.split('\n');
  const htmlLines = lines.map((line) => {
    const escaped = escapeHtml(line);
    if (line.startsWith('+')) {
      return `<div class="diff-line diff-added"><span class="diff-marker">+</span>${escaped.slice(1)}</div>`;
    }
    if (line.startsWith('-')) {
      return `<div class="diff-line diff-removed"><span class="diff-marker">-</span>${escaped.slice(1)}</div>`;
    }
    if (line.startsWith('@@')) {
      return `<div class="diff-line diff-info">${escaped}</div>`;
    }
    return `<div class="diff-line">${escaped}</div>`;
  });
  return htmlLines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool card rendering (recursive for sub-agents)
// ---------------------------------------------------------------------------

function renderToolCard(message: TranscriptViewMessage, workspacePath: string, depth: number = 0): string {
  const tc = message.toolCall;
  const sub = message.subagent;
  if (!tc && !sub) return '';

  const MAX_DEPTH = 5;
  if (depth > MAX_DEPTH) return '<div class="tool-card"><em>(nested tools omitted)</em></div>';

  const isSubagent = message.type === 'subagent';
  const displayName = tc
    ? (formatToolDisplayName(tc.toolName) || tc.toolName)
    : (sub?.teammateName || sub?.agentType || 'Sub-agent');
  const { didFail, label } = toolStatus(message);
  const statusClass = didFail ? 'status-error' : 'status-success';

  let cardClass = 'tool-card';
  let extraLabel = '';
  if (isSubagent) {
    cardClass += ' sub-agent';
    if (sub?.agentType) extraLabel = `<span class="tool-agent-type">${escapeHtml(sub.agentType)}</span>`;
  }
  if (sub?.teammateName) {
    cardClass += ' teammate';
    extraLabel = `<span class="tool-teammate-name">${escapeHtml(sub.teammateName)}</span>`;
  }

  const indentStyle = depth > 0 ? ` style="margin-left: ${depth * 1}rem;"` : '';

  const argsHtml =
    tc?.arguments && Object.keys(tc.arguments).length > 0
      ? `<div class="tool-section"><div class="tool-section-label">Parameters</div>${renderToolArguments(tc.arguments, workspacePath)}</div>`
      : '';

  const resultHtml =
    tc?.result !== undefined && tc?.result !== null
      ? `<div class="tool-section"><div class="tool-section-label">Result</div>${renderToolResult(tc.result, workspacePath)}</div>`
      : '';

  const errorText = (message.isError || message.toolCall?.isError) ? message.text : undefined;
  const errorHtml = errorText
    ? `<div class="tool-error">${escapeHtml(stripAbsolutePaths(errorText, workspacePath))}</div>`
    : '';

  let childHtml = '';
  if (sub?.childEvents && sub.childEvents.length > 0) {
    const childCards = sub.childEvents
      .filter((child: TranscriptViewMessage) => child.toolCall || child.subagent)
      .map((child: TranscriptViewMessage) => renderToolCard(child, workspacePath, depth + 1))
      .join('\n');
    if (childCards) {
      childHtml = `<div class="tool-children">${childCards}</div>`;
    }
  }

  let contentHtml = '';
  if (message.text && depth > 0) {
    contentHtml = `<div class="tool-content">${renderMarkdown(message.text, workspacePath)}</div>`;
  }

  return `
    <details class="${cardClass}"${indentStyle}>
      <summary class="tool-header">
        <span class="tool-icon">&#9881;</span>
        <span class="tool-name">${escapeHtml(displayName)}</span>
        ${extraLabel}
        <span class="tool-status ${statusClass}">${label}</span>
        <span class="tool-chevron"></span>
      </summary>
      <div class="tool-body">
        ${argsHtml}
        ${resultHtml}
        ${errorHtml}
        ${contentHtml}
        ${childHtml}
      </div>
    </details>`;
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function renderMessage(msg: TranscriptViewMessage, workspacePath: string): string {
  if (msg.type === 'system_message' && !msg.text?.trim()) return '';
  if (msg.type === 'tool_call' || msg.type === 'interactive_prompt' || msg.type === 'subagent') return '';
  if (msg.type === 'turn_ended') return '';

  const isUser = msg.type === 'user_message';
  const roleClass = isUser ? 'user' : 'assistant';
  const avatarLabel = isUser ? 'U' : 'A';
  const timeStr = msg.createdAt ? formatShortTime(msg.createdAt.getTime()) : '';

  let contentHtml = '';
  if (msg.text?.trim()) {
    contentHtml = renderMarkdown(msg.text, workspacePath);
  }

  let attachmentsHtml = '';
  if (msg.attachments && msg.attachments.length > 0) {
    const items = msg.attachments
      .map((a) => `<span class="attachment-chip">${escapeHtml(a.filename)}</span>`)
      .join(' ');
    attachmentsHtml = `<div class="message-attachments">${items}</div>`;
  }

  let toolHtml = '';
  if (msg.toolCall || msg.subagent) {
    toolHtml = renderToolCard(msg, workspacePath);
  }

  let editsHtml = '';
  if (msg.toolCall?.changes && msg.toolCall.changes.length > 0) {
    const editCards = msg.toolCall.changes
      .map((change) => {
        const filePath = stripAbsolutePaths(change.path || 'Unknown file', workspacePath);
        const diffContent = change.patch || '';
        if (!diffContent) return '';
        return `
          <details class="edit-card" open>
            <summary class="edit-header">
              <span class="edit-icon">&#9998;</span>
              <span class="edit-file">${escapeHtml(filePath)}</span>
            </summary>
            <div class="diff-content">${renderDiffLines(diffContent, workspacePath)}</div>
          </details>`;
      })
      .join('\n');
    editsHtml = editCards;
  }

  let errorHtml = '';
  if (msg.isError && msg.text) {
    errorHtml = `<div class="message-error">${escapeHtml(stripAbsolutePaths(msg.text, workspacePath))}</div>`;
  }

  const modeBadge = msg.mode ? `<span class="mode-badge">${escapeHtml(msg.mode)}</span>` : '';

  return `
    <div class="message ${roleClass}">
      <div class="message-avatar ${roleClass}">${avatarLabel}</div>
      <div class="message-body">
        <div class="message-meta">
          <span class="message-time">${timeStr}</span>
          ${modeBadge}
        </div>
        ${contentHtml ? `<div class="message-content">${contentHtml}</div>` : ''}
        ${attachmentsHtml}
        ${errorHtml}
        ${toolHtml}
        ${editsHtml}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Full HTML document
// ---------------------------------------------------------------------------

function buildHtmlDocument(session: SessionData, messagesHtml: string): string {
  const title = session.title || 'Untitled Session';
  const provider = session.provider || 'unknown';
  const model = session.model || '';
  const messageCount = session.messages?.length ?? 0;
  const createdStr = session.createdAt ? formatTimestamp(session.createdAt) : '';
  const updatedStr = session.updatedAt ? formatTimestamp(session.updatedAt) : '';
  const exportDate = formatTimestamp(Date.now());

  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} \u2013 Nimbalyst Export</title>
${getStylesheet()}
</head>
<body>
<div class="container">

  <div class="nimbalyst-brand-bar">
    <a href="https://nimbalyst.com" target="_blank" rel="noopener" class="nimbalyst-brand-link">
      ${getNimbalystIconSvg()}
      <span class="nimbalyst-brand-text">Shared from <strong>Nimbalyst</strong></span>
    </a>
  </div>

  <div class="privacy-banner">
    This session export may contain sensitive code, file paths, and credentials. Share with care.
  </div>

  <header class="session-header">
    <h1>${escapeHtml(title)}</h1>
    <div class="session-meta">
      <span class="meta-item"><strong>Provider:</strong> ${escapeHtml(provider)}${model ? ` / ${escapeHtml(model)}` : ''}</span>
      <span class="meta-item"><strong>Messages:</strong> ${messageCount}</span>
      ${createdStr ? `<span class="meta-item"><strong>Started:</strong> ${createdStr}</span>` : ''}
      ${updatedStr ? `<span class="meta-item"><strong>Last activity:</strong> ${updatedStr}</span>` : ''}
    </div>
    <div class="header-actions">
      <button onclick="toggleTheme()" class="theme-toggle" title="Toggle light/dark theme">
        <span class="theme-icon-dark">&#9789;</span>
        <span class="theme-icon-light">&#9788;</span>
        Theme
      </button>
      <button onclick="copyTranscript()" class="copy-btn" title="Copy transcript to clipboard">
        &#128203; Copy
      </button>
    </div>
  </header>

  <main class="transcript">
    ${messagesHtml}
  </main>

  <footer class="export-footer">
    <div class="nimbalyst-brand-bar footer-brand">
      <a href="https://nimbalyst.com" target="_blank" rel="noopener" class="nimbalyst-brand-link">
        ${getNimbalystIconSvg()}
        <span class="nimbalyst-brand-text">Shared from <strong>Nimbalyst</strong></span>
      </a>
      <span class="footer-date">Exported ${exportDate}</span>
    </div>
  </footer>

</div>
${getScript()}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function getStylesheet(): string {
  // Import highlight.js github-dark theme CSS inline
  const hljsCss = getHighlightJsThemeCss();
  return `<style>
/* ================================================================
   CSS Variables – Dark theme (default)
   ================================================================ */
:root.dark {
  --bg: #1a1a1a;
  --bg-secondary: #2d2d2d;
  --bg-tertiary: #3a3a3a;
  --bg-hover: #4a4a4a;
  --text: #e4e4e7;
  --text-muted: #a1a1aa;
  --text-faint: #71717a;
  --text-disabled: #52525b;
  --primary: #60a5fa;
  --success: #4ade80;
  --error: #ef4444;
  --warning: #fbbf24;
  --border: #3f3f46;
  --code-bg: #1e1e1e;
  --diff-added-bg: rgba(74, 222, 128, 0.12);
  --diff-removed-bg: rgba(239, 68, 68, 0.12);
  --diff-added-marker: #4ade80;
  --diff-removed-marker: #ef4444;
  --avatar-user-bg: rgba(74, 222, 128, 0.2);
  --avatar-user-color: #4ade80;
  --avatar-assistant-bg: rgba(96, 165, 250, 0.2);
  --avatar-assistant-color: #60a5fa;
  --sub-agent-bg: rgba(96, 165, 250, 0.05);
  --sub-agent-border: rgba(96, 165, 250, 0.2);
  --teammate-bg: rgba(96, 165, 250, 0.08);
  --teammate-border: rgba(96, 165, 250, 0.3);
}

/* ================================================================
   CSS Variables – Light theme
   ================================================================ */
:root.light {
  --bg: #ffffff;
  --bg-secondary: #f4f4f5;
  --bg-tertiary: #e4e4e7;
  --bg-hover: #d4d4d8;
  --text: #18181b;
  --text-muted: #52525b;
  --text-faint: #71717a;
  --text-disabled: #a1a1aa;
  --primary: #2563eb;
  --success: #16a34a;
  --error: #dc2626;
  --warning: #d97706;
  --border: #d4d4d8;
  --code-bg: #f4f4f5;
  --diff-added-bg: rgba(22, 163, 74, 0.1);
  --diff-removed-bg: rgba(220, 38, 38, 0.1);
  --diff-added-marker: #16a34a;
  --diff-removed-marker: #dc2626;
  --avatar-user-bg: rgba(22, 163, 74, 0.15);
  --avatar-user-color: #16a34a;
  --avatar-assistant-bg: rgba(37, 99, 235, 0.15);
  --avatar-assistant-color: #2563eb;
  --sub-agent-bg: rgba(37, 99, 235, 0.04);
  --sub-agent-border: rgba(37, 99, 235, 0.15);
  --teammate-bg: rgba(37, 99, 235, 0.06);
  --teammate-border: rgba(37, 99, 235, 0.25);
}

/* ================================================================
   Base styles
   ================================================================ */
*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

.container {
  max-width: 56rem;
  margin: 0 auto;
  padding: 1.5rem 1rem;
}

/* ================================================================
   Nimbalyst brand bar
   ================================================================ */
.nimbalyst-brand-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 0;
  margin-bottom: 1rem;
}
.nimbalyst-brand-link {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  text-decoration: none;
  color: var(--text-muted);
  transition: color 0.15s;
}
.nimbalyst-brand-link:hover {
  color: var(--primary);
}
.nimbalyst-brand-text {
  font-size: 0.8125rem;
}
.nimbalyst-brand-text strong {
  color: var(--text);
  font-weight: 600;
}
.nimbalyst-brand-link:hover .nimbalyst-brand-text strong {
  color: var(--primary);
}
.nimbalyst-icon {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}
.footer-brand {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  margin-bottom: 0;
}
.footer-date {
  font-size: 0.75rem;
  color: var(--text-faint);
}

/* ================================================================
   Privacy banner
   ================================================================ */
.privacy-banner {
  background: rgba(251, 191, 36, 0.12);
  border: 1px solid rgba(251, 191, 36, 0.3);
  border-radius: 0.5rem;
  padding: 0.625rem 1rem;
  margin-bottom: 1.5rem;
  font-size: 0.8125rem;
  color: var(--warning);
  text-align: center;
}

/* ================================================================
   Session header
   ================================================================ */
.session-header {
  margin-bottom: 2rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
.session-header h1 {
  margin: 0 0 0.5rem 0;
  font-size: 1.375rem;
  font-weight: 600;
  color: var(--text);
}
.session-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  font-size: 0.8125rem;
  color: var(--text-muted);
}
.meta-item strong {
  color: var(--text-faint);
  font-weight: 500;
}
.header-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
.theme-toggle, .copy-btn {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  padding: 0.375rem 0.75rem;
  font-size: 0.75rem;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.theme-toggle:hover, .copy-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.dark .theme-icon-light { display: none; }
.light .theme-icon-dark { display: none; }
.copy-btn.copied {
  color: var(--success);
  border-color: var(--success);
}

/* ================================================================
   Transcript messages
   ================================================================ */
.transcript {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.message {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem 0;
}
.message + .message {
  border-top: 1px solid var(--border);
}
.message-avatar {
  flex-shrink: 0;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 0.375rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 600;
  margin-top: 0.125rem;
}
.message-avatar.user {
  background: var(--avatar-user-bg);
  color: var(--avatar-user-color);
}
.message-avatar.assistant {
  background: var(--avatar-assistant-bg);
  color: var(--avatar-assistant-color);
}
.message-body {
  flex: 1;
  min-width: 0;
}
.message-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}
.message-time {
  font-size: 0.6875rem;
  color: var(--text-faint);
}
.mode-badge {
  font-size: 0.625rem;
  padding: 0.0625rem 0.375rem;
  border-radius: 0.25rem;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  text-transform: capitalize;
}

/* ================================================================
   Message content (rendered markdown)
   ================================================================ */
.message-content {
  font-size: 0.875rem;
  line-height: 1.65;
  overflow-wrap: break-word;
}
.message-content p { margin: 0.375rem 0; }
.message-content p:first-child { margin-top: 0; }
.message-content p:last-child { margin-bottom: 0; }
.message-content h1, .message-content h2, .message-content h3,
.message-content h4, .message-content h5, .message-content h6 {
  margin: 1rem 0 0.5rem 0;
  font-weight: 600;
  color: var(--text);
}
.message-content h1 { font-size: 1.25rem; }
.message-content h2 { font-size: 1.125rem; }
.message-content h3 { font-size: 1rem; }
.message-content ul, .message-content ol {
  margin: 0.375rem 0;
  padding-left: 1.5rem;
}
.message-content li { margin: 0.125rem 0; }
.message-content blockquote {
  margin: 0.5rem 0;
  padding: 0.25rem 0.75rem;
  border-left: 3px solid var(--border);
  color: var(--text-muted);
}
.message-content a {
  color: var(--primary);
  text-decoration: underline;
}
.message-content table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5rem 0;
  font-size: 0.8125rem;
}
.message-content th, .message-content td {
  border: 1px solid var(--border);
  padding: 0.375rem 0.625rem;
  text-align: left;
}
.message-content th {
  background: var(--bg-tertiary);
  font-weight: 600;
}
.message-content img {
  max-width: 100%;
  border-radius: 0.375rem;
}

/* Inline code */
.inline-code {
  background: var(--bg-tertiary);
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
  font-size: 0.8125rem;
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
}

/* Code blocks */
pre.hljs {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  overflow-x: auto;
  font-size: 0.8125rem;
  line-height: 1.5;
  margin: 0.5rem 0;
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
}
pre.hljs code {
  background: transparent;
  padding: 0;
  border-radius: 0;
  font-size: inherit;
}

/* ================================================================
   Attachments
   ================================================================ */
.message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-top: 0.5rem;
}
.attachment-chip {
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 0.25rem;
  padding: 0.125rem 0.5rem;
  font-size: 0.75rem;
  color: var(--text-muted);
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
}

/* ================================================================
   Error messages
   ================================================================ */
.message-error {
  margin-top: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--diff-removed-bg);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 0.375rem;
  color: var(--error);
  font-size: 0.8125rem;
}

/* ================================================================
   Tool cards
   ================================================================ */
.tool-card {
  margin: 0.5rem 0;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  overflow: hidden;
  background: var(--bg-secondary);
}
.tool-card.sub-agent {
  background: var(--sub-agent-bg);
  border-color: var(--sub-agent-border);
}
.tool-card.teammate {
  background: var(--teammate-bg);
  border-color: var(--teammate-border);
  border-left: 3px solid var(--primary);
}
.tool-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  font-size: 0.8125rem;
  list-style: none;
  user-select: none;
  background: var(--bg-secondary);
  transition: background 0.15s;
}
.tool-card.sub-agent > .tool-header { background: var(--sub-agent-bg); }
.tool-card.teammate > .tool-header { background: var(--teammate-bg); }
.tool-header:hover { background: var(--bg-hover); }
.tool-header::-webkit-details-marker { display: none; }
.tool-icon {
  color: var(--text-faint);
  font-size: 0.875rem;
}
.tool-name {
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
  font-size: 0.75rem;
  color: var(--text);
  font-weight: 500;
}
.tool-agent-type, .tool-teammate-name {
  font-size: 0.6875rem;
  padding: 0.0625rem 0.375rem;
  border-radius: 0.25rem;
  background: var(--avatar-assistant-bg);
  color: var(--primary);
}
.tool-status {
  margin-left: auto;
  font-size: 0.6875rem;
  padding: 0.0625rem 0.375rem;
  border-radius: 0.25rem;
  font-weight: 500;
}
.status-success {
  background: rgba(74, 222, 128, 0.15);
  color: var(--success);
}
.status-error {
  background: rgba(239, 68, 68, 0.15);
  color: var(--error);
}
.tool-chevron::after {
  content: '\\25B6';
  font-size: 0.5rem;
  color: var(--text-faint);
  transition: transform 0.15s;
  display: inline-block;
}
details[open] > .tool-header .tool-chevron::after {
  transform: rotate(90deg);
}
.tool-body {
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--border);
  font-size: 0.8125rem;
}
.tool-section {
  margin-bottom: 0.5rem;
}
.tool-section:last-child {
  margin-bottom: 0;
}
.tool-section-label {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 0.25rem;
}
.tool-result-pre, .tool-args-pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  padding: 0.5rem 0.75rem;
  overflow-x: auto;
  font-size: 0.75rem;
  line-height: 1.45;
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
  color: var(--text-muted);
  margin: 0;
  max-height: 24rem;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.tool-error {
  padding: 0.375rem 0.625rem;
  background: var(--diff-removed-bg);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 0.375rem;
  color: var(--error);
  font-size: 0.8125rem;
  margin-top: 0.25rem;
}
.tool-content {
  margin-top: 0.5rem;
  font-size: 0.8125rem;
}
.tool-children {
  margin-top: 0.5rem;
}

/* ================================================================
   Diff / edit cards
   ================================================================ */
.edit-card {
  margin: 0.5rem 0;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  overflow: hidden;
}
.edit-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  font-size: 0.8125rem;
  background: var(--bg-secondary);
  list-style: none;
  user-select: none;
}
.edit-header::-webkit-details-marker { display: none; }
.edit-icon { color: var(--primary); }
.edit-file {
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
  font-size: 0.75rem;
  color: var(--text);
}
.diff-content {
  font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, Consolas, monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  overflow-x: auto;
}
.diff-line {
  padding: 0 0.75rem;
  white-space: pre-wrap;
  word-break: break-all;
}
.diff-added {
  background: var(--diff-added-bg);
}
.diff-removed {
  background: var(--diff-removed-bg);
}
.diff-info {
  color: var(--text-faint);
  background: var(--bg-secondary);
}
.diff-marker {
  display: inline-block;
  width: 1rem;
  color: var(--text-faint);
  user-select: none;
}
.diff-added .diff-marker { color: var(--diff-added-marker); }
.diff-removed .diff-marker { color: var(--diff-removed-marker); }

/* ================================================================
   Footer
   ================================================================ */
.export-footer {
  margin-top: 2rem;
}

/* ================================================================
   Responsive
   ================================================================ */
@media (max-width: 640px) {
  .container { padding: 1rem 0.5rem; }
  .session-meta { flex-direction: column; gap: 0.25rem; }
  .message { gap: 0.5rem; }
  pre.hljs { font-size: 0.75rem; padding: 0.5rem; }
}

/* ================================================================
   Highlight.js theme overrides (scoped to our variables)
   ================================================================ */
${hljsCss}
</style>`;
}

function getHighlightJsThemeCss(): string {
  // Minimal highlight.js token styling using our CSS variables
  // Works in both dark and light themes because it references variables
  return `
pre.hljs .hljs-comment,
pre.hljs .hljs-quote { color: var(--text-faint); font-style: italic; }
pre.hljs .hljs-keyword,
pre.hljs .hljs-selector-tag,
pre.hljs .hljs-built_in,
pre.hljs .hljs-type { color: var(--primary); font-weight: 500; }
pre.hljs .hljs-string,
pre.hljs .hljs-title,
pre.hljs .hljs-section,
pre.hljs .hljs-attribute,
pre.hljs .hljs-selector-id,
pre.hljs .hljs-selector-class { color: var(--success); }
pre.hljs .hljs-number,
pre.hljs .hljs-literal,
pre.hljs .hljs-variable,
pre.hljs .hljs-template-variable,
pre.hljs .hljs-tag .hljs-attr { color: var(--warning); }
pre.hljs .hljs-regexp,
pre.hljs .hljs-link { color: var(--error); }
pre.hljs .hljs-meta { color: var(--text-muted); }
pre.hljs .hljs-name,
pre.hljs .hljs-selector-pseudo { color: var(--primary); }
pre.hljs .hljs-deletion { background: var(--diff-removed-bg); color: var(--error); }
pre.hljs .hljs-addition { background: var(--diff-added-bg); color: var(--success); }
pre.hljs .hljs-emphasis { font-style: italic; }
pre.hljs .hljs-strong { font-weight: bold; }
`;
}

// ---------------------------------------------------------------------------
// JavaScript (minimal – theme toggle + copy)
// ---------------------------------------------------------------------------

function getScript(): string {
  return `<script>
function toggleTheme() {
  var root = document.documentElement;
  if (root.classList.contains('dark')) {
    root.classList.replace('dark', 'light');
  } else {
    root.classList.replace('light', 'dark');
  }
}

function copyTranscript() {
  var transcript = document.querySelector('.transcript');
  if (!transcript) return;
  var text = transcript.innerText;
  navigator.clipboard.writeText(text).then(function() {
    var btn = document.querySelector('.copy-btn');
    if (btn) {
      btn.classList.add('copied');
      var orig = btn.innerHTML;
      btn.innerHTML = '\\u2713 Copied';
      setTimeout(function() {
        btn.innerHTML = orig;
        btn.classList.remove('copied');
      }, 2000);
    }
  });
}
</script>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Yield to the event loop so the main process stays responsive. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Render a SessionData object to a self-contained HTML string.
 * Async to yield back to the event loop between message batches,
 * preventing the main process from freezing on large sessions.
 */
export async function exportSessionToHtml(session: SessionData): Promise<string> {
  const workspacePath = session.workspacePath || '';

  // Filter out messages we don't want in the export
  const exportMessages = (session.messages || []).filter((msg) => {
    if (msg.type === 'tool_call' || msg.type === 'interactive_prompt' || msg.type === 'subagent') return false;
    if (msg.type === 'turn_ended') return false;
    return true;
  });

  // Process messages in batches, yielding between batches to keep the app responsive
  const BATCH_SIZE = 20;
  const htmlParts: string[] = [];
  for (let i = 0; i < exportMessages.length; i += BATCH_SIZE) {
    const batch = exportMessages.slice(i, i + BATCH_SIZE);
    for (const msg of batch) {
      htmlParts.push(renderMessage(msg, workspacePath));
    }
    // Yield after each batch so the main process can handle UI events
    if (i + BATCH_SIZE < exportMessages.length) {
      await yieldToEventLoop();
    }
  }

  return buildHtmlDocument(session, htmlParts.join('\n'));
}

/**
 * Generate a default filename for the export.
 */
export function getExportFilename(session: SessionData): string {
  const title = (session.title || 'untitled-session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  const date = new Date().toISOString().slice(0, 10);
  return `${title}-${date}.html`;
}
