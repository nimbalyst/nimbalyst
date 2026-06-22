---
packageVersion: 1.0.0
packageId: core
description: Create a visual UX mockup for a requested feature or screen.
---

Create a visual UX mockup for: {{arg1}}

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
       - Create `nimbalyst-local/existing-screens/style-guide.mockup.html` - a comprehensive visual reference showing:
         - Color palette (primary, secondary, accent colors, grays, semantic colors like error/success/warning)
         - Typography scale (headings H1-H6, body text, captions, with actual font families, sizes, weights, line heights)
         - Spacing scale (common padding/margin values used in the app)
         - Button styles (primary, secondary, danger, disabled states)
         - Form elements (inputs, textareas, selects, checkboxes, radio buttons)
         - Common UI patterns (cards, modals, tooltips, navigation elements)
         - Border radii and shadows
         - The style guide should be visually organized and easy to reference, like a design system documentation page
       - This should be a DEEP inspection of the existing UI and a comprehensive guide.
   - **If style guide EXISTS**:
     - Read it to understand the app's design system

3. **Create mockup file** - Create `nimbalyst-local/mockups/[descriptive-name].mockup.html`

4. **Build the mockup** - Write HTML with inline CSS that matches the style guide, ensuring consistency with the existing app

5. **Verify visually** - Use the Task tool to spawn a sub-agent that will:
   - Capture screenshot with `mcp__nimbalyst__capture_editor_screenshot`
   - Analyze for layout issues or problems
   - Fix with Edit tool if needed
   - Re-capture and iterate until correct

### Design Principles (New Screens)

**CRITICAL: New screen mockups should look realistic and consistent with the existing app.**

- **Match app styling**: Use the actual colors, fonts, and spacing from the codebase
- **Realistic appearance**: Mockups should look like finished UI, not sketches
- **Clear hierarchy**: Use size and spacing to show importance
- **Consistent patterns**: Follow the same component patterns used elsewhere in the app

## Steps for MODIFYING Existing Screens

### Directory Structure

- `nimbalyst-local/existing-screens/` - Cached replicas of existing UI screens
- `nimbalyst-local/mockups/` - Modified copies showing proposed changes

### Workflow

1. **Identify the screen** - Determine which existing screen/component is being modified

2. **Check for cached replica** - Look in `nimbalyst-local/existing-screens/` for `[screen-name].mockup.html`

3. **If cached replica EXISTS**:
   - Use the Task tool to spawn a sub-agent that will:
     - Check `git log` and `git diff` for changes to the relevant source files since the cached replica was last modified
     - If source files have changed, update the cached replica to match current implementation
     - If no changes, the cached replica is up-to-date
   - **No styling analysis needed** - The replica already contains all the styling information from the existing screen

4. **If cached replica DOES NOT EXIST**:
   - **Try to get a live screenshot first**:
     - If you have the ability to run the app and capture a screenshot automatically, do so - this gives the most accurate reference
     - If you cannot run the app, ask the user: "Would you like to provide a screenshot of the current screen? This will help me create a pixel-perfect replica. Otherwise, I'll recreate it from the source code."
   - **Deep code analysis** - Use the Task tool to spawn a sub-agent that will analyze the specific screen being replicated:
     - Find ALL relevant React components, CSS files, theme files, and related code **for this specific screen**
     - Extract exact colors (hex values), font sizes, font weights, line heights **used in this screen**
     - Document exact spacing values (padding, margin, gap) **in this screen**
     - Identify border radii, shadows, and other visual details **specific to this screen**
     - Spawn additional sub-agents if needed to cover different aspects (layout, typography, colors, icons)
     - If a screenshot was provided, use it as the reference to match pixel-for-pixel
     - **Note**: This is screen-specific analysis, not app-wide styling research
   - Create `nimbalyst-local/existing-screens/[screen-name].mockup.html` - a **pixel-perfect** HTML/CSS replica including:
     - Exact colors from the existing CSS
     - Exact typography (font family, size, weight, line height)
     - Exact spacing and dimensions
     - All visual details (shadows, borders, hover states if relevant)
   - Verify the replica visually with screenshot capture - iterate until it matches the original exactly

5. **Copy to mockups** - Copy the existing-screen replica to `nimbalyst-local/mockups/[descriptive-name].mockup.html`

6. **Apply modifications** - Edit the copy in mockups to include the proposed changes, keeping modifications **in full color**

7. **Verify visually** - Use the Task tool to spawn a sub-agent to capture and verify the mockup

8. **If the replica was updated or created and you were not able to obtain a screenshot**, after creating the replica, prompt the user in bold: **If you are able to give me a screenshot of the existing screen I can improve the mockup**

### Design Principles (Modifications)

**CRITICAL: Modifications to existing screens should be in FULL COLOR to show realistic integration.**

- **Match existing styles**: Use the actual colors, fonts, and spacing from the codebase
- **Highlight changes**: Consider using a subtle indicator (like a colored border or label) to show what's new/changed
- **Maintain consistency**: The mockup should look like it belongs in the existing app
- **Never modify existing-screens directly**: Always copy to mockups first, then modify the copy

## File Naming

- Use kebab-case: `settings-page.mockup.html`, `checkout-flow.mockup.html`
- Always use `.mockup.html` extension

## HTML Structure

Use standalone HTML with inline CSS. No external dependencies.

## User Annotations

The user can draw on mockups (circles, arrows, highlights). These annotations are **NOT** in the HTML source - you can only see them by capturing a screenshot with `mcp__nimbalyst__capture_editor_screenshot`.

When the user draws annotations:
1. Capture a screenshot to see what they marked
2. Interpret their feedback
3. Update the mockup accordingly

## Error Handling

- **No description provided**: Ask the user what they want to mock up
- **Ambiguous request**: Ask clarifying questions about scope, layout, or specific components
- **Can't find existing screen**: Ask the user to clarify which screen they mean, or offer to create a new mockup instead
- **Complex multi-screen flow**: Offer to create separate mockup files for each screen

## Important Notes

- **All mockups should look realistic** - Full color, proper styling, consistent with the app
- **New screens**: Research app styling first, then build consistent mockups
- **Modifications**: Create pixel-perfect replicas of existing screens, then modify
- Focus on communicating the concept clearly
- Include enough detail to make decisions, but no more
