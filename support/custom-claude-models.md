# Using your own models with Claude Code in Nimbalyst

If you route Claude Code through your own gateway or model router running on your machine, you can make its models selectable in Nimbalyst's model picker.

## Setup

Define the models in Claude's settings under `modelPicker`, the same way Claude Code's `/model` menu reads them. Use `~/.claude/settings.json` for all projects, or `.claude/settings.json` / `.claude/settings.local.json` in a project for that project only.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:20128/v1"
  },
  "modelPicker": {
    "options": [
      { "model": "Fast", "label": "Fast Combo", "description": "Router 'Fast' combo", "behavesAs": "claude-opus-4-8" },
      { "model": "Smart", "label": "Smart Combo", "behavesAs": "claude-opus-4-8" }
    ],
    "replaceBuiltInOptions": true
  }
}
```

Open the model picker in Nimbalyst. The models appear under Claude Agent and Claude Code CLI, labeled with your `label`. Changes to the settings file show up the next time you open the picker.

## How the fields are used

- **`model`**: the name sent to your gateway, exactly as written.
- **`label`**: the name shown in the picker. Defaults to `model`.
- **`behavesAs`**: the Anthropic model whose capabilities yours shares. Nimbalyst uses it for the context-window meter and to decide whether to show the effort and extended-thinking controls. Without it, Nimbalyst assumes a 200k context window and hides the effort control.
- **`replaceBuiltInOptions`**: when `true`, the built-in Claude models are hidden from the picker.

If the same field is set in more than one file, the project's local settings win over project settings, which win over your user settings. The whole `modelPicker` block comes from one file; lists are not combined.

## Claude Code CLI sessions

Nimbalyst runs CLI sessions through a local proxy so it can show the transcript. That proxy forwards to:

1. the **Custom Claude API upstream** in Settings > Agent Features, if set; otherwise
2. `ANTHROPIC_BASE_URL` from Claude's settings `env`, if it is a local address (`localhost`, `127.0.0.1`, `::1`); otherwise
3. Anthropic.

A non-local `ANTHROPIC_BASE_URL` is not followed, because CLI traffic includes your Claude subscription token and full prompt content. Restart CLI sessions after changing either setting.

## Limitations

- The iOS app may show a generic label for these models.
- New sessions still start on the default Claude model even when built-ins are hidden. Pick your model once and Nimbalyst remembers it.

## Older Nimbalyst versions

Before this feature, Nimbalyst always sent its own Claude model ids. As a workaround, map those ids in your router (for example, route `claude-opus-5-5` to your combo) and pick that model in Nimbalyst.
