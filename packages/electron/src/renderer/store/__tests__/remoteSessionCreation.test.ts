// @vitest-environment jsdom
import {it, expect, vi} from 'vitest';
import {createNewSessionActionAtom} from '../actions/sessionHistoryActions';
import {activeWorkspacePathAtom} from '../atoms/openProjects';
import {activeFileRepoPathAtom} from '../atoms/workspaceRepos';
import {defaultAgentModelAtom} from '../atoms/appSettings';
import {selectedMachineAtom} from '../atoms/remoteMachines';

it('uses the host default for New Session while preserving an explicitly requested model', async () => {
  const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => 'remote-new');
  (window as any).electronAPI = {invoke};
  const get = ((key: unknown) => key === activeWorkspacePathAtom || key === activeFileRepoPathAtom ? '/repo' : key === defaultAgentModelAtom ? 'openai-codex:gpt-6-astra' : key === selectedMachineAtom('/repo') ? 'sandbox-one' : undefined) as any;
  await createNewSessionActionAtom.write(get, vi.fn(), {selectSession: false});
  expect(invoke).toHaveBeenCalledWith('ai:createRemoteSession', '/repo', 'sandbox-one', {model: undefined});
  await createNewSessionActionAtom.write(get, vi.fn(), {selectSession: false, model: 'openai-codex:gpt-6-astra'});
  expect(invoke).toHaveBeenLastCalledWith('ai:createRemoteSession', '/repo', 'sandbox-one', {model: 'openai-codex:gpt-6-astra'});
  expect(invoke.mock.calls.every(([channel]) => channel === 'ai:createRemoteSession')).toBe(true);
});
