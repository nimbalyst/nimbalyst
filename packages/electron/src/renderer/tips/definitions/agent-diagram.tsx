/**
 * Tip: Let the agent draw the diagram
 *
 * Targets users who know Excalidraw exists (have opened one) and run heavy
 * tool-use sessions, but have never had the agent drive Excalidraw via its
 * tools. Demonstrates the per-tool usage signal (`hasUsedTool`), which reads
 * the rolled-up `mcp:<server>` key backed by the tool_usage_counters table.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const DiagramIcon = <MaterialSymbol icon="schema" size={16} />;

export const agentDiagramTip: TipDefinition = {
  id: 'tip-agent-diagram',
  name: 'Agent-driven Diagrams',
  version: 1,
  trigger: {
    screen: '*',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_COMPLETED_WITH_TOOLS, 8) &&
      context.hasBeenUsed(FEATURE_USAGE_KEYS.EXCALIDRAW_OPENED) &&
      !context.hasUsedTool('mcp:nimbalyst-excalidraw'),
    delay: 2500,
    priority: 3,
  },
  content: {
    icon: DiagramIcon,
    title: 'Let the agent draw the diagram',
    body: 'You use Excalidraw, but the agent has never drawn one for you. Ask it to sketch an architecture or flow and it will build the diagram directly through its tools.',
    action: {
      label: 'Ask the agent to diagram',
      insertPrompt: 'Create an Excalidraw diagram of ',
    },
  },
};
