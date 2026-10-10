import { beforeEach, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ request: vi.fn(), window: { id: 1 } }));
vi.mock('../../rendererRequest', () => ({ requestFromRenderer: host.request }));
vi.mock('../../mcpWorkspaceResolver', () => ({ findWindowForFilePath: vi.fn(async () => host.window) }));
const server = vi.hoisted(() => ({ fetch: vi.fn(), jwt: vi.fn(async (orgId: string) => `team-jwt-for-${orgId}`) }));
// The setup file's electron mock plus `net`, which the cross-project read uses.
vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: () => 'test-app',
    getVersion: () => '1.0.0',
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    whenReady: () => Promise.resolve(),
    isReady: () => true,
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  net: { fetch: server.fetch },
}));
vi.mock('../../../utils/collabSyncUrl', () => ({ getCollabSyncHttpUrl: () => 'https://sync.test' }));
vi.mock('../../../services/TeamService', () => ({
  getOrgScopedJwt: server.jwt,
  resolveTeamForWorkspace: async () => ({
    complete: true,
    team: {
      orgId: 'org-1',
      name: 'Acme',
      teamProjectId: 'tp-app',
      projects: [
        { projectId: 'p-app', teamProjectId: 'tp-app', gitRemoteHash: null, slug: 'app', name: 'App' },
        { projectId: 'p-docs', teamProjectId: 'tp-docs', gitRemoteHash: null, slug: 'docs', name: 'Docs' },
      ],
    },
  }),
}));
import { getEditorToolSchemas, handleApplyCollabDocEdit, handleApplyDiff, handleReadCollabDoc } from '../editorToolHandlers';
beforeEach(() => {
  host.request.mockReset();
  server.fetch.mockReset();
});
it('exposes decision state only as an opt-in read flag', () => {
  const schema = getEditorToolSchemas(undefined).find(tool => tool.name === 'readCollabDoc')!.inputSchema;
  expect(schema.properties.includeDecisionState.type).toBe('boolean');
  expect(schema.required).toEqual(['filePath']);
});
it('forwards the flag and separates read-only state from editable source', async () => {
  const decisionState = { readOnly: true, blocks: [{ blockId: 'dcn-a', humanVotes: [], agentRecommendations: [] }], truncated: false };
  host.request.mockResolvedValue({ status: 'received', response: { success: true, content: 'source', decisionState } });
  const result = await handleReadCollabDoc({ filePath: 'collab://org:o:doc:d', includeDecisionState: true });
  expect(host.request.mock.calls[0][2]).toMatchObject({ includeDecisionState: true });
  expect(result.content[0].text).toBe('source');
  expect(result.content[1].text).toContain('Read-only decision state');
  expect(result.content[1].text).toContain('humanVotes');
});
it('leaves default source reads unchanged', async () => {
  host.request.mockResolvedValue({ status: 'received', response: { success: true, content: 'source' } });
  expect(await handleReadCollabDoc({ filePath: 'collab://org:o:doc:d' })).toEqual({ content: [{ type: 'text', text: 'source' }], isError: false });
  expect(host.request.mock.calls[0][2]).not.toHaveProperty('includeDecisionState');
});
it('answers an empty page, or a reply without content, with an explicit status instead of no output', async () => {
  host.request.mockResolvedValue({
    status: 'received',
    response: { success: true, content: ' \n', title: 'BigPictureWork', documentType: 'markdown' },
  });
  const empty = await handleReadCollabDoc({ filePath: 'collab://org:o:doc:d' });
  expect(empty.isError).toBe(false);
  expect(empty.content[0].text).toMatch(/^\(empty page\) "BigPictureWork" \(collab:\/\/org:o:doc:d, markdown\) is loaded/);

  host.request.mockResolvedValue({ status: 'received', response: { success: true } });
  const missing = await handleReadCollabDoc({ filePath: 'collab://org:o:doc:d' });
  expect(missing).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('returned no content') }] });
});
it("reads another project's page, named by its link alone, through that project", async () => {
  host.request.mockResolvedValue({
    status: 'received',
    response: { success: false, code: 'OTHER_PROJECT', projectId: 'tp-docs', error: 'a page in another project' },
  });
  server.fetch.mockResolvedValue(new Response(JSON.stringify({ markdown: '# Theirs', title: 'Theirs' }), { status: 200 }));
  const result = await handleReadCollabDoc({ filePath: 'collab://org:org-1:doc:theirs' }, '/ws');
  const [url, init] = server.fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://sync.test/api/teams/org-1/projects/tp-docs/pages/read');
  expect(server.jwt).toHaveBeenCalledWith('org-1');
  expect(JSON.parse(init.body as string)).toEqual({ tool: 'readCollabDoc', args: { filePath: 'collab://org:org-1:doc:theirs' } });
  expect(JSON.parse(result.content[0].text!)).toMatchObject({ markdown: '# Theirs' });
});
it("sends both edit aliases through the renderer's project check with the invoking workspace", async () => {
  host.request.mockResolvedValue({
    status: 'received',
    response: { success: false, code: 'OTHER_PROJECT', error: '"Theirs" is a page in another project of this team (tp-docs); changes stay in the current project.' },
  });
  const args = { filePath: 'collab://org:org-1:doc:theirs', replacements: [{ oldText: 'a', newText: 'b' }] };
  for (const result of [await handleApplyCollabDocEdit(args, undefined, '/ws'), await handleApplyDiff(args, undefined, '/ws')]) {
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('changes stay in the current project') }] });
  }
  expect(host.request.mock.calls.map((call) => [call[1], call[2].workspacePath])).toEqual([['mcp:applyDiff', '/ws'], ['mcp:applyDiff', '/ws']]);
});

