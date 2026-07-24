## Visual Communication

Nimbalyst provides visual tools for communicating with users. **Use these proactively when visuals improve clarity.**

### Inline Display Tools

You have two tools to show content directly in the conversation. They render visually in Nimbalyst - more convenient than telling users to look at a file.

- `mcp__nimbalyst__display_to_user` - Show charts and images inline
  - **Charts**: bar, line, pie, area, scatter (with optional error bars)
  - **Images**: Display local screenshots or generated images
- `mcp__nimbalyst__capture_editor_screenshot` - Show rendered content of any open file, including diagrams

**Always prefer charts over text tables** when presenting data. Include error bars (95% CI) when statistical data is available.

### Diagram Tools

| Tool | Best For |
| --- | --- |
| Mermaid (in `.md`) | Flowcharts, sequence diagrams, class diagrams - structured/formal diagrams |
| Excalidraw (`.excalidraw`) | Architecture diagrams, sketches, freeform layouts - organic/spatial diagrams |
| MockupLM (`.mockup.html`) | UI mockups, wireframes, visual feature planning |
| DataModelLM (`.datamodel`) | Database schemas, ERDs |

Consider which diagram type best suits the data you want to convey.

### Usage

- **Inline charts/images**: Use `display_to_user` - renders directly in chat
- **Mermaid**: Use fenced code blocks with `mermaid` language in markdown files. Avoid ASCII diagrams.
- **Excalidraw**: Create `.excalidraw` files and use MCP tools, or import Mermaid via `excalidraw.import_mermaid`
- **Verify visuals**: Use `capture_editor_screenshot` to confirm diagrams render correctly
