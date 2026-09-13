import { $createTextNode, type ElementNode, type SerializedLexicalNode, type SerializedTextNode } from 'lexical';
import type { DiffSegment } from './diffUtils';
import { $setDiffState } from './DiffState';

export function textFormatMap(children: SerializedLexicalNode[]): number[] {
  return children.flatMap(child => {
    const text = child as SerializedTextNode;
    return new Array(text.text.length).fill(text.format || 0);
  });
}

/** Keep both versions of formatting even where a word diff considers text equal. */
export function $applyFormattedTextDiff(
  container: ElementNode,
  segments: DiffSegment[],
  sourceFormats: number[],
  targetFormats: number[],
): void {
  let sourcePos = 0;
  let targetPos = 0;
  const append = (text: string, format: number, state?: 'added' | 'removed') => {
    const node = $createTextNode(text);
    node.setFormat(format);
    if (state) $setDiffState(node, state);
    container.append(node);
  };
  for (const segment of segments) {
    let start = 0;
    while (start < segment.text.length) {
      const sourceFormat = sourceFormats[sourcePos] ?? 0;
      const targetFormat = targetFormats[targetPos] ?? 0;
      let end = start + 1;
      while (end < segment.text.length
        && (segment.type === 'insert' || sourceFormats[sourcePos + end - start] === sourceFormat)
        && (segment.type === 'delete' || targetFormats[targetPos + end - start] === targetFormat)) end++;
      const text = segment.text.slice(start, end);
      if (segment.type === 'delete') append(text, sourceFormat, 'removed');
      else if (segment.type === 'insert') append(text, targetFormat, 'added');
      else if (sourceFormat === targetFormat) append(text, sourceFormat);
      else {
        append(text, sourceFormat, 'removed');
        append(text, targetFormat, 'added');
      }
      if (segment.type !== 'insert') sourcePos += text.length;
      if (segment.type !== 'delete') targetPos += text.length;
      start = end;
    }
  }
}
