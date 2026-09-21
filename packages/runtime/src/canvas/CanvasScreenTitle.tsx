import { useEffect, useRef, useState } from 'react';

/** Board-local title editing; the source image and capture metadata stay intact. */
export function CanvasScreenTitle({
  label,
  readOnly,
  onRename,
}: {
  label: string;
  readOnly: boolean;
  onRename(label: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const pending = useRef(false);
  useEffect(() => {
    if (readOnly) {
      pending.current = false;
      setEditing(false);
    }
  }, [readOnly]);
  const begin = () => {
    if (readOnly) return;
    setDraft(label);
    pending.current = true;
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (!pending.current) return;
    pending.current = false;
    setEditing(false);
    const next = draft.trim();
    if (save && !readOnly && next && next !== label) onRename(next);
  };
  if (readOnly) return <span className="canvas-screen-title">{label}</span>;
  if (editing)
    return (
      <input
        autoFocus
        aria-label="Screenshot title"
        className="canvas-screen-title canvas-screen-title--input nodrag nowheel"
        value={draft}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter' || event.key === 'Escape') {
            event.preventDefault();
            finish(event.key === 'Enter');
          }
        }}
      />
    );
  return (
    <button
      type="button"
      className="canvas-screen-title canvas-screen-title--button"
      title="Double-click to rename"
      aria-label={`Rename ${label}`}
      onDoubleClick={(event) => {
        event.stopPropagation();
        begin();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter' || event.key === 'F2') {
          event.preventDefault();
          begin();
        }
      }}
    >
      {label}
    </button>
  );
}
