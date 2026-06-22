---
name: excalidraw
description: Create diagrams and visual drawings using Excalidraw (.excalidraw files). Use when the user wants flowcharts, architecture diagrams, system diagrams, sketches, or any visual diagram. For database schemas and entity relationship diagrams, use the DataModelLM extension instead.
---

# Excalidraw Diagrams

Excalidraw is Nimbalyst's whiteboard-style diagram editor for creating flowcharts, architecture diagrams, system diagrams, and visual sketches.

## STOP AFTER ONE PASS — Do Not Thrash

The single biggest failure mode with this skill is agents creating a diagram, capturing a screenshot, noticing minor cosmetic imperfections, then clearing and rebuilding the diagram two, three, or four times without being asked. This is the wrong behavior. The user sees every rebuild, and iterations the user did not ask for are a waste of their time and attention.

Follow these rules:

1. **One-shot by default.** Build the diagram, capture a screenshot once, describe what you made, and stop. Do not iterate on visual polish unless the user explicitly asks for a change.
2. **Never use `excalidraw.clear_all` followed by a rebuild as a way to "redo" the diagram.** `clear_all` is only for user-requested rebuilds. If you just produced a diagram, looked at it, and feel like starting over, don't — stop and hand control back to the user.
3. **Minor imperfections are fine.** Excalidraw is a whiteboard / hand-drawn-style tool. Slight overlaps, arrows that route imperfectly, labels that aren't perfectly centered, and asymmetric spacing are all acceptable and expected. Do not rebuild to fix these. Do not re-run `import_mermaid` because the auto-layout isn't pixel-perfect.
4. **Only one screenshot per diagram.** Capture once to verify the diagram exists and is roughly what you intended, then stop screenshotting. Repeated screenshots drive perfectionism loops.
5. **If something is actually broken, make a targeted fix — not a rebuild.** Use `update_element`, `move_element`, `remove_element`, or `align_elements` on the specific problem. Do not wipe and restart.
6. **"Good enough to convey the idea" is the bar.** The diagram's job is to communicate structure or flow to a human reader. Once it does that, you are done. Do not keep polishing.

If you catch yourself about to call `clear_all` after just having built a diagram, or about to capture a second screenshot of the same diagram, stop. Report what you made and let the user decide whether changes are needed.

## When to Use Excalidraw

- Flowcharts and process diagrams
- Architecture diagrams
- System design diagrams
- Sequence diagrams
- Mind maps
- Network diagrams
- User flow diagrams
- General visual diagrams and sketches

## When NOT to Use Excalidraw

- **Database schemas / Entity relationship diagrams** - Use DataModelLM extension instead (creates `.datamodel` files with Prisma schema)

## File Format

- **Extension**: `.excalidraw`
- **Format**: JSON-based Excalidraw format
- **Location**: Any directory in the workspace

## Available MCP Tools

The Excalidraw extension provides these MCP tools for diagram manipulation:

### Getting Information
- `excalidraw.get_elements` - Get all elements in the diagram

### Adding Elements
- `excalidraw.add_rectangle` - Add a rectangle/box
- `excalidraw.add_arrow` - Add a single arrow
- `excalidraw.add_arrows` - Add multiple arrows at once
- `excalidraw.add_elements` - Add multiple elements at once
- `excalidraw.add_frame` - Add a frame (container for elements)
- `excalidraw.add_row` - Add elements in a horizontal row
- `excalidraw.add_column` - Add elements in a vertical column

### Modifying Elements
- `excalidraw.update_element` - Update an existing element
- `excalidraw.move_element` - Move an element to new position
- `excalidraw.remove_element` - Remove a single element
- `excalidraw.remove_elements` - Remove multiple elements

### Organization
- `excalidraw.align_elements` - Align elements horizontally/vertically
- `excalidraw.distribute_elements` - Distribute elements evenly
- `excalidraw.group_elements` - Group elements together
- `excalidraw.set_elements_in_frame` - Put elements into a frame
- `excalidraw.relayout` - Automatically relayout elements

### Special Features
- `excalidraw.import_mermaid` - Convert Mermaid syntax to Excalidraw
- `excalidraw.clear_all` - Clear all elements from the diagram

## Workflow

1. **Create file** - Create a new `.excalidraw` file or open existing one
2. **Use MCP tools** - Use the Excalidraw MCP tools to add/modify elements
3. **Verify visually (once)** - Use `mcp__nimbalyst__capture_editor_screenshot` a single time to confirm the diagram rendered
4. **Stop** - Report what you made and hand control back. Do not iterate on polish unless the user asks for changes. See "STOP AFTER ONE PASS" above.

## Best Practices

- Use frames to group related elements
- Keep diagrams clean and readable
- Use consistent spacing and alignment
- Add arrows to show flow/relationships
- Use color sparingly for emphasis

## Example: Creating a Flowchart

1. Add rectangles for each step
2. Add arrows connecting the steps
3. Use `align_elements` to align horizontally/vertically
4. Use `distribute_elements` for even spacing
