# Animation

Animated explainer diagrams for Nimbalyst, authored as `.anim.json` files.

An animation is a named scene plus an ordered list of steps. Each step assigns *states* to the scene's parts -- a node becomes `active`, an edge starts `flowing`, a label lights up -- and CSS transitions interpolate between them. There are no keyframes, easing curves, or property tracks to manage.

## Features

- **Steps, not a dope sheet** -- write what is true at each beat; the editor handles the motion between beats.
- **Scrub and retime** -- drag the playhead through the timeline, or drag a step boundary to change how long a beat holds.
- **Click a part to talk about it** -- clicking any node, edge, or label puts it in chat context along with its current state and time, so you can ask an agent to change exactly that.
- **Plain JSON on disk** -- any agent can author or edit an animation with `Write` and `Edit`. No binary format, no required tool calls.
- **Export** -- render an animation to standalone HTML, GIF, or MP4.

## File format

```json
{
  "version": 1,
  "stage": { "width": 1200, "height": 620, "fps": 25 },
  "parts": {
    "cache": { "type": "node", "label": "Cache", "x": 420, "y": 200, "w": 260, "h": 176 }
  },
  "steps": [
    { "id": "lookup", "duration": 1000, "caption": "The service asks the cache for the key.",
      "set": { "cache": { "state": "active", "tone": "data" } } }
  ]
}
```

Five part types -- `node`, `edge`, `label`, `shape`, and `html` for product UI the primitives cannot draw -- and seven semantic tones that follow the user's theme. States are **cumulative**: a step asserts only what changes, and anything it does not mention keeps whatever the previous step left it in.

`samples/demo.anim.json` is a complete ten-step example.

## AI tools

| Tool | Does |
| --- | --- |
| `animation.export_html` | Render to a standalone HTML file |
| `animation.export_gif` | Render to an animated GIF |
| `animation.export_mp4` | Render to an MP4 |

The bundled Claude plugin adds an `animation` skill covering the format in full, plus an `/animate` command that creates an explainer from a description.

## Development

```bash
pnpm install
pnpm run build
```

Use `extension_reload` from the Extension Dev Kit to apply a build to the running app -- a bare `pnpm run build` does not install anything.
