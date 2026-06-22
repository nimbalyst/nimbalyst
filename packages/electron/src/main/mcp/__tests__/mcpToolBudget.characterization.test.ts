import { describe, it, expect } from 'vitest';
import {
  FIRST_PARTY_TOOL_TO_SERVER,
  MCP_EAGER_CONFIG_KEYS,
  MCP_CORE,
  buildToolBudgetReport,
  formatToolBudgetReport,
  type MeasurableToolSchema,
} from '@nimbalyst/runtime/ai/server';

import { getInteractiveToolSchemas } from '../tools/interactiveToolHandlers';
import { displayToolSchemas } from '../tools/displayToolHandler';
import { getEditorToolSchemas } from '../tools/editorToolHandlers';
import { trackerToolSchemas } from '../tools/trackerToolHandlers';
import { feedbackToolSchemas } from '../tools/feedbackToolHandlers';
import { voiceToolSchemas } from '../tools/voiceToolHandlers';

/**
 * Phase 0 characterization harness for the MCP server consolidation.
 *
 * Measures the CURRENT first-party `ListTools` footprint and groups it by the
 * TARGET server topology (mcpTopology). This is the before/after instrument the
 * later phases use to confirm the eager (core-only) surface lands ≤ ~8K tokens.
 *
 * It is a characterization test: it prints the budget table and guards a
 * generous regression ceiling on the eager core, rather than pinning exact
 * numbers (descriptions still churn).
 */
describe('MCP tool budget characterization (current first-party surface)', () => {
  function collectCurrentFirstPartySchemas(): MeasurableToolSchema[] {
    return [
      ...getInteractiveToolSchemas('characterization-session'),
      ...displayToolSchemas,
      ...getEditorToolSchemas('characterization-session'),
      ...trackerToolSchemas,
      ...feedbackToolSchemas,
      ...voiceToolSchemas,
    ];
  }

  it('reports the per-target-server token budget for the current surface', () => {
    const all = collectCurrentFirstPartySchemas();

    // Group current tools by their TARGET server (mcpTopology reverse index).
    const byServer: Record<string, MeasurableToolSchema[]> = {};
    const unmapped: string[] = [];
    for (const tool of all) {
      const server = FIRST_PARTY_TOOL_TO_SERVER.get(tool.name);
      if (!server) {
        unmapped.push(tool.name);
        continue;
      }
      (byServer[server] ??= []).push(tool);
    }

    const report = buildToolBudgetReport(byServer, MCP_EAGER_CONFIG_KEYS);

    // Visible in test output for before/after comparison across phases.
    // eslint-disable-next-line no-console
    console.log(
      `\n[MCP budget] current first-party surface by target server:\n${formatToolBudgetReport(report)}` +
        (unmapped.length ? `\n  unmapped (not in topology): ${unmapped.join(', ')}` : ''),
    );

    expect(report.totalToolCount).toBeGreaterThan(0);
    // The eager surface should be a clear minority of the total once trackers,
    // host config, and extensions defer. Generous ceiling guards regressions.
    expect(report.eagerEstTokens).toBeGreaterThan(0);
    expect(report.eagerEstTokens).toBeLessThan(12000);
  });

  it('maps every current first-party tool to a topology server (except known IPC-only names)', () => {
    const all = collectCurrentFirstPartySchemas();
    // open_workspace is intentionally retired in favor of workspace_open; it is
    // still listed by the current editor schemas, so allow it during migration.
    const allowedUnmapped = new Set(['open_workspace']);

    const unmapped = all
      .map((t) => t.name)
      .filter((name) => !FIRST_PARTY_TOOL_TO_SERVER.has(name) && !allowedUnmapped.has(name));

    expect(unmapped).toEqual([]);
  });

  it('confirms core is the only eager server', () => {
    expect(MCP_EAGER_CONFIG_KEYS).toEqual([MCP_CORE]);
  });
});
