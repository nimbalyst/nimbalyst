// @vitest-environment jsdom
import { Provider } from 'jotai';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  collabDocumentStateAtom,
  collabAwarenessAtom,
  DEFAULT_COLLAB_DOCUMENT_STATE,
} from '../../../store/atoms/collabEditor';
import { trackerContentCollabKey } from '../../../hooks/trackerContentCollabKey';
// Imported from the standalone chrome module, not TrackerItemDetail: mounting
// the detail would drag the whole editor stack into this test.
import {
  TrackerDocumentHeaderMeta,
  trackerBreadcrumbSegments,
} from '../TrackerDocumentHeaderMeta';

const ITEM_ID = 'item-1';
const COLLAB_KEY = trackerContentCollabKey(ITEM_ID);

function renderMeta(props: Partial<Parameters<typeof TrackerDocumentHeaderMeta>[0]> = {}) {
  render(
    <Provider store={store}>
      <TrackerDocumentHeaderMeta
        itemId={ITEM_ID}
        title="Pill item"
        breadcrumb={{
          kind: 'file',
          segments: ['Features', 'plan.md'],
          dirty: false,
          fullPath: '/ws/Features/plan.md',
        }}
        showCollabChrome={false}
        {...props}
      />
    </Provider>,
  );
}

describe('trackerBreadcrumbSegments', () => {
  it('uses the backing file path when the item has one', () => {
    const result = trackerBreadcrumbSegments(
      { kind: 'file', segments: ['Features', 'plan.md'], dirty: false, fullPath: '/ws/Features/plan.md' },
      'Ignored title',
    );

    expect(result.segments).toEqual(['Features', 'plan.md']);
    expect(result.tooltip).toBe('/ws/Features/plan.md');
  });

  it('names collection, type and title when there is no backing file', () => {
    const result = trackerBreadcrumbSegments(
      { kind: 'degraded', collection: 'Trackers', typeLabel: 'Specs' },
      'Pill item',
    );

    expect(result.segments).toEqual(['Trackers', 'Specs', 'Pill item']);
    expect(result.tooltip).toBe('Trackers / Specs / Pill item');
  });
});

describe('TrackerDocumentHeaderMeta', () => {
  afterEach(() => {
    store.set(collabDocumentStateAtom(COLLAB_KEY), DEFAULT_COLLAB_DOCUMENT_STATE);
    store.set(collabAwarenessAtom(COLLAB_KEY), new Map());
  });

  it('shows the backing file path with no dirty dot while it is saved', () => {
    renderMeta();

    expect(screen.getByTestId('tracker-document-breadcrumb').textContent).toContain('plan.md');
    expect(screen.queryByTestId('tracker-document-breadcrumb-dirty')).toBeNull();
  });

  it('marks the breadcrumb dirty when the backing file has unsaved edits', () => {
    renderMeta({
      breadcrumb: {
        kind: 'file',
        segments: ['plans', 'x.md'],
        dirty: true,
        fullPath: '/ws/plans/x.md',
      },
    });

    screen.getByTestId('tracker-document-breadcrumb-dirty');
  });

  it('falls back to collection and type for a DB-only item', () => {
    renderMeta({
      breadcrumb: { kind: 'degraded', collection: 'Trackers', typeLabel: 'Specs' },
    });

    const breadcrumb = screen.getByTestId('tracker-document-breadcrumb');
    expect(breadcrumb.textContent).toContain('Trackers');
    expect(breadcrumb.textContent).toContain('Specs');
    expect(breadcrumb.textContent).toContain('Pill item');
  });

  it('shows the connection state only for a collaborative body', () => {
    renderMeta();
    expect(screen.queryByTestId('tracker-collab-sync-dot')).toBeNull();

    renderMeta({ showCollabChrome: true });
    expect(screen.getAllByTestId('tracker-collab-sync-dot').length).toBe(1);
  });
});
