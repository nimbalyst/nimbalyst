// @vitest-environment jsdom
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TrackerFilterSet } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { TrackerFilterOmnibox } from '../TrackerFilterOmnibox';
import type { TrackerFilterField } from '../TrackerViewHeaderControls';

const FIELDS: TrackerFilterField[] = [
  {
    id: 'status',
    label: 'Status',
    type: 'select',
    options: [
      { value: 'open', label: 'Open', count: 2 },
      { value: 'done', label: 'Done', count: 1 },
    ],
  },
  { id: 'title', label: 'Title', type: 'string' },
  { id: 'assignee', label: 'Assignee', type: 'user' },
];

const TAGS = [{ name: 'ui', count: 4 }, { name: 'urgent', count: 2 }];

interface HarnessProps {
  onSearchQueryChange?: (value: string) => void;
  onFiltersChange?: (filters: TrackerFilterSet) => void;
  onTagFilterChange?: (tags: string[]) => void;
  initialFilters?: TrackerFilterSet | null;
  initialQuery?: string;
  initialTags?: string[];
  withTags?: boolean;
  showPills?: boolean;
  className?: string;
}

/** The omnibox is controlled, so the test owns the state it drives. */
function Harness({
  onSearchQueryChange,
  onFiltersChange,
  onTagFilterChange,
  initialFilters = null,
  initialQuery = '',
  initialTags = [],
  withTags = false,
  showPills,
  className,
}: HarnessProps) {
  const [query, setQuery] = useState(initialQuery);
  const [filters, setFilters] = useState<TrackerFilterSet | null>(initialFilters);
  const [tags, setTags] = useState<string[]>(initialTags);
  const tagProps = withTags || initialTags.length > 0
    ? {
        tagOptions: TAGS.filter(tag => !tags.includes(tag.name)),
        tagFilter: tags,
        onTagFilterChange: (next: string[]) => {
          setTags(next);
          onTagFilterChange?.(next);
        },
      }
    : {};
  return (
    <TrackerFilterOmnibox
      searchQuery={query}
      onSearchQueryChange={value => {
        setQuery(value);
        onSearchQueryChange?.(value);
      }}
      fields={FIELDS}
      filters={filters}
      onFiltersChange={next => {
        setFilters(next);
        onFiltersChange?.(next);
      }}
      showPills={showPills}
      className={className}
      {...tagProps}
    />
  );
}

const input = () => screen.getByTestId('tracker-filter-omnibox-input') as HTMLInputElement;
const type = (value: string) => fireEvent.change(input(), { target: { value } });

describe('TrackerFilterOmnibox', () => {
  it('drives the shared search query with plain text and leaves filters alone', () => {
    const onSearchQueryChange = vi.fn();
    const onFiltersChange = vi.fn();
    render(<Harness onSearchQueryChange={onSearchQueryChange} onFiltersChange={onFiltersChange} />);

    type('needs review');

    expect(onSearchQueryChange).toHaveBeenLastCalledWith('needs review');
    expect(onFiltersChange).not.toHaveBeenCalled();
    expect(input().value).toBe('needs review');
  });

  it('offers fields for a bare word without stealing Enter from search', () => {
    const onFiltersChange = vi.fn();
    render(<Harness onFiltersChange={onFiltersChange} />);

    type('stat');
    screen.getByTestId('tracker-filter-omnibox-option-field:status');
    // Nothing is highlighted, so Enter is still an ordinary search keystroke.
    expect(document.querySelector('[data-selected="true"]')).toBeNull();

    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onFiltersChange).not.toHaveBeenCalled();
    expect(input().value).toBe('stat');
  });

  it('turns a highlighted field suggestion into a token, keeping earlier search text', () => {
    const onSearchQueryChange = vi.fn();
    render(<Harness onSearchQueryChange={onSearchQueryChange} />);

    type('auth stat');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(input().value).toBe('auth status:');
    expect(onSearchQueryChange).toHaveBeenLastCalledWith('auth ');
    screen.getByTestId('tracker-filter-omnibox-option-value:open');
  });

  it('commits a value from the typeahead into the shared filter set', () => {
    const onFiltersChange = vi.fn();
    render(<Harness onFiltersChange={onFiltersChange} />);

    type('status:');
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onFiltersChange).toHaveBeenCalledWith({
      combinator: 'and',
      clauses: [{ field: 'status', op: '=', value: 'open' }],
    });
    // The token leaves the input; it is a pill now.
    expect(input().value).toBe('');
    expect(screen.getByTestId('tracker-filter-omnibox-pill-0').textContent).toContain('Open');
  });

  it('walks the menu with the arrow keys', () => {
    const onFiltersChange = vi.fn();
    render(<Harness onFiltersChange={onFiltersChange} />);

    type('status:');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onFiltersChange).toHaveBeenCalledWith({
      combinator: 'and',
      clauses: [{ field: 'status', op: '=', value: 'done' }],
    });
  });

  it('replaces a field clause instead of stacking an unsatisfiable second one', () => {
    const onFiltersChange = vi.fn();
    render(
      <Harness
        onFiltersChange={onFiltersChange}
        initialFilters={{ combinator: 'and', clauses: [{ field: 'status', op: '=', value: 'open' }] }}
      />,
    );

    type('status:done');
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onFiltersChange).toHaveBeenCalledWith({
      combinator: 'and',
      clauses: [{ field: 'status', op: '=', value: 'done' }],
    });
  });

  it('commits current-user shorthand from the normally highlighted menu state', () => {
    const onFiltersChange = vi.fn();
    render(<Harness onFiltersChange={onFiltersChange} />);

    type('assignee:me');
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onFiltersChange).toHaveBeenCalledWith({
      combinator: 'and',
      clauses: [{ field: 'assignee', op: 'is-current-user' }],
    });
  });

  it('commits empty shorthand instead of searching for the literal word', () => {
    const onFiltersChange = vi.fn();
    render(<Harness onFiltersChange={onFiltersChange} />);

    type('title:empty');
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onFiltersChange).toHaveBeenCalledWith({
      combinator: 'and',
      clauses: [{ field: 'title', op: 'is-empty' }],
    });
  });

  it('reaches an operator the default spelling does not cover', () => {
    const onFiltersChange = vi.fn();
    render(<Harness onFiltersChange={onFiltersChange} />);

    type('title:');
    fireEvent.mouseDown(screen.getByTestId('tracker-filter-omnibox-option-op:not-contains'));
    expect(input().value).toBe('title:not-contains:');

    type('title:not-contains:draft');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onFiltersChange).toHaveBeenCalledWith({
      combinator: 'and',
      clauses: [{ field: 'title', op: 'not-contains', value: 'draft' }],
    });
  });

  it('pops the last filter on Backspace in an empty input', () => {
    const onFiltersChange = vi.fn();
    render(
      <Harness
        onFiltersChange={onFiltersChange}
        initialFilters={{
          combinator: 'and',
          clauses: [
            { field: 'status', op: '=', value: 'open' },
            { field: 'title', op: 'contains', value: 'auth' },
          ],
        }}
      />,
    );

    fireEvent.keyDown(input(), { key: 'Backspace' });

    expect(onFiltersChange).toHaveBeenCalledWith({
      combinator: 'and',
      clauses: [{ field: 'status', op: '=', value: 'open' }],
    });
  });

  it('pulls a pill back into the input for editing', () => {
    render(
      <Harness
        initialFilters={{ combinator: 'and', clauses: [{ field: 'title', op: 'contains', value: 'a b' }] }}
      />,
    );

    fireEvent.click(screen.getByTitle('Edit title:"a b"'));

    expect(input().value).toBe('title:"a b"');
    expect(screen.queryByTestId('tracker-filter-omnibox-pill-0')).toBeNull();
  });

  it('keeps `#` tag completion working, as the box it replaced did', () => {
    const onTagFilterChange = vi.fn();
    const onSearchQueryChange = vi.fn();
    render(<Harness withTags onTagFilterChange={onTagFilterChange} onSearchQueryChange={onSearchQueryChange} />);

    type('auth #u');
    screen.getByTestId('tracker-filter-omnibox-option-tag:ui');
    screen.getByTestId('tracker-filter-omnibox-option-tag:urgent');

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onTagFilterChange).toHaveBeenCalledWith(['urgent']);
    // The tag token leaves the input; the search text it followed stays.
    expect(input().value).toBe('auth ');
    expect(onSearchQueryChange).toHaveBeenLastCalledWith('auth ');
    screen.getByTestId('tracker-filter-omnibox-tag-chip-urgent');
  });

  it('commits the first tag on Enter without arrowing', () => {
    const onTagFilterChange = vi.fn();
    render(<Harness withTags onTagFilterChange={onTagFilterChange} />);

    type('#ui');
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(onTagFilterChange).toHaveBeenCalledWith(['ui']);
    expect(input().value).toBe('');
  });

  it('renders existing tag filters as removable chips', () => {
    const onTagFilterChange = vi.fn();
    render(<Harness initialTags={['ui', 'urgent']} onTagFilterChange={onTagFilterChange} />);

    expect(screen.getByTestId('tracker-filter-omnibox-tag-chip-ui').textContent).toContain('#ui');
    fireEvent.click(screen.getByTestId('tracker-filter-omnibox-tag-chip-ui'));
    expect(onTagFilterChange).toHaveBeenCalledWith(['urgent']);
  });

  it('drops an already-applied tag from the completion list', () => {
    render(<Harness initialTags={['ui']} />);

    type('#u');
    expect(screen.queryByTestId('tracker-filter-omnibox-option-tag:ui')).toBeNull();
    screen.getByTestId('tracker-filter-omnibox-option-tag:urgent');
  });

  it('pops the last tag before the last clause on Backspace', () => {
    const onTagFilterChange = vi.fn();
    const onFiltersChange = vi.fn();
    render(
      <Harness
        initialTags={['ui']}
        onTagFilterChange={onTagFilterChange}
        onFiltersChange={onFiltersChange}
        initialFilters={{ combinator: 'and', clauses: [{ field: 'status', op: '=', value: 'open' }] }}
      />,
    );

    fireEvent.keyDown(input(), { key: 'Backspace' });
    expect(onTagFilterChange).toHaveBeenCalledWith([]);
    expect(onFiltersChange).not.toHaveBeenCalled();

    fireEvent.keyDown(input(), { key: 'Backspace' });
    expect(onFiltersChange).toHaveBeenCalledWith({ combinator: 'and', clauses: [] });
  });

  it('suppresses its own pills where the surface already shows them', () => {
    render(
      <Harness
        showPills={false}
        initialTags={['ui']}
        className="flex-1 max-w-[420px]"
        initialFilters={{ combinator: 'and', clauses: [{ field: 'status', op: '=', value: 'open' }] }}
      />,
    );

    expect(screen.queryByTestId('tracker-filter-omnibox-pills')).toBeNull();
    expect(screen.queryByTestId('tracker-filter-omnibox-tag-chip-ui')).toBeNull();
    // Layout is the surface's call, not the component's.
    expect(screen.getByTestId('tracker-filter-omnibox').className).toContain('max-w-[420px]');
  });

  it('clears the search text and every filter at once', () => {
    const onSearchQueryChange = vi.fn();
    const onFiltersChange = vi.fn();
    render(
      <Harness
        initialQuery="auth"
        onSearchQueryChange={onSearchQueryChange}
        onFiltersChange={onFiltersChange}
        initialFilters={{ combinator: 'and', clauses: [{ field: 'status', op: '=', value: 'open' }] }}
      />,
    );

    fireEvent.click(screen.getByTestId('tracker-filter-omnibox-clear'));

    expect(onSearchQueryChange).toHaveBeenLastCalledWith('');
    expect(onFiltersChange).toHaveBeenLastCalledWith({ combinator: 'and', clauses: [] });
  });

  it('clears tag filters too', () => {
    const onTagFilterChange = vi.fn();
    render(<Harness initialTags={['ui']} onTagFilterChange={onTagFilterChange} />);

    fireEvent.click(screen.getByTestId('tracker-filter-omnibox-clear'));
    expect(onTagFilterChange).toHaveBeenCalledWith([]);
  });
});
