import { defineExtension } from 'lexical';

import { MathBlockNode } from './MathBlockNode';
import { MathInlineNode } from './MathInlineNode';

export const MathLexicalExtension = defineExtension({
  name: '@nimbalyst/extensions/math',
  nodes: [MathInlineNode, MathBlockNode],
});
