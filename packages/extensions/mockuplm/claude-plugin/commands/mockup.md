---
description: Create a visual UX mockup for planning UI and design
---

Create a visual UX mockup for: $ARGUMENTS

## Determine Mockup Type

First, determine if this is:
1. **New screen/feature** - Something that doesn't exist yet
2. **Modification to existing screen** - Changes to an existing UI in the codebase

## Steps for NEW Screens

1. **Parse the request** - Understand what UI/screen/feature the user wants to mock up

2. **Check for style guide** - Look for `nimbalyst-local/existing-screens/style-guide.mockup.html`
   - **If style guide DOES NOT EXIST**:
     - Use the Task tool to spawn a sub-agent that will:
       - Explore the codebase to understand the app's look and feel
       - Find the theme files, CSS variables, color palette, and typography
       - Identify common UI patterns, component styles, and spacing conventions
       - Create `nimbalyst-local/existing-screens/style-guide.mockup.html` - a comprehensive visual reference
   - **If style guide EXISTS**:
     - Read it to understand the app's design system

3. **Create mockup file** - Create `nimbalyst-local/mockups/[descriptive-name].mockup.html`

4. **Build the mockup** - Write HTML with inline CSS that matches the style guide

5. **Verify visually** - Use the Task tool to spawn a sub-agent that will:
   - Capture screenshot with `mcp__nimbalyst__capture_editor_screenshot`
   - Analyze for layout issues or problems
   - Fix with Edit tool if needed
   - Re-capture and iterate until correct

## Steps for MODIFYING Existing Screens

### Directory Structure

- `nimbalyst-local/existing-screens/` - Cached replicas of existing UI screens
- `nimbalyst-local/mockups/` - Modified copies showing proposed changes

### Workflow

1. **Identify the screen** - Determine which existing screen/component is being modified

2. **Check for cached replica** - Look in `nimbalyst-local/existing-screens/` for `[screen-name].mockup.html`

3. **If cached replica EXISTS**:
   - Use the Task tool to spawn a sub-agent that will:
     - Check `git log` and `git diff` for changes to the relevant source files
     - If source files have changed, update the cached replica
   - No styling analysis needed - the replica already contains all styling information

4. **If cached replica DOES NOT EXIST**:
   - Ask the user if they can provide a screenshot of the current screen
   - Do deep code analysis to understand the exact styling used
   - Create `nimbalyst-local/existing-screens/[screen-name].mockup.html` as a pixel-perfect replica
   - Verify the replica visually with screenshot capture

5. **Copy to mockups** - Copy the replica to `nimbalyst-local/mockups/[descriptive-name].mockup.html`

6. **Apply modifications** - Edit the copy to include the proposed changes

7. **Verify visually** - Capture and verify the mockup

## File Naming

- Use kebab-case: `settings-page.mockup.html`, `checkout-flow.mockup.html`
- Always use `.mockup.html` extension

## HTML Structure

Use standalone HTML with inline CSS. No external dependencies.

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    /* CSS variables and styles */
  </style>
</head>
<body>
  <!-- Content -->
</body>
</html>
```

## User Annotations

The user can draw on mockups (circles, arrows, highlights). These annotations are NOT in the HTML source - you can only see them by capturing a screenshot with `mcp__nimbalyst__capture_editor_screenshot`.

When the user draws annotations:
1. Capture a screenshot to see what they marked
2. Interpret their feedback
3. Update the mockup accordingly

## Design Principles

- **Match app styling**: Use actual colors, fonts, and spacing from the codebase
- **Realistic appearance**: Mockups should look like finished UI, not sketches
- **Clear hierarchy**: Use size and spacing to show importance
- **Consistent patterns**: Follow the same component patterns used elsewhere

## Error Handling

- **No description provided**: Ask the user what they want to mock up
- **Ambiguous request**: Ask clarifying questions
- **Can't find existing screen**: Ask for clarification or offer to create new mockup
- **Complex multi-screen flow**: Offer to create separate files for each screen
