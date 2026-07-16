// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CollabCreateItemDialog } from '../CollabCreateItemDialog';
import type { SharedFolder } from '../../../store/atoms/collabDocuments';

vi.mock('@nimbalyst/runtime', () => ({
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
    expect(screen.getByText('Pick where this folder should live in your team space.')).toBeTruthy();
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
    expect(screen.getByText('Will be created as')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create Folder' }));
    expect(onConfirm).toHaveBeenCalledWith('Architecture');
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
            embed: false,
          },
        }}
        folders={folders}
        targetFolderId={null}
        onTargetFolderChange={() => {}}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText('New Shared Mockup')).toBeTruthy();
    expect(screen.getByText('.mockup.html')).toBeTruthy();
    expect(document.querySelector('[data-icon="palette"]')).toBeTruthy();
    fireEvent.change(screen.getByTestId('collab-create-name-input'), {
      target: { value: 'Checkout.mockup.html' },
    });
    expect((screen.getByTestId('collab-create-name-input') as HTMLInputElement).value).toBe('Checkout');
    fireEvent.click(screen.getByRole('button', { name: 'Create Mockup' }));
    expect(onConfirm).toHaveBeenCalledWith('Checkout');
  });
});
