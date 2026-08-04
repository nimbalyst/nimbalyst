// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TrackerFieldEditor } from '../TrackerFieldEditor';

describe('TrackerFieldEditor array values', () => {
  it('renders structured runtime entries safely when legacy schema metadata says string array', () => {
    const requirement = {
      id: 'criterion-1',
      description: 'Open the tracker item',
      owner: 'Keith',
      evidenceRequirement: 'The detail view renders',
      state: 'pending',
    };

    render(
      <TrackerFieldEditor
        field={{ name: 'requirements', type: 'array', itemType: 'string' }}
        value={[requirement]}
        onChange={vi.fn()}
      />,
    );

    screen.getByText(JSON.stringify(requirement));
    expect(screen.queryByPlaceholderText('Add tag...')).toBeNull();
  });
});
