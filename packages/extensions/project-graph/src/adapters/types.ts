import type { PanelHost } from '@nimbalyst/extension-sdk';
import type { ProjectGraphEdge, ProjectGraphNode } from '../types';

export interface AdapterResult {
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  /** Diagnostic message surfaced in status bar / dev console. */
  status: 'ok' | 'unavailable' | 'error';
  message?: string;
}

export interface Adapter {
  id: string;
  /** Human label used in status bar diagnostics. */
  label: string;
  run(host: PanelHost): Promise<AdapterResult>;
}

export const EMPTY_RESULT: AdapterResult = { nodes: [], edges: [], status: 'ok' };
