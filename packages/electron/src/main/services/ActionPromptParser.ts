/**
 * Parser for ai-actions.md files.
 *
 * The file is a flat list of `## Heading` actions; the body is everything
 * between the heading and the next `## ` heading or end of file. The body is
 * preserved verbatim (with `\n` between lines) so users can include slash
 * commands, code fences, and multi-line natural language exactly as written.
 *
 * An action may optionally begin with a config block: contiguous lowercase
 * `key: value` lines immediately under the heading, terminated by the first
 * blank line. Only known keys are consumed, so bodies that legitimately start
 * with `Hello: world` keep working. See ActionLaunchConfig for the keys.
 */

import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';

export type ActionLaunch = 'same-session' | 'new-session';

export interface ActionLaunchConfig {
  launch: ActionLaunch;
  /** Provider:variant identifier (e.g. "claude-code:opus"); undefined = inherit parent's model */
  model?: string;
  foreground: boolean;
  autoSubmit: boolean;
  worktree: boolean;
}

export interface ActionPrompt {
  /** kebab-case slug derived from the heading, used as a stable id */
  id: string;
  /** original heading text, trimmed */
  label: string;
  /** trimmed body content (verbatim, with original line breaks preserved) */
  body: string;
  /** Parsed config block, if any. Undefined means the action has no config (back-compat path). */
  config?: ActionLaunchConfig;
}

export type ActionPromptDiagnosticCode =
  | 'duplicate-heading'
  | 'empty-body'
  | 'unknown-action-key'
  | 'invalid-launch'
  | 'invalid-bool'
  | 'invalid-model';

export interface ActionPromptParseDiagnostic {
  level: 'warning';
  code: ActionPromptDiagnosticCode;
  label: string;
  message: string;
}

export interface ActionPromptParseResult {
  actions: ActionPrompt[];
  diagnostics: ActionPromptParseDiagnostic[];
}

const COMBINING_DIACRITICAL_MARKS = /[̀-ͯ]/g;

function slugify(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICAL_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'action';
}

const KEY_VALUE_PATTERN = /^([a-z][a-zA-Z0-9_-]*)\s*:\s*(.+?)\s*$/;
const KNOWN_KEYS = new Set([
  'launch',
  'model',
  'foreground',
  'autoSubmit',
  'worktree',
]);

const DEFAULT_CONFIG: ActionLaunchConfig = {
  launch: 'same-session',
  model: undefined,
  foreground: true,
  autoSubmit: true,
  worktree: false,
};

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === 'yes' || v === '1') return true;
  if (v === 'false' || v === 'no' || v === '0') return false;
  return null;
}

interface ConfigParseOutcome {
  /** Number of input lines consumed (including any blank-line terminator). */
  consumedLines: number;
  /** Parsed config, or null if the first non-blank line was not a known key. */
  config: ActionLaunchConfig | null;
  diagnostics: ActionPromptParseDiagnostic[];
}

function parseConfigBlock(label: string, lines: string[]): ConfigParseOutcome {
  const diagnostics: ActionPromptParseDiagnostic[] = [];

  // Find the first non-blank line — if it isn't a known key, this section has
  // no config block and the entire content is body (back-compat path).
  let firstContentIdx = 0;
  while (firstContentIdx < lines.length && lines[firstContentIdx].trim() === '') {
    firstContentIdx++;
  }
  if (firstContentIdx >= lines.length) {
    return { consumedLines: 0, config: null, diagnostics };
  }

  const firstMatch = KEY_VALUE_PATTERN.exec(lines[firstContentIdx]);
  if (!firstMatch || !KNOWN_KEYS.has(firstMatch[1])) {
    return { consumedLines: 0, config: null, diagnostics };
  }

  const result: ActionLaunchConfig = { ...DEFAULT_CONFIG };
  let i = firstContentIdx;
  for (; i < lines.length; i++) {
    const line = lines[i];

    // Blank line terminates the config block; consume it so the body starts cleanly.
    if (line.trim() === '') {
      i++;
      break;
    }

    const match = KEY_VALUE_PATTERN.exec(line);
    if (!match) break;

    const key = match[1];
    const value = match[2];

    if (!KNOWN_KEYS.has(key)) {
      diagnostics.push({
        level: 'warning',
        code: 'unknown-action-key',
        label,
        message: `Unknown action config key "${key}" — line ignored.`,
      });
      continue;
    }

    switch (key) {
      case 'launch': {
        const v = value.trim();
        if (v === 'same-session' || v === 'new-session') {
          result.launch = v;
        } else {
          diagnostics.push({
            level: 'warning',
            code: 'invalid-launch',
            label,
            message: `Invalid launch value "${v}" — expected "same-session" or "new-session". Falling back to same-session.`,
          });
        }
        break;
      }
      case 'model': {
        const v = value.trim();
        // Validate via the canonical ModelIdentifier.tryParse so every model
        // the app itself accepts (including provider-prefixed IDs that
        // contain slashes like `opencode:anthropic/claude-sonnet-4-5`) is
        // valid here too. A hand-rolled regex here drifts from reality.
        if (ModelIdentifier.tryParse(v)) {
          result.model = v;
        } else {
          diagnostics.push({
            level: 'warning',
            code: 'invalid-model',
            label,
            message: `Invalid model "${v}" — expected provider:variant (e.g. "claude-code:opus"). Falling back to inherit.`,
          });
        }
        break;
      }
      case 'foreground': {
        const parsed = parseBool(value);
        if (parsed === null) {
          diagnostics.push({
            level: 'warning',
            code: 'invalid-bool',
            label,
            message: `Invalid foreground value "${value.trim()}" — expected true or false.`,
          });
        } else {
          result.foreground = parsed;
        }
        break;
      }
      case 'autoSubmit': {
        const parsed = parseBool(value);
        if (parsed === null) {
          diagnostics.push({
            level: 'warning',
            code: 'invalid-bool',
            label,
            message: `Invalid autoSubmit value "${value.trim()}" — expected true or false.`,
          });
        } else {
          result.autoSubmit = parsed;
        }
        break;
      }
      case 'worktree': {
        const parsed = parseBool(value);
        if (parsed === null) {
          diagnostics.push({
            level: 'warning',
            code: 'invalid-bool',
            label,
            message: `Invalid worktree value "${value.trim()}" — expected true or false.`,
          });
        } else {
          result.worktree = parsed;
        }
        break;
      }
    }
  }

  return { consumedLines: i, config: result, diagnostics };
}

/**
 * Parse the content of an ai-actions.md file into a list of actions.
 *
 * Splits on lines that begin with `## ` (exactly two `#` followed by a space).
 * Headings are detected line-by-line; lines inside fenced code blocks are
 * ignored so that `## ` literals inside code fences don't open new actions.
 */
export function parseActionPromptsFile(content: string): ActionPromptParseResult {
  const actions: ActionPrompt[] = [];
  const diagnostics: ActionPromptParseDiagnostic[] = [];
  const seenIds = new Set<string>();

  if (!content || !content.trim()) {
    return { actions, diagnostics };
  }

  const lines = content.split(/\r?\n/);
  let currentLabel: string | null = null;
  let currentBody: string[] = [];
  let inFencedCode = false;

  const flush = () => {
    if (currentLabel === null) return;
    const label = currentLabel.trim();
    if (!label) return;
    const id = slugify(label);
    if (seenIds.has(id)) {
      diagnostics.push({
        level: 'warning',
        code: 'duplicate-heading',
        label,
        message: `Duplicate action heading "${label}" — only the first occurrence is used.`,
      });
      return;
    }

    const configOutcome = parseConfigBlock(label, currentBody);
    diagnostics.push(...configOutcome.diagnostics);
    const bodyLines = currentBody.slice(configOutcome.consumedLines);
    const body = bodyLines.join('\n').trim();

    if (!body) {
      diagnostics.push({
        level: 'warning',
        code: 'empty-body',
        label,
        message: `Action "${label}" has no body and will be skipped.`,
      });
      return;
    }

    seenIds.add(id);
    const action: ActionPrompt = { id, label, body };
    if (configOutcome.config) {
      action.config = configOutcome.config;
    }
    actions.push(action);
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFencedCode = !inFencedCode;
    }

    const headingMatch = !inFencedCode && /^##\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      flush();
      currentLabel = headingMatch[1];
      currentBody = [];
      continue;
    }

    if (currentLabel !== null) {
      currentBody.push(line);
    }
  }

  flush();

  return { actions, diagnostics };
}

/** Default content seeded into ai-actions.md when the user creates the file. */
export const DEFAULT_ACTION_PROMPTS_TEMPLATE = `# AI Action Prompts

This file lists reusable prompts that show up in the **Actions** dropdown in the AI composer.
Each \`## Heading\` is one action; everything beneath it (until the next \`##\`) is the prompt that gets inserted into the draft when you pick the action.

Actions can also launch a brand-new sibling session in the current workstream
instead of prefilling the current input.

Recognized keys: \`launch\` (same-session | new-session), \`model\`
(provider:variant), \`foreground\` (true/false), \`autoSubmit\` (true/false),
\`worktree\` (true/false). \`launch: same-session\` is the default; omit the
block entirely to keep current behavior.

## Review Changed Files
/review changed files in this session and call out regression risk in the affected modules.

## Plan Implementation
Look at the active issue (linked above) and the open editor.

Produce a structured plan that:
- breaks the work into 3-5 phases
- identifies the files I'll need to touch
- flags any cross-cutting concerns I should think about before writing code

When you're done, ask me which phase to start with.

## Plan in Fresh Opus Session
launch: new-session
model: claude-code:opus
foreground: true
autoSubmit: true

Open a fresh sibling planning session.
Look at the originating session for context, then produce a clean implementation plan in 3-5 phases.
Call out the riskiest unknowns before suggesting code changes.

## Worktree Implementation Draft
launch: new-session
foreground: true
autoSubmit: false
worktree: true

Open a sibling coding session in a git worktree.
Use the originating session and current editor state for context.
Draft the first implementation message I should send there, including the files to inspect first and the first validation step.

## Draft Release Notes
/release-notes from merged work since the last tag, formatted as a user-facing changelog.

## Inspect Current Editor
Read the file that's currently open and tell me what you'd change. Be specific:
- 3 concrete improvements
- 1 thing that's already good and shouldn't change
`;
