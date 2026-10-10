/**
 * The chart block in the editor: the chart drawn from the fence body, and an
 * Edit toggle (or a double-click) that shows the body as text, saved on blur.
 * The fence body stays the source of truth; nothing here rewrites it.
 *
 * In a shared document a teammate can change the block while the text is
 * open. An untouched draft follows the node and never saves. An edited draft
 * saves only over the text it started from; if the node changed underneath
 * it, the draft is kept and the block asks which to keep.
 *
 * The shared block resizer's bottom-right grip, as on a placed view, saves
 * the block's width and the plot's height as the body's top-level `width:` /
 * `height:` lines; dragged to the column's edge means no width (fill the
 * column), and double-clicking the grip clears both.
 *
 * The block menu (`chartBlockMenu`) changes the type directly; its "Edit
 * title" and "Edit data and settings" items run here, through `useBlockActions`.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import { $getNodeByKey, type NodeKey } from 'lexical';

import { parseFenceYaml, setFenceYamlValues } from '../../../core/fenceBody';
import { compileChartSource, MAX_CHART_HEIGHT, MIN_CHART_HEIGHT, MIN_CHART_WIDTH } from '../../../ui/chart/chartSpec';
import { DEFAULT_CHART_HEIGHT, VegaChart } from '../../../ui/chart/VegaChart';
import BlockResizer from '../../ui/BlockResizer';
import { useBlockActions } from '../DraggableBlockPlugin/useBlockActions';
import { $isChartNode } from './ChartNodeCore';

interface Draft {
  text: string;
  /** The node's source when the draft was last in step with it. */
  baseline: string;
  dirty: boolean;
  conflict: boolean;
}

const clampHeight = (height: number) => Math.min(MAX_CHART_HEIGHT, Math.max(MIN_CHART_HEIGHT, Math.round(height)));

export function ChartBlock({ source, nodeKey }: { source: string; nodeKey: NodeKey }): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const [draft, setDraft] = useState<Draft | null>(null);
  // The title being edited from the block menu; null when not editing.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const blockRef = useRef<HTMLDivElement | null>(null);
  // Block height minus plot height (title, axes, legend, footer, padding), so
  // a drag of the block's edge maps to the plot's height.
  const chromeRef = useRef(0);
  // An untouched draft tracks the node, so an open editor shows a teammate's update.
  useEffect(() => {
    setDraft((current) => (current && !current.dirty && current.baseline !== source
      ? { ...current, text: source, baseline: source }
      : current));
  }, [source]);
  const compiled = useMemo(() => compileChartSource(draft ? draft.text : source), [draft, source]);
  const plotHeight = compiled.size.height ?? DEFAULT_CHART_HEIGHT;
  // The chart draws after React renders, so the chrome is measured again when a drag starts.
  const measureChrome = () => {
    const block = blockRef.current;
    if (block) chromeRef.current = Math.max(0, block.offsetHeight - plotHeight);
  };
  useLayoutEffect(measureChrome);

  const open = () => setDraft({ text: source, baseline: source, dirty: false, conflict: false });
  // A raw Vega-Lite spec with its own title owns it; the fence's `title:` would not show.
  const currentTitle = useMemo(() => {
    const parsed = parseFenceYaml(source);
    if (!parsed.ok) return null;
    const raw = parsed.value['vega-lite'];
    if (raw && typeof raw === 'object' && 'title' in raw) return null;
    return typeof parsed.value.title === 'string' ? parsed.value.title : '';
  }, [source]);
  const saveTitle = () => {
    if (titleDraft === null) return;
    const next = titleDraft.trim();
    setTitleDraft(null);
    if (currentTitle !== null && next !== currentTitle) write(setFenceYamlValues(source, { title: next || null }));
  };
  useBlockActions(nodeKey, {
    'edit-title': editable && !draft && currentTitle !== null && titleDraft === null ? () => setTitleDraft(currentTitle) : null,
    'edit-source': editable && !draft ? open : null,
  });
  const write = (text: string) => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isChartNode(node)) node.setSource(text);
    });
  };
  const save = () => {
    if (!draft || draft.conflict) return;
    if (!draft.dirty) {
      setDraft(null);
      return;
    }
    if (source !== draft.baseline) {
      setDraft({ ...draft, conflict: true });
      return;
    }
    setDraft(null);
    if (draft.text !== source) write(draft.text);
  };
  const onResizeEnd = (width: number, height: number) => {
    const block = blockRef.current;
    const column = block?.parentElement?.clientWidth ?? Infinity;
    // Dragged out to the column's edge means "fill the column", not a fixed width.
    const fill = width >= column - 1;
    if (block) {
      // The resizer sized the block inline; the saved fence owns the size now.
      block.style.height = '';
      if (fill) block.style.width = '';
    }
    write(setFenceYamlValues(source, { width: fill ? null : Math.max(MIN_CHART_WIDTH, width), height: clampHeight(height - chromeRef.current) }));
  };
  const resetSize = () => {
    const block = blockRef.current;
    if (block) {
      block.style.width = '';
      block.style.height = '';
    }
    write(setFenceYamlValues(source, { width: null, height: null }));
  };

  const overwrite = () => {
    if (!draft) return;
    setDraft(null);
    write(draft.text);
  };

  return (
    <div
      ref={blockRef}
      className="chart-block relative my-3 max-w-full rounded-lg border border-nim bg-nim-secondary p-2"
      style={compiled.size.width === undefined ? undefined : { width: `${compiled.size.width}px` }}
      contentEditable={false}
      data-testid="chart-block"
      onDoubleClick={(event) => {
        if (!editable || draft || (event.target instanceof Element && event.target.closest('textarea, .block-resizer-grip'))) return;
        open();
      }}
    >
      {titleDraft !== null ? (
        <input
          className="chart-block-title-input mb-1 w-full rounded border border-[var(--nim-border-focus)] bg-nim px-2 py-1 text-[13px] font-semibold text-nim focus:outline-none"
          value={titleDraft}
          placeholder="Chart title"
          autoFocus
          onChange={(event) => setTitleDraft(event.target.value)}
          onBlur={saveTitle}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') saveTitle();
            if (event.key === 'Escape') setTitleDraft(null);
          }}
          data-testid="chart-block-title-input"
        />
      ) : null}
      {compiled.ok ? (
        <VegaChart spec={compiled.spec} height={plotHeight} />
      ) : (
        <div role="alert" className="chart-block-error rounded border border-nim bg-nim-tertiary px-3 py-2 font-mono text-xs text-nim-error select-text" data-testid="chart-block-error">
          {compiled.error}
        </div>
      )}
      {editable ? (
        <div className="chart-block-foot flex items-center px-1 pt-1 text-[11px] text-nim-faint">
          <button
            type="button"
            className="ml-auto cursor-pointer border-none bg-transparent p-0 text-[11px] text-nim-link hover:underline"
            data-testid="chart-block-edit"
            onClick={() => (draft ? save() : open())}
          >
            {draft ? 'Done' : 'Edit'}
          </button>
        </div>
      ) : null}
      {draft?.conflict ? (
        <div role="alert" className="chart-block-conflict mt-1 flex items-center gap-3 rounded border border-nim bg-nim-tertiary px-2 py-1 text-xs text-nim-warning" data-testid="chart-block-conflict">
          <span>This chart changed while you were editing it.</span>
          {/* mousedown keeps focus in the text, so the blur-save does not race the choice. */}
          <button type="button" className="ml-auto cursor-pointer border-none bg-transparent p-0 text-xs text-nim-link hover:underline" onMouseDown={(event) => event.preventDefault()} onClick={overwrite} data-testid="chart-block-conflict-overwrite">
            Keep mine
          </button>
          <button type="button" className="cursor-pointer border-none bg-transparent p-0 text-xs text-nim-link hover:underline" onMouseDown={(event) => event.preventDefault()} onClick={() => setDraft(null)} data-testid="chart-block-conflict-discard">
            Use theirs
          </button>
        </div>
      ) : null}
      {draft ? (
        <textarea
          className="chart-block-source mt-1 min-h-[160px] w-full resize-y rounded border border-nim bg-nim-tertiary p-2 font-mono text-xs text-nim focus:border-[var(--nim-border-focus)] focus:outline-none"
          value={draft.text}
          autoFocus
          spellCheck={false}
          onChange={(event) => setDraft({ ...draft, text: event.target.value, dirty: true })}
          onBlur={save}
          onKeyDown={(event) => event.stopPropagation()}
          data-testid="chart-block-source"
        />
      ) : null}
      {editable && !draft ? (
        <BlockResizer
          editor={editor}
          targetRef={blockRef}
          handles="corner"
          keepAspectRatio={false}
          minWidth={MIN_CHART_WIDTH}
          minHeight={MIN_CHART_HEIGHT + chromeRef.current}
          maxWidth={blockRef.current?.parentElement?.clientWidth}
          maxHeight={MAX_CHART_HEIGHT + chromeRef.current}
          onResizeStart={measureChrome}
          onResizeEnd={onResizeEnd}
          onReset={resetSize}
        />
      ) : null}
    </div>
  );
}
