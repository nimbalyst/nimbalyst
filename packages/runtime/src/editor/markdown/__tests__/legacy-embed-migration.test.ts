import { describe, expect, it } from 'vitest';
import { upgradeLegacyMockupEmbeds } from '../EnhancedMarkdownImport';

describe('upgradeLegacyMockupEmbeds', () => {
  it('migrates sized mockup references to the universal embed link contract', () => {
    expect(
      upgradeLegacyMockupEmbeds(
        '![Tracker Studio](preview.png){mockup:./tracker-studio.mockup.html}{1200x760}',
      ),
    ).toBe('[Tracker Studio](./tracker-studio.mockup.html "width=1200 height=760")');
  });

  it('migrates legacy references without dimensions', () => {
    expect(
      upgradeLegacyMockupEmbeds(
        '![Architecture](diagram.png){mockup:../architecture/system.excalidraw}',
      ),
    ).toBe('[Architecture](../architecture/system.excalidraw)');
  });

  it('leaves current embed links and ordinary images unchanged', () => {
    const markdown = [
      '[Architecture](../architecture/system.excalidraw "width=1000 height=650")',
      '![Screenshot](screenshot.png){800x600}',
    ].join('\n\n');

    expect(upgradeLegacyMockupEmbeds(markdown)).toBe(markdown);
  });
});
