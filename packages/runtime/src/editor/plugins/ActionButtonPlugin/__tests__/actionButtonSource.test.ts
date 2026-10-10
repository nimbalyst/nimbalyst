// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { fenceRoundTrip } from '../../fencedBlock/__tests__/fenceRoundTrip';
import type { TransclusionHost, TransclusionSourceState } from '../../TransclusionPlugin/transclusionHost';
import { parseNewItemAction, parseSessionAction, templateLinkHref } from '../actionButtonSource';
import { resolveTemplateBody } from '../templateBody';

describe('action button fences', () => {
  it('round-trip both fences verbatim, unknown keys and comments included', () => {
    const md = [
      '```action',
      'label: Draft notes   # shown on the button',
      'prompt: |',
      '  Read this page.',
      '',
      '  Then draft ```release``` notes.',
      'model: claude-code:opus',
      'effort: high',
      'color: blue',
      '```',
      '',
      '```new-item',
      'label: New decision',
      'type: decision',
      'owner: me',
      '```',
    ].join('\n');
    const trip = fenceRoundTrip(md);
    expect(trip.errors).toEqual([]);
    expect(trip.blockTypes.filter((type) => type === 'action-button')).toHaveLength(2);
    // The body holds a triple-backtick run, so export picks a longer fence; it is stable from there.
    expect(trip.exported).toContain('````action\nlabel: Draft notes   # shown on the button');
    expect(trip.reexported).toBe(trip.exported);
    expect(fenceRoundTrip(trip.exported).exported).toBe(trip.exported);
  });

  it('parses a session action and rejects a missing prompt or an unknown effort', () => {
    expect(parseSessionAction('label: Go\nprompt: |\n  Do it.\nmodel: claude-code:opus\neffort: XHigh\nextra: 1')).toEqual({
      ok: true,
      value: { label: 'Go', prompt: 'Do it.', model: 'claude-code:opus', effort: 'xhigh' },
    });
    expect(parseSessionAction('label: Go')).toMatchObject({ ok: false, error: expect.stringContaining('prompt') });
    expect(parseSessionAction('prompt: x\neffort: huge')).toMatchObject({ ok: false, error: expect.stringContaining('effort') });
    expect(parseSessionAction('prompt: [a')).toMatchObject({ ok: false, error: expect.stringContaining('YAML') });
  });

  it('parses a new-item action and tells a template link from an inline body', () => {
    expect(parseNewItemAction('type: decision\ntemplate: "[T](collab://org:o:doc:D)"')).toEqual({
      ok: true,
      value: { label: 'New decision', type: 'decision', template: '[T](collab://org:o:doc:D)' },
    });
    expect(parseNewItemAction('label: x')).toMatchObject({ ok: false, error: expect.stringContaining('type') });
    expect(templateLinkHref('[T](collab://org:o:doc:D#steps)')).toBe('collab://org:o:doc:D#steps');
    expect(templateLinkHref('https://console.nimbalyst.com/app/page/P')).toBe('https://console.nimbalyst.com/app/page/P');
    expect(templateLinkHref('## Context\n\n[T](collab://org:o:doc:D)')).toBeNull();
  });
});

describe('template bodies', () => {
  const hostWith = (state: TransclusionSourceState): TransclusionHost & { unsubscribed: ReturnType<typeof vi.fn> } => {
    const unsubscribed = vi.fn();
    return {
      unsubscribed,
      subscribe: (_link, onChange) => {
        onChange({ status: 'loading' });
        onChange(state);
        return unsubscribed;
      },
      open: vi.fn(),
    };
  };

  it('uses inline markdown as written and reads a linked page section through the transclusion host', async () => {
    expect(await resolveTemplateBody('## Context\n\nText\n', null)).toEqual({ ok: true, body: '## Context\n\nText' });
    expect(await resolveTemplateBody(undefined, null)).toEqual({ ok: true, body: '' });

    const host = hostWith({ status: 'ready', markdown: '# Page\n\nIntro\n\n## Steps\n\n1. one\n\n## Other\n\nx', title: 'T' });
    const result = await resolveTemplateBody('[T](collab://org:o:doc:D#steps)', host);
    expect(result).toMatchObject({ ok: true, body: expect.stringContaining('1. one') });
    expect(result.ok && result.body).not.toContain('Other');
    await Promise.resolve();
    expect(host.unsubscribed).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when the template page cannot be read', async () => {
    expect(await resolveTemplateBody('[T](collab://org:o:doc:D)', null)).toMatchObject({ ok: false });
    expect(await resolveTemplateBody('[T](collab://org:o:doc:D)', hostWith({ status: 'no-access' })))
      .toMatchObject({ ok: false, error: expect.stringContaining('not readable') });
  });
});
