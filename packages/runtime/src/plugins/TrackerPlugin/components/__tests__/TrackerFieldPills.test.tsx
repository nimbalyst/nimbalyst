import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TrackerFieldPills } from '../TrackerFieldPills';
import type { FieldDefinition } from '../../models/TrackerDataModel';

const statusField: FieldDefinition = {
  name: 'state',
  type: 'select',
  options: [
    { value: 'open', label: 'Open', icon: 'radio_button_checked' },
    { value: 'done', label: 'Done', icon: 'check_circle' },
  ],
};

const ownerField: FieldDefinition = { name: 'owner', type: 'user' };
const dueField: FieldDefinition = { name: 'dueDate', type: 'date' };
const tagsField: FieldDefinition = { name: 'tags', type: 'array' };

function renderPills(
  fields: FieldDefinition[],
  values: Record<string, unknown>,
  overrides: Partial<React.ComponentProps<typeof TrackerFieldPills>> = {},
) {
  const onSave = vi.fn();
  render(
    <TrackerFieldPills
      fields={fields}
      values={values}
      onSave={onSave}
      {...overrides}
    />,
  );
  return { onSave };
}

describe('TrackerFieldPills', () => {
  it('names the field in the popover of a select chip and saves the choice', () => {
    const { onSave } = renderPills([statusField], { state: 'open' });

    const chip = screen.getByTestId('tracker-field-pill-state');
    expect(chip.textContent).toContain('Open');

    fireEvent.click(chip);
    expect(screen.getByTestId('tracker-field-popover-header-state').textContent).toBe('State');

    fireEvent.click(screen.getByText('Done'));
    expect(onSave).toHaveBeenCalledWith('state', 'done');
  });

  it('names the field in a people chip popover built from team members', () => {
    const { onSave } = renderPills([ownerField], { owner: '' }, {
      teamMembers: [{ email: 'ada@example.com', name: 'Ada' }],
    });

    const chip = screen.getByTestId('tracker-field-pill-owner');
    expect(chip.getAttribute('data-empty')).toBe('true');

    fireEvent.click(chip);
    expect(screen.getByTestId('tracker-field-popover-header-owner').textContent).toBe('Owner');
    screen.getByTestId('tracker-field-choices-owner');

    fireEvent.click(screen.getByText('Ada'));
    expect(onSave).toHaveBeenCalledWith('owner', 'ada@example.com');
  });

  it('heads form-style editors once, without the editor repeating the label', () => {
    renderPills([dueField], { dueDate: '2026-07-30' });

    fireEvent.click(screen.getByTestId('tracker-field-pill-dueDate'));
    const popover = screen.getByTestId('tracker-field-popover-dueDate');
    expect(screen.getByTestId('tracker-field-popover-header-dueDate').textContent)
      .toBe('Due Date');
    expect(popover.querySelectorAll('label').length).toBe(0);
  });

  it('formats Date instances instead of treating them as empty objects', () => {
    renderPills([dueField], { dueDate: new Date(2026, 6, 30) });

    const chip = screen.getByTestId('tracker-field-pill-dueDate');
    expect(chip.getAttribute('data-empty')).toBe('false');
    expect(chip.textContent).toContain('Jul');
    expect(chip.textContent).toContain('30');
  });

  it('renders read-only chips without opening an editor', () => {
    renderPills([tagsField], { tags: ['design'] }, { editable: false });

    const chip = screen.getByTestId('tracker-field-pill-tags') as HTMLButtonElement;
    expect(chip.textContent).toContain('design');
    expect(chip.disabled).toBe(true);

    fireEvent.click(chip);
    expect(screen.queryByTestId('tracker-field-popover-tags')).toBeNull();
  });

  it('labels filled chips whose value cannot name its own field', () => {
    const shotField: FieldDefinition = { name: 'shootDate', type: 'date' };
    const briefField: FieldDefinition = { name: 'brief', type: 'url' };
    renderPills(
      [statusField, dueField, shotField, briefField, ownerField],
      {
        state: 'open',
        dueDate: '2026-05-29',
        shootDate: '2026-05-01',
        brief: { url: 'https://drive.example/brief' },
        owner: '',
      },
    );

    const labelOf = (field: string): string | undefined => screen
      .getByTestId(`tracker-field-pill-${field}`)
      .querySelector('.tracker-field-pill-label')?.textContent ?? undefined;

    // Two dates and a URL are indistinguishable as bare values (#1166).
    expect(labelOf('dueDate')).toBe('Due Date');
    expect(labelOf('shootDate')).toBe('Shoot Date');
    expect(labelOf('brief')).toBe('Brief');

    // A select value is already its own label, so labelling it would duplicate.
    expect(labelOf('state')).toBeUndefined();

    // An empty chip renders the label as its value; it must not show up twice.
    expect(labelOf('owner')).toBeUndefined();
    expect(screen.getByTestId('tracker-field-pill-owner').textContent).toContain('Owner');
  });

  it('honours a surface-specific test id base and row class', () => {
    renderPills([statusField], { state: 'open' }, {
      testIdBase: 'tracker-document-field',
      className: 'tracker-document-field-pills',
    });

    const row = screen.getByTestId('tracker-document-field-pills');
    expect(row.className).toContain('tracker-field-pills');
    expect(row.className).toContain('tracker-document-field-pills');
    screen.getByTestId('tracker-document-field-pill-state');
  });
});
