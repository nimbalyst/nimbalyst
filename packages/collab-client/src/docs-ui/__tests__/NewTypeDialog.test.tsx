// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CollabTypeTreeResolver } from '../../docs/collabTree';
import type { CollabDocsSession } from '../../docs/session';
import { NewTypeDialog } from '../NewTypeDialog';
import { SetPageTypeDialog } from '../SetPageTypeDialog';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

afterEach(cleanup);

const resolver: CollabTypeTreeResolver = {
  typeName: (typeId) => (typeId === 'competitor' ? 'Competitors' : null),
  itemsOfType: () => [],
  listedTypes: () => [{ typeId: 'competitor', name: 'Competitors', icon: 'radar' }],
};

function setup(defineType = vi.fn(async () => undefined)) {
  const placeType = vi.fn(async () => ({ ok: true as const }));
  const onCreated = vi.fn();
  render(
    <NewTypeDialog
      lane="team"
      resolver={resolver}
      session={{ placeType } as unknown as CollabDocsSession}
      parent={{ id: 'page-1', kind: 'page' }}
      defineType={defineType}
      onCreated={onCreated}
      onClose={() => {}}
    />,
  );
  return { defineType, placeType, onCreated };
}

const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('NewTypeDialog', () => {
  it('writes the built schema, then places the type under the page it was opened from', async () => {
    const { defineType, placeType, onCreated } = setup();
    type('new-type-plural', 'Customers');
    fireEvent.click(screen.getByTestId('new-type-add-field'));
    type('new-type-field-label-0', 'Rivals');
    type('new-type-field-kind-0', 'relation');
    type('new-type-field-target-0', 'competitor');
    fireEvent.click(screen.getByTestId('new-type-create'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('customer'));
    expect(defineType).toHaveBeenCalledWith(expect.objectContaining({
      type: 'customer',
      displayName: 'Customer',
      displayNamePlural: 'Customers',
      sharing: 'team',
    }));
    expect((defineType.mock.calls[0] as unknown as [{ fields: unknown[] }])[0].fields).toContainEqual(
      { name: 'rivals', type: 'relationship', targetTrackerTypes: ['competitor'], multiValue: true },
    );
    expect(placeType).toHaveBeenCalledWith('customer', 'page-1', 'page');
    expect(defineType.mock.invocationCallOrder[0]).toBeLessThan(placeType.mock.invocationCallOrder[0]);
  });

  it('refuses an existing type id without writing anything', () => {
    const { defineType } = setup();
    type('new-type-plural', 'Competitors');
    fireEvent.click(screen.getByTestId('new-type-create'));
    screen.getByText('A type named "competitor" already exists.');
    expect(defineType).not.toHaveBeenCalled();
  });

  it('shows the host refusal and does not place the type', async () => {
    const { placeType } = setup(vi.fn(async () => { throw new Error('The team room refused the new type (forbidden).'); }));
    type('new-type-plural', 'Customers');
    fireEvent.click(screen.getByTestId('new-type-create'));
    await screen.findByText('The team room refused the new type (forbidden).');
    expect(placeType).not.toHaveBeenCalled();
    // What the person entered stays, so they can pick another name and retry.
    expect((screen.getByTestId('new-type-plural') as HTMLInputElement).value).toBe('Customers');
  });
});

describe('NewTypeDialog, while the team has not answered', () => {
  it('says the type is still syncing instead of claiming success, and keeps the form', async () => {
    const onClose = vi.fn();
    const placeType = vi.fn(async () => ({ ok: true as const }));
    render(
      <NewTypeDialog
        lane="team"
        resolver={resolver}
        session={{ placeType } as unknown as CollabDocsSession}
        defineType={vi.fn(async () => ({ status: 'syncing' as const }))}
        onClose={onClose}
      />,
    );
    type('new-type-plural', 'Customers');
    fireEvent.click(screen.getByTestId('new-type-create'));
    await screen.findByText(/still syncing to the team/);
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByTestId('new-type-plural') as HTMLInputElement).value).toBe('Customers');
  });
});

describe('Set type, in a section with no types', () => {
  it('offers New type when the host can write one', () => {
    const onNewType = vi.fn();
    const empty: CollabTypeTreeResolver = { typeName: () => null, itemsOfType: () => [], listedTypes: () => [] };
    render(<SetPageTypeDialog pageTitle="Acme" resolver={empty} running={false} onPick={() => {}} onClose={() => {}} onNewType={onNewType} />);
    fireEvent.click(screen.getByTestId('set-page-type-new-type'));
    expect(onNewType).toHaveBeenCalled();
  });
});
