import { describe, expect, it } from 'vitest';
import { HOST_TOOLS } from '../../services/mcpTopology';
import { BaseAgentProvider } from '../BaseAgentProvider';

describe('meta-agent attention tool parity', () => {
  const names = ['notify_user', 'attention_arm', 'attention_cancel', 'attention_status'];

  it('auto-allows every fully-qualified host attention tool', () => {
    for (const name of names) {
      expect(BaseAgentProvider.META_AGENT_ALLOWED_TOOLS)
        .toContain(`mcp__nimbalyst-host__${name}`);
    }
  });

  it('keeps each allowed tool on the deferred host topology', () => {
    for (const name of names) expect(HOST_TOOLS).toContain(name);
  });

  it('auto-allows priority prompt delivery on the deferred host topology', () => {
    expect(BaseAgentProvider.META_AGENT_ALLOWED_TOOLS)
      .toContain('mcp__nimbalyst-host__send_prompt_now');
    expect(HOST_TOOLS).toContain('send_prompt_now');
  });
});
