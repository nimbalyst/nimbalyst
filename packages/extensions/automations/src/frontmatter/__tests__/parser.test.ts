import { describe, it, expect } from 'vitest';
import {
  parseAutomationStatus,
  hasAutomationStatus,
  updateAutomationStatus,
  extractPromptBody,
} from '../parser';

// Regression coverage for nimbalyst#68: the FRONTMATTER_REGEX in this parser
// used to require bare LF line endings. Windows users with
// `git config core.autocrlf=true` checkout files with CRLF, so every helper
// here returned null/unchanged content and the automations extension treated
// CRLF files as if they had no automationStatus block at all.

const SAMPLE_STATUS = {
  id: 'daily-summary',
  title: 'Daily Summary',
  enabled: true,
  schedule: { type: 'daily', time: '09:00' },
  output: { mode: 'new-file', location: 'out/' },
};

function buildLfContent(): string {
  return [
    '---',
    'automationStatus:',
    `  id: ${SAMPLE_STATUS.id}`,
    `  title: ${SAMPLE_STATUS.title}`,
    '  enabled: true',
    '  schedule:',
    '    type: daily',
    `    time: "${SAMPLE_STATUS.schedule.time}"`,
    '  output:',
    '    mode: new-file',
    `    location: ${SAMPLE_STATUS.output.location}`,
    '---',
    '',
    '# Prompt body',
    '',
  ].join('\n');
}

function buildCrlfContent(): string {
  return buildLfContent().replace(/\n/g, '\r\n');
}

describe('automations parser - CRLF tolerance (#68)', () => {
  it('parseAutomationStatus reads LF frontmatter', () => {
    const status = parseAutomationStatus(buildLfContent());
    expect(status).not.toBeNull();
    expect(status?.id).toBe('daily-summary');
  });

  it('parseAutomationStatus reads CRLF frontmatter', () => {
    const status = parseAutomationStatus(buildCrlfContent());
    expect(status).not.toBeNull();
    expect(status?.id).toBe('daily-summary');
    expect(status?.title).toBe('Daily Summary');
  });

  it('hasAutomationStatus returns true for CRLF files', () => {
    expect(hasAutomationStatus(buildCrlfContent())).toBe(true);
  });

  it('extractPromptBody returns the body of a CRLF file', () => {
    const body = extractPromptBody(buildCrlfContent());
    expect(body).toContain('# Prompt body');
  });

  it('updateAutomationStatus preserves CRLF intent and updates fields', () => {
    const updated = updateAutomationStatus(buildCrlfContent(), { runCount: 3 });
    // Output is canonicalised to LF (jsyaml dump default), but the parse must
    // still succeed and the updated field must be present.
    const reparsed = parseAutomationStatus(updated);
    expect(reparsed?.runCount).toBe(3);
    expect(reparsed?.id).toBe('daily-summary');
  });

  it('returns null for content with no frontmatter', () => {
    expect(parseAutomationStatus('# Just a heading\n')).toBeNull();
    expect(parseAutomationStatus('# Just a heading\r\n')).toBeNull();
  });
});
