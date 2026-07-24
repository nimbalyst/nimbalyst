# Visual Diff Guide for List Type Changes

## The Issue

When converting between bullet and numbered lists, the diff is applied correctly but no visual diff (red/green) is shown. This is because:

1. The lexical-diff package only marks nodes with metadata, it doesn't control visual styling
2. List type changes are marked as 'modified' (not 'added'/'removed')
3. The consuming application needs to handle the visual presentation

## How It Works

When a list type changes (e.g., bullet → number):
- The list node gets `DiffState: 'modified'`
- The original list type is stored in `OriginalListTypeState`
- The list type is updated to the new type

## How to Show Visual Diff

Your application needs to detect list type changes and style them appropriately:

```javascript
// In your React component or decorator
import {$getDiffState} from '@lexical/diff';
import {$isListNode} from '@lexical/list';

function decorateListNode(node) {
  const diffState = $getDiffState(node);
  
  if (diffState === 'modified' && $isListNode(node)) {
    // Check if it's specifically a list type change
    // You may need to track this in your app's state
    // or check the OriginalListTypeState
    
    return {
      className: 'list-type-changed',
      // Add visual indicator in CSS or as a pseudo-element
    };
  }
  
  // Standard diff styling
  if (diffState === 'added') return {className: 'diff-added'};
  if (diffState === 'removed') return {className: 'diff-removed'};
  if (diffState === 'modified') return {className: 'diff-modified'};
}
```

```css
/* CSS for list type change indicator */
.list-type-changed::before {
  content: "List type changed";
  display: inline-block;
  background: #fff5b1;
  color: #735c0f;
  padding: 2px 6px;
  margin-right: 8px;
  font-size: 0.85em;
  border-radius: 3px;
}

/* Or show the actual change */
.list-type-changed[data-old-type="bullet"][data-new-type="number"]::before {
  content: "• → 1.";
}

.list-type-changed[data-old-type="number"][data-new-type="bullet"]::before {
  content: "1. → •";
}
```

## Alternative Approach: Duplicate Lists

If you want to show the old list as removed (red) and new list as added (green), you would need to:

1. Create a custom diff handler that duplicates the entire list
2. Mark one copy as 'removed' with the old type
3. Mark another copy as 'added' with the new type
4. This would show both versions side-by-side

However, this approach can be confusing as it duplicates all list content.

## Recommendation

The best approach is to:
1. Keep the current behavior (marking as 'modified')
2. Add visual indicators in your application's UI
3. Use tooltips or badges to show "List type changed from bullet to numbered"
4. Consider adding a toggle to show/hide the old version

This gives users clear feedback about what changed without cluttering the interface.