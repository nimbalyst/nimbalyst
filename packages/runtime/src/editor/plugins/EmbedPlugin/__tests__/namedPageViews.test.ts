// @vitest-environment node
import { createHeadlessEditor } from '@lexical/headless';
import { $createCodeNode, CodeNode } from '@lexical/code';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';
import { describe, expect, it } from 'vitest';
import { EmbeddedFileNode } from '../EmbeddedFileNodeCore';
import { createNamedPageViewsController } from '../namedPageViewsController';

describe('named page views', () => {
  it('keeps malformed source and refuses new metadata until it is repaired', () => {
    const editor = createHeadlessEditor({ nodes: [EmbeddedFileNode, CodeNode], onError: error => { throw error; } });
    editor.update(() => $getRoot().append($createCodeNode('page-view').append($createTextNode('{broken'))), { discrete: true });
    const views = createNamedPageViewsController(editor, 'task');
    expect(views.getSnapshot().error).toContain('invalid data');
    expect(() => views.add('new', 'New', {})).toThrow('invalid data');
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toContain('{broken');
    views.dispose();
  });
  it('edits only the addressed view and refuses mutations after permission loss or teardown', () => {
    const editor = createHeadlessEditor({ nodes: [EmbeddedFileNode], onError: error => { throw error; } });
    editor.update(() => $getRoot().append($createParagraphNode().append($createTextNode('Preserve this description.'))), { discrete: true });
    const views = createNamedPageViewsController(editor, 'task');
    views.add('one', 'First', { mode: 'list', custom: 'future' });
    views.add('two', 'Second', { mode: 'board' });
    views.rename('one', 'Renamed');
    views.patch('one', { sort: 'title:asc' });
    expect(views.getSnapshot().views.find(view => view.id === 'one')).toEqual({ id: 'one', name: 'Renamed', type: 'task', attrs: { mode: 'list', custom: 'future', sort: 'title:asc' } });
    views.remove('two');
    expect(() => views.patch('two', { mode: 'table' })).toThrow('removed');
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toContain('Preserve this description.');
    editor.setEditable(false);
    expect(views.getSnapshot().editable).toBe(false);
    expect(() => views.add('three', 'Denied', {})).toThrow('not editable');
    editor.setEditable(true);
    views.dispose();
    expect(() => views.remove('one')).toThrow('not editable');
  });
});
