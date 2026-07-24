// @vitest-environment jsdom
import React, { useLayoutEffect } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DocumentModel } from '../DocumentModel';
import { DocumentModelRegistry } from '../DocumentModelRegistry';
import type { DocumentBackingStore, DocumentModelEditorHandle } from '../types';
import { useDocumentModel } from '../useDocumentModel';

function createMockStore(): DocumentBackingStore & { dispose: () => void } {
  return {
    load: vi.fn(async () => ''),
    save: vi.fn(async () => {}),
    onExternalChange: vi.fn(() => () => {}),
    dispose: vi.fn(),
  };
}

interface Snapshot {
  handle: DocumentModelEditorHandle;
  model: DocumentModel;
}

function Probe({
  filePath,
  label,
  onSnapshot,
}: {
  filePath: string;
  label: string;
  onSnapshot: (label: string, snapshot: Snapshot) => void;
}) {
  const { model, handle } = useDocumentModel(filePath, {
    autosaveInterval: 0,
    getPendingTags: async () => [],
    updateTagStatus: async () => {},
  });

  useLayoutEffect(() => {
    onSnapshot(label, { model, handle });
  }, [handle, label, model, onSnapshot]);

  return null;
}

describe('useDocumentModel rename lifecycle', () => {
  beforeEach(() => {
    DocumentModelRegistry.clear();
    DocumentModelRegistry.setModelFactory((filePath: string) => {
      return new DocumentModel(filePath, createMockStore(), {
        autosaveInterval: 0,
        getPendingTags: async () => [],
        updateTagStatus: async () => {},
      });
    });
  });

  afterEach(() => {
    DocumentModelRegistry.clear();
    DocumentModelRegistry.setModelFactory(null);
  });

  it('keeps the same attachment when the component rerenders with the renamed path', () => {
    const snapshots = new Map<string, Snapshot>();
    const onSnapshot = (label: string, snapshot: Snapshot) => {
      snapshots.set(label, snapshot);
    };

    const view = render(
      <Probe filePath="/test/old.md" label="editor" onSnapshot={onSnapshot} />,
    );

    const first = snapshots.get('editor')!;
    first.handle.setDirty(true);

    expect(DocumentModelRegistry.rename('/test/old.md', '/test/new.md')).toBe(true);

    view.rerender(
      <Probe filePath="/test/new.md" label="editor" onSnapshot={onSnapshot} />,
    );

    const second = snapshots.get('editor')!;
    expect(second.model).toBe(first.model);
    expect(second.handle).toBe(first.handle);
    expect(second.model.isDirty()).toBe(true);

    view.unmount();
    expect(DocumentModelRegistry.has('/test/new.md')).toBe(false);
  });

  it('reuses the migrated model during an overlapped remount and cleans up the old handle', () => {
    const snapshots = new Map<string, Snapshot>();
    const onSnapshot = (label: string, snapshot: Snapshot) => {
      snapshots.set(label, snapshot);
    };

    const view = render(
      <Probe filePath="/test/old.md" label="old" onSnapshot={onSnapshot} />,
    );

    const first = snapshots.get('old')!;
    first.handle.setDirty(true);

    expect(DocumentModelRegistry.rename('/test/old.md', '/test/new.md')).toBe(true);

    view.rerender(
      <>
        <Probe filePath="/test/old.md" label="old" onSnapshot={onSnapshot} />
        <Probe filePath="/test/new.md" label="new" onSnapshot={onSnapshot} />
      </>,
    );

    const replacement = snapshots.get('new')!;
    expect(replacement.model).toBe(first.model);
    expect(replacement.model.getAttachCount()).toBe(2);

    view.rerender(
      <Probe filePath="/test/new.md" label="new" onSnapshot={onSnapshot} />,
    );

    const active = snapshots.get('new')!;
    expect(active.model).toBe(first.model);
    expect(active.model.getAttachCount()).toBe(1);
    expect(active.model.isDirty()).toBe(true);

    view.unmount();
    expect(DocumentModelRegistry.has('/test/new.md')).toBe(false);
  });
});
