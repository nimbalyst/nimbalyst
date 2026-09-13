// @vitest-environment node
/**
 * A `command` in a repository's own `.mcp.json` is code the repository author
 * chose, not code the user chose, and the headless CLI agents spawn it at
 * session start with no per-server approval.
 *
 * These tests drive the production loader itself, not just its helpers. That
 * matters twice over: the trust gate has to be reachable through the real code
 * path to be worth anything, and the loader must never *throw*, because the
 * runtime's MCP config service catches a throwing loader and falls back to
 * reading `<workspace>/.mcp.json` directly with no gate at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MCPConfigService, loadTrustGatedMcpServers } from '../MCPConfigService';

const REPO_COMMAND = 'SYNTH_EVIL_COMMAND';

describe('trust-gated headless MCP loading', () => {
  let workspace: string;
  let service: MCPConfigService;
  let log: {
    info: ReturnType<typeof vi.fn<(message: string) => void>>;
    warn: ReturnType<typeof vi.fn<(message: string, error?: unknown) => void>>;
  };

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-mcp-origin-'));
    service = new MCPConfigService();
    log = {
      info: vi.fn<(message: string) => void>(),
      warn: vi.fn<(message: string, error?: unknown) => void>(),
    };
    // The user's global config is irrelevant to origin here, and reading the
    // developer's real ~/.claude.json would make these tests machine-dependent.
    vi.spyOn(service, 'readUserMCPConfig').mockResolvedValue({ mcpServers: {} });
    // OAuth reachability is a different axis; every server under test is local.
    vi.spyOn(service, 'isOAuthAuthorized').mockResolvedValue(true);
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const writeMcpJson = (contents: string) =>
    fs.writeFile(path.join(workspace, '.mcp.json'), contents, 'utf8');

  const load = (trustMode: 'ask' | 'allow-all' | 'bypass-all' | null) =>
    loadTrustGatedMcpServers({
      service,
      providerId: 'grok',
      displayName: 'Grok',
      workspacePath: workspace,
      getTrustMode: () => trustMode,
      log,
    });

  it('withholds a repository server in ask mode, with one log line naming it', async () => {
    await writeMcpJson(JSON.stringify({ mcpServers: { evil: { command: REPO_COMMAND } } }));

    expect(Object.keys(await load('ask'))).toEqual([]);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][0]).toContain('evil');
  });

  it.each(['allow-all', 'bypass-all'] as const)(
    'delivers it once the user has trusted the workspace for %s',
    async (mode) => {
      await writeMcpJson(JSON.stringify({ mcpServers: { evil: { command: REPO_COMMAND } } }));
      expect(Object.keys(await load(mode))).toEqual(['evil']);
    },
  );

  it('never withholds a user-configured server, whatever the trust mode', async () => {
    vi.spyOn(service, 'readUserMCPConfig').mockResolvedValue({
      mcpServers: { mine: { command: 'node' } as any },
    });
    expect(Object.keys(await load('ask'))).toEqual(['mine']);
  });

  it('treats a same-named repository server as repository-provided, not as the user server it shadows', async () => {
    vi.spyOn(service, 'readUserMCPConfig').mockResolvedValue({
      mcpServers: { shared: { command: 'node' } as any },
    });
    await writeMcpJson(JSON.stringify({ mcpServers: { shared: { command: REPO_COMMAND } } }));

    // `.mcp.json` wins the merge, so the entry that would actually run is the
    // repository's. Classifying it by the name it shadows would smuggle it in.
    expect(Object.keys(await load('ask'))).toEqual([]);
  });

  it('skips a malformed entry instead of throwing past the gate', async () => {
    // The bypass this closes: one null entry used to throw out of the loader,
    // and the runtime caught that and reloaded .mcp.json with no gate at all.
    await writeMcpJson(
      JSON.stringify({ mcpServers: { invalid: null, evil: { command: REPO_COMMAND } } }),
    );

    const servers = await load('ask');

    expect(servers.evil).toBeUndefined();
    expect(Object.keys(servers)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('skips a malformed entry even when the trust gate is not there to catch it', async () => {
    // In ask mode the gate drops both entries before the malformed one is ever
    // inspected, so only a trusted workspace actually exercises the skip:
    // `isMCPServerEnabledForProvider` dereferences the entry and throws on null.
    await writeMcpJson(
      JSON.stringify({ mcpServers: { invalid: null, good: { command: 'node' } } }),
    );

    const servers = await load('allow-all');

    expect(Object.keys(servers)).toEqual(['good']);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info.mock.calls.map((call) => call[0]).join('\n')).toContain('invalid');
  });

  it('returns an empty map when the trust lookup itself throws', async () => {
    // The permission store is read inside the loader's catch, not at the call
    // site. Evaluated outside it, a throw from here reached the runtime's
    // ungated fallback and that fallback loaded the repository command.
    await writeMcpJson(JSON.stringify({ mcpServers: { evil: { command: REPO_COMMAND } } }));

    const servers = await loadTrustGatedMcpServers({
      service,
      providerId: 'grok',
      displayName: 'Grok',
      workspacePath: workspace,
      getTrustMode: () => {
        throw new Error('permission store unavailable');
      },
      log,
    });

    expect(servers).toEqual({});
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('returns an empty map rather than throwing when the config cannot be read at all', async () => {
    vi.spyOn(service, 'getMergedConfigWithOrigins').mockRejectedValue(new Error('disk gone'));

    expect(await load('ask')).toEqual({});
    // A throw here would hand the decision to the runtime's ungated fallback.
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('fails closed when .mcp.json exists but cannot be parsed', async () => {
    // Origin is unknowable for this workspace, so nothing workspace-scoped may
    // be assumed to be the user's.
    vi.spyOn(service as any, 'readWorkspaceMcpLayers').mockResolvedValue({
      claudeJsonServers: { unknown: { command: REPO_COMMAND } },
      mcpJsonServers: {},
      mcpJsonUnreadable: true,
    });

    expect(Object.keys(await load('ask'))).toEqual([]);
    expect(Object.keys(await load('allow-all'))).toEqual(['unknown']);
  });
});

describe('MCPConfigService.getMergedConfigWithOrigins', () => {
  let workspace: string;
  let service: MCPConfigService;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-mcp-merged-'));
    service = new MCPConfigService();
    vi.spyOn(service, 'readUserMCPConfig').mockResolvedValue({ mcpServers: {} });
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports servers and their origin from the same read', async () => {
    await fs.writeFile(
      path.join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'repo-tool': { command: './scripts/setup.sh' } } }),
      'utf8',
    );

    const { mcpServers, repositoryProvided } = await service.getMergedConfigWithOrigins(workspace);

    expect(Object.keys(mcpServers)).toEqual(['repo-tool']);
    expect([...repositoryProvided]).toEqual(['repo-tool']);
  });

  it('has no repository origin without a workspace', async () => {
    const { repositoryProvided } = await service.getMergedConfigWithOrigins(undefined);
    expect([...repositoryProvided]).toEqual([]);
  });

  it('reports nothing repository-provided when the workspace ships no .mcp.json', async () => {
    const { repositoryProvided } = await service.getMergedConfigWithOrigins(workspace);
    expect([...repositoryProvided]).toEqual([]);
  });
});
