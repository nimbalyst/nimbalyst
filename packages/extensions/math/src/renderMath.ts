import katex from 'katex';

import { buildKatexOptions } from './katexOptions';

export function renderMathMarkup(source: string, displayMode: boolean): string {
  try {
    return katex.renderToString(source, buildKatexOptions(displayMode));
  } catch (error) {
    console.warn('[MathExtension] Failed to render LaTeX source', error);
    return displayMode
      ? `<pre class="nim-math-render-fallback">${escapeHtml(source)}</pre>`
      : `<code class="nim-math-render-fallback">${escapeHtml(source)}</code>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
