// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestFromRenderer = vi.fn();
const fakeWindow = { isDestroyed: () => false };
const netFetch = vi.fn();
const resolveTeamForWorkspace = vi.fn();
const getOrgScopedJwt = vi.fn(async (orgId: string) => `team-jwt-for-${orgId}`);

vi.mock('electron', () => ({ BrowserWindow: { fromId: () => fakeWindow }, net: { fetch: (...args: unknown[]) => netFetch(...args) } }));
vi.mock('../../mcpWorkspaceResolver', () => ({ findWindowIdForWorkspacePath: async () => 1 }));
vi.mock('../../../window/WindowManager', () => ({ getMostRecentlyFocusedWorkspaceWindow: () => null }));
vi.mock('../../rendererRequest', () => ({ requestFromRenderer: (...args: unknown[]) => requestFromRenderer(...args) }));
vi.mock('../../../services/TeamService', () => ({
  resolveTeamForWorkspace: (...args: unknown[]) => resolveTeamForWorkspace(...args),
  getOrgScopedJwt: (orgId: string) => getOrgScopedJwt(orgId),
}));
vi.mock('../../../utils/collabSyncUrl', () => ({ getCollabSyncHttpUrl: () => 'https://sync.test' }));

import {
  getCollabIndexToolSchemas,
  handleCollabIndexTool,
} from '../collabIndexToolHandlers';
import { routePageRead } from '../pageProjectReads';
import { pageTreeListing } from '../../../../../../collab-client/src/docs/pageTreeListing';

const TEAM = {
  orgId: 'org-1',
  name: 'Acme',
  teamProjectId: 'tp-app',
  projects: [
    { projectId: 'p-app', teamProjectId: 'tp-app', gitRemoteHash: null, slug: 'app', name: 'App' },
    { projectId: 'p-docs', teamProjectId: 'tp-docs', gitRemoteHash: null, slug: 'docs', name: 'Docs' },
    { projectId: 'p-web1', teamProjectId: 'tp-web1', gitRemoteHash: null, slug: 'web-one', name: 'Web' },
    { projectId: 'p-web2', teamProjectId: 'tp-web2', gitRemoteHash: null, slug: 'web-two', name: 'web' },
  ],
};

describe('page tree MCP tools', () => {
  beforeEach(() => {
    requestFromRenderer.mockReset();
    netFetch.mockReset();
    getOrgScopedJwt.mockClear();
    resolveTeamForWorkspace.mockReset().mockResolvedValue({ team: TEAM, complete: true });
  });

  it('forwards the section and workspace to the renderer and reports what it answered', async () => {
    requestFromRenderer.mockResolvedValue({
      status: 'responded',
      response: { success: true, section: 'personal', nodes: [{ nodeId: 'document:a', kind: 'page', title: 'Ideas' }] },
    });
    const result = await handleCollabIndexTool('listPages', { section: 'personal' }, '/ws');
    expect(requestFromRenderer).toHaveBeenCalledWith(fakeWindow, 'mcp:listPages', expect.objectContaining({ section: 'personal', workspacePath: '/ws' }), expect.anything());
    expect(result?.isError).toBe(false);
    expect(result?.content[0].text).toContain('"title":"Ideas"');
  });

  it('pages listPages past the first 100 nodes with the cursor it returned', async () => {
    const props = getCollabIndexToolSchemas().find((tool) => tool.name === 'listPages')!.inputSchema.properties;
    for (const arg of ['cursor', 'root', 'kinds', 'limit']) expect(props, arg).toHaveProperty(arg);

    const nodes = Array.from({ length: 250 }, (_, i) => ({ nodeId: `document:${i}`, kind: 'page', id: `${i}`, title: `Page ${i}`, depth: 0 }));
    requestFromRenderer.mockImplementation(async (_window: unknown, _channel: string, payload: Record<string, unknown>) => ({
      status: 'responded',
      response: { success: true, section: 'personal', ...(await pageTreeListing(nodes as never, 'personal', payload, null)) },
    }));
    const first = JSON.parse((await handleCollabIndexTool('listPages', { section: 'personal' }, '/ws'))!.content[0].text!);
    expect(first).toMatchObject({ total: 250, truncated: true });
    expect(first.nodes).toHaveLength(100);
    const second = JSON.parse((await handleCollabIndexTool('listPages', { section: 'personal', cursor: first.nextCursor }, '/ws'))!.content[0].text!);
    expect(second.nodes[0].title).toBe('Page 100');
    expect(second.nodes).toHaveLength(100);
  });

  it('warns when a created Team page links a file on this computer, and not for a Personal page or a web link', async () => {
    const body = 'See [diagram](/Users/me/repo/docs/architecture.excalidraw), ![chart](docs/chart.png) and [the spec](https://console.nimbalyst.com/app/page/abc).';
    requestFromRenderer.mockResolvedValue({ status: 'responded', response: { success: true, documentId: 'd1', uri: 'collab://org:o:doc:d1' } });
    const team = await handleCollabIndexTool('createSharedDoc', { title: 'Architecture', initialContent: body }, '/ws');
    expect(team?.isError).toBe(false);
    expect(team?.content[0].text).toMatch(/Teammates cannot open it/);
    expect(team?.content[0].text).toContain('/Users/me/repo/docs/architecture.excalidraw, docs/chart.png)');

    requestFromRenderer.mockResolvedValue({ status: 'responded', response: { success: true, documentId: 'd2', uri: 'personal://d2' } });
    const personal = await handleCollabIndexTool('createSharedDoc', { title: 'Notes', section: 'personal', initialContent: body }, '/ws');
    expect(personal?.content[0].text).not.toMatch(/Teammates/);

    requestFromRenderer.mockResolvedValue({ status: 'responded', response: { success: true, documentId: 'd3', uri: 'collab://org:o:doc:d3' } });
    const web = await handleCollabIndexTool('createSharedDoc', { title: 'Links', initialContent: '[a](https://x.test/a.png) [b](#top) [c](mailto:a@b.test)' }, '/ws');
    expect(web?.content[0].text).not.toMatch(/Teammates/);
  });

  it('moves typed pages and types, and turns a renderer refusal into a tool error', async () => {
    requestFromRenderer.mockResolvedValue({ status: 'responded', response: { success: false, error: 'Refused: that would put it inside itself.' } });
    const result = await handleCollabIndexTool('moveSharedItem', { itemId: 'MOD-1', kind: 'item', newParentFolderId: 'p' }, '/ws');
    expect(requestFromRenderer).toHaveBeenCalledWith(fakeWindow, 'mcp:moveSharedItem', expect.objectContaining({ kind: 'item', itemId: 'MOD-1' }), expect.anything());
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('inside itself') }] });
    expect(await handleCollabIndexTool('moveSharedItem', { itemId: 'x', kind: 'shelf' }, '/ws')).toMatchObject({ isError: true });
    expect(requestFromRenderer).toHaveBeenCalledTimes(1);
  });

  it('declares every page tool and answers only its own names', async () => {
    const names = getCollabIndexToolSchemas().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['listPages', 'setPageType', 'createSharedDoc', 'moveSharedItem']));
    expect(handleCollabIndexTool('tracker_get', {}, '/ws')).toBeNull();
  });

  it('lists the current project from the local session, naming it and the other projects', async () => {
    requestFromRenderer.mockResolvedValue({ status: 'responded', response: { success: true, section: 'team', nodes: [] } });
    const result = await handleCollabIndexTool('listPages', {}, '/ws');
    expect(netFetch).not.toHaveBeenCalled();
    expect(JSON.parse(result!.content[0].text!)).toMatchObject({
      project: { projectId: 'tp-app', projectName: 'App' },
      otherProjects: [
        { projectId: 'tp-docs', projectName: 'Docs' },
        { projectId: 'tp-web1', projectName: 'Web' },
        { projectId: 'tp-web2', projectName: 'web' },
      ],
    });
    // Naming the current project is the same local read.
    await handleCollabIndexTool('listPages', { project: 'App' }, '/ws');
    expect(netFetch).not.toHaveBeenCalled();
    expect(requestFromRenderer).toHaveBeenCalledTimes(2);
  });

  it("reads another project's tree from the server with the team JWT and passes it through", async () => {
    const serverTree = {
      section: 'team',
      nodes: [
        { nodeId: 'type:module', kind: 'type', id: 'module', title: 'Modules' },
        { nodeId: 'item:mod-1', kind: 'typedPage', id: 'mod-1', typeId: 'module', title: 'Sync', placed: false },
      ],
    };
    netFetch.mockResolvedValue(new Response(JSON.stringify(serverTree), { status: 200 }));
    const result = await handleCollabIndexTool('listPages', { project: 'docs', section: 'team' }, '/ws');

    expect(requestFromRenderer).not.toHaveBeenCalled();
    expect(getOrgScopedJwt).toHaveBeenCalledWith('org-1');
    const [url, init] = netFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sync.test/api/teams/org-1/projects/tp-docs/pages/read');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer team-jwt-for-org-1');
    expect(JSON.parse(init.body as string)).toEqual({ tool: 'listPages', args: { section: 'team' } });
    expect(result).toMatchObject({ isError: false });
    expect(JSON.parse(result!.content[0].text!)).toEqual(serverTree);
  });

  it("reads another project's typed page body by id, and returns the server's refusal", async () => {
    const readLocal = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'local' }], isError: false }));
    netFetch.mockResolvedValueOnce(new Response(JSON.stringify({ markdown: '# Sync', title: 'Sync', uri: 'collab://tracker-content/mod-1' }), { status: 200 }));
    const read = await routePageRead('readCollabDoc', { filePath: 'collab://tracker-content/mod-1', project: 'p-docs' }, '/ws', readLocal);
    expect(readLocal).not.toHaveBeenCalled();
    expect(JSON.parse((netFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      tool: 'readCollabDoc', args: { filePath: 'collab://tracker-content/mod-1' },
    });
    expect(JSON.parse(read.content[0].text)).toMatchObject({ markdown: '# Sync' });

    netFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'project_not_accessible', error_description: 'You cannot access this team project' }), { status: 403 }));
    const refused = await routePageRead('readCollabDoc', { filePath: 'collab://org:org-1:doc:x', project: 'tp-docs' }, '/ws', readLocal);
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('project_not_accessible: You cannot access this team project') }] });
  });

  it('takes the current project the way the Pages session does when the team lists none', async () => {
    // resolveIndexConfig fills it from a one-project registry; naming it must stay local.
    resolveTeamForWorkspace.mockResolvedValue({ team: { ...TEAM, teamProjectId: null, projects: [TEAM.projects[1]] }, complete: true });
    requestFromRenderer.mockResolvedValue({ status: 'responded', response: { success: true, section: 'team', nodes: [] } });
    const result = await handleCollabIndexTool('listPages', { project: 'Docs' }, '/ws');
    expect(netFetch).not.toHaveBeenCalled();
    expect(JSON.parse(result!.content[0].text!)).toMatchObject({ project: { projectId: 'tp-docs', projectName: 'Docs' }, otherProjects: [] });
  });

  it('refuses an ambiguous or unknown project name without calling the server', async () => {
    const ambiguous = await handleCollabIndexTool('listPages', { project: 'Web' }, '/ws');
    expect(ambiguous).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/tp-web1.*tp-web2/) }] });
    const unknown = await handleCollabIndexTool('listPages', { project: 'Nope' }, '/ws');
    expect(unknown).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('No project "Nope"') }] });
    expect(netFetch).not.toHaveBeenCalled();
    expect(requestFromRenderer).not.toHaveBeenCalled();
  });

  it('refuses a write that names another project', async () => {
    const result = await handleCollabIndexTool('createSharedDoc', { title: 'Plan', project: 'Docs' }, '/ws');
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('current project') }] });
    expect(requestFromRenderer).not.toHaveBeenCalled();
    expect(netFetch).not.toHaveBeenCalled();
  });
});
