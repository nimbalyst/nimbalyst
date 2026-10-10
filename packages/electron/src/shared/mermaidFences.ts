/**
 * The source of each ```mermaid fence in a markdown file, trimmed. Shared
 * links render markdown to HTML in the main process, which has no DOM for
 * mermaid, so the renderer draws these first and the exporter looks each
 * fence up by the same trimmed source.
 */
const MERMAID_FENCE_RE = /^(`{3,}|~{3,})[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*$/gm;

export function mermaidFenceSources(markdown: string): string[] {
  const sources = new Set<string>();
  for (const match of markdown.matchAll(MERMAID_FENCE_RE)) {
    const source = match[2].trim();
    if (source) sources.add(source);
  }
  return [...sources];
}
