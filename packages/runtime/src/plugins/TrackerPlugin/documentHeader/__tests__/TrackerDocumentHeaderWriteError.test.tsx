import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The frontmatter writers refuse a header they cannot rewrite without losing
// the author's YAML (GitHub #1552). Before this, the refusal escaped the
// header's change handler as an uncaught error and the user saw nothing at all
// -- the field just snapped back. StatusBar and the model loader are stubbed so
// this stays a test of the change handler, not of the status chips.

import type { TrackerDataModel } from '../../models/TrackerDataModel';

const model: TrackerDataModel = {
  type: 'plan',
  displayName: 'Plan',
  displayNamePlural: 'Plans',
  icon: 'checklist',
  color: '#000000',
  modes: { inline: false, fullDocument: true },
  idPrefix: 'plan',
  fields: [],
} as unknown as TrackerDataModel;

vi.mock('../../components/StatusBar', () => ({
  StatusBar: ({ onChange }: { onChange: (updates: Record<string, unknown>) => void }) => (
    <button type="button" onClick={() => onChange({ status: 'completed' })}>
      change status
    </button>
  ),
}));

vi.mock('../../models/ModelLoader', () => ({
  ModelLoader: { getInstance: () => ({ getModel: async () => model }) },
}));

import { TrackerDocumentHeader } from '../TrackerDocumentHeader';

/** Parses fine, but no writer can splice a flow mapping at the root. */
const UNWRITABLE = '---\n{ trackerStatus: { type: plan }, status: draft }\n---\n\nPlan body.\n';
const WRITABLE = '---\nstatus: draft\ntrackerStatus:\n  type: plan\n---\n\nPlan body.\n';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TrackerDocumentHeader rejected frontmatter writes (#1552)', () => {
  it('reports a refused write instead of silently dropping the edit, and recovers', async () => {
    const onContentChange = vi.fn();
    let content = UNWRITABLE;

    const view = render(
      <TrackerDocumentHeader
        filePath="/workspace/plans/p.md"
        fileName="p.md"
        getContent={() => content}
        contentVersion={1}
        onContentChange={onContentChange}
      />,
    );

    const button = await screen.findByRole('button', { name: 'change status' });
    fireEvent.click(button);

    expect(onContentChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/flow mapping/i);

    // The same header, fixed by the user: the next edit goes through and the
    // message clears.
    content = WRITABLE;
    view.rerender(
      <TrackerDocumentHeader
        filePath="/workspace/plans/p.md"
        fileName="p.md"
        getContent={() => content}
        contentVersion={2}
        onContentChange={onContentChange}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'change status' }));

    expect(onContentChange).toHaveBeenCalledTimes(1);
    expect(onContentChange.mock.calls[0][0]).toContain('status: completed');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
