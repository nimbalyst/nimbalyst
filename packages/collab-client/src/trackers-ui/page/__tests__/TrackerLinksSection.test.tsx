// @vitest-environment jsdom
/**
 * The Links section groups a page's links by how they read from this page:
 * outgoing under the relation, incoming under its inverse, symmetric relations
 * merged, plain body links as Mentions / Mentioned in.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalRegistry, type TrackerDataModel } from '@nimbalyst/tracker-schema';
import { TrackerLinksSection } from '../TrackerLinksSection';
import type { PageLinksSource, TrackerPageLink } from '../pageLinks';

const linksFor = vi.fn<PageLinksSource['linksFor']>();
const source: PageLinksSource = { linksFor };

function model(type: string, displayName: string, fields: TrackerDataModel['fields'] = []): TrackerDataModel {
  return {
    type, displayName, displayNamePlural: `${displayName}s`, icon: 'article', color: '#888',
    modes: { inline: false, fullDocument: true }, idPrefix: type, idFormat: 'ulid', fields,
  } as TrackerDataModel;
}

function link(partial: Partial<TrackerPageLink> & Pick<TrackerPageLink, 'direction' | 'otherItemId'>): TrackerPageLink {
  return {
    predicateId: null, relationshipTypeKey: null, otherTitle: partial.otherItemId.toUpperCase(), otherIssueKey: null,
    otherTypeId: 'lnk-system', sentence: null, sourceFieldId: 'body:link', ...partial,
  };
}

const line = (label: string) => screen.getByText(label).closest('.tracker-links-line') as HTMLElement;

beforeAll(() => {
  globalRegistry.register(model('lnk-system', 'System', [{ name: 'dependsOn', type: 'relationship', relationshipTypeKey: 'depends-on' } as any]));
  globalRegistry.register(model('lnk-product', 'Product'));
  globalRegistry.setPredicates([
    { id: 'built-on', label: 'Built on', inverseLabel: 'Underlies', subjectKinds: ['*'], valueShape: 'entity', direction: 'directed' } as any,
    { id: 'alternative-to', label: 'Alternative to', subjectKinds: ['*'], valueShape: 'entity', direction: 'symmetric' } as any,
  ]);
});

afterAll(() => {
  globalRegistry.unregister('lnk-system');
  globalRegistry.unregister('lnk-product');
  globalRegistry.setPredicates([]);
});

beforeEach(() => {
  linksFor.mockReset();
});

describe('TrackerLinksSection', () => {
  it('groups relations by how they read from this page', async () => {
    linksFor.mockResolvedValue([
      link({ direction: 'out', otherItemId: 'do', predicateId: 'built-on', sourceFieldId: 'body:built-on', sentence: 'Runs on Durable Objects.' }),
      link({ direction: 'in', otherItemId: 'flags', otherTypeId: 'lnk-product', predicateId: 'built-on', sourceFieldId: 'body:built-on', sentence: 'Storage lives in Flagship.' }),
      link({ direction: 'out', otherItemId: 'ld', predicateId: 'alternative-to', sourceFieldId: 'body:alternative-to' }),
      link({ direction: 'in', otherItemId: 'gb', predicateId: 'alternative-to', sourceFieldId: 'body:alternative-to' }),
      link({ direction: 'in', otherItemId: 'ld', predicateId: 'alternative-to', sourceFieldId: 'body:alternative-to' }),
      link({ direction: 'out', otherItemId: 'arch', sentence: 'See arch.' }),
      link({ direction: 'in', otherItemId: 'limits' }),
      // Field-derived, no predicate: the field on the OTHER item's type names it, read inversely.
      link({ direction: 'in', otherItemId: 'worker', predicateId: null, sourceFieldId: 'dependsOn' }),
      // The indexed type key overrides the field default (`depends-on` field holding a `blocks` value).
      link({ direction: 'out', otherItemId: 'queue', predicateId: null, sourceFieldId: 'dependsOn', relationshipTypeKey: 'blocks' }),
    ]);
    const onOpenItem = vi.fn();
    render(<TrackerLinksSection linksSource={source} itemId="me" itemType="lnk-system" onOpenItem={onOpenItem} />);

    await screen.findByText('Built on');
    expect(linksFor).toHaveBeenCalledWith('me');
    within(line('Built on')).getByText('DO');
    within(line('Underlies')).getByText('FLAGS');
    within(line('Underlies')).getByText('Product');
    // Symmetric: both directions under one label, each page once.
    expect(within(line('Alternative to')).getAllByRole('button').map((b) => b.textContent)).toEqual(['SystemLD', 'SystemGB']);
    within(line('Mentions')).getByText('ARCH');
    within(line('Mentioned in')).getByText('LIMITS');
    within(line('Blocks')).getByText('WORKER');
    within(line('Blocks')).getByText('QUEUE');
    expect(screen.queryByText('Depends on')).toBeNull();

    // Collapsed lines hide the sentence; expanding shows it.
    expect(screen.queryByText('Storage lives in Flagship.')).toBeNull();
    fireEvent.click(line('Underlies'));
    screen.getByText('Storage lives in Flagship.');
    expect(screen.queryByText('Runs on Durable Objects.')).toBeNull();

    // Opening a page does not toggle the line.
    fireEvent.click(within(line('Built on')).getByText('DO'));
    expect(onOpenItem).toHaveBeenCalledWith('do', { newTab: false });
    expect(screen.queryByText('Runs on Durable Objects.')).toBeNull();
  });

  it('labels workspace keys with no registered type from the key going out and the other field coming in', async () => {
    linksFor.mockResolvedValue([
      link({ direction: 'out', otherItemId: 'hub', predicateId: null, sourceFieldId: 'parent', relationshipTypeKey: 'part-of' }),
      link({ direction: 'in', otherItemId: 'leaf', predicateId: null, sourceFieldId: 'parent', relationshipTypeKey: 'part-of' }),
      link({ direction: 'in', otherItemId: 'q1', predicateId: null, sourceFieldId: 'subjects', relationshipTypeKey: 'concerns' }),
    ]);
    render(<TrackerLinksSection linksSource={source} itemId="me" itemType="lnk-system" onOpenItem={vi.fn()} />);

    await screen.findByText('Part of');
    within(line('Part of')).getByText('HUB');
    within(line('Parent of')).getByText('LEAF');
    within(line('Subjects of')).getByText('Q1');
    expect(screen.queryByText('parent')).toBeNull();
  });

  it('renders nothing without links and refetches when the revision bumps', async () => {
    linksFor.mockResolvedValue([]);
    const { container, rerender } = render(<TrackerLinksSection linksSource={source} itemId="me" revision={0} />);
    await waitFor(() => expect(linksFor).toHaveBeenCalledTimes(1));
    expect(container.innerHTML).toBe('');

    linksFor.mockResolvedValue([link({ direction: 'out', otherItemId: 'arch' })]);
    rerender(<TrackerLinksSection linksSource={source} itemId="me" revision={1} />);
    await screen.findByText('Mentions');
    expect(linksFor).toHaveBeenCalledTimes(2);
  });
});
