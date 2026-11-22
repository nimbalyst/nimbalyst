// @vitest-environment jsdom

import React from 'react';
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import type { TrackerIdentity } from '@nimbalyst/runtime/core/DocumentService';
import { createFakeServer } from '../../../../tracker-engine/src/__tests__/fakeTrackerServer';
import { BrowserTrackerDataSource } from '../../trackers/browser/BrowserTrackerDataSource';
import {
  BROWSER_TRACKER_UI_CAPABILITIES,
  TrackerBoardSurface,
  TrackerMutationRejectionNotice,
  TrackersUIProvider,
  useTrackerCommand,
  useTrackerData,
  useTrackerDataSelector,
} from '../index';

const identity: TrackerIdentity = {
  displayName: 'Browser member',
  email: 'browser@example.com',
  gitName: null,
  gitEmail: null,
};

let databaseSequence = 0;
const sources: BrowserTrackerDataSource[] = [];

function createSource(connect: () => WebSocket): BrowserTrackerDataSource {
  const source = new BrowserTrackerDataSource({
    workspacePath: '/browser/team-project',
    serverUrl: 'ws://fake',
    orgId: 'org-test',
    teamProjectId: 'project-test',
    teamMemberId: asTeamMemberId(`member-${databaseSequence}`),
    currentUser: identity,
    presenceIdentity: { displayName: identity.displayName, avatarUrl: null },
    getTeamJwt: async () => asTeamJwt('team-jwt'),
    authorizeRoom: async () => null,
    databaseName: `browser-tracker-mutations-${databaseSequence++}`,
    indexedDbFactory: fakeIndexedDB,
    createWebSocket: () => {
      const socket = connect();
      const send = socket.send.bind(socket);
      socket.send = ((data: Parameters<WebSocket['send']>[0]) => {
        const text = typeof data === 'string' ? data : '';
        if (text.includes('"type":"trackerMutation"')) {
          setTimeout(() => send(data), 300);
          return;
        }
        send(data);
      }) as WebSocket['send'];
      return socket;
    },
  });
  sources.push(source);
  return source;
}

function SelectorFanout() {
  useTrackerDataSelector(state => state.records);
  useTrackerDataSelector(state => state.recordsById);
  useTrackerDataSelector(state => state.savedViews);
  useTrackerDataSelector(state => state.presence);
  useTrackerDataSelector(state => state.sync);
  useTrackerDataSelector(state => state.rejection);
  const loaded = useTrackerDataSelector(state => state.loaded);
  return <span hidden>{String(loaded)}</span>;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function BoardHarness({
  onBoardMutation,
}: {
  onBoardMutation: (updates: Record<string, unknown>, outcome: Promise<unknown>) => void;
}) {
  const { records, rejection } = useTrackerData();
  const command = useTrackerCommand();
  return (
    <>
      <TrackerMutationRejectionNotice rejection={rejection} />
      <TrackerBoardSurface
        rows={records}
        trackerType="bug"
        groupBy="none"
        ordering="manual"
        onOpenItem={() => {}}
        onItemUpdate={(item, updates) => {
          const outcome = command({
            type: 'update-item',
            input: { itemId: item.id, updates, sharing: 'team' },
          });
          onBoardMutation(updates, outcome);
          return outcome;
        }}
      />
    </>
  );
}

function renderedCardIds(): Array<string | undefined> {
  return screen.queryAllByTestId('tracker-kanban-card').map((card) => card.dataset.itemId);
}

async function waitForCardOrder(expected: string[]): Promise<void> {
  await waitFor(() => expect(renderedCardIds()).toEqual(expected));
}

afterEach(() => {
  for (const source of sources.splice(0)) source.dispose();
});

describe('browser tracker mutations', () => {
  it('round-trips bounded mutations to a second client, then visibly rolls a rejected drag back', async () => {
    const server = createFakeServer();
    const browser = createSource(server.connect);
    const peer = createSource(server.connect);
    await waitUntil(() => browser.status().status === 'connected' && peer.status().status === 'connected');

    await browser.command({
      type: 'create-item',
      item: {
        id: 'bug-a',
        type: 'bug',
        title: 'First',
        status: 'to-do',
        priority: 'medium',
        workspace: '/browser/team-project',
        sharing: 'team',
        customFields: { kanbanSortOrder: 'a0' },
      },
    });
    await browser.command({
      type: 'create-item',
      item: {
        id: 'bug-b',
        type: 'bug',
        title: 'Second',
        status: 'to-do',
        priority: 'medium',
        workspace: '/browser/team-project',
        sharing: 'team',
        customFields: {
          kanbanSortOrder: 'a1',
          relatedPlans: [{ itemId: 'plan-1', trackerType: 'plan' }],
        },
      },
    });
    await waitUntil(async () => (await peer.snapshot()).items.length === 2);

    await browser.command({
      type: 'update-item',
      input: { itemId: 'bug-a', updates: { status: 'in-progress' }, sharing: 'team' },
    });
    await waitUntil(async () => {
      const item = (await peer.snapshot()).items.find((candidate) => candidate.id === 'bug-a');
      return item?.status === 'in-progress';
    });
    expect((await peer.snapshot()).items.find((item) => item.id === 'bug-a')?.status).toBe('in-progress');
    await browser.command({
      type: 'update-item',
      input: { itemId: 'bug-a', updates: { status: 'to-do' }, sharing: 'team' },
    });
    await waitUntil(async () => {
      const item = (await peer.snapshot()).items.find((candidate) => candidate.id === 'bug-a');
      return item?.status === 'to-do';
    });

    await browser.command({ type: 'add-comment', itemId: 'bug-a', body: 'Needs a browser check' });
    await waitUntil(async () => {
      const item = (await peer.snapshot()).items.find((candidate) => candidate.id === 'bug-a');
      return item?.customFields?.comments?.[0]?.body === 'Needs a browser check';
    });
    const peerComment = (await peer.snapshot()).items
      .find((item) => item.id === 'bug-a')?.customFields?.comments?.[0];
    expect(peerComment?.id).toBeTypeOf('string');
    await browser.command({
      type: 'update-comment',
      itemId: 'bug-a',
      commentId: peerComment!.id,
      body: 'Browser check complete',
    });
    await waitUntil(async () => {
      const item = (await peer.snapshot()).items.find((candidate) => candidate.id === 'bug-a');
      return item?.customFields?.comments?.[0]?.body === 'Browser check complete';
    });

    const onBoardMutation = vi.fn();
    const snapshot = vi.spyOn(browser, 'snapshot');
    const subscribe = vi.spyOn(browser, 'subscribe');
    render(
      <TrackersUIProvider
        dataSource={browser}
        identity={identity}
        capabilities={BROWSER_TRACKER_UI_CAPABILITIES}
      >
        <BoardHarness onBoardMutation={onBoardMutation} />
        <SelectorFanout />
      </TrackersUIProvider>,
    );
    await waitForCardOrder(['bug-a', 'bug-b']);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    server.room.setRejectAll(true);
    const cards = screen.getAllByTestId('tracker-kanban-card');
    const first = cards[0];
    const second = cards[1];
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: () => {},
    };
    first.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON: () => ({}),
    });

    fireEvent.dragStart(second, { dataTransfer });
    const dragOver = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperties(dragOver, {
      clientY: { value: 0 },
      dataTransfer: { value: dataTransfer },
    });
    fireEvent(first, dragOver);
    fireEvent.drop(first, { dataTransfer });
    expect(onBoardMutation).toHaveBeenCalledTimes(1);
    expect(onBoardMutation.mock.calls[0]?.[0]).toMatchObject({ kanbanSortOrder: expect.any(String) });
    expect(onBoardMutation.mock.calls[0]?.[0].kanbanSortOrder).not.toBe('a1');
    await act(async () => {
      await onBoardMutation.mock.calls[0]![1];
      await waitUntil(async () => {
        const optimistic = await browser.snapshot();
        return optimistic.items.find((item) => item.id === 'bug-b')?.customFields?.kanbanSortOrder !== 'a1';
      });
    });

    expect(server.room.receivedMutations).toHaveLength(6);
    expect((await browser.snapshot()).items.find((item) => item.id === 'bug-b')?.customFields?.kanbanSortOrder)
      .toBe(onBoardMutation.mock.calls[0]?.[0].kanbanSortOrder);
    await waitForCardOrder(['bug-b', 'bug-a']);
    await waitForCardOrder(['bug-a', 'bug-b']);
    expect(screen.getByRole('alert').textContent).toMatch(/rolled back|restored/i);
    expect(screen.getByRole('alert').textContent).toMatch(/permission/i);
  });
});
