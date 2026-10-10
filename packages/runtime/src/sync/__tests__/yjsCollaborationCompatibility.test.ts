// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createUndoManager } from '@lexical/yjs';
import { CollabLexicalProvider } from '../CollabLexicalProvider';

function blockState(doc: Y.Doc) {
  const block = doc.get('root', Y.XmlText).toDelta()[0]?.insert as Y.XmlText | undefined;
  return block && { attributes: block.getAttributes(), text: block.toString() };
}

describe('Yjs collaboration compatibility', () => {
  it('merges adjacent deletions without changing a retained snapshot delete set', () => {
    const doc = new Y.Doc({ gc: false });
    try {
      const text = doc.getText('body');
      text.insert(0, 'abcd');
      text.delete(0, 1);
      const before = Y.snapshot(doc);
      const retained = [...before.ds.clients.values()].map(items => items.map(item => ({ ...item })));
      text.delete(0, 1);
      const merged = Y.mergeDeleteSets([before.ds, Y.snapshot(doc).ds]);
      expect([...merged.clients.values()][0]).toEqual([{ clock: 0, len: 2 }]);
      expect([...before.ds.clients.values()].map(items => items.map(item => ({ ...item })))).toEqual(retained);
    } finally {
      doc.destroy();
    }
  });

  it('preserves restored block attributes through the editor bridge, reconnect and remount', async () => {
    const shared = new Y.Doc();
    const remote = new Y.Doc();
    const root = shared.get('root', Y.XmlText);
    const block = new Y.XmlText();
    block.setAttribute('__type', 'paragraph');
    block.setAttribute('__format', 0);
    block.insert(0, 'Retained content');
    root.insertEmbed(0, block);
    const provider = new CollabLexicalProvider({
      getYDoc: () => shared,
      getStatus: () => 'connected',
      onAwarenessChange: () => () => {},
      setLocalAwareness: () => {},
      connect: async () => {},
    } as any);
    let undo: Y.UndoManager | undefined;
    let retired: Y.Doc | undefined;
    try {
      await provider.connect();
      const mounted = provider.getYDoc();
      const editorRoot = mounted.get('root', Y.XmlText);
      const editorBlock = editorRoot.toDelta()[0].insert as Y.XmlText;
      // Same undo factory and tracked-origin policy as Lexical's collaboration hook.
      undo = createUndoManager({} as Parameters<typeof createUndoManager>[0], editorRoot);
      mounted.transact(() => {
        editorBlock.setAttribute('__format', 1);
        editorRoot.delete(0, 1);
      });
      expect(blockState(shared)).toBeUndefined();
      undo.undo();
      const expected = { attributes: { __type: 'paragraph', __format: 0 }, text: 'Retained content' };
      expect(blockState(mounted)).toEqual(expected);
      // A newly joining peer must receive attributes on the restored parent.
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(shared));
      expect(blockState(remote)).toEqual(expected);
      expect(blockState(shared)).toEqual(expected);
      undo.redo();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(shared, Y.encodeStateVector(remote)));
      expect(blockState(remote)).toBeUndefined();
      undo.undo();
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(shared, Y.encodeStateVector(remote)));
      expect(blockState(remote)).toEqual(expected);
      provider.disconnect();
      await provider.connect();
      expect(blockState(provider.getYDoc())).toEqual(expected);
      undo.destroy();
      retired = mounted;
      provider.prepareForBinding();
      expect(provider.getYDoc()).not.toBe(retired);
      await provider.connect();
      expect(blockState(provider.getYDoc())).toEqual(expected);
      remote.getMap('comments').set('remote', 'after remount');
      Y.applyUpdate(shared, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(shared)), 'remote');
      expect(provider.getYDoc().getMap('comments').get('remote')).toBe('after remount');
      const current = provider.getYDoc();
      provider.destroy();
      shared.getMap('comments').set('later', 'after teardown');
      expect(current.getMap('comments').has('later')).toBe(false);
    } finally {
      undo?.destroy();
      provider.destroy();
      retired?.destroy();
      shared.destroy();
      remote.destroy();
    }
  });

  it('removes each Lexical undo destroy handler when a binding is retired', () => {
    const doc = new Y.Doc();
    const on = vi.spyOn(doc, 'on');
    const off = vi.spyOn(doc, 'off');
    try {
      for (let mount = 0; mount < 3; mount++) {
        const undo = createUndoManager({} as Parameters<typeof createUndoManager>[0], doc.get('root', Y.XmlText));
        const handler = on.mock.calls.findLast(([event]) => event === 'destroy')![1];
        undo.destroy();
        expect(off).toHaveBeenCalledWith('destroy', handler);
        off.mockClear();
      }
    } finally {
      doc.destroy();
    }
  });
});
