// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NewFileDialog } from '../NewFileDialog';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

describe('NewFileDialog', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        getFolderContents: vi.fn().mockResolvedValue([]),
      },
    });
  });

  afterEach(cleanup);

  it('renders an explicit dropdown affordance for the file type selector', () => {
    render(
      <NewFileDialog
        isOpen={true}
        onClose={() => {}}
        currentDirectory="/workspace"
        workspacePath="/workspace"
        onCreateFile={() => {}}
      />,
    );

    expect(screen.getByLabelText('Type').tagName).toBe('SELECT');
    expect(screen.getByTestId('new-file-type-chevron')).toBeTruthy();
    expect(document.querySelector('[data-icon="expand_more"]')).toBeTruthy();
  });
});
