import { describe, it, expect } from 'vitest';
import {
  FIRST_PARTY_TOOL_TO_SERVER,
  MCP_EAGER_CONFIG_KEYS,
  MCP_CORE,
  MCP_TRACKERS,
  MCP_SITUATIONAL,
  CORE_ALWAYS_LOAD_TOOLS,
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
import { getCollabIndexToolSchemas } from '../tools/collabIndexToolHandlers';

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
      ...getCollabIndexToolSchemas(),
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

    // Per-tool eagerness: only CORE_ALWAYS_LOAD_TOOLS are charged eagerly.
    // Lower-frequency core schemas stay registered but defer through ToolSearch.
    const report = buildToolBudgetReport(byServer, MCP_EAGER_CONFIG_KEYS, CORE_ALWAYS_LOAD_TOOLS);

    // Visible in test output for before/after comparison across phases.
    // eslint-disable-next-line no-console
    console.log(
      `\n[MCP budget] current first-party surface by target server:\n${formatToolBudgetReport(report)}` +
        (unmapped.length ? `\n  unmapped (not in topology): ${unmapped.join(', ')}` : ''),
    );

    expect(report.totalToolCount).toBeGreaterThan(0);
    // The always-load core subset is the fixed tool floor every session pays.
    // The ceiling leaves headroom for description churn while catching a large
    // schema creeping back into the eager set.
    expect(report.eagerEstTokens).toBeGreaterThan(0);
    expect(report.eagerEstTokens).toBeLessThan(3200);
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

  // Reverse of the mapping test above: guards against topology declaring a tool
  // that no `ListTools` schema actually provides (phantom entries). This is the
  // check that was missing when `developer_git_log` (core) and
  // `applyDiff`/`streamContent` (host) were declared in topology but absent from
  // any schema.
  //
  // Scope: core, trackers, and situational — the servers fully covered by the
  // leaf schema modules importable in a node test env. The host schema modules
  // pull in the electron service graph (monaco, etc.) and can't be imported
  // here; `update_session_meta` (session-naming) is likewise excluded and is
  // covered by the routing tests.
  it('every first-party core/trackers/situational topology tool has a real schema', () => {
    const builtInNames = new Set(collectCurrentFirstPartySchemas().map((t) => t.name));
    const guardedServers = new Set([MCP_CORE, MCP_TRACKERS, MCP_SITUATIONAL]);
    // These tools live on guarded servers but their schemas are defined in host
    // modules (settingsServer / sessionNamingServer) that can't be imported in
    // this node test env. Their schema-backing is covered by the routing tests.
    //   - update_session_meta       → sessionNamingServer (core)
    //   - tracker_set_sync_policy    → settingsServer (trackers, moved in Phase 5)
    //   - tracker_set_issue_key_prefix → settingsServer (trackers, moved in Phase 5)
    const excluded = new Set([
      'update_session_meta',
      'tracker_set_sync_policy',
      'tracker_set_issue_key_prefix',
    ]);

    const phantom = [...FIRST_PARTY_TOOL_TO_SERVER.entries()]
      .filter(([tool, server]) => guardedServers.has(server) && !excluded.has(tool))
      .map(([tool]) => tool)
      .filter((tool) => !builtInNames.has(tool));

    expect(phantom).toEqual([]);
  });
});
