import { describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import type { ProjectGraphEdge } from '../../../types';
import type { PrototypeViewProps } from '../../contracts';
import { AtlasPrototype } from '../AtlasPrototype';
import { area, edge, event, model, node } from './atlasFixture';

/**
 * `a1` is deliberately filed in Collaboration *and* Delivery so the two
 * connection families (recorded edges, shared membership) both exist between
 * the same pair of areas. `Docs` is deliberately quiet in range.
 */
function defaultModel() {
  return model({
    nodes: [
      node('a1', { label: 'Access rules' }),
      node('a2', { label: 'Session queue' }),
      node('b1', { label: 'Release check' }),
      node('b2', { label: 'Rollout note' }),
      node('d1', { label: 'Naming decision' }),
      node('u1', { label: 'Loose CRM record' }),
    ],
    edges: [
      // Two links a source record carries, plus one the loader synthesized
      // from a file path -- they must not share a header.
      edge('e1', 'a1', 'b1', 'worked_on_in'),
      edge('e2', 'a2', 'b1', 'references'),
      edge('e3', 'a1', 'b2', 'part_of'),
    ],
    areas: [
      area('collab', 'Collaboration', ['a1', 'a2'], 'tag:collab'),
      area('delivery', 'Delivery', ['b1', 'b2', 'a1'], 'tag:delivery'),
      area('docs', 'Docs', ['d1'], 'tag:docs'),
      area('unassigned', 'Unassigned', ['u1'], 'no tag rule matched'),
    ],
    events: [
      event('ev1', 'a1', 150),
      event('ev2', 'a2', 160, { kind: 'last-activity', provenance: 'last-observed' }),
      event('ev3', 'd1', 10),
    ],
  });
}

function renderAtlas(over: Partial<PrototypeViewProps> = {}) {
  const props: PrototypeViewProps = {
    model: defaultModel(),
    range: { startMs: 100, endMs: 200 },
    selectedAreaId: null,
    selectedNodeId: null,
    onSelectArea: vi.fn(),
    onSelectNode: vi.fn(),
    onOpenNode: vi.fn(),
    onNavigate: vi.fn(),
    onRenameArea: vi.fn(),
    ...over,
  };
  return { props, ...render(<AtlasPrototype {...props} />) };
}

describe('AtlasPrototype', () => {
  it('separates recorded, derived, and shared-membership connections in the panel', () => {
    renderAtlas({ selectedAreaId: 'collab' });
    const panel = screen.getByLabelText('Area detail: Collaboration');
    // The view opens on recorded links; this test is about all four families.
    fireEvent.change(within(panel).getByLabelText('Relation lens'), { target: { value: 'all' } });

    expect(
      within(panel).getByText('2 links recorded in source records between Collaboration and Delivery.'),
    ).toBeTruthy();
    expect(within(panel).getByText('references ×1, worked_on_in ×1')).toBeTruthy();
    expect(
      within(panel).getByText(
        '1 record is filed in both areas by a membership rule. Co-membership is not a dependency.',
      ),
    ).toBeTruthy();

    // The path-synthesized edge gets its own header and its own derivation note.
    expect(within(panel).getByText(/1 link the loader derived between Collaboration and Delivery/)).toBeTruthy();
    expect(
      within(panel).getByText(/being filed under a directory is not a statement about that directory/),
    ).toBeTruthy();
    expect(within(panel).queryByText(/1 link recorded in source records/)).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: /Collaboration ↔ Delivery Recorded links/ }));
    expect(
      within(panel).getByText('Snapshot worked_on_in edge · link recorded in a source record'),
    ).toBeTruthy();
    expect(within(panel).getByText('Showing 2 of 2 evidence rows')).toBeTruthy();
  });

  it('routes evidence rows to selection, opening, and the Trails view', () => {
    const { props } = renderAtlas({ selectedAreaId: 'collab' });
    const panel = screen.getByLabelText('Area detail: Collaboration');
    fireEvent.click(within(panel).getByRole('button', { name: /Collaboration ↔ Delivery Recorded links/ }));

    const row = within(panel).getByText('Access rules → Release check').closest('li')!;
    fireEvent.click(within(row).getByText('Access rules → Release check'));
    expect(props.onSelectNode).toHaveBeenCalledWith('b1');

    fireEvent.click(within(row).getByRole('button', { name: 'Open' }));
    expect(props.onOpenNode).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }));

    fireEvent.click(within(row).getByRole('button', { name: 'Trail' }));
    expect(props.onNavigate).toHaveBeenCalledWith('trails', 'b1', 'collab');

    fireEvent.click(within(panel).getByRole('button', { name: 'See this area in Pulse' }));
    expect(props.onNavigate).toHaveBeenCalledWith('pulse', undefined, 'collab');
  });

  it('narrows both the drawn bridges and the list to the chosen relation lens', () => {
    renderAtlas({ selectedAreaId: 'collab' });
    const panel = screen.getByLabelText('Area detail: Collaboration');
    fireEvent.change(within(panel).getByLabelText('Relation lens'), { target: { value: 'all' } });

    expect(screen.getByRole('button', { name: /Collaboration to Delivery: 2 links recorded/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Collaboration to Delivery: 1 link the loader derived/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Collaboration to Delivery: 1 record is filed in both areas/ })).toBeTruthy();

    fireEvent.change(within(panel).getByLabelText('Relation lens'), { target: { value: 'recorded-link' } });

    expect(screen.queryByRole('button', { name: /filed in both areas/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /the loader derived/ })).toBeNull();
    expect(within(panel).queryByText(/Co-membership is not a dependency/)).toBeNull();
    expect(within(panel).queryByText(/the loader derived/)).toBeNull();
  });

  it('commits a rename on Enter and abandons it on Escape', () => {
    const { props } = renderAtlas({ selectedAreaId: 'collab' });
    const panel = screen.getByLabelText('Area detail: Collaboration');

    fireEvent.click(within(panel).getByRole('button', { name: 'Rename' }));
    const first = within(panel).getByLabelText('Area display name');
    fireEvent.change(first, { target: { value: 'Teams & Sharing' } });
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(props.onRenameArea).not.toHaveBeenCalled();

    fireEvent.click(within(panel).getByRole('button', { name: 'Rename' }));
    const second = within(panel).getByLabelText('Area display name');
    fireEvent.change(second, { target: { value: '  Teams & Sharing  ' } });
    fireEvent.keyDown(second, { key: 'Enter' });
    expect(props.onRenameArea).toHaveBeenCalledWith('collab', 'Teams & Sharing');
  });

  it('states quiet areas honestly and reports selection upward', () => {
    const { props } = renderAtlas();

    expect(screen.getByRole('button', { name: /^Docs\./ }).getAttribute('aria-label')).toBe(
      'Docs. 1 record. No activity recorded in range.',
    );
    expect(screen.getByRole('button', { name: /^Collaboration\./ }).getAttribute('aria-label')).toContain(
      '2 of 2 records active (100%) · 2 events in range',
    );

    fireEvent.click(screen.getByRole('button', { name: /^Collaboration\./ }));
    expect(props.onSelectArea).toHaveBeenCalledWith('collab');
  });

  it('moves focus across territories with bare arrows and yields modified chords to the app', () => {
    renderAtlas();
    // Territories are ordered by area id: collab, delivery, docs, unassigned.
    const collab = screen.getByRole('button', { name: /^Collaboration\./ });
    const delivery = screen.getByRole('button', { name: /^Delivery\./ });
    collab.focus();

    fireEvent.keyDown(collab, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(delivery);

    const modified = createEvent.keyDown(delivery, { key: 'ArrowRight', metaKey: true });
    fireEvent(delivery, modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(delivery);
  });

  it('keeps Unassigned reachable from the footer', () => {
    const { props } = renderAtlas();

    fireEvent.click(screen.getByRole('button', { name: 'Unassigned: 1 record' }));
    expect(props.onSelectArea).toHaveBeenCalledWith('unassigned');
  });

  it('bounds long evidence lists and labels how much of the total is shown', () => {
    const nodes = [node('home', { label: 'Home record' })];
    const edges: ProjectGraphEdge[] = [];
    for (let i = 0; i < 40; i += 1) {
      nodes.push(node(`far${i}`, { label: `Far record ${i}` }));
      edges.push(edge(`e${i}`, 'home', `far${i}`, 'references'));
    }
    const m = model({
      nodes,
      edges,
      areas: [
        area('home', 'Home', ['home']),
        area('far', 'Far', nodes.slice(1).map((n) => n.id)),
      ],
    });

    renderAtlas({ model: m, selectedAreaId: 'home' });
    const panel = screen.getByLabelText('Area detail: Home');
    fireEvent.click(within(panel).getByRole('button', { name: /Home ↔ Far Recorded links/ }));

    expect(within(panel).getByText('Showing 25 of 40 evidence rows')).toBeTruthy();
    expect(within(panel).getAllByRole('button', { name: 'Trail' })).toHaveLength(25);

    fireEvent.click(within(panel).getByRole('button', { name: 'Show 25 more' }));
    expect(within(panel).getByText('Showing 40 of 40 evidence rows')).toBeTruthy();
  });

  it('opens on recorded links, which volume sorting otherwise buries', () => {
    // Directory rollups outnumber recorded links by three orders of magnitude
    // on a real index, so a volume-sorted "all relations" map draws six derived
    // routes and nothing a record actually asserts.
    const { container } = renderAtlas({ selectedAreaId: 'collab' });
    const panel = screen.getByLabelText('Area detail: Collaboration');

    expect((within(panel).getByLabelText('Relation lens') as HTMLSelectElement).value).toBe(
      'recorded-link',
    );

    const bridges = [...container.querySelectorAll('.pga-bridge')].map((b) => b.textContent);
    expect(bridges).toEqual(['2 recorded links']);
    expect(within(panel).queryByText(/the loader derived/)).toBeNull();
    expect(within(panel).queryByText(/Co-membership is not a dependency/)).toBeNull();
  });

  it('keeps a family selectable when the area has none of it, and says so plainly', () => {
    // `only` is joined to `main` by a path-derived edge alone.
    const derivedOnly = model({
      nodes: [node('only', { label: 'Filed note' }), node('main', { label: 'Main record' })],
      edges: [edge('e1', 'only', 'main', 'part_of')],
      areas: [area('side', 'Side', ['only']), area('core', 'Core', ['main'])],
    });
    renderAtlas({ model: derivedOnly, selectedAreaId: 'side' });
    const panel = screen.getByLabelText('Area detail: Side');
    const lens = within(panel).getByLabelText('Relation lens') as HTMLSelectElement;

    expect(lens.value).toBe('recorded-link');
    expect(within(panel).getByText(/No recorded links between this area and any other area/)).toBeTruthy();
    // The option is still offered even though it currently matches nothing,
    // so the reader can tell an empty family from a missing control.
    expect([...lens.options].map((o) => o.value)).toContain('recorded-link');

    fireEvent.change(lens, { target: { value: 'all' } });
    expect(within(panel).getByText(/the loader derived/)).toBeTruthy();
  });

  it('keeps every family between one pair of areas separately reachable on the map', () => {
    const { container } = renderAtlas({ selectedAreaId: 'collab' });
    fireEvent.change(
      within(screen.getByLabelText('Area detail: Collaboration')).getByLabelText('Relation lens'),
      { target: { value: 'all' } },
    );

    const bridges = [
      /Collaboration to Delivery: 2 links recorded/,
      /Collaboration to Delivery: 1 link the loader derived/,
      /Collaboration to Delivery: 1 record is filed in both areas/,
    ].map((name) => screen.getByRole('button', { name }) as HTMLElement);

    // Stacked controls make the lower ones unclickable, so the same pair of
    // territories must not put two of them on the same point or the same line.
    const points = bridges.map((b) => `${b.style.left}|${b.style.top}`);
    expect(new Set(points).size).toBe(3);
    const routes = [...container.querySelectorAll('.pga-connector')].map((p) =>
      p.getAttribute('d'),
    );
    expect(new Set(routes).size).toBe(routes.length);

    const panel = screen.getByLabelText('Area detail: Collaboration');
    fireEvent.click(bridges[1]);
    expect(
      within(panel.querySelector('.pga-conn.is-open') as HTMLElement).getByText(
        /the loader derived/,
      ),
    ).toBeTruthy();

    fireEvent.click(bridges[2]);
    expect(
      within(panel.querySelector('.pga-conn.is-open') as HTMLElement).getByText(
        /Co-membership is not a dependency/,
      ),
    ).toBeTruthy();
  });

  it('renders an honest empty state instead of inventing territories', () => {
    renderAtlas({ model: model({ nodes: [node('n1'), node('n2')], areas: [] }) });

    expect(screen.getByText(/This model has no areas.*2 records are loaded/s)).toBeTruthy();
  });
});
