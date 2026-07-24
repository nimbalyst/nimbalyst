import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TrackerRecord } from '../../../../core/TrackerRecord';
import { StatusBar } from '../../components/StatusBar';
import type { TrackerDataModel } from '../../models/TrackerDataModel';
import { findAssociatedTrackerItem } from '../TrackerDocumentHeader';

function record(overrides: Partial<TrackerRecord> = {}): TrackerRecord {
  return {
    id: 'fm:plan:plans/roadmap.md',
    primaryType: 'plan',
    typeTags: ['plan'],
    issueKey: 'NIM-42',
    source: 'frontmatter',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/workspace',
      documentPath: 'plans/roadmap.md',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    fields: { title: 'Roadmap' },
    ...overrides,
  };
}

describe('TrackerDocumentHeader tracker item link', () => {
  it('finds the frontmatter item associated with an absolute document path', () => {
    const item = record();
    expect(findAssociatedTrackerItem([item], '/workspace/plans/roadmap.md', 'plan')).toBe(item);
  });

  it('does not associate a different tracker type or source', () => {
    expect(findAssociatedTrackerItem([record({ primaryType: 'task' })], '/workspace/plans/roadmap.md', 'plan')).toBeNull();
    expect(findAssociatedTrackerItem([record({ source: 'native' })], '/workspace/plans/roadmap.md', 'plan')).toBeNull();
  });

  it('renders a pill that opens the tracker item without collapsing the header', () => {
    const onOpen = vi.fn();
    const model: TrackerDataModel = {
      type: 'plan',
      displayName: 'Plan',
      displayNamePlural: 'Plans',
      icon: 'checklist',
      color: '#000000',
      modes: { inline: false, fullDocument: true },
      idPrefix: 'plan',
      idFormat: 'ulid',
      fields: [],
    };

    render(
      <StatusBar
        model={model}
        data={{}}
        onChange={() => {}}
        trackerItemLink={{ label: 'NIM-42', title: 'Roadmap', onOpen }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open tracker item NIM-42' }));

    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.getByText('Plan')).toBeTruthy();
  });
});
