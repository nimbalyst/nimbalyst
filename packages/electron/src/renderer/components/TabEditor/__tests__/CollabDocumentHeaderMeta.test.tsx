// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  collabAwarenessAtom,
  collabDocumentStateAtom,
} from '../../../store/atoms/collabEditor';
import {
  CollabDocumentHeaderMeta,
  CollabRecoveryBanner,
} from '../CollabDocumentHeaderMeta';

const filePath = 'collab://org:org-a:doc:doc-a';

describe('CollabDocumentHeaderMeta', () => {
  it('renders path, sync dot, and collaborators in one row without status prose', () => {
    const store = createStore();
    store.set(collabDocumentStateAtom(filePath), {
      replica: 'ready',
      transport: 'connected',
      outbox: 'clean',
    });
    store.set(collabAwarenessAtom(filePath), new Map([
      ['user-a', { name: 'Ada Lovelace', color: '#336699' }],
    ]));

    render(
      <Provider store={store}>
        <CollabDocumentHeaderMeta
          filePath={filePath}
          displayPath="Specs/Auth/Architecture Plan"
        />
      </Provider>,
    );

    expect(Array.from(
      screen.getByTestId('shared-document-breadcrumb').querySelectorAll('.breadcrumb-segment'),
    ).map(segment => segment.textContent?.replace(/^(folder|description)/, '')))
      .toEqual(['Specs', 'Auth', 'Architecture Plan']);
    expect(screen.getByTestId('collab-sync-dot').getAttribute('title')).toBe('Synced');
    expect(screen.queryByText('Synced')).toBeNull();
    expect(screen.getByTestId('collab-header-presence').textContent).toContain('AL');
    expect(Array.from(screen.getByTestId('shared-document-breadcrumb').parentElement!.children)
      .map(element => element.getAttribute('data-testid')))
      .toEqual([
        'shared-document-breadcrumb',
        'collab-sync-dot',
        'collab-header-presence',
      ]);
  });

  it('keeps rejected-update recovery actions in an exceptional banner', () => {
    const store = createStore();
    store.set(collabDocumentStateAtom(filePath), {
      replica: 'ready',
      transport: 'disconnected',
      outbox: 'rejected',
    });

    render(
      <Provider store={store}>
        <CollabRecoveryBanner
          filePath={filePath}
          onCopyCurrentDocument={vi.fn()}
          onDiscardLocalCopy={vi.fn()}
        />
      </Provider>,
    );

    expect(screen.getByRole('button', { name: 'Copy current document' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard local copy' })).toBeTruthy();
  });
});
