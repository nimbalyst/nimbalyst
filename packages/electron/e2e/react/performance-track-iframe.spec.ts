import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

test.use({ video: 'on' });

// This isolates React's real commit loop from app state. jsdom does not enforce
// cross-origin Window access, so a real sandboxed Chromium frame is essential.
test('development React keeps committing input after inspecting a sandboxed Window prop', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<iframe title="Sandbox" sandbox="allow-scripts allow-popups" srcdoc="<p>Sandbox ready</p>"></iframe><div id="root"></div>');
  await expect(page.getByTitle('Sandbox').contentFrame().getByText('Sandbox ready')).toBeVisible();
  expect(await page.evaluate(() => {
    try {
      Reflect.get(document.querySelector('iframe')!.contentWindow!, '$$typeof');
      return 'readable';
    } catch (error) {
      return (error as Error).name;
    }
  })).toBe('SecurityError');

  const bundle = await build({
    stdin: {
      contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        function FrameHolder({ frame }) { return <span>{frame ? 'Attached' : 'Detached'}</span>; }
        function App() {
          const [frame, setFrame] = useState(null);
          const [text, setText] = useState('');
          const [clicks, setClicks] = useState(0);
          return <main>
            <FrameHolder frame={frame} />
            <button onClick={() => setFrame(document.querySelector('iframe').contentWindow)}>Attach frame</button>
            <button onClick={() => setFrame(null)}>Detach frame</button>
            <label>Prompt<input value={text} onChange={event => setText(event.target.value)} /></label>
            <output aria-label="Committed prompt">{text}</output>
            <button onClick={() => setClicks(value => value + 1)}>Clicks: {clicks}</button>
          </main>;
        }
        createRoot(document.getElementById('root')).render(<App />);
      `,
      loader: 'jsx',
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByRole('button', { name: 'Attach frame' }).click();
  await expect(page.getByText('Attached', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Prompt' }).pressSequentially('hello');
  await expect(page.getByRole('status', { name: 'Committed prompt' })).toHaveText('hello', { timeout: 3000 });
  await page.getByRole('button', { name: 'Clicks: 0', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clicks: 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Detach frame' }).click();
  await expect(page.getByText('Detached', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Prompt' }).press('End');
  await page.getByRole('textbox', { name: 'Prompt' }).pressSequentially(' again');
  await expect(page.getByRole('status', { name: 'Committed prompt' })).toHaveText('hello again');
  expect(errors).toEqual([]);
});
