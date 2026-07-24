import jsyaml from 'js-yaml';
import type { CalcSheetFrontmatter, ParsedCalcSheetDocument } from './types';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function normalizeFrontmatter(input: unknown): CalcSheetFrontmatter {
  if (!input || typeof input !== 'object') {
    return {};
  }
  return input as CalcSheetFrontmatter;
}

export function splitCalcSheetDocument(content: string): ParsedCalcSheetDocument {
  const totalLineCount = content.split(/\r?\n/).length;
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return {
      frontmatter: {},
      frontmatterBlock: '',
      body: content,
      lines: [],
      bodyStartLine: 0,
      totalLineCount,
      frontmatterError: null,
    };
  }

  const bodyStartLine = match[0].split(/\r?\n/).length - 1;

  try {
    const parsed = normalizeFrontmatter(jsyaml.load(match[1]));
    return {
      frontmatter: parsed,
      frontmatterBlock: match[0],
      body: content.slice(match[0].length),
      lines: [],
      bodyStartLine,
      totalLineCount,
      frontmatterError: null,
    };
  } catch (error) {
    return {
      frontmatter: {},
      frontmatterBlock: match[0],
      body: content.slice(match[0].length),
      lines: [],
      bodyStartLine,
      totalLineCount,
      frontmatterError: error instanceof Error ? error.message : 'Invalid frontmatter',
    };
  }
}
