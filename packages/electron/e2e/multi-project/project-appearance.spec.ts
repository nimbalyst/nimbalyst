import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempWorkspace, launchElectronApp } from '../helpers';

test.describe.configure({ mode: 'serial' });
let app: ElectronApplication;
let page: Page;
let root: string;
let fileRocket: string;
let libraryKit: string;
let imagePath: string;
let savedImageUrl: string;

async function launch(preserveTestDatabase = false) {
  app = await launchElectronApp({
    workspace: fileRocket,
    mainPath: path.join(root, 'launch.cjs'),
    env: { NIMBALYST_USER_DATA_DIR: path.join(root, 'profile') },
    preserveTestDatabase,
    recordVideo: false,
  });
  page = await app.firstWindow();
  await page.getByTestId('window-top-bar').waitFor({ timeout: 60_000 });
}

async function customize(name: string, targetPage = page) {
  await targetPage.getByRole('button', { name: `Switch to project ${name}`, exact: true }).click({ button: 'right' });
  await targetPage.getByRole('button', { name: 'Customize appearance…', exact: true }).click();
  await expect(targetPage.getByTestId('project-appearance-panel')).toHaveAttribute(
    'data-project-path', name === 'FileRocket' ? fileRocket : libraryKit,
  );
}

async function history(button: 3 | 4) {
  await page.evaluate(button => document.dispatchEvent(new MouseEvent('auxclick', { button, bubbles: true })), button);
}

async function save() {
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = await createTempWorkspace();
  // Set the profile before importing main: some module initializers read stores
  // before bootstrap's body runs. The fixture must never inherit host settings.
  const electronRoot = path.resolve(__dirname, '../..');
  const mainPath = process.env.NIMBALYST_E2E_MAIN_PATH ?? path.join(electronRoot, 'out/main/index.js');
  await fs.writeFile(path.join(root, 'launch.cjs'), `
    const { app } = require('electron');
    app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
    app.setPath('appData', ${JSON.stringify(root)});
    app.setAppPath(${JSON.stringify(electronRoot)});
    require(${JSON.stringify(mainPath)});
  `);
  fileRocket = path.join(root, 'FileRocket');
  libraryKit = path.join(root, 'LibraryKit');
  for (const directory of [fileRocket, libraryKit, path.join(root, 'SecondWindow')]) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'README.md'), '# Appearance test\n');
  }
  await launch();
  await page.evaluate(async ({ fileRocket, libraryKit }) => {
    await window.electronAPI.invoke('app:set-multi-project-mode', true);
    await window.electronAPI.invoke('app:set-restore-previous-projects', true);
    await window.electronAPI.invoke('app-settings:set', 'recent.workspaces', [
      { path: libraryKit, name: 'LibraryKit', timestamp: Date.now() },
      { path: fileRocket, name: 'FileRocket', timestamp: Date.now() },
    ]);
  }, { fileRocket, libraryKit });
  await page.reload();
  await page.getByTestId('project-rail-add').click();
  await page.locator('.project-rail-context-menu-item-recent').filter({ hasText: 'LibraryKit' }).click();
  await expect(page.getByRole('button', { name: 'Switch to project LibraryKit', exact: true })).toHaveAttribute('aria-current', 'true');
});

test.afterAll(async () => {
  await app?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('Back and Forward preserve the edited project and saving leaves the active project unchanged', async () => {
  await customize('FileRocket');
  await page.getByTestId('settings-route-project-agent-permissions').click();
  await expect(page.getByTestId('project-appearance-panel')).toHaveCount(0);
  await history(3);
  await expect(page.getByTestId('project-appearance-panel')).toHaveAttribute('data-project-path', fileRocket);
  await history(4);
  await expect(page.getByTestId('project-appearance-panel')).toHaveCount(0);
  await history(3);
  await expect(page.getByTestId('project-appearance-panel')).toHaveAttribute('data-project-path', fileRocket);
  await customize('LibraryKit');
  await history(3);
  await expect(page.getByTestId('project-appearance-panel')).toHaveAttribute('data-project-path', fileRocket);
  await page.getByLabel('Initials', { exact: true }).fill('FR');
  await page.getByLabel('Color', { exact: true }).fill('#ffdd00');
  await save();
  await expect(page.getByRole('button', { name: 'Switch to project LibraryKit', exact: true })).toHaveAttribute('aria-current', 'true');
  const appearances = await page.evaluate(async ({ fileRocket, libraryKit }) => ({
    edited: await window.electronAPI.invoke('project-appearance:get', fileRocket),
    active: await window.electronAPI.invoke('project-appearance:get', libraryKit),
  }), { fileRocket, libraryKit });
  expect(appearances.edited.appearance).toMatchObject({ initials: 'FR', color: '#ffdd00' });
  expect(appearances.active.appearance).toEqual({});
});

test('custom colors keep the rail selection and hover treatment in light and dark themes', async () => {
  test.setTimeout(60_000);
  const edited = page.getByRole('button', { name: 'Switch to project FileRocket', exact: true });
  const other = page.getByRole('button', { name: 'Switch to project LibraryKit', exact: true });
  const colors = () => edited.evaluate(button => {
    const style = getComputedStyle(button);
    const neutral = document.createElement('span');
    neutral.style.backgroundColor = 'var(--nim-bg-tertiary)';
    button.appendChild(neutral);
    const background = getComputedStyle(neutral).backgroundColor;
    neutral.remove();
    return { background: style.backgroundColor, foreground: style.color, neutral: background };
  });
  for (const theme of ['Dark', 'Light']) {
    await page.getByRole('button', { name: 'Change theme', exact: true }).click();
    await page.getByRole('menuitem', { name: new RegExp(`^(dark_mode|light_mode) ${theme}( check)?$`) }).click();
    for (const choice of [
      { hex: '#204c85', rgb: 'rgb(32, 76, 133)', foreground: 'rgb(255, 255, 255)' },
      { hex: '#ffdd00', rgb: 'rgb(255, 221, 0)', foreground: 'rgb(0, 0, 0)' },
    ]) {
      await customize('FileRocket');
      await page.getByLabel('Color', { exact: true }).fill(choice.hex);
      await save();
      await page.mouse.move(1000, 50);
      await expect.poll(async () => {
        const c = await colors();
        return c.background === c.neutral && c.foreground === choice.rgb;
      }).toBe(true);
      await edited.hover();
      await expect.poll(async () => {
        const c = await colors();
        return [c.background, c.foreground];
      }).toEqual([choice.rgb, choice.foreground]);
      await edited.click();
      await page.mouse.move(1000, 50);
      await expect(edited).toHaveAttribute('aria-current', 'true');
      await expect.poll(async () => {
        const c = await colors();
        return [c.background, c.foreground];
      }).toEqual([choice.rgb, choice.foreground]);
      await other.click();
      await page.mouse.move(1000, 50);
      await expect.poll(async () => {
        const c = await colors();
        return c.background === c.neutral && c.foreground === choice.rgb;
      }).toBe(true);
    }
  }
  await customize('FileRocket');
});

test('permissions and marketplace entry points clear a previous appearance destination', async () => {
  await page.getByTestId('files-mode-button').click();
  await page.getByTestId('gutter-permissions-button').click();
  await page.getByRole('menuitem', { name: 'swap_horiz Change permission mode', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agent Permissions', exact: true })).toBeVisible();
  await expect(page.getByText('Settings for LibraryKit', { exact: true })).toBeVisible();
  await expect(page.getByTestId('project-appearance-panel')).toHaveCount(0);

  await customize('FileRocket');
  await page.getByTestId('files-mode-button').click();
  // Exercise the same main-to-renderer notification as an extension install link.
  // A nonexistent ID opens the marketplace without installing an extension.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('extension-marketplace:install-request', {
      extensionId: 'com.example.appearance-navigation-test',
    });
  });
  await expect(page.getByTestId('project-appearance-panel')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Extension Marketplace', exact: true })).toBeVisible();
  await customize('FileRocket');
});

test('the image button opens a file chooser and imports a bounded thumbnail', async () => {
  imagePath = path.join(root, 'logo.png');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 256;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#204c85'; context.fillRect(0, 0, 512, 256);
    context.fillStyle = '#ffffff'; context.fillRect(64, 64, 384, 128);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await fs.writeFile(imagePath, Buffer.from(png, 'base64'));
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose image…', exact: true }).click();
  await (await chooserPromise).setFiles(imagePath);
  await expect(page.getByTestId('project-appearance-preview').locator('img')).toBeVisible();
  await save();
  savedImageUrl = await page.getByTestId('project-appearance-preview').locator('img').getAttribute('src') ?? '';
  expect(savedImageUrl).toMatch(/^nim-asset:/);
  await expect.poll(() => page.getByTestId('project-appearance-preview').locator('img').evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([128, 64]);
  // The copy in app storage must survive removal of the original file.
  await fs.rename(imagePath, path.join(root, 'moved-logo.png'));
});

test('images retain their colors and show a separate selection ring in every theme', async () => {
  test.setTimeout(90_000);
  const edited = page.getByRole('button', { name: 'Switch to project FileRocket', exact: true });
  const other = page.getByRole('button', { name: 'Switch to project LibraryKit', exact: true });
  // Preserve the app-owned thumbnail without exporting a cross-origin canvas.
  const imageDirectory = path.join(root, 'profile', 'project-icons');
  const [imageFile] = await fs.readdir(imageDirectory);
  const original = `data:image/png;base64,${(await fs.readFile(path.join(imageDirectory, imageFile))).toString('base64')}`;
  for (const theme of ['Dark', 'Crystal Dark', 'Light']) {
    await page.getByRole('button', { name: 'Change theme', exact: true }).click();
    await page.getByRole('menuitem', { name: new RegExp(`^(bedtime|dark_mode|light_mode) ${theme}( check)?$`) }).click();
    for (const background of ['#ffffff', '#111827', 'transparent']) {
      await page.evaluate(async ({ workspacePath, background }) => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
        const context = canvas.getContext('2d')!;
        if (background !== 'transparent') { context.fillStyle = background; context.fillRect(0, 0, 128, 128); }
        context.fillStyle = '#f59e0b'; context.fillRect(40, 40, 48, 48);
        await window.electronAPI.invoke('project-appearance:update', workspacePath, {
          image: canvas.toDataURL('image/png'), color: '#ffffff',
        });
      }, { workspacePath: fileRocket, background });
      await expect.poll(() => edited.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(128);
      await page.mouse.move(1000, 50);
      await expect.poll(() => edited.evaluate(el => getComputedStyle(el).boxShadow)).toBe('none');
      await expect(edited.locator('img')).toHaveCSS('opacity', '1');
      await edited.hover();
      await expect.poll(() => edited.evaluate(el => getComputedStyle(el).boxShadow)).toBe('none');
      await edited.click();
      await page.mouse.move(1000, 50);
      await expect(edited).toHaveAttribute('aria-current', 'true');
      await expect.poll(() => edited.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none');
      await expect(edited.locator('img')).toHaveCSS('opacity', '1');
      await other.click();
      await page.mouse.move(1000, 50);
      await expect.poll(() => edited.evaluate(el => getComputedStyle(el).boxShadow)).toBe('none');
    }
  }
  const restored = await page.evaluate(({ workspacePath, image }) => window.electronAPI.invoke('project-appearance:update', workspacePath, {
    image, color: '#ffdd00',
  }), { workspacePath: fileRocket, image: original });
  savedImageUrl = restored.appearance.imageUrl;
  await customize('FileRocket');
});

test('a full restart preserves the icon and reset updates another window', async () => {
  test.setTimeout(120_000);
  await app.close();
  await launch(true);
  await customize('FileRocket');
  const image = page.getByTestId('project-appearance-preview').locator('img');
  await expect(image).toHaveAttribute('src', savedImageUrl);
  await expect.poll(() => image.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(128);
  await expect(page.getByLabel('Initials', { exact: true })).toHaveValue('FR');
  await expect(page.getByLabel('Color', { exact: true })).toHaveValue('#ffdd00');

  const secondWindow = app.waitForEvent('window');
  // Opening an already-open project focuses its existing window. Open a new
  // workspace; project restoration brings FileRocket into this window's rail.
  await page.evaluate(workspace => window.electronAPI.invoke('workspace-manager:open-workspace', workspace), path.join(root, 'SecondWindow'));
  const other = await secondWindow;
  await other.getByTestId('project-rail').waitFor({ timeout: 60_000 });
  await customize('FileRocket', other);
  await expect(other.getByTestId('project-appearance-preview').locator('img')).toHaveAttribute('src', savedImageUrl);
  await page.getByRole('button', { name: 'Reset to default', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await expect(other.getByTestId('project-appearance-preview').locator('img')).toHaveCount(0);
  await expect(other.getByTestId('project-appearance-preview')).toHaveText('FI');
  const colors = await other.evaluate(() => {
    const hex = (document.querySelector('#project-color') as HTMLInputElement).value;
    return {
      input: `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ')})`,
      preview: getComputedStyle(document.querySelector('.project-appearance-preview')!).backgroundColor,
    };
  });
  expect(colors.input).toBe(colors.preview);
});
