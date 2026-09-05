import { test, expect } from '@nimbalyst/extension-sdk/testing';

test('retained legacy canvas survives switching away while its sources load', async ({ page }) => {
  test.setTimeout(60000);
  const experience = page.locator('.pg-experience');
  if (!await experience.isVisible()) {
    await page.getByRole('button', { name: 'Project Graph', exact: true }).click();
  }
  await expect(experience).toBeVisible();
  await experience.getByRole('button', { name: 'Advanced: legacy graph', exact: true }).click();
  await experience.getByRole('button', { name: 'Return to project views', exact: true }).click();
  const hidden = experience.locator('.pg-experience-page[hidden]');
  expect(await hidden.evaluate(e => e.getBoundingClientRect().width)).toBeGreaterThan(0);
  await expect(hidden).toBeHidden();
  await expect.poll(() => page.evaluate(() => {
    const sigma = (window as unknown as { __pgSigma?: { getGraph(): { order: number } } }).__pgSigma;
    return sigma?.getGraph().order ?? 0;
  }), { timeout: 45000 }).toBeGreaterThan(0);
  await expect(experience).toBeVisible();
  await experience.getByRole('button', { name: 'Advanced: legacy graph', exact: true }).click();
  await expect(experience.locator('.pg-experience-page:not([hidden]) canvas').first()).toBeVisible();
  await experience.getByRole('button', { name: 'Return to project views', exact: true }).click();
  await expect(experience.locator('.pg-prototype-lab')).toBeVisible();
});
