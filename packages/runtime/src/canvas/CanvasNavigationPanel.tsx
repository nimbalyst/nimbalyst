import { useMemo, useState } from 'react';
import type { CanvasDocument } from './CanvasDocument';
import { readCanvasNavigation } from './canvasNavigation';
import './CanvasNavigationPanel.css';

export function CanvasNavigationPanel({
  document,
  onNavigate,
  onOverview,
}: {
  document: CanvasDocument;
  onNavigate(nodeId: string): void;
  onOverview(): void;
}) {
  const items = useMemo(() => readCanvasNavigation(document), [document]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const current = items.find((item) => item.nodeId === currentId);
  const siblings = items.filter(
    (item) => item.parentId === (current?.parentId ?? null)
  );
  const index = siblings.findIndex((item) => item.nodeId === current?.nodeId);
  const children = current
    ? items.filter((item) => item.parentId === current.nodeId)
    : [];
  if (!items.length) return null;
  const go = (id: string) => {
    setCurrentId(id);
    onNavigate(id);
  };
  const overview = () => {
    setCurrentId(null);
    onOverview();
  };
  return (
    <div className="canvas-navigation nodrag nopan nowheel">
      <nav
        aria-label="Screen navigation"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div className="canvas-navigation__row">
          <button
            type="button"
            onClick={overview}
            data-canvas-help="canvas-nav-overview"
          >
            Overview
          </button>
          <select
            aria-label="Go to screen"
            value={current?.nodeId ?? ''}
            onChange={(event) => go(event.target.value)}
          >
            <option value="" disabled>
              Browse screens…
            </option>
            {items.map((item) => (
              <option key={item.nodeId} value={item.nodeId}>
                {item.parentId
                  ? `${
                      items.find((parent) => parent.nodeId === item.parentId)
                        ?.label
                    } / `
                  : ''}
                {item.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!current}
            onClick={() =>
              current?.parentId ? go(current.parentId) : overview()
            }
            data-canvas-help="canvas-nav-up"
          >
            Up
          </button>
          <button
            type="button"
            aria-label="Previous screen"
            disabled={index <= 0}
            onClick={() => go(siblings[index - 1].nodeId)}
            data-canvas-help="canvas-nav-previous"
          >
            ←
          </button>
          <span className="canvas-navigation__count" aria-live="polite">
            {current
              ? `${index + 1} / ${siblings.length}`
              : `${siblings.length} screens`}
          </span>
          <button
            type="button"
            aria-label="Next screen"
            disabled={index >= siblings.length - 1}
            onClick={() => go(siblings[index + 1].nodeId)}
            data-canvas-help="canvas-nav-next"
          >
            →
          </button>
        </div>
        {children.length > 0 && (
          <select
            aria-label="Explore child view"
            value=""
            onChange={(event) => go(event.target.value)}
          >
            <option value="" disabled>
              Explore…
            </option>
            {children.map((item) => (
              <option key={item.nodeId} value={item.nodeId}>
                {item.label}
              </option>
            ))}
          </select>
        )}
      </nav>
    </div>
  );
}
