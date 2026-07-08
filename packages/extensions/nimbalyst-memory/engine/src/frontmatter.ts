/** Minimal YAML frontmatter parsing for facts files. */
import yaml from 'js-yaml';

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Split a leading `--- ... ---` YAML block from the markdown body. Returns an
 * empty `data` object when there is no frontmatter or it fails to parse.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith('---')) return { data: {}, body: raw };
  const lines = raw.split('\n');
  if (lines[0].trim() !== '---') return { data: {}, body: raw };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      const yamlText = lines.slice(1, i).join('\n');
      const body = lines.slice(i + 1).join('\n');
      try {
        const data = yaml.load(yamlText);
        return {
          data: data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
          body,
        };
      } catch {
        return { data: {}, body };
      }
    }
  }
  return { data: {}, body: raw };
}
