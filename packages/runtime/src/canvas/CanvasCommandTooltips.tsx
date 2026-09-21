import { useEffect, useId, useState } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import { CANVAS_HELP_CONTENT } from './canvasHelpContent';
import './CanvasCommandTooltips.css';

/** One delegated tooltip for the panels, outside the transformed board. */
export function CanvasCommandTooltips({
  surfaceRef,
}: {
  surfaceRef: { current: HTMLElement | null };
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const id = useId();
  const { refs, floatingStyles } = useFloating({
    open: target !== null,
    placement: target?.closest('.canvas-tool-rail') ? 'right' : 'bottom',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: HTMLElement | null = null;
    let cooldown = 0;
    const hide = () => {
      clearTimeout(timer);
      pending = null;
      setTarget(null);
    };
    const find = (node: EventTarget | null) =>
      node instanceof Element
        ? node.closest<HTMLElement>('[data-canvas-help]')
        : null;
    const show = (event: Event) => {
      const button = find(event.target);
      if (!button || button === pending) return;
      hide();
      if (
        Date.now() < cooldown ||
        button.getAttribute('aria-expanded') === 'true'
      )
        return;
      pending = button;
      timer = setTimeout(() => {
        refs.setPositionReference(button);
        setTarget(button);
      }, 500);
    };
    const leave = (event: Event) => {
      if (find((event as MouseEvent).relatedTarget) !== pending) hide();
    };
    const click = () => {
      cooldown = Date.now() + 5000;
      hide();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ')
        click();
    };
    surface.addEventListener('mouseover', show);
    surface.addEventListener('mouseout', leave);
    surface.addEventListener('focusin', show);
    surface.addEventListener('focusout', leave);
    surface.addEventListener('pointerdown', click, true);
    surface.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(timer);
      surface.removeEventListener('mouseover', show);
      surface.removeEventListener('mouseout', leave);
      surface.removeEventListener('focusin', show);
      surface.removeEventListener('focusout', leave);
      surface.removeEventListener('pointerdown', click, true);
      surface.removeEventListener('keydown', key, true);
    };
  }, [surfaceRef, refs]);
  useEffect(() => {
    if (!target) return;
    const previous = target.getAttribute('aria-describedby');
    target.setAttribute(
      'aria-describedby',
      [previous, id].filter(Boolean).join(' ')
    );
    return () => {
      if (previous === null) target.removeAttribute('aria-describedby');
      else target.setAttribute('aria-describedby', previous);
    };
  }, [target, id]);
  const help = target
    ? CANVAS_HELP_CONTENT[target.dataset.canvasHelp ?? '']
    : undefined;
  if (!help) return null;
  const shortcut = help.shortcut?.replace(
    /Cmd/g,
    /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
  );
  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        id={id}
        role="tooltip"
        className="canvas-command-tooltip"
        style={floatingStyles}
      >
        <strong>{help.title}</strong>
        {shortcut && <kbd>{shortcut}</kbd>}
        <div>{help.body}</div>
      </div>
    </FloatingPortal>
  );
}
