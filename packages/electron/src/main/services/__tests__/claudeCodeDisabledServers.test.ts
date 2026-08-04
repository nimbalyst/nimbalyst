// @vitest-environment node
/**
 * Projection of Nimbalyst's MCP on/off state into Claude Code's own config
 * (NIM-2372). Nimbalyst used to enforce the toggle by making the binary ignore
 * its whole ecosystem (`--strict-mcp-config`); it now writes the same fields the
 * CLI writes for `/mcp disable`, so both agree:
 *
 *   user / local scope   -> ~/.claude.json  projects[cwd].disabledMcpServers
 *   project .mcp.json    -> .claude/settings.local.json  disabledMcpjsonServers
 */

import { describe, expect, it } from 'vitest';
import {
  applyDisabledMcpjsonServersToSettings,
  applyDisabledServersToClaudeConfig,
  claudeDisabledServersInput,
} from '../mcp/claudeCodeDisabledServers';

const WS = '/work/proj';

describe('claudeDisabledServersInput', () => {
  it('reads both the legacy `disabled` flag and per-provider opt-outs, and ignores other providers', () => {
    const input = claudeDisabledServersInput({
      on: {},
      legacyOff: { disabled: true },
      codexOnly: { enabledForProviders: ['codex'] },
      claudeOnly: { enabledForProviders: ['claude-agent'], disabled: true },
    });

    expect(input.knownNames).toEqual(['on', 'legacyOff', 'codexOnly', 'claudeOnly']);
    // `claudeOnly` stays on: enabledForProviders wins over the legacy flag.
    expect(input.disabledNames).toEqual(['legacyOff', 'codexOnly']);
  });
});

describe('applyDisabledServersToClaudeConfig', () => {
  it('writes disabled names into the project entry and leaves enabled ones out', () => {
    const { config, changed } = applyDisabledServersToClaudeConfig({}, WS, {
      knownNames: ['linear', 'figma'],
      disabledNames: ['figma'],
    });

    expect(changed).toBe(true);
    expect(config.projects?.[WS]?.disabledMcpServers).toEqual(['figma']);
  });

  it('preserves entries the user disabled outside Nimbalyst (unknown servers are not ours to re-enable)', () => {
    const existing = { projects: { [WS]: { disabledMcpServers: ['some-other-tool', 'figma'] } } };

    const { config } = applyDisabledServersToClaudeConfig(existing, WS, {
      knownNames: ['figma'],
      disabledNames: [],
    });

    // `figma` is ours and is now on -> removed. `some-other-tool` is not ours -> kept.
    expect(config.projects?.[WS]?.disabledMcpServers).toEqual(['some-other-tool']);
  });

  it('reports no change when the list already matches, so we never touch the file needlessly', () => {
    const existing = { projects: { [WS]: { disabledMcpServers: ['figma'], mcpServers: { a: {} } } } };

    const { config, changed } = applyDisabledServersToClaudeConfig(existing, WS, {
      knownNames: ['figma', 'linear'],
      disabledNames: ['figma'],
    });

    expect(changed).toBe(false);
    // Untouched siblings survive (we read-modify-write a file the CLI also owns).
    expect(config.projects?.[WS]?.mcpServers).toEqual({ a: {} });
  });

  it('drops the key entirely when nothing is disabled, rather than leaving an empty array', () => {
    const existing = { projects: { [WS]: { disabledMcpServers: ['figma'] } } };

    const { config, changed } = applyDisabledServersToClaudeConfig(existing, WS, {
      knownNames: ['figma'],
      disabledNames: [],
    });

    expect(changed).toBe(true);
    expect(config.projects?.[WS]).not.toHaveProperty('disabledMcpServers');
  });

  it('tolerates a corrupt existing value instead of throwing into session start', () => {
    const existing = { projects: { [WS]: { disabledMcpServers: 'figma' as any } } };

    const { config } = applyDisabledServersToClaudeConfig(existing, WS, {
      knownNames: ['figma'],
      disabledNames: ['figma'],
    });

    expect(config.projects?.[WS]?.disabledMcpServers).toEqual(['figma']);
  });
});

describe('applyDisabledMcpjsonServersToSettings', () => {
  it('lists only servers that actually come from .mcp.json', () => {
    const { settings, changed } = applyDisabledMcpjsonServersToSettings(
      {},
      { knownNames: ['from-mcpjson', 'from-user'], disabledNames: ['from-mcpjson', 'from-user'] },
      ['from-mcpjson']
    );

    expect(changed).toBe(true);
    expect(settings.disabledMcpjsonServers).toEqual(['from-mcpjson']);
  });

  it('keeps unrelated settings keys intact', () => {
    const { settings } = applyDisabledMcpjsonServersToSettings(
      { permissions: { allow: ['Bash'] } } as any,
      { knownNames: ['a'], disabledNames: ['a'] },
      ['a']
    );

    expect((settings as any).permissions).toEqual({ allow: ['Bash'] });
  });
});
