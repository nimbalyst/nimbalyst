/**
 * The JSON that the blocks write. Each line has an edge in the colour of the
 * block it came from, and the selected block's lines are lit. The user never
 * types here.
 */

import { useState } from 'react';

import type { WriteResult } from '../../../shared/hookEditor/hookWriter';
import { BLOCK_COLOURS, BUTTON, type BlockKind } from './hookEditorText';
import { HelpTooltip } from '../../help/HelpTooltip';

interface HookJsonPaneProps {
  written: WriteResult | null;
  /** The open file's name, such as settings.local.json, for the "show the whole file" button. */
  fileName: string;
  kindOf: (id: string) => BlockKind;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function HookJsonPane({ written, fileName, kindOf, selectedId, onSelect }: HookJsonPaneProps) {
  const [hooksOnly, setHooksOnly] = useState(false);
  if (written === null) return null;
  const lines = written.text.split('\n');
  const owned = written.lineMap.map((id, index) => (id === null ? -1 : index)).filter((index) => index >= 0);
  const first = hooksOnly && owned.length > 0 ? owned[0] : 0;
  const last = hooksOnly && owned.length > 0 ? owned[owned.length - 1] : lines.length - 1;

  return (
    <div className="hook-json-pane flex h-full flex-col text-xs">
      <div className="flex items-center gap-2 border-b border-[var(--nim-border)] p-2">
        <HelpTooltip testId="hook-json-scope">
          <button type="button" data-testid="hook-json-scope" className={`${BUTTON.ghost} ${BUTTON.small}`} onClick={() => setHooksOnly(!hooksOnly)}>
            {hooksOnly ? `Show ${fileName}` : 'Show hooks only'}
          </button>
        </HelpTooltip>
        <button type="button" data-testid="hook-json-copy" className={`${BUTTON.ghost} ${BUTTON.small}`} onClick={() => void navigator.clipboard.writeText(written.text)}>
          Copy JSON
        </button>
        <span className="ml-auto text-[var(--nim-text-faint)]">Written from your blocks. You do not type here.</span>
      </div>
      <pre className="flex-1 select-text overflow-auto p-2 font-mono" data-testid="hook-json-text">
        {lines.slice(first, last + 1).map((line, offset) => {
          const id = written.lineMap[first + offset] ?? null;
          const lit = id !== null && selectedId !== null && (id === selectedId || id.startsWith(`${selectedId}/`));
          return (
            <div
              key={first + offset}
              className={lit ? 'bg-[var(--nim-bg-selected)]' : ''}
              style={{ borderLeft: `3px solid ${id === null ? 'transparent' : BLOCK_COLOURS[kindOf(id)]}`, paddingLeft: 6 }}
              onClick={id === null ? undefined : () => onSelect(id)}
            >
              {line === '' ? ' ' : line}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
