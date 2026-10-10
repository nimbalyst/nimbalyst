// @vitest-environment jsdom
/**
 * The typed page layout runs without the desktop: the host hands it the item,
 * crumb and field values, a body to render and a links source.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { globalRegistry, type TrackerDataModel } from '@nimbalyst/tracker-schema';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { TrackerPageView } from '../TrackerPageView';
import { PlainPageHeader } from '../PlainPageHeader';

const MODULE = {
  type: 'tpv-module', displayName: 'Module', displayNamePlural: 'Modules', icon: 'widgets', color: '#888',
  modes: { inline: false, fullDocument: true }, idPrefix: 'mod', idFormat: 'ulid',
  fields: [{ name: 'title', type: 'string' }],
} as unknown as TrackerDataModel;

const item = {
  id: 'mod_1', primaryType: 'tpv-module', typeTags: [], issueKey: 'MOD-1', archived: false, source: 'native',
  fields: { title: 'Sync engine' }, fieldUpdatedAt: {}, system: {},
} as unknown as TrackerRecord;

beforeAll(() => globalRegistry.register(MODULE));
afterAll(() => globalRegistry.unregister('tpv-module'));

describe('TrackerPageView', () => {
  it('lays out crumb, title, body and links from host-supplied pieces', async () => {
    expect((window as { electronAPI?: unknown }).electronAPI).toBeUndefined();
    const onRename = vi.fn();
    const onShowHistory = vi.fn();
    const linksFor = vi.fn().mockResolvedValue([{
      direction: 'out', otherItemId: 'mod_2', otherTitle: 'Storage', otherIssueKey: 'MOD-2', otherTypeId: 'tpv-module',
      predicateId: null, relationshipTypeKey: null, sentence: 'Writes go to Storage.', sourceFieldId: 'body:link',
    }]);

    render(
      <TrackerPageView
        item={item}
        loaded
        crumb={{ section: 'Personal', ancestors: ['Architecture'], underType: true }}
        editable
        title="Sync engine"
        onRename={onRename}
        fieldValues={item.fields}
        onUpdateField={vi.fn()}
        renderBody={() => <p>Body from the host</p>}
        linksSource={{ linksFor }}
        onShowHistory={onShowHistory}
      />,
    );

    expect(screen.getByTestId('tracker-page-crumb').textContent).toBe('Personal / Architecture / Module / Sync engine');
    screen.getByText('Body from the host');
    await screen.findByText('Mentions');
    expect(linksFor).toHaveBeenCalledWith('mod_1');

    fireEvent.change(screen.getByTestId('tracker-page-title'), { target: { value: 'Sync\nengine v2' } });
    expect(onRename).toHaveBeenCalledWith('Sync engine v2');

    // Agent edits land directly, so the body's history is how one is reverted.
    fireEvent.click(screen.getByRole('button', { name: 'Page history' }));
    expect(onShowHistory).toHaveBeenCalledOnce();
  });

  it('archives the typed page from its header only after the in-app confirm, then says it is archived', async () => {
    const onArchive = vi.fn();
    const page = (record: TrackerRecord) => (
      <TrackerPageView
        item={record} loaded crumb={{ ancestors: [], underType: false }} editable title="Sync engine"
        onRename={vi.fn()} fieldValues={record.fields} onUpdateField={vi.fn()} renderBody={() => null} onArchive={onArchive}
      />
    );
    const { rerender } = render(page(item));
    fireEvent.click(screen.getByRole('button', { name: 'Archive page' }));
    const dialog = await screen.findByTestId('collab-confirm-dialog');
    expect(onArchive).not.toHaveBeenCalled();
    fireEvent.click(dialog.querySelector('.collab-confirm-accept')!);
    await waitFor(() => expect(onArchive).toHaveBeenCalledOnce());

    rerender(page({ ...item, archived: true } as TrackerRecord));
    expect(screen.queryByRole('button', { name: 'Archive page' })).toBeNull();
    screen.getByText('Archived');
    cleanup();
  });

  it('in the header strip, opens each page above it and keeps Archive behind the menu', async () => {
    const onOpenAncestor = vi.fn();
    const onArchive = vi.fn();
    const onShowHistory = vi.fn();
    render(
      <TrackerPageView
        item={item} loaded editable title="Sync engine"
        crumb={{
          ancestors: ['Architecture'], underType: true,
          path: [{ id: 'arch', kind: 'page', name: 'Architecture' }, { id: 'tpv-module', kind: 'type', name: 'Modules' }],
        }}
        onRename={vi.fn()} fieldValues={item.fields} onUpdateField={vi.fn()} renderBody={() => null}
        onShowHistory={onShowHistory} onArchive={onArchive} headerBar={{ onOpenAncestor }}
      />,
    );

    expect(screen.queryByTestId('tracker-page-crumb')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Modules' }));
    expect(onOpenAncestor).toHaveBeenCalledWith(expect.objectContaining({ id: 'tpv-module', kind: 'type' }));
    fireEvent.click(screen.getByRole('button', { name: 'Page history' }));
    expect(onShowHistory).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByTestId('page-header-menu-archive'));
    fireEvent.click((await screen.findByTestId('collab-confirm-dialog')).querySelector('.collab-confirm-accept')!);
    await waitFor(() => expect(onArchive).toHaveBeenCalledOnce());
    cleanup();
  });
});

describe('PlainPageHeader', () => {
  it('renames on Enter only when the title changed, and Escape puts the title back', () => {
    const onRename = vi.fn();
    const onSetType = vi.fn();
    render(<PlainPageHeader title="Product" editable onRename={onRename} onSetType={onSetType} onUpdateField={vi.fn()} />);
    const title = screen.getByTestId('plain-page-title') as HTMLTextAreaElement;

    fireEvent.focus(title);
    fireEvent.keyDown(title, { key: 'Enter' });
    fireEvent.blur(title);
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Draft' } });
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(title.value).toBe('Product');

    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Product areas ' } });
    fireEvent.blur(title);
    expect(onRename).toHaveBeenCalledExactlyOnceWith('Product areas');

    // A plain page's type chip changes its type; its "+" offers its own fields.
    fireEvent.click(screen.getByTestId('plain-page-type'));
    expect(onSetType).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    expect(Array.from(screen.getByTestId('plain-page-add-field-menu').querySelectorAll('[role="menuitem"]'))
      .map((entry) => entry.getAttribute('data-field'))).toEqual(['status', 'owner', 'summary']);
    cleanup();
  });
});
