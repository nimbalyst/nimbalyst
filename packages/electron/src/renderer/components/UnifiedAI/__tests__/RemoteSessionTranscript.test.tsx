// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn() }));
vi.mock('../../../store/listeners/remoteSessionViews', async () => {
  const { atom } = await import('jotai');
  const snapshot = atom({ session: { id: 'remote', messages: [], provider: 'claude-code', metadata: {remoteHostDeviceId: 'sandbox-1'} }, hostOnline: true, connected: false, syncing: false, executing: false, queuedPrompts: [] });
  const error = atom(null);
  return { acquireRemoteSession: mocks.acquire, remoteSessionSnapshotAtom: () => snapshot, remoteSessionErrorAtom: () => error };
});
vi.mock('../../../store/atoms/sessions', async () => {
  const {atom} = await import('jotai');
  const text = atom(''), attachments = atom([]), hydrated = atom(false), modified = atom(0);
  return {sessionDraftInputAtom: () => text, sessionDraftAttachmentsAtom: () => attachments, sessionDraftHydratedAtom: () => hydrated, sessionDraftLocalModifiedAtAtom: () => modified, canPersistSessionDraft: (ready: boolean, timestamp: number) => ready && timestamp > 0};
});
vi.mock('../AIInput', async () => {
  const React = await import('react');
  return {AIInput: React.forwardRef((_props: any, _ref) => {
    const props = _props;
    return <div><textarea aria-label="Message" value={props.value} onChange={event => props.onChange(event.target.value)} />
      <span>{props.attachments.length} attachments</span>
      <button onClick={() => props.onAttachmentAdd({id: 'file', filename: 'diagram.png', filepath: '/staged/image.png', mimeType: 'image/png', size: 5, type: 'image', addedAt: 1})}>Attach</button>
      <button disabled={props.disabled} onClick={() => props.onSend()}>Send</button>
      <button onClick={() => props.onLaunchActionInNewSession({id: 'review', label: 'Review', body: 'Review these changes', config: {launch: 'new-session', autoSubmit: false, foreground: false, worktree: false}})}>Action</button></div>;
  })};
});
vi.mock('@nimbalyst/runtime/ui/AgentTranscript/components/RichTranscriptView', () => ({ RichTranscriptView: () => <div /> }));
import { RemoteSessionTranscript } from '../RemoteSessionTranscript';
import {sessionDraftInputAtom, sessionDraftHydratedAtom} from '../../../store/atoms/sessions';
import {remoteSessionSnapshotAtom} from '../../../store/listeners/remoteSessionViews';
import {getInteractiveWidgetHost} from '@nimbalyst/runtime/store/atoms/interactiveWidgetHost';
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('remote session composer commands', () => {
  it('restores the saved draft again if session initialization clears hydration after mount', async () => {
    mocks.acquire.mockReturnValue(mocks.release);
    const invoke = vi.fn(async (channel: string) => channel === 'ai:loadRemoteDraft' ? {text: 'Saved remote draft', attachments: []} : channel === 'ai:remoteWorkspaceContext' ? {files: [], commands: []} : undefined);
    (window as any).electronAPI = {invoke};
    const state = createStore();
    render(<Provider store={state}><RemoteSessionTranscript sessionId="remote" workspacePath="/repo" mode="agent" /></Provider>);
    await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Saved remote draft'));
    act(() => {state.set(sessionDraftInputAtom('remote'), ''); state.set(sessionDraftHydratedAtom('remote'), false);});
    await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Saved remote draft'));
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps text and attachments on failure, retries explicitly, and routes draft Actions to the same host', async () => {
    mocks.acquire.mockReturnValue(mocks.release);
    const queue = vi.fn().mockRejectedValueOnce(new Error('Sandbox offline')).mockResolvedValue({promptId: 'accepted'});
    const invoke = vi.fn(async (channel, ...args) => {
      if (channel === 'ai:loadRemoteDraft') return {text: '', attachments: []};
      if (channel === 'ai:saveRemoteDraft') return;
      if (channel === 'ai:remoteWorkspaceContext') return {files: ['remote-file.ts'], commands: []};
      if (channel === 'ai:createRemoteSession') return 'new-remote';
      if (channel === 'ai:queueRemotePrompt') return queue(...args);
      throw new Error(`Unexpected local execution: ${channel}`);
    });
    (window as any).electronAPI = {invoke};
    const view = render(<Provider store={createStore()}><RemoteSessionTranscript sessionId="remote" workspacePath="/repo" mode="agent" /></Provider>);
    await waitFor(() => expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Message'), {target: {value: 'Read this image'}});
    fireEvent.click(screen.getByText('Attach'));
    fireEvent.click(screen.getByText('Send'));
    await screen.findByText('Sandbox offline');
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('Read this image');
    screen.getByText('1 attachments');
    expect(queue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe(''));
    expect(queue).toHaveBeenLastCalledWith('remote', '/repo', 'Read this image', [expect.objectContaining({id: 'file'})], expect.objectContaining({mode: 'agent'}));
    fireEvent.click(screen.getByText('Action'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:saveRemoteDraft', 'new-remote', '/repo', {text: 'Review these changes', attachments: []}));
    expect(invoke).toHaveBeenCalledWith('ai:createRemoteSession', '/repo', 'sandbox-1', expect.objectContaining({prompt: undefined}));
    view.unmount(); expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('answers prompts on a desktop host through the host machine and never locally', async () => {
    mocks.acquire.mockReturnValue(mocks.release);
    const respond = vi.fn(async () => {});
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'ai:loadRemoteDraft') return {text: '', attachments: []};
      if (channel === 'ai:remoteWorkspaceContext') return {files: [], commands: []};
      if (channel === 'ai:respondRemotePrompt') return (respond as (...a: unknown[]) => Promise<void>)(...args);
      if (channel === 'ai:cancelRemoteSession') return;
      throw new Error(`Unexpected local execution: ${channel}`);
    });
    (window as any).electronAPI = {invoke};
    const state = createStore();
    const snapshot = remoteSessionSnapshotAtom('remote') as any;
    const view = render(<Provider store={state}><RemoteSessionTranscript sessionId="remote" workspacePath="/repo" mode="agent" /></Provider>);
    expect(getInteractiveWidgetHost('remote')).toBeNull();

    act(() => state.set(snapshot, {...(state.get(snapshot) as object), canAnswerPrompts: true}));
    await waitFor(() => expect(getInteractiveWidgetHost('remote')).not.toBeNull());
    const host = getInteractiveWidgetHost('remote')!;
    await host.askUserQuestionSubmit('question-1', {'Which branch?': 'develop'});
    await host.askUserQuestionCancel('question-2');
    await host.requestUserInputCancel('form-0');
    await host.toolPermissionSubmit('tool-perm-1', {decision: 'allow', scope: 'session'});
    await host.exitPlanModeCancel('plan-1');
    expect(await host.gitCommit('commit-1', ['a.ts'], 'Ship it')).toEqual({success: true, pending: true});
    expect(respond.mock.calls).toEqual([
      ['remote', '/repo', {promptType: 'ask_user_question', promptId: 'question-1', response: {answers: {'Which branch?': 'develop'}}}],
      ['remote', '/repo', {promptType: 'ask_user_question', promptId: 'question-2', response: {answers: {}, cancelled: true}}],
      ['remote', '/repo', {promptType: 'request_user_input', promptId: 'form-0', response: {answers: {}, cancelled: true}}],
      ['remote', '/repo', {promptType: 'tool_permission', promptId: 'tool-perm-1', response: {decision: 'allow', scope: 'session'}}],
      ['remote', '/repo', {promptType: 'exit_plan_mode', promptId: 'plan-1', response: {approved: false}}],
      ['remote', '/repo', {promptType: 'git_commit', promptId: 'commit-1', response: {action: 'committed', files: ['a.ts'], message: 'Ship it'}}],
    ]);
    const channels = invoke.mock.calls.map(([channel, ...args]) => channel === 'ai:respondRemotePrompt' ? (args[2] as {promptId: string}).promptId : channel);
    expect(channels.indexOf('ai:cancelRemoteSession')).toBe(channels.indexOf('plan-1') - 1);

    respond.mockRejectedValueOnce(new Error('The remote machine is offline. Your answer has not been sent.'));
    await act(() => expect(host.requestUserInputSubmit('form-1', {})).rejects.toThrow('offline'));
    await screen.findByText('The remote machine is offline. Your answer has not been sent.');
    await act(() => expect(host.gitCommit('commit-2', ['a.ts'], 'Part', [{path: 'a.ts', hunks: []} as any])).rejects.toThrow('Partial file commits'));
    await act(() => expect(host.exitPlanModeStartNewSession('plan-2', '/repo/plan.md')).rejects.toThrow('only available on the machine'));
    expect(respond).toHaveBeenCalledTimes(7);

    act(() => state.set(snapshot, {...(state.get(snapshot) as object), canAnswerPrompts: false}));
    await waitFor(() => expect(getInteractiveWidgetHost('remote')).toBeNull());
    act(() => state.set(snapshot, {...(state.get(snapshot) as object), canAnswerPrompts: true}));
    await waitFor(() => expect(getInteractiveWidgetHost('remote')).not.toBeNull());
    view.unmount();
    expect(getInteractiveWidgetHost('remote')).toBeNull();
  });
});
