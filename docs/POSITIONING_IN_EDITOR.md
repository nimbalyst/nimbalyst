# Floating Element Positioning in Rexical Editor

## DOM Structure

The editor uses a scroller container that serves as the anchor element for all floating UI:

```tsx
<div className="editor-scroller" ref={onRef}>  {/* floatingAnchorElem */}
  {config.documentHeader}
  <div className="editor">
    <ContentEditable />
  </div>
</div>
```

The `floatingAnchorElem` is the `editor-scroller` div itself, which handles scrolling.

## Floating Plugins

These plugins position UI elements relative to selected text or editor content:

- `FloatingTextFormatToolbarPlugin` - Format toolbar on text selection
- `FloatingLinkEditorPlugin` - Link editor for URLs
- `DraggableBlockPlugin` - Block drag handles
- `CodeActionMenuPlugin` - Code block actions
- `TableHoverActionsPlugin` - Table hover menus

## Positioning Logic

All floating elements use similar positioning:

1. Get target position via `getBoundingClientRect()` (viewport-relative)
2. Convert to anchor-relative coordinates
3. **Add scroll offset** to account for editor scrolling
4. Apply transform

### Critical: Scroll Offset

After the DOM restructure, `anchorElem` IS the scroller, not its parent:

```typescript
// anchorElem is the editor-scroller itself
const scrollerElem = anchorElem;

// Convert to anchor-relative
top -= anchorElementRect.top;
left -= anchorElementRect.left;

// Account for scroll offset
if (scrollerElem) {
  top += scrollerElem.scrollTop;
  left += scrollerElem.scrollLeft;
}
```

Without adding `scrollTop`, floating elements appear offset by the scroll amount.

## Utilities

- `setFloatingElemPosition()` - Standard floating element positioning
- `setFloatingElemPositionForLinkEditor()` - Link editor specific positioning
- `getDOMRangeRect()` - Get bounding rect for text selection

## Scroll Event Handling

Floating plugins must listen to scroll events to reposition:

```typescript
useEffect(() => {
  const scrollerElem = anchorElem; // anchorElem is the scroller

  const update = () => {
    editor.getEditorState().read(() => {
      $updatePosition();
    });
  };

  scrollerElem.addEventListener('scroll', update);
  window.addEventListener('resize', update);

  return () => {
    scrollerElem.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
  };
}, [anchorElem, editor, $updatePosition]);
```

## Adding New Floating Elements

When creating new floating UI:

1. Use `floatingAnchorElem` from Editor.tsx
2. Use existing positioning utilities
3. Remember to add scroll offset compensation
4. Listen to scroll events for repositioning
5. Portal the element to `anchorElem` for proper stacking

Example:

```tsx
return createPortal(
  <YourFloatingUI />,
  anchorElem
);
```
