# Markdown Editor and Transcript Contribution Points

This guide covers the extension APIs that add behavior to Nimbalyst's
built-in markdown editor and AI transcript renderer.

Use these APIs when your extension needs to:

- add slash-picker entries to the markdown editor
- add markdown import/export transformers
- register Lexical nodes or full `LexicalExtension` objects
- teach the diff system how to handle a custom node type
- render transcript markdown languages like `mermaid` or `math` with a
  custom widget

## The Four Contribution Surfaces

| Surface | Preferred registration style | Purpose |
| --- | --- | --- |
| `setExtensionContributions()` | Declarative for `nodes`, `transformers`, and slash commands; imperative fallback available | Slash-picker entries, markdown transformers, dynamic picker options |
| `setExtensionLexicalExtension()` | Declarative `contributions.lexicalExtensions` + `module.lexicalExtensions`; imperative fallback available | Full Lexical extensions with `nodes`, `dependencies`, and `register()` |
| `diffHandlerRegistry.register()` | Imperative in `activate()` | Diff behavior for custom node types |
| `setTranscriptMarkdownContributions()` | Usually from a host component | Transcript markdown plugins, component overrides, transcript-only styles |

## Import Note

The imperative APIs in this guide come from `@nimbalyst/runtime`.
Nimbalyst provides that module at runtime, so do not add
`@nimbalyst/runtime` to your extension's `package.json`.

## Preferred Path: Declarative Manifest + Module Exports

For editor contributions, prefer declaring names in `manifest.json` and
exporting matching values from your extension module. The extension
loader reads those exports and wires them into the runtime editor stores
for you.

### Manifest

```json
{
  "contributions": {
    "slashCommands": [
      {
        "id": "mermaid.insert",
        "title": "Insert Mermaid Diagram",
        "handler": "insertMermaid"
      }
    ],
    "nodes": ["MermaidNode"],
    "transformers": ["MERMAID_TRANSFORMER"],
    "lexicalExtensions": ["MermaidLexicalExtension"],
    "hostComponents": ["TranscriptMermaidHost"]
  }
}
```

### Module Exports

```ts
import './styles.css';

export const nodes = {
  MermaidNode,
};

export const transformers = {
  MERMAID_TRANSFORMER,
};

export const lexicalExtensions = {
  MermaidLexicalExtension,
};

export const slashCommandHandlers = {
  insertMermaid() {
    // Called when the slash command contribution is chosen
  },
};

export const hostComponents = {
  TranscriptMermaidHost,
};
```

### What the Host Does

- `contributions.nodes` + `module.nodes` are wrapped into a synthetic
  Lexical extension and added to the markdown editor
- `contributions.transformers` + `module.transformers` are published into
  the markdown import/export transformer list
- `contributions.slashCommands` + `module.slashCommandHandlers` are
  published into the markdown slash picker
- `contributions.lexicalExtensions` + `module.lexicalExtensions` are
  added directly to the editor's Lexical extension graph
- `contributions.hostComponents` + `module.hostComponents` are mounted by
  the host app, which is the usual place to register transcript markdown
  behavior

Use the imperative APIs below when you need to register something
conditionally at activation time instead of declaring it up front.

## `setExtensionContributions()`

Use `setExtensionContributions(source, contribution)` to contribute
markdown-editor features that are not full `LexicalExtension` objects.

```ts
import { setExtensionContributions } from '@nimbalyst/runtime';

setExtensionContributions('com.example.mermaid', {
  userCommands: [
    {
      title: 'Mermaid Diagram',
      description: 'Insert a Mermaid diagram block',
      icon: 'account_tree',
      keywords: ['mermaid', 'diagram', 'flowchart'],
      command: INSERT_MERMAID_COMMAND,
    },
  ],
  markdownTransformers: [MERMAID_TRANSFORMER],
  getDynamicOptions: async (queryString) => {
    return searchDiagramTemplates(queryString);
  },
});
```

### When to use it

- You need an imperative fallback instead of manifest-declared
  `transformers` or `slashCommands`
- You want to add `getDynamicOptions()` for async slash-picker results
- You are publishing editor contributions conditionally from `activate()`

### Contribution Shape

| Field | Description |
| --- | --- |
| `userCommands` | Slash-picker entries in the markdown editor |
| `markdownTransformers` | Markdown import/export transformers |
| `getDynamicOptions(queryString)` | Async provider for dynamic slash-picker options |

## `setExtensionLexicalExtension()`

Use `setExtensionLexicalExtension(source, lexicalExtension)` to register a
full Lexical extension imperatively.

```ts
import { setExtensionLexicalExtension } from '@nimbalyst/runtime';
import { defineExtension } from 'lexical';

export const MermaidLexicalExtension = defineExtension({
  name: 'com.example.mermaid/lexical',
  nodes: [MermaidNode],
  register: (editor) =>
    editor.registerCommand(
      INSERT_MERMAID_COMMAND,
      (payload) => {
        editor.update(() => {
          $insertNodes([$createMermaidNode(payload)]);
        });
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});

export async function activate(): Promise<void> {
  setExtensionLexicalExtension('com.example.mermaid', MermaidLexicalExtension);
}
```

### Preferred vs. imperative path

- Preferred: declare `contributions.lexicalExtensions` in the manifest
  and export matching values from `module.lexicalExtensions`
- Imperative fallback: call `setExtensionLexicalExtension()` in
  `activate()` when registration must be conditional

### What the `lexicalExtension` value looks like

Pass the same kind of value you would give to Lexical's extension
composer:

- a `defineExtension({ ... })` result
- a configured extension such as `configExtension(SomeExtension, config)`
- any other `AnyLexicalExtensionArgument` accepted by Lexical

## `diffHandlerRegistry.register()`

If your custom node needs special diff behavior, register a diff handler
from `activate()`.

```ts
import { diffHandlerRegistry } from '@nimbalyst/runtime';

class MermaidDiffHandler {
  readonly nodeType = 'mermaid';

  canHandle(context) {
    return $isMermaidNode(context.liveNode);
  }

  handleUpdate(context) {
    // ...
    return { handled: true, skipChildren: true };
  }

  handleAdd(targetNode, parentNode, position, validator) {
    // ...
    return { handled: true };
  }

  handleRemove(liveNode, validator) {
    // ...
    return { handled: true };
  }
}

export async function activate(): Promise<void> {
  diffHandlerRegistry.register(new MermaidDiffHandler());
}
```

### Required Handler Methods

Your handler must implement:

```ts
interface DiffNodeHandler {
  readonly nodeType: string;
  canHandle(context): boolean;
  handleUpdate(context): DiffHandlerResult;
  handleAdd(targetNode, parentNode, position, validator): DiffHandlerResult;
  handleRemove(liveNode, validator): DiffHandlerResult;
  handleApprove?(liveNode, validator): DiffHandlerResult;
  handleReject?(liveNode, validator): DiffHandlerResult;
}
```

### Notes

- Register handlers from `activate()`
- Re-registering the same `nodeType` replaces the previous handler
- `MermaidDiffHandler` in the runtime source is a good reference for an
  atomic block node

## `setTranscriptMarkdownContributions()`

Use `setTranscriptMarkdownContributions(source, contribution)` to extend
the markdown renderer used in the AI transcript and chat UI.

This is the API to use when you want to render fenced code blocks for a
specific language as a custom widget.

```ts
import { useEffect } from 'react';
import {
  clearTranscriptMarkdownContributions,
  setTranscriptMarkdownContributions,
} from '@nimbalyst/runtime';

const SOURCE = 'com.example.mermaid';

export function TranscriptMermaidHost(): null {
  useEffect(() => {
    setTranscriptMarkdownContributions(SOURCE, {
      components: {
        code: TranscriptMermaidCodeBlock,
      },
    });

    return () => {
      clearTranscriptMarkdownContributions(SOURCE);
    };
  }, []);

  return null;
}
```

### Why register from a host component?

Transcript contributions are usually best owned by a host component
because:

- the host mounts and unmounts the component automatically
- the contribution cleans itself up on unmount
- transcript behavior often travels with transcript-specific UI and CSS

### Contribution Shape

| Field | Description |
| --- | --- |
| `remarkPlugins?: ReadonlyArray<unknown>` | Extra remark plugins for transcript markdown |
| `rehypePlugins?: ReadonlyArray<unknown>` | Extra rehype plugins for transcript markdown |
| `components?: Readonly<Record<string, ComponentType<any>>>` | `react-markdown` component overrides |
| `styles?: ReadonlyArray<...>` | Transcript-only inline CSS or stylesheet links |

### Rendering a specific language

Override `components.code` and branch on `className` or parsed language:

```ts
function TranscriptMermaidCodeBlock(props: any) {
  const className = props.className || '';
  const match = /language-(\w+)/.exec(className);
  const language = match?.[1];

  if (language === 'mermaid') {
    return <MermaidPreview source={String(props.children)} />;
  }

  return <code className={className}>{props.children}</code>;
}
```

When multiple contributors override the same component key, the last
registered contributor wins.

## Desktop Availability

Community extensions currently run in the desktop extension host.
Transcript markdown contributions are therefore available for desktop
transcript rendering. The mobile apps use the same renderer internally,
but they do not currently load third-party desktop extensions.

## Choosing the Right Path

Use the declarative manifest/module path when:

- the contribution is static
- you can list the export name in `manifest.json`
- you want the smallest amount of activation code

Use the imperative runtime API when:

- registration is conditional
- registration depends on settings or runtime checks
- you are integrating with a registry that has no manifest counterpart
  such as `diffHandlerRegistry`
