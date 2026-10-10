/**
 * The chart's block-menu items: change the type (the current type, and pie
 * for several series, are not offered), edit the title or the source (run by
 * `ChartBlock`), and reset a dragged size. Type and size rewrite only their
 * own lines of the fence body.
 *
 * This module loads eagerly in the web console, so visibility reads the
 * body's top-level lines directly; the YAML-based rewrite loads on click.
 */

import type { LexicalEditor, LexicalNode } from 'lexical';

import type { ChartType } from '../../../ui/chart/chartSpec';
import { draggableBlockMenuRegistry } from '../DraggableBlockPlugin/DraggableBlockMenuRegistry';
import { registerBlockActionMenuItem } from '../DraggableBlockPlugin/blockActions';
import { $isChartNode, ChartNode } from './ChartNodeCore';

const TYPE_LABELS: Record<ChartType, { label: string; icon: string }> = {
  bar: { label: 'Bar', icon: 'bar_chart' },
  line: { label: 'Line', icon: 'show_chart' },
  area: { label: 'Area', icon: 'area_chart' },
  pie: { label: 'Pie', icon: 'pie_chart' },
  scatter: { label: 'Scatter', icon: 'scatter_plot' },
};

const CHART_TYPES: readonly ChartType[] = ['bar', 'line', 'area', 'pie', 'scatter'];

interface TopLevel {
  keys: Map<string, string>;
  /** Number of `y` series: a `[a, b]` list or `- item` lines under `y:`. */
  ySeries: number;
}

/** The body's unindented `key: value` lines, read without a YAML parser. */
export function readChartTopLevel(source: string): TopLevel {
  const keys = new Map<string, string>();
  let ySeries = 0;
  let inY = false;
  for (const line of source.split('\n')) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match) {
      keys.set(match[1], match[2].trim());
      inY = match[1] === 'y' && match[2].trim() === '';
      if (match[1] === 'y') {
        const value = match[2].trim();
        ySeries = value.startsWith('[') ? value.slice(1, -1).split(',').filter((part) => part.trim()).length : value ? 1 : 0;
      }
    } else if (inY && /^\s*-\s+\S/.test(line)) {
      ySeries += 1;
    }
  }
  return { keys, ySeries };
}

function fence(node: LexicalNode): TopLevel | null {
  return $isChartNode(node) ? readChartTopLevel(node.getSource()) : null;
}

/** Whether "Change to <type>" applies: a small-spec chart of another type, and pie only for one series. */
export function canChangeChartType(definition: TopLevel | null, type: ChartType): boolean {
  if (!definition || definition.keys.has('vega-lite') || definition.keys.get('type') === type) return false;
  return type !== 'pie' || definition.ySeries <= 1;
}

function rewrite(editor: LexicalEditor, node: LexicalNode, values: Record<string, string | number | null>): void {
  void import('../../../core/fenceBody').then(({ setFenceYamlValues }) => editor.update(() => {
    const latest = node.getLatest();
    if ($isChartNode(latest)) latest.setSource(setFenceYamlValues(latest.getSource(), values));
  }));
}

const NODE_TYPES = [ChartNode.getType()];

CHART_TYPES.forEach((type, index) => {
  draggableBlockMenuRegistry.registerMenuItem({
    id: `chart:type:${type}`,
    label: `Change to ${TYPE_LABELS[type].label.toLowerCase()} chart`,
    icon: TYPE_LABELS[type].icon,
    nodeTypes: NODE_TYPES,
    order: index,
    isVisible: (node) => canChangeChartType(fence(node), type),
    command: (editor, node) => rewrite(editor, node, { type }),
  });
});

registerBlockActionMenuItem({ id: 'chart:edit-title', label: 'Edit title', icon: 'title', nodeTypes: NODE_TYPES, order: 10, action: 'edit-title' });
registerBlockActionMenuItem({ id: 'chart:edit-source', label: 'Edit data and settings', icon: 'data_object', nodeTypes: NODE_TYPES, order: 11, action: 'edit-source' });

draggableBlockMenuRegistry.registerMenuItem({
  id: 'chart:reset-size',
  label: 'Reset size',
  icon: 'fit_screen',
  nodeTypes: NODE_TYPES,
  order: 20,
  isVisible: (node) => {
    const definition = fence(node);
    return !!definition && (definition.keys.has('width') || definition.keys.has('height'));
  },
  command: (editor, node) => rewrite(editor, node, { width: null, height: null }),
});
