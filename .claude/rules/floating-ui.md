## CRITICAL: Use @floating-ui/react for All Popover/Tooltip/Menu Positioning

**NEVER manually calculate `position: fixed` coordinates for floating UI elements** (tooltips, hover cards, context menus, dropdowns, popovers).

Manual positioning with `getBoundingClientRect()` + `window.innerHeight` arithmetic breaks at viewport edges, inside transformed containers, and with scroll. Always use `@floating-ui/react` instead:

```tsx
import { useFloating, offset, flip, shift, FloatingPortal, useInteractions, useDismiss } from '@floating-ui/react';

// For a virtual anchor (e.g. cursor position or a DOMRect):
const virtualRef = useMemo(() => ({
  getBoundingClientRect: () => anchorRect, // or DOMRect.fromRect({ x, y, width: 0, height: 0 })
}), [anchorRect]);

const { refs, floatingStyles, context } = useFloating({
  elements: { reference: virtualRef },
  placement: 'top-start',
  middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
});

// Always render through FloatingPortal to escape overflow:hidden containers
return <FloatingPortal><div ref={refs.setFloating} style={floatingStyles}>...</div></FloatingPortal>;
```

- `@floating-ui/react` is in `packages/electron/package.json` — use it in renderer code
- Extensions must add it to their own `package.json` dependencies so it bundles
- Use `useDismiss` + `useRole('menu')` + `useInteractions` for context menus
- Never set `position: fixed` manually on floating elements — let `floatingStyles` handle it
