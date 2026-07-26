// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PullRequestRow } from '../../../services/RendererPullRequestService';
import {
  dismissEditorContextItem,
  getEditorContextEntry,
  getActiveEditorContextItems,
  setEditorContextItems,
} from '../../../stores/editorContextStore';
import { buildPrContextItem, prContextPath } from '../prFormat';
import { usePrAiContext } from '../usePrAiContext';

const remote = 'nimbalyst/nimbalyst';
const pr: PullRequestRow = {
  id: 'pr-1408',
  workspaceId: '/workspace',
  remote,
  number: 1408,
  title: 'Add PR chat context',
  body: 'This body must not be included.',
  state: 'open',
  isDraft: false,
  authorLogin: 'octocat',
  authorAvatarUrl: null,
  headRef: 'feature/pr-chat',
  headSha: 'abc123',
  baseRef: 'main',
  mergeable: 'mergeable',
  commentsCount: 3,
  reviewCommentsCount: 2,
  additions: 42,
  deletions: 7,
  changedFiles: 5,
  ciStatus: 'success',
  reviewers: [{ login: 'reviewer', state: 'approved' }],
  labels: ['feature'],
  raw: { html_url: 'https://github.com/nimbalyst/nimbalyst/pull/1408' },
  etag: null,
  createdAt: 1,
  updatedAt: 2,
  fetchedAt: 3,
};

afterEach(() => {
  for (const number of [1408, 1409]) {
    setEditorContextItems(prContextPath(remote, number), null);
  }
});

describe('PR AI context', () => {
  it('builds a compact PR identity item without the body or diff', () => {
    const item = buildPrContextItem(remote, pr);

    expect(item).toMatchObject({
      id: 'pr-1408',
      icon: 'merge',
      label: 'PR #1408',
    });
    expect(item.description).toContain('Pull request: #1408 Add PR chat context');
    expect(item.description).toContain('State: open');
    expect(item.description).toContain('Branches: feature/pr-chat -> main');
    expect(item.description).toContain('https://github.com/nimbalyst/nimbalyst/pull/1408');
    expect(item.description).not.toContain('This body must not be included.');
    expect(item.description).not.toContain('diff');
    expect(item.data).toBeUndefined();
    expect(item.includeData).toBeUndefined();
  });

  it('publishes, replaces, deactivates, and clears the selected PR context', async () => {
    const { result, rerender, unmount } = renderHook(
      ({ selectedPr, isActive }: { selectedPr: PullRequestRow | null; isActive: boolean }) =>
        usePrAiContext(remote, selectedPr, isActive),
      { initialProps: { selectedPr: pr, isActive: true } },
    );

    const firstPath = prContextPath(remote, 1408);
    expect(getActiveEditorContextItems(firstPath)?.[0]?.id).toBe('pr-1408');
    await expect(result.current.getDocumentContext()).resolves.toMatchObject({
      filePath: firstPath,
      fileType: 'pull-request',
      content: '',
      editorContextItems: [{ id: 'pr-1408' }],
    });

    const nextPr = { ...pr, id: 'pr-1409', number: 1409 };
    act(() => rerender({ selectedPr: nextPr, isActive: true }));
    const nextPath = prContextPath(remote, 1409);
    expect(getEditorContextEntry(firstPath)).toBeNull();
    expect(getActiveEditorContextItems(nextPath)?.[0]?.id).toBe('pr-1409');

    act(() => rerender({ selectedPr: nextPr, isActive: false }));
    expect(getEditorContextEntry(nextPath)).toBeNull();
    await expect(result.current.getDocumentContext()).resolves.toMatchObject({
      filePath: '',
      editorContextItems: undefined,
    });

    act(() => rerender({ selectedPr: pr, isActive: true }));
    expect(getEditorContextEntry(firstPath)).not.toBeNull();
    unmount();
    expect(getEditorContextEntry(firstPath)).toBeNull();
  });

  it('preserves a dismissed PR chip across payload-only refreshes', () => {
    const { rerender, unmount } = renderHook(
      ({ selectedPr }: { selectedPr: PullRequestRow }) =>
        usePrAiContext(remote, selectedPr, true),
      { initialProps: { selectedPr: pr } },
    );
    const path = prContextPath(remote, 1408);

    dismissEditorContextItem('pr-1408', path);
    act(() => rerender({ selectedPr: { ...pr, commentsCount: 4 } }));

    expect(getActiveEditorContextItems(path)).toBeUndefined();
    expect(getEditorContextEntry(path)?.dismissedIds.has('pr-1408')).toBe(true);
    unmount();
  });
});
