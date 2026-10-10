// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CollabCreateItemDialog } from '../CollabCreateItemDialog';
import type { CollabTreeNode, CollabTreeTypeNode, SharedDocument, SharedFolder } from '@nimbalyst/collab-client/docs';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const folders: SharedFolder[] = [
  {
    folderId: 'f-specs',
    name: 'Specs',
    parentFolderId: null,
    sortOrder: 0,
    createdBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    folderId: 'f-api',
    name: 'API',
    parentFolderId: 'f-specs',
    sortOrder: 0,
    createdBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
  },
];

afterEach(cleanup);

describe('CollabCreateItemDialog', () => {
  it('lets a user retarget creation from a selected folder to Root', () => {
    const onConfirm = vi.fn();

    function Harness() {
      const [targetFolderId, setTargetFolderId] = useState<string | null>('f-specs');
      return (
        <CollabCreateItemDialog
          isOpen
          kind="folder"
          folders={folders}
          targetFolderId={targetFolderId}
          onTargetFolderChange={setTargetFolderId}
          onConfirm={onConfirm}
          onCancel={() => {}}
        />
      );
    }

    render(<Harness />);
    const embeddedPicker = screen.getByTestId('collab-create-location-picker');
    screen.getByText('Pick where this folder should live in your team space.');
    expect(embeddedPicker.textContent).toContain('Team root');
    expect(embeddedPicker.textContent).toContain('Specs');
    expect(embeddedPicker.textContent).toContain('API');
    expect(embeddedPicker.getAttribute('role')).toBe('tree');
    expect(screen.getByTestId('collab-create-location-option-root').querySelector('button')).toBeNull();
    expect(screen.getByTestId('collab-create-location-option-f-specs').getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByTestId('collab-create-location-option-root'));
    expect(screen.getByTestId('collab-create-location-option-root').getAttribute('aria-selected')).toBe('true');

    fireEvent.change(screen.getByTestId('collab-create-name-input'), {
      target: { value: 'Architecture' },
    });
    screen.getByText('Will be created as');
    fireEvent.click(screen.getByRole('button', { name: 'Create Folder' }));
    expect(onConfirm).toHaveBeenCalledWith('Architecture');
  });

  it('mirrors the page tree: types shown but not pickable, typed pages and their children as targets', () => {
    const page = (documentId: string, title: string, parentFolderId: string | null = null) => ({
      documentId, title, documentType: 'markdown', parentFolderId, createdBy: 'u', createdAt: 1, updatedAt: 1,
    }) as unknown as SharedDocument;
    const tree: CollabTreeNode[] = [{
      id: 'document:p-init', type: 'document', path: 'Initiatives', name: 'Initiatives', document: page('p-init', 'Initiatives'),
      children: [{
        id: 'type:initiative', type: 'type', typeId: 'initiative', path: '', name: 'Initiatives', count: 1,
        placement: {} as CollabTreeTypeNode['placement'],
        children: [{
          id: 'item:i-pages', type: 'item', itemId: 'i-pages', typeId: 'initiative', path: '', name: 'Pages', typeLabel: 'Initiative',
          children: [{
            id: 'document:p-problems', type: 'document', path: '', name: 'Problems with Pages',
            document: page('p-problems', 'Problems with Pages', 'i-pages'),
          }],
        }],
      }],
    }];
    const onTargetFolderChange = vi.fn();
    render(
      <CollabCreateItemDialog
        isOpen
        kind="document"
        folders={folders}
        tree={tree}
        rootLabel="Team"
        targetFolderId="p-problems"
        targetParentKind="page"
        onTargetFolderChange={onTargetFolderChange}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    // The selected page opens expanded down to it, nested under its typed page and type.
    const problems = screen.getByTestId('collab-create-location-option-document:p-problems');
    expect(problems.getAttribute('aria-selected')).toBe('true');
    expect(problems.style.paddingLeft).toBe(`${8 + 3 * 18}px`);
    expect(screen.queryByTestId('collab-create-location-option-f-specs')).toBeNull();
    screen.getByText('Initiatives / Initiatives / Pages / Problems with Pages /');

    fireEvent.click(screen.getByTestId('collab-create-location-option-item:i-pages'));
    expect(onTargetFolderChange).toHaveBeenCalledWith('i-pages', 'item');

    // A type row only collapses its items; it is never a target.
    const typeRow = screen.getByTestId('collab-create-location-option-type:initiative');
    expect(typeRow.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(typeRow);
    expect(onTargetFolderChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('collab-create-location-option-item:i-pages')).toBeNull();
  });

  it('shows the selected catalog type and keeps its compound suffix fixed', () => {
    const onConfirm = vi.fn();
    render(
      <CollabCreateItemDialog
        isOpen
        kind="document"
        documentDescriptor={{
          documentType: 'mockup.html',
          displayName: 'Mockup',
          fileExtensions: ['.mockup.html'],
          defaultExtension: '.mockup.html',
          icon: 'palette',
          editor: { kind: 'extension', extensionId: 'com.nimbalyst.mockuplm' },
          content: { strategy: 'text', codecId: 'mockup.html' },
          creation: { defaultContent: '<main />', source: 'newFileMenu' },
          capabilities: {
            localCreate: true,
            shareToTeam: true,
            sharedCreate: true,
            history: true,
            export: true,
          },
        }}
        folders={folders}
        targetFolderId={null}
        onTargetFolderChange={() => {}}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    screen.getByText('New Shared Mockup');
    screen.getByText('.mockup.html');
    expect(document.querySelector('[data-icon="palette"]')).toBeTruthy();
    fireEvent.change(screen.getByTestId('collab-create-name-input'), {
      target: { value: 'Checkout.mockup.html' },
    });
    expect((screen.getByTestId('collab-create-name-input') as HTMLInputElement).value).toBe('Checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Create Mockup' }));
    expect(onConfirm).toHaveBeenCalledWith('Checkout');
  });
});
