/**
 * A new-item template's body: inline markdown as written, or the content of
 * the page (or section) a template link points at, read once through the
 * transclusion host, which already knows how to read every kind of page.
 */

import { getTransclusionHost, type TransclusionHost } from '../TransclusionPlugin/transclusionHost';
import { parseTransclusionHref } from '../TransclusionPlugin/transclusionLink';
import { extractTransclusionSection } from '../TransclusionPlugin/transclusionSection';
import { templateLinkHref } from './actionButtonSource';

export type TemplateBody = { ok: true; body: string } | { ok: false; error: string };

const READ_TIMEOUT_MS = 15_000;

export function resolveTemplateBody(
  template: string | undefined,
  host: TransclusionHost | null = getTransclusionHost(),
): Promise<TemplateBody> {
  if (template === undefined) return Promise.resolve({ ok: true, body: '' });
  const href = templateLinkHref(template);
  const link = href ? parseTransclusionHref(href) : null;
  if (!link) return Promise.resolve({ ok: true, body: template.replace(/\s+$/, '') });
  if (!host) return Promise.resolve({ ok: false, error: 'Template pages cannot be read here.' });

  return new Promise((resolve) => {
    let done = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (result: TemplateBody) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // The first state can arrive inside `subscribe`, before it returns the unsubscribe.
      queueMicrotask(() => unsubscribe?.());
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'The template page did not load in time.' }), READ_TIMEOUT_MS);
    unsubscribe = host.subscribe(link, (state) => {
      if (state.status === 'loading') return;
      if (state.status !== 'ready') {
        const reason = state.status === 'missing' ? 'does not exist here' : state.status === 'no-access' ? 'is not readable by you' : 'could not be read';
        finish({ ok: false, error: `The template page ${reason}${'message' in state && state.message ? `: ${state.message}` : '.'}` });
        return;
      }
      const section = extractTransclusionSection(state.markdown, link.anchor);
      finish(section.status === 'ok'
        ? { ok: true, body: section.markdown }
        : { ok: false, error: `The template page has no section "#${section.anchor}".` });
    });
  });
}
