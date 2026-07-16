// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CollaborativeDocumentTypeDescriptor } from '../../../services/CollaborativeDocumentTypeCatalog';
import {
  buildSharedNewDocumentMenuItems,
  CollabNewDocumentMenu,
} from '../CollabNewDocumentMenu';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

function descriptor(
  documentType: string,
  displayName: string,
  suffix: string,
  ready: boolean,
  localCreate = true,
): CollaborativeDocumentTypeDescriptor {
  return {
    documentType,
    displayName,
    fileExtensions: [suffix],
    defaultExtension: suffix,
    icon: documentType === 'markdown' ? 'description' : 'extension',
    editor: documentType === 'markdown'
      ? { kind: 'lexical' }
      : { kind: 'extension', extensionId: `com.nimbalyst.${documentType}` },
    content: { strategy: documentType === 'markdown' ? 'lexical' : 'structured-yjs', codecId: documentType },
    creation: { defaultContent: `new ${documentType}`, source: documentType === 'markdown' ? 'builtin' : 'newFileMenu' },
    capabilities: {
      localCreate,
      shareToTeam: ready,
      sharedCreate: ready,
      history: ready,
      export: ready,
      embed: false,
      ...(ready ? {} : { disabledReason: `${displayName} is pending collaborative support.` }),
    },
  };
}

afterEach(cleanup);

describe('Shared New catalog menu', () => {
  it('enables exactly the first-wave types and keeps later types visible with reasons', () => {
    const ready = [
      descriptor('markdown', 'Markdown', '.md', true),
      descriptor('excalidraw', 'Excalidraw Diagram', '.excalidraw', true),
      descriptor('prisma', 'Data Model', '.prisma', true),
      descriptor('csv', 'CSV Spreadsheet', '.csv', true),
      descriptor('mockup.html', 'Mockup', '.mockup.html', true),
      descriptor('mockupproject', 'Mockup Project', '.mockupproject', true),
      descriptor('calc.md', 'Calc Sheet', '.calc.md', true),
    ];
    const code = descriptor('code', 'Text / Code', '.ts', false);
    code.editor = { kind: 'monaco' };
    const laterExtension = descriptor('mindmap', 'Mind Map', '.mindmap', false);
    const virtualTab = descriptor('browser', 'Browser Tab', '.browser', false, false);
    virtualTab.creation = undefined;

    const items = buildSharedNewDocumentMenuItems([...ready, code, laterExtension, virtualTab]);
    expect(items.filter(item => !item.disabledReason).map(item => item.descriptor.documentType)).toEqual([
      'markdown',
      'calc.md',
      'csv',
      'prisma',
      'excalidraw',
      'mockup.html',
      'mockupproject',
    ]);
    expect(items.filter(item => item.disabledReason).map(item => item.descriptor.documentType)).toEqual([
      'mindmap',
      'code',
    ]);
    expect(items.some(item => item.descriptor.documentType === 'browser')).toBe(false);

    const onSelect = vi.fn();
    render(<CollabNewDocumentMenu items={items} onSelect={onSelect} />);
    const codeButton = screen.getByRole('menuitem', { name: /Text \/ Code/ });
    expect(codeButton.hasAttribute('disabled')).toBe(true);
    expect(codeButton.textContent).toContain('pending collaborative support');
    fireEvent.click(codeButton);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: /Excalidraw Diagram/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ documentType: 'excalidraw' }));
  });
});
