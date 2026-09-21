import { test, expect, extensionEditor } from '@nimbalyst/extension-sdk/testing';
import { fileURLToPath } from 'node:url';

// Open samples/page-geometry.pdf with extension_test_open_file before running.
const sample = fileURLToPath(new URL('../samples/page-geometry.pdf', import.meta.url));

test('page boxes, canvas and text agree for landscape, portrait, rotation and crop at zoom and Fit', async ({ page }) => {
  const editor = extensionEditor(page, 'com.nimbalyst.pdf-viewer', sample);
  await expect(editor).toBeVisible();
  await editor.locator('[title="Click to reset zoom"]').click();
  await editor.getByTitle('Zoom Out (Cmd+-)', { exact: true }).click();
  await editor.getByTitle('Zoom Out (Cmd+-)', { exact: true }).click();
  await expect(editor.locator('[title="Click to reset zoom"]')).toHaveText('50%');
  const scroller = editor.locator('.pdf-scroll-view > div');
  await scroller.evaluate(el => { el.scrollTop = 0; });

  const dimensions = [[792, 612], [792, 612], [612, 792], [792, 612], [648, 468]];
  for (const [index, [width, height]] of dimensions.entries()) {
    const pageBox = editor.locator(`[data-page-number="${index + 1}"]`);
    await pageBox.scrollIntoViewIfNeeded();
    await expect(pageBox.locator('.textLayer span')).toBeVisible();
    await expect.poll(() => pageBox.evaluate(el => el.getBoundingClientRect().width)).toBe(width / 2);
    const geometry = await pageBox.evaluate(el => {
      const box = el.getBoundingClientRect();
      const canvas = el.querySelector('canvas')!.getBoundingClientRect();
      const text = el.querySelector('.textLayer')!.getBoundingClientRect();
      return { box: box.toJSON(), canvas: canvas.toJSON(), text: text.toJSON() };
    });
    expect(geometry.box.height).toBe(height / 2);
    for (const layer of [geometry.canvas, geometry.text]) {
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(layer[key] - geometry.box[key]), `page ${index + 1} ${key}`).toBeLessThan(1);
      }
    }
  }

  await scroller.evaluate(el => { el.scrollTop = 0; });
  const first = editor.locator('[data-page-number="1"]');
  const second = editor.locator('[data-page-number="2"]');
  await expect(first.locator('.textLayer span')).toBeVisible();
  await expect(second.locator('.textLayer span')).toBeVisible();
  const firstBox = await first.boundingBox();
  const secondBox = await second.boundingBox();
  expect(secondBox!.y - firstBox!.y - firstBox!.height).toBeCloseTo(16, 1);

  await editor.getByTitle('Fit to Width', { exact: true }).click();
  const availableWidth = await editor.locator('.pdf-scroll-view').evaluate(el => el.clientWidth - 32);
  await expect.poll(() => first.evaluate(el => el.getBoundingClientRect().width)).toBeCloseTo(availableWidth, 1);
  const fitBox = await first.boundingBox();
  expect(fitBox!.width / fitBox!.height).toBeCloseTo(792 / 612, 3);

  // Resize the viewer without changing the user's window or pane arrangement.
  const container = editor.locator('.pdf-scroll-view');
  const previousWidth = await container.evaluate(el => (el as HTMLElement).style.width);
  try {
    await container.evaluate(el => { (el as HTMLElement).style.width = '600px'; });
    await expect.poll(() => first.evaluate(el => el.getBoundingClientRect().width)).toBeCloseTo(568, 1);
    await editor.locator('[title="Click to reset zoom"]').click();
    await expect.poll(() => first.evaluate(el => el.getBoundingClientRect().width)).toBe(792);
    await expect.poll(() => scroller.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await scroller.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    const rightEdge = await first.boundingBox();
    const scrollRight = await scroller.evaluate(el => el.getBoundingClientRect().x + el.clientWidth);
    expect(rightEdge!.x + rightEdge!.width).toBeCloseTo(scrollRight, 1);
  } finally {
    await container.evaluate((el, width) => { (el as HTMLElement).style.width = width; }, previousWidth);
    await scroller.evaluate(el => { el.scrollLeft = 0; el.scrollTop = 0; });
    await editor.getByTitle('Fit to Width', { exact: true }).click();
  }
});
