// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { pendingCollabDocumentAtom } from '../../atoms/collabDocuments';
import {
  trackerModeDocumentItemIdAtom,
  trackerModeLayoutAtom,
} from '../../atoms/trackers';
import { windowModeAtom } from '../../atoms/windowMode';
import { initDeepLinkListeners } from '../deepLinkListeners';

describe('tracker deep-link routing', () => {
  let cleanup: (() => void) | undefined;
  let handlers: Record<string, (data: any) => void>;
  let pendingTrackerPayload: Record<string, unknown> | null;

  beforeEach(() => {
    handlers = {};
    pendingTrackerPayload = null;
    store.set(activeWorkspacePathAtom, '/workspace/source');
    store.set(windowModeAtom, 'files');
    store.set(pendingCollabDocumentAtom, null);
    store.set(trackerModeLayoutAtom, {
      ...store.get(trackerModeLayoutAtom),
      selectedType: 'plan',
      selectedItemId: null,
      itemViews: {},
    });

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'deep-link:consume-pending-tracker') {
            return pendingTrackerPayload;
          }
          return null;
        }),
        on: vi.fn((event: string, handler: (data: any) => void) => {
          handlers[event] = handler;
          return () => delete handlers[event];
        }),
        featureUsage: {
          record: vi.fn(async () => undefined),
        },
      },
    });
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    store.set(activeWorkspacePathAtom, null);
    store.set(windowModeAtom, 'files');
    store.set(pendingCollabDocumentAtom, null);
  });

  it('binds a shared-document link to the workspace scope selected by the desktop host', () => {
    cleanup = initDeepLinkListeners();

    handlers['deep-link:open-shared-document']({
      documentId: 'doc-target',
      orgId: 'org-target',
      workspacePath: '/workspace/target',
    });

    expect(store.get(activeWorkspacePathAtom)).toBe('/workspace/target');
    expect(store.get(windowModeAtom)).toBe('collab');
    expect(store.get(pendingCollabDocumentAtom)).toMatchObject({
      documentId: 'doc-target',
      scopeKey: '/workspace/target',
      orgId: 'org-target',
      analyticsSource: 'deep_link',
    });
  });

  it('keeps links without view on the plain tracker selection path', () => {
    cleanup = initDeepLinkListeners();

    handlers['deep-link:open-tracker']({
      trackerId: 'tracker-plain',
      orgId: 'org-1',
      workspacePath: '/workspace/target',
    });

    expect(store.get(activeWorkspacePathAtom)).toBe('/workspace/target');
    expect(store.get(windowModeAtom)).toBe('tracker');
    expect(store.get(trackerModeLayoutAtom)).toMatchObject({
      selectedType: 'all',
      selectedItemId: 'tracker-plain',
      itemViews: {},
    });
    expect(store.get(trackerModeDocumentItemIdAtom)).toBeNull();
  });

  it('drains a pending view=document link into document presentation', async () => {
    pendingTrackerPayload = {
      trackerId: 'tracker-document',
      orgId: 'org-1',
      workspacePath: '/workspace/source',
      view: 'document',
    };

    cleanup = initDeepLinkListeners();

    await vi.waitFor(() => {
      expect(store.get(trackerModeDocumentItemIdAtom)).toBe('tracker-document');
    });
    expect(store.get(windowModeAtom)).toBe('tracker');
    expect(store.get(trackerModeLayoutAtom)).toMatchObject({
      selectedType: 'all',
      selectedItemId: 'tracker-document',
      itemViews: { 'tracker-document': 'document' },
    });
  });
});
