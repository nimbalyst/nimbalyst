# Nimbalyst Extension SDK Documentation

Welcome to the Nimbalyst Extension SDK. This documentation will help you build extensions that add new capabilities to Nimbalyst.

## What Can Extensions Do?

Extensions can add:

- **Custom Editors** - New ways to view and edit file types (spreadsheets, diagrams, 3D models), including collaborative shared documents via `CollabContentAdapter`
- **AI Tools** - Tools that Claude can use to interact with your extension
- **AI Completions** - Call chat models (Claude, OpenAI, LM Studio) directly from your extension
- **Slash Commands** - Commands users can invoke from the editor
- **Markdown and Transcript Integrations** - Extend the built-in markdown editor and AI transcript renderer
- **File Icons** - Custom icons for file types in the sidebar
- **New File Types** - Add entries to the "New File" menu
- **Backend Modules** - Run isolated, permission-gated code in a worker thread or utility process (kernels, language servers, indexers). The permissions and consent flow are still evolving — see [permissions.md](./permissions.md).

## Quick Links

| Document | Description |
| --- | --- |
| [getting-started.md](./getting-started.md) | Create your first extension in 10 minutes |
| [custom-editors.md](./custom-editors.md) | Build editors for new file types |
| [ai-tools.md](./ai-tools.md) | Add tools that Claude can use |
| [contribution-points.md](./contribution-points.md) | Extend the built-in markdown editor and transcript renderer |
| [permissions.md](./permissions.md) | Backend modules, the granular permission catalog, and the consent flow (evolving) |
| [manifest-reference.md](./manifest-reference.md) | Complete manifest.json schema |
| [api-reference.md](./api-reference.md) | TypeScript types and interfaces |

## Examples

Working example projects you can copy and modify:

| Example | Description |
| --- | --- |
| [minimal](./examples/minimal/) | Bare-bones extension structure |
| [custom-editor](./examples/custom-editor/) | Full custom editor with toolbar |
| [ai-tool](./examples/ai-tool/) | Extension that adds AI tools |

## Recommended In-App Flow

The intended workflow is to create and iterate on extensions from inside Nimbalyst:

1. Enable Extension Dev Tools in Settings > Advanced
2. Use `File > New Extension Project` or `Developer > New Extension Project`
3. Or, in Claude, run `/new-extension <path> <name> [file-patterns]`
4. Describe the extension you want Claude to build from the starter scaffold
5. Ask Claude to build and install the extension with `extension_build` and `extension_install`
6. Use `extension_reload` for rebuild + reinstall during iteration

## Development Workflow

1. **Create** - Use `/new-extension` inside Nimbalyst or copy an example
2. **Develop** - Edit files in your extension project
3. **Build** - Claude uses `extension_build` to compile
4. **Install** - Claude uses `extension_install` to load it
5. **Test** - Open a file with your extension's file type
6. **Iterate** - Claude uses `extension_reload` for hot updates

## Prerequisites

- Nimbalyst with Extension Dev Tools enabled (Settings > Advanced)
- Node.js 18+ installed
- Basic knowledge of React and TypeScript

## Project Structure

A typical extension project looks like:

```
my-extension/
  manifest.json       # Extension metadata and contributions
  package.json        # npm dependencies
  tsconfig.json       # TypeScript configuration
  vite.config.ts      # Build configuration
  src/
    index.ts          # Extension entry point (activate/deactivate)
    components/       # React components
    styles.css        # Scoped styles
```

## Getting Help

- Read the [getting-started.md](./getting-started.md) guide
- Check the [examples](./examples/) for working code
- Look at built-in extensions in `packages/extensions/` for reference
