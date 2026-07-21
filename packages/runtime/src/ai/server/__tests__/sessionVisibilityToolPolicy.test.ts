import { describe, expect, it } from 'vitest';

import { HOST_TOOLS, MCP_HOST } from '../services/mcpTopology';
import { BaseAgentProvider } from '../providers/BaseAgentProvider';
import { INTERNAL_MCP_TOOLS } from '../providers/claudeCode/toolPolicy';

const shortNames = ['session_set_pinned', 'session_set_workstream', 'session_rename'];
const qualifiedNames = shortNames.map((name) => `mcp__${MCP_HOST}__${name}`);

describe('session visibility tool topology and policy', () => {
  it('places visibility controls on the deferred host', () => {
    for (const name of shortNames) expect(HOST_TOOLS).toContain(name);
  });

  it('auto-allows the internal Claude tool policy to avoid permission deadlock', () => {
    for (const name of qualifiedNames) expect(INTERNAL_MCP_TOOLS).toContain(name);
  });

  it('allows watcher/meta-agent housekeeping profiles to call the controls', () => {
    for (const name of qualifiedNames) {
      expect(BaseAgentProvider.META_AGENT_ALLOWED_TOOLS).toContain(name);
    }
  });
});
