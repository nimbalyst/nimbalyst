import type { ReactNode } from 'react';

export interface FloatingTextToolbarAction {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}
