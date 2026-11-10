// @vitest-environment node
/**
 * Thread anchor state read from a page's Y.Doc built the way Lexical's yjs
 * binding stores it: a mark element names its threads in `__ids`; a thread
 * with no mark is anchored when its quote occurs exactly once in the text.
 * The doc is rebuilt from its update first, as the room delivers it, so the
 * top-level types arrive untyped.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { openThreads, readPageComments } from '../teamComments.js';

function paragraph(parent: Y.XmlText, at: number, parts: Array<string | { mark: string[]; text: string }>): void {
  const p = new Y.XmlText();
  parent.insertEmbed(at, p);
  p.setAttribute('__type', 'paragraph');
  let offset = 0;
  for (const part of parts) {
    if (typeof part === 'string') {
      p.insertEmbed(offset++, new Y.Map([['__type', 'text']]));
      p.insert(offset, part);
      offset += part.length;
    } else {
      const mark = new Y.XmlText();
      p.insertEmbed(offset++, mark);
      mark.setAttribute('__type', 'mark');
      mark.setAttribute('__ids', part.mark as any);
      mark.insertEmbed(0, new Y.Map([['__type', 'text']]));
      mark.insert(1, part.text);
    }
  }
}

function thread(id: string, quote: string, extra: Record<string, unknown> = {}, comments: Array<Record<string, unknown>> = [{ id: `${id}-c`, content: 'Please fix', timeStamp: 1, deleted: false, author: 'Ana', actor: { kind: 'user', displayName: 'Ana' } }]): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('type', 'thread');
  map.set('id', id);
  map.set('quote', quote);
  map.set('resolved', false);
  for (const [k, v] of Object.entries(extra)) map.set(k, v);
  const list = new Y.Array<Y.Map<unknown>>();
  list.push(comments.map((c) => new Y.Map(Object.entries({ type: 'comment', ...c }))));
  map.set('comments', list);
  return map;
}

/** The doc as a fresh client receives it: one update, nothing typed. */
function received(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

describe('readPageComments', () => {
  it('reports marked, quote-found and orphaned threads, and lists only open ones', () => {
    const doc = new Y.Doc();
    const root = doc.get('root', Y.XmlText);
    paragraph(root, 0, ['The plan ships ', { mark: ['t-marked'], text: 'in March' }, '.']);
    paragraph(root, 1, ['Pricing is flat. Pricing is flat.']);
    paragraph(root, 2, ['Reviewers comment here.']);
    doc.getArray('comments').push([
      thread('t-marked', 'in March'),
      thread('t-quote', 'Reviewers comment', { anchor: { kind: 'text-quote', exact: 'Reviewers comment' } }),
      thread('t-twice', 'Pricing is flat', { anchor: { kind: 'text-quote', exact: 'Pricing is flat' } }),
      thread('t-lost', 'old wording'),
      thread('t-done', 'in March', { resolved: true }),
      thread('t-empty', 'in March', {}, [{ id: 'x', content: 'gone', timeStamp: 2, deleted: true }]),
    ]);

    const page = readPageComments(received(doc));

    const states = Object.fromEntries(page.threads.map((t) => [t.id, t.anchorState]));
    expect(states).toEqual({ 't-marked': 'marked', 't-quote': 'quote', 't-twice': 'orphaned', 't-lost': 'orphaned', 't-done': 'quote', 't-empty': 'quote' });
    expect(page.threads.find((t) => t.id === 't-quote')!.anchorKind).toBe('text-quote');
    expect(openThreads(page).map((t) => t.id)).toEqual(['t-marked', 't-quote', 't-twice', 't-lost']);
    expect(openThreads(page)[0].comments[0]).toMatchObject({ author: 'Ana', content: 'Please fix', byAgent: false });
  });

  it('joins top-level blocks with one newline, as the editor does', () => {
    const doc = new Y.Doc();
    const root = doc.get('root', Y.XmlText);
    paragraph(root, 0, ['first']);
    paragraph(root, 1, ['second']);
    doc.getArray('comments').push([thread('glued', 'firstsecond'), thread('joined', 'first\nsecond')]);
    const page = readPageComments(received(doc));
    expect(page.text).toBe('first\nsecond');
    expect(Object.fromEntries(page.threads.map((t) => [t.id, t.anchorState]))).toEqual({ glued: 'orphaned', joined: 'quote' });
  });

  it('tells a repeated quote apart by its prefix and suffix', () => {
    const doc = new Y.Doc();
    const root = doc.get('root', Y.XmlText);
    paragraph(root, 0, ['Ship by Friday. Review by Friday.']);
    doc.getArray('comments').push([
      thread('bare', 'by Friday', { anchor: { kind: 'text-quote', exact: 'by Friday' } }),
      thread('context', 'by Friday', { anchor: { kind: 'text-quote', exact: 'by Friday', prefix: 'Review ', suffix: '.' } }),
      thread('entity', '', { anchor: { kind: 'entity', entityType: 'tracker', entityId: 'x' } }),
    ]);
    const states = Object.fromEntries(readPageComments(received(doc)).threads.map((t) => [t.id, t.anchorState]));
    expect(states).toEqual({ bare: 'orphaned', context: 'quote', entity: 'entity' });
  });

  it('keeps a quote whose neighbours were edited anchored when the bare quote is unique, as the editor does', () => {
    const doc = new Y.Doc();
    const root = doc.get('root', Y.XmlText);
    paragraph(root, 0, ['Ship by Monday. Review by Friday.']);
    doc.getArray('comments').push([
      // Written as "Approve by Friday." before a publish changed the word before it.
      thread('moved', 'by Friday', { anchor: { kind: 'text-quote', exact: 'by Friday', prefix: 'Approve ', suffix: '.' } }),
      // The bare quote occurs twice: no fallback.
      thread('ambiguous', 'by', { anchor: { kind: 'text-quote', exact: 'by', prefix: 'Approve ' } }),
    ]);
    const states = Object.fromEntries(readPageComments(received(doc)).threads.map((t) => [t.id, t.anchorState]));
    expect(states).toEqual({ moved: 'quote', ambiguous: 'orphaned' });
  });

  it('reads a list as one block, the text of its items run together', () => {
    const doc = new Y.Doc();
    const root = doc.get('root', Y.XmlText);
    paragraph(root, 0, ['Intro']);
    const list = new Y.XmlText();
    root.insertEmbed(1, list);
    list.setAttribute('__type', 'list');
    paragraph(list, 0, ['alpha']);
    paragraph(list, 1, [{ mark: ['m'], text: 'beta' }]);
    doc.getArray('comments').push([thread('m', 'beta'), thread('item', 'alpha'), thread('across', 'alpha\nbeta')]);
    const page = readPageComments(received(doc));
    expect(page.text).toBe('Intro\nalphabeta');
    expect(Object.fromEntries(page.threads.map((t) => [t.id, t.anchorState]))).toEqual({ m: 'marked', item: 'quote', across: 'orphaned' });
  });
});
