import type { LexicalEditor } from 'lexical';
import type { ComponentType } from 'react';

export interface TabContext {
  filePath: string;
  fileName: string;
  editor?: LexicalEditor;
}

export interface FixedTabHeaderProps {
  filePath: string;
  fileName: string;
  editor?: LexicalEditor;
}

export interface FixedTabHeaderProvider {
  id: string;
  priority: number;
  shouldRender: (context: TabContext) => boolean;
  component: ComponentType<FixedTabHeaderProps>;
}
