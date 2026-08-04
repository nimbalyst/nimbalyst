import { useMemo, useState } from 'react';
import type { GraphNodeTypeSchema, GraphViewDefinition, ProjectGraphSnapshot } from '../types';
import { groupTypesByCategory } from '../schema';
import { IconEyeOff, IconEyeOpen, IconSearch, IconStar } from './icons';

interface GraphSidebarProps {
  snapshot: ProjectGraphSnapshot;
  types: GraphNodeTypeSchema[];
  extraCategories: Array<{ id: string; label: string }>;
  visibleTypes: ReadonlySet<string>;
  onToggleType: (type: string) => void;
  onSetGroupHidden: (typesInGroup: string[], hidden: boolean) => void;
  onSetAllHidden: (hidden: boolean) => void;
  views: GraphViewDefinition[];
  activeViewId: string;
  onSelectView: (id: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
}

export function GraphSidebar({
  snapshot,
  types,
  extraCategories,
  visibleTypes,
  onToggleType,
  onSetGroupHidden,
  onSetAllHidden,
  views,
  activeViewId,
  onSelectView,
  searchQuery,
  onSearchChange,
}: GraphSidebarProps) {
  const groups = useMemo(() => groupTypesByCategory(types, extraCategories), [types, extraCategories]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // All types that actually have items (the only ones with a toggle row), and
  // whether every one is currently visible — drives the global Show/Hide all.
  const toggleableTypes = useMemo(
    () => types.filter(t => (snapshot.stats.countsByType[t.type] ?? 0) > 0).map(t => t.type),
    [types, snapshot.stats.countsByType],
  );
  const allVisible = toggleableTypes.every(t => visibleTypes.has(t));

  return (
    <aside className="pg-left">
      <div className="pg-search">
        <IconSearch />
        <input
          placeholder="Search nodes..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          aria-label="Search nodes"
        />
      </div>

      <div className="pg-left-section">
        <h4>Saved views <span className="pg-count">{views.length}</span></h4>
        {views.map(view => {
          const isActive = view.id === activeViewId;
          return (
            <button
              key={view.id}
              className={`pg-preset${isActive ? ' is-active' : ''}`}
              onClick={() => onSelectView(view.id)}
              type="button"
            >
              <IconStar className="pg-star" filled={view.builtin} />
              <span>{view.name}</span>
            </button>
          );
        })}
      </div>

      <div className="pg-left-section pg-types-header">
        <h4>
          <span>Item types</span>
          <button
            type="button"
            className="pg-group-bulk"
            onClick={() => onSetAllHidden(allVisible)}
            disabled={toggleableTypes.length === 0}
            title={allVisible ? 'Hide every type' : 'Show every type'}
          >
            {allVisible ? 'Hide all' : 'Show all'}
          </button>
        </h4>
      </div>

      {groups.map(group => {
        const totalCount = group.types.reduce((sum, t) => sum + (snapshot.stats.countsByType[t.type] ?? 0), 0);
        // Collapse empty groups — hide them entirely so the sidebar reads cleanly.
        if (totalCount === 0) return null;
        // Sort types within a group by descending count (zero-count types last).
        const sortedTypes = [...group.types].sort((a, b) => {
          const ca = snapshot.stats.countsByType[a.type] ?? 0;
          const cb = snapshot.stats.countsByType[b.type] ?? 0;
          if (ca === 0 && cb !== 0) return 1;
          if (cb === 0 && ca !== 0) return -1;
          return cb - ca;
        });
        const allVisible = sortedTypes.every(t => visibleTypes.has(t.type) || (snapshot.stats.countsByType[t.type] ?? 0) === 0);
        const isCollapsed = collapsed.has(group.id as string);
        return (
          <div key={group.id} className="pg-left-section">
            <h4>
              <button
                type="button"
                className="pg-group-toggle"
                onClick={() => setCollapsed(prev => {
                  const next = new Set(prev);
                  if (next.has(group.id as string)) next.delete(group.id as string);
                  else next.add(group.id as string);
                  return next;
                })}
                title={isCollapsed ? 'Expand group' : 'Collapse group'}
              >
                <span className={`pg-group-caret${isCollapsed ? ' is-collapsed' : ''}`}>▾</span>
                <span>{group.label}</span>
              </button>
              <span className="pg-group-actions">
                <button
                  type="button"
                  className="pg-group-bulk"
                  onClick={() => onSetGroupHidden(sortedTypes.map(t => t.type), allVisible)}
                  title={allVisible ? 'Hide all' : 'Show all'}
                >
                  {allVisible ? 'Hide' : 'Show'}
                </button>
                <span className="pg-count">{totalCount}</span>
              </span>
            </h4>
            {!isCollapsed && sortedTypes.map(t => {
              const count = snapshot.stats.countsByType[t.type] ?? 0;
              if (count === 0) return null;
              const isVisible = visibleTypes.has(t.type);
              return (
                <button
                  key={t.type}
                  type="button"
                  className={`pg-type-row${isVisible ? '' : ' is-muted'}`}
                  onClick={() => onToggleType(t.type)}
                >
                  <span className="pg-swatch" style={{ background: `var(${t.colorToken})` }} />
                  <span>{t.label}</span>
                  <span className="pg-count">{count}</span>
                  {isVisible ? <IconEyeOpen className="pg-eye" /> : <IconEyeOff className="pg-eye" />}
                </button>
              );
            })}
          </div>
        );
      })}
    </aside>
  );
}
