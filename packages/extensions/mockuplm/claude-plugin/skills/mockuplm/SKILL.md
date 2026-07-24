---
name: mockuplm
description: Create visual UX mockups using HTML/CSS files (.mockup.html). Use when the user wants to design UI, wireframes, visual layouts, or plan features visually.
---

# MockupLM - Visual Planning

MockupLM is Nimbalyst's visual mockup system for UI/UX design and planning. Create `.mockup.html` files with HTML and inline CSS to share and iterate on designs with users.

## When to Use MockupLM

- Planning new UI features or screens
- Designing layouts and visual hierarchy
- Creating wireframes or prototypes
- Visualizing proposed changes to existing screens
- Any situation where visual communication helps

**Do NOT use for implementation** - MockupLM is for planning only. If you're implementing actual code, don't create mockup files.

## File Format

- **Extension**: `.mockup.html`
- **Location**: `nimbalyst-local/mockups/` for new designs, `nimbalyst-local/existing-screens/` for replicas of existing UI
- **Structure**: Standalone HTML with inline CSS, no external dependencies

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    /* Inline CSS here */
  </style>
</head>
<body>
  <!-- Mockup content -->
</body>
</html>
```

## Workflow

1. **Create mockup file** in `nimbalyst-local/mockups/[descriptive-name].mockup.html`
2. **Build the mockup** with HTML and inline CSS
3. **Verify visually** using the Task tool to spawn a sub-agent that will:
   - Capture screenshot with `mcp__nimbalyst__capture_editor_screenshot`
   - Analyze for layout/visual issues
   - Fix with Edit tool if needed
   - Re-capture and iterate until correct

## User Annotations

Users can draw directly on mockups in the editor (circles, arrows, highlights). These annotations are NOT in the HTML source.

**To see user annotations**: Use `mcp__nimbalyst__capture_editor_screenshot` to capture a screenshot that includes the annotations.

When the user draws on a mockup:
1. Capture a screenshot to see what they marked
2. Interpret their visual feedback
3. Update the mockup accordingly

## Design Guidelines

- **Realistic appearance**: Mockups should look like finished UI, not sketches
- **Clean HTML/CSS**: Use semantic HTML and minimal, well-organized CSS
- **Modern patterns**: Use flexbox, grid, CSS variables
- **Placeholder content**: Use realistic sample data (lorem ipsum, example names, etc.)
- **Responsive design**: Consider mobile breakpoints when appropriate

## For Existing Screens

When modifying existing UI:

1. Check `nimbalyst-local/existing-screens/` for cached replicas
2. If no replica exists, create a pixel-perfect HTML/CSS replica first
3. Copy to `nimbalyst-local/mockups/` and apply modifications there
4. Never modify the original in existing-screens directly

## File Naming

Use kebab-case with `.mockup.html` extension:
- `settings-page.mockup.html`
- `checkout-flow.mockup.html`
- `user-profile-card.mockup.html`
