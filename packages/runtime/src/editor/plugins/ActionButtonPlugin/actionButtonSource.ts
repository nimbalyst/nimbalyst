/**
 * The two action-button fences and what their YAML bodies mean.
 *
 *   ```action
 *   label: Draft release notes
 *   prompt: |
 *     Read this page and draft release notes for everything under "Shipped".
 *   model: claude-code:opus      # optional; the user's default otherwise
 *   effort: high                 # optional: low, medium, high, xhigh, max, ultra
 *   ```
 *
 *   ```new-item
 *   label: New decision
 *   type: decision
 *   title: Untitled decision     # optional; the click asks for a title
 *   template: |                  # optional: inline markdown, or a page link
 *     ## Context
 *
 *     ## Options
 *   ```
 *
 * The node keeps the body verbatim (the shared fence contract), so keys this
 * version does not read survive a save. Pure and React-free.
 */

import { parseFenceYaml } from '../../../core/fenceBody';
import type { EffortLevel } from '../../../ai/server/effortLevels';

export * from './actionButtonFences';

const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export interface SessionAction {
  label: string;
  prompt: string;
  model?: string;
  effort?: EffortLevel;
}

export interface NewItemAction {
  label: string;
  type: string;
  title?: string;
  /** Inline markdown, or a page link whose content becomes the body. */
  template?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function optionalString(value: Record<string, unknown>, key: string): Parsed<string | undefined> {
  const raw = value[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw === 'number' || typeof raw === 'boolean') return { ok: true, value: String(raw) };
  if (typeof raw !== 'string') return { ok: false, error: `"${key}" must be text.` };
  return { ok: true, value: raw.trim() === '' ? undefined : raw };
}

export function parseSessionAction(source: string): Parsed<SessionAction> {
  const parsed = parseFenceYaml(source);
  if (!parsed.ok) return parsed;
  const label = optionalString(parsed.value, 'label');
  const prompt = optionalString(parsed.value, 'prompt');
  const model = optionalString(parsed.value, 'model');
  const effort = optionalString(parsed.value, 'effort');
  for (const field of [label, prompt, model, effort]) if (!field.ok) return field;
  if (!prompt.ok || !prompt.value?.trim()) return { ok: false, error: 'Add a "prompt:" for the session to run.' };
  const effortValue = effort.ok ? effort.value?.trim().toLowerCase() : undefined;
  if (effortValue && !(EFFORTS as readonly string[]).includes(effortValue)) {
    return { ok: false, error: `"effort" must be one of ${EFFORTS.join(', ')}.` };
  }
  return {
    ok: true,
    value: {
      label: (label.ok && label.value?.trim()) || 'Start session',
      prompt: prompt.value.replace(/\s+$/, ''),
      ...(model.ok && model.value?.trim() ? { model: model.value.trim() } : {}),
      ...(effortValue ? { effort: effortValue as EffortLevel } : {}),
    },
  };
}

export function parseNewItemAction(source: string): Parsed<NewItemAction> {
  const parsed = parseFenceYaml(source);
  if (!parsed.ok) return parsed;
  const label = optionalString(parsed.value, 'label');
  const type = optionalString(parsed.value, 'type');
  const title = optionalString(parsed.value, 'title');
  const template = optionalString(parsed.value, 'template');
  for (const field of [label, type, title, template]) if (!field.ok) return field;
  if (!type.ok || !type.value?.trim()) return { ok: false, error: 'Add a "type:" naming the page type to create.' };
  return {
    ok: true,
    value: {
      label: (label.ok && label.value?.trim()) || `New ${type.value.trim()}`,
      type: type.value.trim(),
      ...(title.ok && title.value?.trim() ? { title: title.value.trim() } : {}),
      ...(template.ok && template.value !== undefined ? { template: template.value } : {}),
    },
  };
}

const MARKDOWN_LINK_REGEX = /^\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)$/;

/**
 * The href when a template is a single page link (`[Name](href)` or a bare
 * href), so its page supplies the body; null when it is inline markdown.
 */
export function templateLinkHref(template: string): string | null {
  const trimmed = template.trim();
  if (trimmed.includes('\n')) return null;
  const link = trimmed.match(MARKDOWN_LINK_REGEX);
  if (link) return link[1];
  return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(trimmed) ? trimmed : null;
}

export const DEFAULT_SESSION_ACTION_SOURCE = [
  'label: Summarize this page',
  'prompt: |',
  '  Read this page and summarize the open questions.',
].join('\n');

export const DEFAULT_NEW_ITEM_ACTION_SOURCE = [
  'label: New decision',
  'type: decision',
].join('\n');
