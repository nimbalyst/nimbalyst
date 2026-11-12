import type { ReactNode } from 'react';

export interface FloatingTextToolbarAction {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  /**
   * Also offered when the editor is read-only. For actions that do not change
   * the document body, such as commenting from a commenter role.
   */
  availableWhenReadOnly?: boolean;
}
