/**
 * Flow Documentation Exporter
 *
 * Exports a .mockupproject's canvas layout and connections as
 * Markdown documentation with an optional Mermaid flowchart.
 */

import type { MockupProjectFile } from '../types/project';

/**
 * Export the project as a Markdown document with a Mermaid flowchart.
 */
export function exportFlowAsMarkdown(project: MockupProjectFile): string {
  const lines: string[] = [];

  lines.push(`# ${project.name}`);
  if (project.description) {
    lines.push('');
    lines.push(project.description);
  }

  // Screen inventory
  lines.push('');
  lines.push('## Screens');
  lines.push('');
  for (const mockup of project.mockups) {
    lines.push(`- **${mockup.label}** (\`${mockup.path}\`)`);
  }

  // Navigation flows
  if (project.connections.length > 0) {
    lines.push('');
    lines.push('## Navigation Flows');
    lines.push('');
    for (const conn of project.connections) {
      const from = project.mockups.find((m) => m.id === conn.fromMockupId);
      const to = project.mockups.find((m) => m.id === conn.toMockupId);
      const fromLabel = from?.label || conn.fromMockupId;
      const toLabel = to?.label || conn.toMockupId;
      const trigger = conn.label || conn.trigger || 'navigate';
      lines.push(`- ${fromLabel} --[${trigger}]--> ${toLabel}`);
    }
  }

  // Mermaid flowchart
  if (project.connections.length > 0) {
    lines.push('');
    lines.push('## Flowchart');
    lines.push('');
    lines.push('```mermaid');
    lines.push('graph LR');

    // Declare nodes
    for (const mockup of project.mockups) {
      const safeId = sanitizeMermaidId(mockup.id);
      lines.push(`  ${safeId}["${mockup.label}"]`);
    }

    // Declare edges
    for (const conn of project.connections) {
      const fromId = sanitizeMermaidId(conn.fromMockupId);
      const toId = sanitizeMermaidId(conn.toMockupId);
      const label = conn.label || conn.trigger || '';
      if (label) {
        lines.push(`  ${fromId} -->|${label}| ${toId}`);
      } else {
        lines.push(`  ${fromId} --> ${toId}`);
      }
    }

    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Sanitize a string for use as a Mermaid node ID.
 */
function sanitizeMermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}
