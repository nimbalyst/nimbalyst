import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

test('long lines in new-file previews scroll inside the card before and after expansion', async ({ page }, testInfo) => {
  const packages = path.resolve(path.dirname(testInfo.file), '../../..');
  const bundle = await build({
    stdin: {
      resolveDir: path.join(packages, 'runtime/src/ui/AgentTranscript/components'),
      loader: 'jsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { NewFilePreview } from './NewFilePreview';
        const line = JSON.stringify({ description: 'a'.repeat(500) });
        createRoot(document.querySelector('main')).render(<>
          <NewFilePreview filePath="short.json" content={line} />
          <NewFilePreview filePath="long.json" content={Array(40).fill(line).join('\\n')} />
        </>);
      `,
    },
    alias: { '@nimbalyst/tracker-core': path.join(packages, 'tracker-core/src/index.ts') },
    bundle: true,
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.yaml': 'text' },
  });
  await page.setContent('<main style="width:320px"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const cards = page.locator('.new-file-preview');
  await expect(cards).toHaveCount(2);
  async function expectScrollable(index: number) {
    const bounds = await cards.nth(index).evaluate(card => {
      const viewport = card.querySelector('code')!.parentElement!;
      viewport.scrollLeft = 100;
      return { scrollLeft: viewport.scrollLeft, overflow: card.scrollWidth - card.clientWidth };
    });
    expect(bounds.scrollLeft).toBeGreaterThan(0);
    expect(bounds.overflow).toBeLessThanOrEqual(1);
  }
  await expectScrollable(0);
  await expectScrollable(1);
  await cards.nth(1).getByRole('button', { name: /show|expand/i }).click();
  await expectScrollable(1);
});
