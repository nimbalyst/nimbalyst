import { expect, test, type Page } from '@playwright/test';
import * as Y from 'yjs';
import { openFileFromTree } from '../utils/testHelpers';
import {
  TwoClientCollabHarness,
  type TwoClientCollabClient,
} from '../utils/twoClientCollab';

test.skip(
  () => !process.env.RUN_COLLAB_TESTS,
  'Requires RUN_COLLAB_TESTS=1 and local wrangler support',
);
test.describe.configure({ mode: 'serial' });

interface CollaborativeTypeDescriptor {
  documentType: string;
  displayName: string;
  suffix: string;
  icon: string;
  editorSelector: string;
  extensionFixture?: { id: string; path: string };
  seedContent: string;
  seedMarkers: string[];
  /**
   * Set when the type is deliberately not shareable. The row stays in the
   * table as the record of what is blocked and why -- deleting it would lose
   * the only place that says so -- but the matrix cannot run against a type the
   * catalog refuses to share.
   */
  blockedReason?: string;
  makeEdit(page: Page, parentText: string, marker: string): Promise<void>;
  readConvergedContent(page: Page): Promise<string[]>;
  readPersistedContent(yDoc: Y.Doc): string[];
  assertExportRoundTrip(exported: string, seeded: string): void;
}

const MINDMAP_EXTENSION_PATH = '/Users/ghinkle/sources/nimbalyst-mindmap';
const SLIDES_EXTENSION_PATH = '/Users/ghinkle/sources/nimbalyst-slides';
const JUPYTER_EXTENSION_PATH = '/Users/ghinkle/sources/nimbalyst-jupyter';

// Jupyter's Y layout, mirrored from the extension's own codec. Duplicated
// rather than imported because the extension is a separate repo and this spec
// asserts the on-the-wire shape a teammate actually receives -- if the codec
// renames a key, this row should fail rather than silently follow it.
const Y_NOTEBOOK_CELLS = 'notebook-cells';
const Y_NOTEBOOK_ORDER = 'notebook-cell-order';

async function appendSlide(
  page: Page,
  _parentText: string,
  marker: string,
): Promise<void> {
  const filePath = await activeEditorFilePath(page);
  await page.evaluate(
    ({ filePath, marker }) => {
      const api = (window as any).__testHelpers?.getExtensionEditorAPI?.(
        filePath,
      );
      if (!api) throw new Error(`No slides editor API registered for ${filePath}`);
      // Append rather than replace: both clients read-modify-write the whole
      // deck, and the binding diffs that into Y.Text. A minimal trailing diff
      // is what makes two concurrent appends merge instead of clobbering.
      api.setContent(`${api.getContent().trimEnd()}\n\n---\n\n# ${marker}\n`);
    },
    { filePath, marker },
  );
  await expect(
    page.locator('.slides-slide-title').filter({ hasText: marker }),
  ).toBeVisible({ timeout: 10_000 });
}

function slideTitles(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.match(/^#\s+(.+)$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .sort();
}

async function readSlideTitles(page: Page): Promise<string[]> {
  return page
    .locator('.slides-slide-title')
    .allTextContents()
    .then((values) =>
      values
        .map((value) => value.trim())
        .filter((value) => value && value !== '(untitled)')
        .sort(),
    );
}

async function addNotebookCell(
  page: Page,
  _parentText: string,
  marker: string,
): Promise<void> {
  const filePath = await activeEditorFilePath(page);
  await page.evaluate(
    ({ filePath, marker }) => {
      const api = (window as any).__testHelpers?.getExtensionEditorAPI?.(
        filePath,
      );
      if (!api) throw new Error(`No notebook editor API registered for ${filePath}`);
      api.insertCell({
        cellType: 'markdown',
        source: `# ${marker}`,
        index: api.listCells().length,
      });
    },
    { filePath, marker },
  );
  await expect(
    page.locator('.jupyter-notebook-editor-mount').getByText(marker),
  ).toBeVisible({ timeout: 10_000 });
}

function notebookHeadings(content: string): string[] {
  const parsed = JSON.parse(content) as {
    cells?: { source?: string | string[] }[];
  };
  return (parsed.cells ?? [])
    .map((cell) =>
      (Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? ''))
        .match(/^#\s+(.+)$/m)?.[1]
        ?.trim(),
    )
    .filter((value): value is string => Boolean(value))
    .sort();
}

async function readNotebookHeadings(page: Page): Promise<string[]> {
  const filePath = await activeEditorFilePath(page);
  return page.evaluate((filePath) => {
    const api = (window as any).__testHelpers?.getExtensionEditorAPI?.(filePath);
    if (!api) return [];
    return api
      .listCells()
      .map((cell: any) => String(cell.source ?? '').match(/^#\s+(.+)$/m)?.[1]?.trim())
      .filter(Boolean)
      .sort();
  }, filePath);
}

async function editCsvCell(
  page: Page,
  _parentText: string,
  marker: string,
): Promise<void> {
  const cellIndex = marker.startsWith('Alpha')
    ? 6
    : marker.startsWith('Bravo')
    ? 7
    : 8;
  const cell = page.locator('revogr-data [role="gridcell"]').nth(cellIndex);
  await cell.dblclick();
  const input = page.locator('revo-grid textarea').filter({ visible: true });
  await expect(input).toBeVisible({ timeout: 2_000 });
  await input.fill(marker);
  await input.press('Enter');
  await expect(
    page.locator('revogr-data [role="gridcell"]').filter({ hasText: marker }),
  ).toBeVisible({ timeout: 10_000 });
}

async function readCsvCells(page: Page): Promise<string[]> {
  return page
    .locator('revogr-data [role="gridcell"]')
    .allTextContents()
    .then((values) =>
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .sort(),
    );
}

function csvCells(content: string): string[] {
  return content
    .split(/[,\n\r]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}

async function appendCalcSheetMarker(
  page: Page,
  _parentText: string,
  marker: string,
): Promise<void> {
  // Focus Monaco's hidden input directly. Clicking the editor box lands on
  // whatever is at its centre -- for calc sheets that can be the results column
  // overlay rather than the text area, which silently swallows the keystrokes.
  // Monaco 0.55 renders its input as a contenteditable `.native-edit-context`
  // div when the EditContext API is available, and falls back to
  // `textarea.inputarea` otherwise. Accept either.
  const input = page
    .locator('.calc-sheets__editor .monaco-editor')
    .locator('textarea.inputarea, .native-edit-context')
    .first();
  await input.waitFor({ state: 'attached', timeout: 10_000 });
  await input.focus();
  // Both clients append at the end of the document. Do NOT send the cursor to
  // the top: in collab mode the model holds the whole file and lines 1..n are
  // the YAML frontmatter, hidden via setHiddenAreas. Inserting there corrupts
  // the frontmatter ("Unrecognized line. Source: ---") and leaves the tab dirty.
  // Two clients appending at the same position is also the stronger convergence
  // case. Monaco binds cursorBottom to Cmd+Down on macOS; Meta+End is unbound
  // there, which is why the cursor previously never moved at all.
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  );
  await page.keyboard.insertText(`\n# ${marker}`);
}

function calcSheetLines(content: string): string[] {
  return content
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^#\s*/, ''))
    .filter(Boolean)
    .sort();
}

async function readCalcSheetLines(page: Page): Promise<string[]> {
  const lines = await page
    .locator('.calc-sheets__editor .view-line')
    .allTextContents();
  return calcSheetLines(lines.join('\n'));
}

async function activeEditorFilePath(page: Page): Promise<string> {
  const filePath = await page.locator('.tab.active').getAttribute('title');
  if (!filePath) throw new Error('Active editor tab has no file path');
  return filePath;
}

async function addDataModelEntity(
  page: Page,
  _parentText: string,
  marker: string,
): Promise<void> {
  const filePath = await activeEditorFilePath(page);
  await page.evaluate(
    ({ filePath, marker }) => {
      const store = (window as any).__testHelpers?.getExtensionEditorAPI?.(
        filePath,
      );
      if (!store)
        throw new Error(`No data-model editor API registered for ${filePath}`);
      const index = store.getState().entities.length;
      store.getState().addEntity({
        id: `cert-${marker.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name: `CertificationEntity${index + 1}`,
        description: marker,
        fields: [
          {
            id: `field-${index}`,
            name: 'id',
            dataType: 'Int',
            isPrimaryKey: true,
          },
        ],
        position: { x: 100 + index * 300, y: 100 },
      });
    },
    { filePath, marker },
  );
}

async function readDataModelDescriptions(page: Page): Promise<string[]> {
  const filePath = await activeEditorFilePath(page);
  return page.evaluate((filePath) => {
    const store = (window as any).__testHelpers?.getExtensionEditorAPI?.(
      filePath,
    );
    if (!store) return [];
    return store
      .getState()
      .entities.map((entity: any) => String(entity.description ?? '').trim())
      .filter(Boolean)
      .sort();
  }, filePath);
}

function prismaDescriptions(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*\/\/\/\s+(.+)$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .sort();
}

function visibleEditor(
  page: Page,
  type: Pick<CollaborativeTypeDescriptor, 'editorSelector'>,
) {
  return page.locator(type.editorSelector).filter({ visible: true });
}

/**
 * Error toasts render at `top-10 right-5` with `pointer-events-auto` over the
 * tab bar, so a lingering one silently blocks tab clicks several steps later.
 * Returns the titles it dismissed so callers can assert on them rather than
 * letting a real error pass unnoticed.
 */
/**
 * Clear every toast on screen; report only the ones that are actually errors.
 *
 * Two jobs, deliberately separate. *Everything* is dismissed because a toast
 * parked over the tab bar turns a later click into an unexplained timeout. Only
 * `error-toast--error` is returned, because `ErrorToastContainer` renders every
 * severity with the same `.error-toast` class -- so a successful Share to Team,
 * which raises `showInfo(..., { duration: 4000 })`, was being reported as an
 * outstanding error. Its auto-dismiss timer pauses while the pointer rests on
 * it, so it can outlive its 4s and reach the next document type's check. A
 * certification matrix that fails on "the previous step succeeded" is reporting
 * on Playwright's mouse position rather than on the product.
 */
async function dismissErrorToasts(page: Page): Promise<string[]> {
  const toasts = page.locator('.error-toast');
  const errors: string[] = [];
  for (let remaining = await toasts.count(); remaining > 0; remaining--) {
    const toast = toasts.first();
    const severityClass = (await toast.getAttribute('class')) ?? '';
    if (severityClass.includes('error-toast--error')) {
      const title = await toast.locator('.error-toast-title').textContent();
      const message = await toast.locator('.error-toast-message').textContent();
      errors.push(`${title?.trim() ?? ''}: ${message?.trim() ?? ''}`);
    }
    const close = toast.locator('.error-toast-close');
    if (await close.count() > 0) await close.click();
    // Count, not `toBeHidden` on `first()`: once this toast leaves the DOM,
    // `first()` resolves to the next one, which is still visible.
    await expect(toasts).toHaveCount(remaining - 1, { timeout: 10_000 });
  }
  return errors;
}

async function addMindmapChild(
  page: Page,
  parentText: string,
  marker: string,
): Promise<void> {
  const editor = page.locator('.mindmap-editor').filter({ visible: true });
  const parent = editor
    .locator('.mindmap-node-text')
    .filter({ hasText: parentText })
    .first();
  await expect(parent).toBeVisible({ timeout: 10_000 });
  await parent.click();
  await editor.focus();
  await page.keyboard.press('Tab');
  const overlay = editor.locator('.edit-overlay');
  await expect(overlay).toBeVisible({ timeout: 5_000 });
  await overlay.fill(marker);
  await editor.locator('.mindmap-toolbar-title').click();
  await expect(
    editor.locator('.mindmap-node-text').filter({ hasText: marker }),
  ).toBeVisible({
    timeout: 10_000,
  });
}

async function readMindmapNodes(page: Page): Promise<string[]> {
  return page
    .locator('.mindmap-editor')
    .filter({ visible: true })
    .locator('.mindmap-node-text')
    .allTextContents()
    .then((values) =>
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .sort(),
    );
}

function mindmapHeadings(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .sort();
}

function mockupComments(html: string): string[] {
  return [...html.matchAll(/<!--\s*([\s\S]*?)\s*-->/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .sort();
}

/**
 * Append a marker comment through the mockup's source pane. A mockup has no
 * other content-editing control -- the rendered preview is a sandboxed iframe
 * -- so this is the only user-visible way to change a shared mockup, and the
 * row exists to keep that affordance from disappearing again.
 */
async function appendMockupSourceComment(
  page: Page,
  _parentText: string,
  marker: string,
): Promise<void> {
  const editor = page.locator('.mockup-editor').filter({ visible: true });
  const textarea = editor.locator('.mockup-source-editor');
  if ((await textarea.count()) === 0) {
    await editor.locator('.mockup-view-source-button').click();
  }
  await expect(textarea).toBeVisible({ timeout: 10_000 });
  await textarea.focus();
  // End of document, not the top: both clients appending at the same offset is
  // the stronger convergence case, and the seeded head/style block above is not
  // something a stray keystroke should land in.
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  );
  await page.keyboard.insertText(`\n<!-- ${marker} -->`);
}

async function readMockupComments(page: Page): Promise<string[]> {
  const filePath = await activeEditorFilePath(page);
  const html = await page.evaluate((filePath) => {
    const api = (window as any).__testHelpers?.getExtensionEditorAPI?.(filePath);
    return String(api?.getCurrentHtml?.() ?? '');
  }, filePath);
  return mockupComments(html);
}

async function addMockupProjectScreen(
  page: Page,
  _parentText: string,
  marker: string,
): Promise<void> {
  const editor = page.locator('.mockup-project-editor').filter({ visible: true });
  await editor.getByRole('button', { name: '+ Add Screen' }).first().click();
  const input = editor.locator('input[placeholder="Screen name..."]');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(marker);
  await input.press('Enter');
  // `commitAddScreen` is async, so pressing Enter is not the mutation. Without
  // this wait the offline step polls the sync dot before the store has changed
  // and reads a still-`synced` provider.
  await expect(
    editor.locator('.mockup-node-label').filter({ hasText: marker }),
  ).toBeVisible({ timeout: 15_000 });
}

async function readMockupProjectLabels(page: Page): Promise<string[]> {
  return page
    .locator('.mockup-project-editor')
    .filter({ visible: true })
    .locator('.mockup-node-label')
    .allTextContents()
    .then((values) =>
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .sort(),
    );
}

function mockupProjectLabels(content: string): string[] {
  const parsed = JSON.parse(content) as {
    mockups?: { label?: string }[];
  };
  return (parsed.mockups ?? [])
    .map((mockup) => String(mockup.label ?? '').trim())
    .filter(Boolean)
    .sort();
}

const collaborativeTypes: CollaborativeTypeDescriptor[] = [
  {
    documentType: 'mindmap',
    displayName: 'Mindmap',
    suffix: '.mindmap',
    icon: 'account_tree',
    editorSelector: '.mindmap-editor',
    extensionFixture: {
      id: 'com.nimbalyst.mindmap',
      path: MINDMAP_EXTENSION_PATH,
    },
    seedContent: [
      '---',
      'title: Promoted certification map',
      '---',
      '',
      '# Promoted root',
      '## Seeded alpha branch',
      '## Seeded bravo branch',
      '',
    ].join('\n'),
    seedMarkers: [
      'Promoted root',
      'Seeded alpha branch',
      'Seeded bravo branch',
    ],
    makeEdit: addMindmapChild,
    readConvergedContent: readMindmapNodes,
    readPersistedContent(yDoc) {
      return [...yDoc.getMap<Y.Map<unknown>>('nodes').values()]
        .map((node) => String(node.get('text') ?? '').trim())
        .filter(Boolean)
        .sort();
    },
    assertExportRoundTrip(exported, seeded) {
      expect(mindmapHeadings(exported)).toEqual(mindmapHeadings(seeded));
      expect(exported).toContain('title: Promoted certification map');
    },
  },
  {
    documentType: 'csv',
    displayName: 'CSV Spreadsheet',
    suffix: '.csv',
    icon: 'table',
    editorSelector: 'revo-grid',
    seedContent: 'Name,Value\nSeeded alpha row,100\nSeeded bravo row,200\n',
    seedMarkers: ['Seeded alpha row', 'Seeded bravo row'],
    makeEdit: editCsvCell,
    readConvergedContent: readCsvCells,
    readPersistedContent(yDoc) {
      return csvCells(yDoc.getText('csv').toString());
    },
    assertExportRoundTrip(exported, seeded) {
      expect(csvCells(exported)).toEqual(csvCells(seeded));
    },
  },
  {
    documentType: 'calc.md',
    displayName: 'Calc Sheet',
    suffix: '.calc.md',
    icon: 'calculate',
    editorSelector: '.calc-sheets__editor .monaco-editor',
    seedContent: [
      '---',
      'title: Promoted certification sheet',
      'baseCurrency: USD',
      '---',
      '',
      '# Seeded alpha calculation',
      'alpha = 100 USD',
      '# Seeded bravo calculation',
      'bravo = alpha * 2',
      '',
    ].join('\n'),
    seedMarkers: ['Seeded alpha calculation', 'Seeded bravo calculation'],
    makeEdit: appendCalcSheetMarker,
    readConvergedContent: readCalcSheetLines,
    readPersistedContent(yDoc) {
      return calcSheetLines(yDoc.getText('content').toString());
    },
    assertExportRoundTrip(exported, seeded) {
      expect(exported.trim()).toBe(seeded.trim());
    },
  },
  (() => {
    // Until the first two-client convergence completes, intersect the live
    // canvas labels with a fresh headless export from the real document room.
    // This distinguishes server persistence from an editor that merely paints
    // its own local state. Once proven, later offline reads stay local because
    // the server is intentionally stopped during that matrix row.
    let serverRoomProvenPopulated = false;
    let serverReadInFlight: Promise<string[]> | null = null;
    const seededLabels = ['Seeded alpha diagram', 'Seeded bravo diagram'];
    const seedElements = seededLabels.map((text, index) => ({
      id: 'cert-seed-' + index,
      type: 'text',
      x: 100,
      y: 100 + index * 80,
      width: 260,
      height: 25,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1000 + index,
      version: 1,
      versionNonce: 2000 + index,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      text,
      fontSize: 20,
      fontFamily: 1,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      originalText: text,
      autoResize: true,
      lineHeight: 1.25,
    }));

    return {
      documentType: 'excalidraw',
      displayName: 'Excalidraw',
      suffix: '.excalidraw',
      icon: 'draw',
      editorSelector: '.excalidraw-editor',
      seedContent: JSON.stringify(
        {
          type: 'excalidraw',
          version: 2,
          source: 'https://excalidraw.com',
          elements: seedElements,
          appState: { viewBackgroundColor: '#ffffff' },
          files: {},
        },
        null,
        2,
      ),
      seedMarkers: seededLabels,
      async makeEdit(page: Page, _parentText: string, marker: string) {
        // Excalidraw's imperative API is available before its async Y.Doc
        // binding necessarily is. Real pointer edits are gated by
        // viewModeEnabled during that interval; this adapter must honor the
        // same product-ready boundary instead of writing behind the gate.
        await expect(
          page.locator('.excalidraw-editor:visible'),
        ).toHaveAttribute('data-collab-binding-ready', 'true');
        const filePath = await activeEditorFilePath(page);
        await page.evaluate(
          ({ filePath, marker }) => {
            const api = (window as any).__testHelpers?.getExtensionEditorAPI?.(
              filePath,
            );
            if (!api) {
              throw new Error(
                'No Excalidraw editor API registered for ' + filePath,
              );
            }
            const alpha = marker.startsWith('Alpha');
            const suffix = marker.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            api.updateScene({
              // This imperative call stands in for a completed user gesture.
              // Excalidraw's default EVENTUALLY mode can defer/coalesce it
              // with an unrelated remote repaint, which is not how a committed
              // pointer edit enters the Store.
              captureUpdate: 'IMMEDIATELY',
              elements: [
                ...api.getSceneElements(),
                {
                  id: 'cert-' + suffix,
                  type: 'text',
                  x: alpha ? 100 : 420,
                  y: 160,
                  width: 280,
                  height: 25,
                  angle: 0,
                  strokeColor: '#1e1e1e',
                  backgroundColor: 'transparent',
                  fillStyle: 'solid',
                  strokeWidth: 1,
                  strokeStyle: 'solid',
                  roughness: 1,
                  opacity: 100,
                  groupIds: [],
                  frameId: null,
                  roundness: null,
                  seed: alpha ? 3001 : 3002,
                  version: 1,
                  versionNonce: alpha ? 4001 : 4002,
                  isDeleted: false,
                  boundElements: null,
                  updated: Date.now(),
                  link: null,
                  locked: false,
                  text: marker,
                  fontSize: 20,
                  fontFamily: 1,
                  textAlign: 'left',
                  verticalAlign: 'top',
                  containerId: null,
                  originalText: marker,
                  autoResize: true,
                  lineHeight: 1.25,
                },
              ],
            });
          },
          { filePath, marker },
        );
      },
      async readConvergedContent(page: Page) {
        const result = await page.evaluate(() => {
          const filePath = document
            .querySelector('.tab.active')
            ?.getAttribute('title');
          const api = filePath
            ? (window as any).__testHelpers?.getExtensionEditorAPI?.(filePath)
            : null;
          if (!api) return { canvas: [], documentId: undefined };
          const canvas = api
            .getSceneElements()
            .filter((element: any) => element.type === 'text')
            .map((element: any) => String(element.text ?? '').trim())
            .filter(Boolean)
            .sort();
          const documentId = filePath?.match(/:doc:(.+)$/)?.[1];
          return { canvas, documentId };
        });
        if (
          !serverRoomProvenPopulated &&
          result.canvas.length >= 2 &&
          result.documentId
        ) {
          // Both page polls run concurrently. Share one headless room export
          // rather than creating competing sync clients on every poll tick.
          serverReadInFlight ??= page
            .evaluate(async (documentId) => {
              const exported = await (window as any).__exportCollabDocTest({
                documentId,
                documentType: 'excalidraw',
              });
              if (!exported?.ok || typeof exported.content !== 'string') {
                return [];
              }
              return JSON.parse(exported.content)
                .elements.filter((element: any) => element.type === 'text')
                .map((element: any) => String(element.text ?? '').trim())
                .filter(Boolean)
                .sort();
            }, result.documentId)
            .finally(() => {
              serverReadInFlight = null;
            });
          const serverLabels = new Set(await serverReadInFlight);
          if (result.canvas.every((label: string) => serverLabels.has(label))) {
            serverRoomProvenPopulated = true;
          } else {
            return result.canvas.filter((label: string) =>
              serverLabels.has(label),
            );
          }
        }
        return result.canvas;
      },
      readPersistedContent(yDoc: Y.Doc) {
        return yDoc
          .getArray<Y.Map<unknown>>('elements')
          .toArray()
          .map((entry) => entry.get('el') as { type?: string; text?: string })
          .filter((element) => element.type === 'text')
          .map((element) => String(element.text ?? '').trim())
          .filter(Boolean)
          .sort();
      },
      assertExportRoundTrip(exported: string, seeded: string) {
        const labels = (content: string) =>
          JSON.parse(content)
            .elements.filter((element: any) => element.type === 'text')
            .map((element: any) => String(element.text ?? '').trim())
            .filter(Boolean)
            .sort();
        expect(labels(exported)).toEqual(labels(seeded));
      },
    } satisfies CollaborativeTypeDescriptor;
  })(),
  {
    documentType: 'datamodel',
    displayName: 'Data Model',
    suffix: '.prisma',
    icon: 'database',
    editorSelector: '.datamodel-editor .datamodel-canvas',
    seedContent: [
      '// @nimbalyst {"viewport":{"x":0,"y":0,"zoom":1},"positions":{},"entityViewMode":"standard"}',
      '',
      'datasource db {',
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL")',
      '}',
      '',
      '/// Seeded alpha model',
      'model SeedAlpha {',
      '  id Int @id',
      '}',
      '',
      '/// Seeded bravo model',
      'model SeedBravo {',
      '  id Int @id',
      '}',
      '',
    ].join('\n'),
    seedMarkers: ['Seeded alpha model', 'Seeded bravo model'],
    makeEdit: addDataModelEntity,
    readConvergedContent: readDataModelDescriptions,
    readPersistedContent(yDoc) {
      return [...yDoc.getMap<Y.Map<unknown>>('entities').values()]
        .map((entity) => String(entity.get('description') ?? '').trim())
        .filter(Boolean)
        .sort();
    },
    assertExportRoundTrip(exported, seeded) {
      expect(prismaDescriptions(exported)).toEqual(prismaDescriptions(seeded));
    },
  },
  {
    documentType: 'mockup.html',
    displayName: 'Mockup',
    suffix: '.mockup.html',
    icon: 'palette',
    editorSelector: '.mockup-editor',
    seedContent: [
      '<!DOCTYPE html>',
      '<html>',
      '<head><style>body { font-family: Inter, sans-serif; }</style></head>',
      '<body>',
      '  <!-- Seeded alpha panel -->',
      '  <h1>Promoted certification mockup</h1>',
      '  <!-- Seeded bravo panel -->',
      '  <p>Seeded body copy.</p>',
      '</body>',
      '</html>',
      '',
    ].join('\n'),
    seedMarkers: ['Seeded alpha panel', 'Seeded bravo panel'],
    makeEdit: appendMockupSourceComment,
    readConvergedContent: readMockupComments,
    readPersistedContent(yDoc) {
      return mockupComments(yDoc.getText('html').toString());
    },
    assertExportRoundTrip(exported, seeded) {
      expect(mockupComments(exported)).toEqual(mockupComments(seeded));
      expect(exported).toContain('Promoted certification mockup');
    },
  },
  {
    documentType: 'slides.md',
    displayName: 'Slides',
    suffix: '.slides.md',
    icon: 'slideshow',
    editorSelector: '.slides-presentation-editor',
    extensionFixture: { id: 'com.nimbalyst.slides', path: SLIDES_EXTENSION_PATH },
    seedContent: [
      '---',
      'theme: black',
      'transition: slide',
      '---',
      '',
      '# Seeded alpha slide',
      '',
      'Alpha body copy.',
      '',
      '---',
      '',
      '# Seeded bravo slide',
      '',
      'Bravo body copy.',
      '',
    ].join('\n'),
    seedMarkers: ['Seeded alpha slide', 'Seeded bravo slide'],
    makeEdit: appendSlide,
    readConvergedContent: readSlideTitles,
    readPersistedContent(yDoc) {
      return slideTitles(yDoc.getText('content').toString());
    },
    assertExportRoundTrip(exported, seeded) {
      expect(slideTitles(exported)).toEqual(slideTitles(seeded));
      expect(exported).toContain('theme: black');
    },
  },
  {
    documentType: 'ipynb',
    displayName: 'Notebook',
    suffix: '.ipynb',
    icon: 'code_blocks',
    editorSelector: '.jupyter-notebook-editor-root',
    extensionFixture: { id: 'com.nimbalyst.jupyter', path: JUPYTER_EXTENSION_PATH },
    seedContent: JSON.stringify(
      {
        cells: [
          {
            cell_type: 'markdown',
            id: 'cert-seed-alpha',
            metadata: {},
            source: ['# Seeded alpha cell'],
          },
          {
            cell_type: 'markdown',
            id: 'cert-seed-bravo',
            metadata: {},
            source: ['# Seeded bravo cell'],
          },
        ],
        metadata: {
          kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
          language_info: { name: 'python' },
        },
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      1,
    ),
    seedMarkers: ['Seeded alpha cell', 'Seeded bravo cell'],
    makeEdit: addNotebookCell,
    readConvergedContent: readNotebookHeadings,
    readPersistedContent(yDoc) {
      // Read through the order array, not the map, so a cell that lost its
      // ordering entry reads as missing rather than silently passing.
      const cells = yDoc.getMap<Y.Map<unknown>>(Y_NOTEBOOK_CELLS);
      return yDoc
        .getArray<string>(Y_NOTEBOOK_ORDER)
        .toArray()
        .map((id) => cells.get(id)?.get('source'))
        .map((source) => String(source ?? '').match(/^#\s+(.+)$/m)?.[1]?.trim())
        .filter((value): value is string => Boolean(value))
        .sort();
    },
    assertExportRoundTrip(exported, seeded) {
      expect(notebookHeadings(exported)).toEqual(notebookHeadings(seeded));
      // nbformat metadata must survive the Y.Doc round trip or the notebook
      // opens without a kernel on the receiving side.
      expect(JSON.parse(exported).nbformat).toBe(4);
    },
  },
  // Covers the project document itself -- screens, labels, layout, meta. It
  // deliberately does NOT cover a screen's HTML, which is still resolved
  // through the workspace filesystem: `commitAddScreen` derives the child path
  // from `host.filePath`, so in a shared project it writes a real file under a
  // directory literally named `collab:` in the author's own workspace and no
  // teammate can ever read it. Certifying that needs a way for an extension to
  // create and read a child SHARED document, which does not exist; a green run
  // here is not a certified type. See the plan's certification log.
  {
    documentType: 'mockupproject',
    displayName: 'Mockup Project',
    suffix: '.mockupproject',
    icon: 'dashboard',
    editorSelector: '.mockup-project-editor',
    blockedReason:
      'Sharing is disabled in the manifest: a screen\'s HTML is still resolved through the author\'s workspace filesystem, so teammates see empty screens. Re-enable `collaboration.supported` for ".mockupproject" once screens are shared documents, and this row runs again.',
    seedContent: JSON.stringify(
      {
        version: 1,
        name: 'Promoted certification project',
        mockups: [
          {
            id: 'cert-seed-alpha',
            path: 'promoted-certification-alpha.mockup.html',
            label: 'Seeded alpha screen',
            position: { x: 100, y: 100 },
            size: { width: 400, height: 300 },
          },
          {
            id: 'cert-seed-bravo',
            path: 'promoted-certification-bravo.mockup.html',
            label: 'Seeded bravo screen',
            position: { x: 600, y: 100 },
            size: { width: 400, height: 300 },
          },
        ],
        connections: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      null,
      2,
    ),
    seedMarkers: ['Seeded alpha screen', 'Seeded bravo screen'],
    makeEdit: addMockupProjectScreen,
    readConvergedContent: readMockupProjectLabels,
    readPersistedContent(yDoc) {
      return [...yDoc.getMap<Y.Map<unknown>>('mockups').values()]
        .map((mockup) => String(mockup.get('label') ?? '').trim())
        .filter(Boolean)
        .sort();
    },
    assertExportRoundTrip(exported, seeded) {
      expect(mockupProjectLabels(exported)).toEqual(mockupProjectLabels(seeded));
    },
  },
].filter(
  (type) =>
    !process.env.COLLAB_DOCUMENT_TYPE ||
    type.documentType === process.env.COLLAB_DOCUMENT_TYPE,
);

const runnableTypes = collaborativeTypes.filter((type) => !type.blockedReason);
const promotionFiles = runnableTypes.map((type) => ({
  relativePath: `promoted-certification${type.suffix}`,
  content: type.seedContent,
  client: 'A' as const,
}));
const extensionFixtures = runnableTypes.flatMap((type) =>
  type.extensionFixture ? [type.extensionFixture] : [],
);

let harness: TwoClientCollabHarness;

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(180_000);
  harness = new TwoClientCollabHarness({
    extensions: extensionFixtures,
    files: promotionFiles,
  });
  await harness.start();
});

test.afterAll(async () => {
  await harness?.stop();
});

function sharedDocumentRow(page: Page, name: string) {
  return page
    .getByTestId('collab-sidebar')
    .locator('.file-tree-file')
    .filter({ hasText: name });
}

async function assertSharedPresentation(
  page: Page,
  type: CollaborativeTypeDescriptor,
  name: string,
  expectedPath = name,
): Promise<void> {
  const row = sharedDocumentRow(page, name);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.locator('.file-tree-name')).toHaveText(name);
  await expect(row).toHaveAttribute('title', expectedPath);
  await expect(
    row.locator('.file-tree-icon .material-symbols-outlined'),
  ).toHaveText(type.icon);
}

async function openSharedDocument(
  client: TwoClientCollabClient,
  type: CollaborativeTypeDescriptor,
  name: string,
): Promise<void> {
  await sharedDocumentRow(client.page, name).click();
  await visibleEditor(client.page, type).waitFor({
    state: 'visible',
    timeout: 20_000,
  });
  await client.page
    .locator('.collab-hydration-overlay')
    .waitFor({ state: 'hidden', timeout: 20_000 });
}

async function activeDocumentId(page: Page): Promise<string> {
  const uri = await page
    .locator('.collab-mode .tab.active')
    .getAttribute('title');
  const documentId = uri?.match(/:doc:(.+)$/)?.[1];
  if (!documentId)
    throw new Error(
      `Active shared tab did not expose a collab URI: ${uri ?? '<none>'}`,
    );
  return documentId;
}

async function waitForMarkers(
  type: CollaborativeTypeDescriptor,
  page: Page,
  markers: string[],
  timeout = 30_000,
): Promise<string[]> {
  await expect
    .poll(async () => type.readConvergedContent(page), {
      timeout,
      message: `waiting for ${markers.join(', ')} in ${type.displayName}`,
    })
    .toEqual(expect.arrayContaining(markers));
  return type.readConvergedContent(page);
}

async function waitForPersistedMarkers(
  type: CollaborativeTypeDescriptor,
  label: 'A' | 'B',
  documentId: string,
  markers: string[],
): Promise<void> {
  await expect
    .poll(
      async () => {
        const yDoc = await harness.loadDurableReplicaDocument(
          label,
          documentId,
        );
        try {
          return type.readPersistedContent(yDoc);
        } finally {
          yDoc.destroy();
        }
      },
      {
        timeout: 15_000,
        message: `waiting for ${markers.join(', ')} in the durable ${
          type.displayName
        } replica`,
      },
    )
    .toEqual(expect.arrayContaining(markers));
}

async function createSharedDocument(
  type: CollaborativeTypeDescriptor,
  baseName: string,
): Promise<string> {
  const page = await harness.openSharedMode('A');
  await page.getByTitle('New document').click();
  const menuItem = page
    .getByRole('menuitem')
    .filter({ hasText: type.displayName })
    .filter({ hasText: type.suffix });
  await expect(menuItem).toContainText(type.suffix);
  await menuItem.click();
  const dialog = page.getByTestId('collab-create-dialog');
  await dialog.getByTestId('collab-create-location-option-root').click();
  await dialog.getByTestId('collab-create-name-input').fill(baseName);
  await dialog.locator('.collab-create-confirm').click();
  const name = `${baseName}${type.suffix}`;
  await assertSharedPresentation(page, type, name);
  return name;
}

async function renameAndMoveSharedDocument(
  type: CollaborativeTypeDescriptor,
  currentName: string,
): Promise<string> {
  const page = harness.clientA.page;
  const folderName = `Certified ${type.documentType.replaceAll(
    '.',
    '-',
  )} folder`;
  await sharedDocumentRow(page, currentName).click({ button: 'right' });
  await page
    .getByRole('menu')
    .getByRole('button', { name: /Rename$/ })
    .click();
  const renameModal = page
    .locator('.input-modal')
    .filter({ hasText: 'Rename Shared Document' });
  await renameModal.locator('input').fill('Renamed certification map');
  await renameModal
    .getByRole('button', { name: 'Rename', exact: true })
    .click();
  const renamed = `Renamed certification map${type.suffix}`;
  await assertSharedPresentation(page, type, renamed);

  await page.getByTestId('collab-sidebar').getByTitle('New folder').click();
  const folderDialog = page.getByTestId('collab-create-dialog');
  await folderDialog.getByTestId('collab-create-name-input').fill(folderName);
  await folderDialog.getByRole('button', { name: 'Create Folder' }).click();
  const folder = page
    .getByTestId('collab-sidebar')
    .locator('.file-tree-directory')
    .filter({
      hasText: folderName,
    });
  await expect(folder).toBeVisible({ timeout: 10_000 });
  await sharedDocumentRow(page, renamed).dragTo(folder);
  await assertSharedPresentation(
    page,
    type,
    renamed,
    `${folderName}/${renamed}`,
  );
  await sharedDocumentRow(page, renamed).click();
  await expect(visibleEditor(page, type)).toBeVisible({ timeout: 10_000 });
  return renamed;
}

async function promoteLocalFileAndAssertRoundTrip(
  type: CollaborativeTypeDescriptor,
): Promise<void> {
  const sourceName = `promoted-certification${type.suffix}`;
  const pageA = harness.clientA.page;
  await pageA.getByTestId('files-mode-button').click();
  await openFileFromTree(pageA, sourceName);
  await expect(visibleEditor(pageA, type)).toBeVisible({ timeout: 10_000 });
  await pageA
    .locator('.file-tree-name', { hasText: sourceName })
    .click({ button: 'right' });
  await pageA.getByText('Copy to Wiki...', { exact: true }).last().click();
  const shareDialog = pageA.getByRole('dialog', { name: 'Copy to Wiki' });
  await expect(shareDialog).toBeVisible({ timeout: 10_000 });
  await shareDialog.getByRole('button', { name: /Copy to Team$/ }).click();
  await expect(shareDialog).toBeHidden({ timeout: 20_000 });

  const pageB = await harness.openSharedMode('B');
  await assertSharedPresentation(pageB, type, sourceName);
  await openSharedDocument(harness.clientB, type, sourceName);
  await waitForMarkers(type, pageB, type.seedMarkers);
  const documentId = await activeDocumentId(pageB);
  const exported = await harness.exportDocument('B', {
    documentId,
    title: sourceName,
    documentType: type.documentType,
  });
  type.assertExportRoundTrip(exported, type.seedContent);
}

test('collaborative document types pass the two-client certification matrix', async () => {
  test.setTimeout(240_000 * collaborativeTypes.length);
  const runSuffix = harness.runId.slice(-8);

  for (const type of collaborativeTypes) {
    if (type.blockedReason) {
      // Logged, not silently dropped: a blocked type that vanishes from the
      // output reads exactly like a type that passed.
      console.log(`[certification] Skipping ${type.displayName}: ${type.blockedReason}`);
      continue;
    }
    await test.step(type.displayName, async () => {
      const directName = await createSharedDocument(
        type,
        `Certified map ${runSuffix}`,
      );

      const pageA = harness.clientA.page;
      const pageB = await harness.openSharedMode('B');
      await assertSharedPresentation(pageB, type, directName);
      await openSharedDocument(harness.clientA, type, directName);
      await openSharedDocument(harness.clientB, type, directName);
      expect(await activeDocumentId(pageB)).toBe(await activeDocumentId(pageA));

      const markerA = `Alpha branch ${runSuffix}`;
      const markerB = `Bravo branch ${runSuffix}`;
      await Promise.all([
        type.makeEdit(pageA, 'Central idea', markerA),
        type.makeEdit(pageB, 'Central idea', markerB),
      ]);
      // Each edit must be visible on the client that made it before we wait for
      // convergence. Without this, a keystroke that never reached the editor is
      // indistinguishable from a document that failed to sync.
      // Full budget, not a tighter one: grid-style editors (revo-grid) commit a
      // cell asynchronously, so a short timeout here fails on commit latency
      // rather than on the thing this check exists to catch.
      await Promise.all([
        waitForMarkers(type, pageA, [markerA]),
        waitForMarkers(type, pageB, [markerB]),
      ]);
      const [contentA, contentB] = await Promise.all([
        waitForMarkers(type, pageA, [markerA, markerB]),
        waitForMarkers(type, pageB, [markerA, markerB]),
      ]);
      expect(contentA).toEqual(contentB);

      const documentId = await activeDocumentId(pageA);
      await waitForPersistedMarkers(type, 'A', documentId, [markerA, markerB]);
      await harness.waitForDurableOutbox('A', documentId, false);

      // Server-backed close/reopen coverage. This subsumes the former
      // csv-collab-reopen.spec.ts without introducing a CSV-only branch.
      // No error toast should be outstanding at this point. Failing here names
      // the real error instead of letting it surface as an unrelated click
      // timeout when the toast overlays the tab bar.
      expect(await dismissErrorToasts(pageB)).toEqual([]);
      expect(await dismissErrorToasts(pageA)).toEqual([]);

      // Target the tab by name rather than `.tab.active`, and hover first so the
      // close affordance is actually interactable. A forced click on the active
      // tab's close button was landing on the tab instead of the button, which
      // just re-activated it and left the editor mounted.
      const tabB = pageB
        .locator('.collab-mode .tab')
        .filter({ hasText: directName });
      await tabB.hover();
      await tabB.locator('.tab-close-button').click();
      await expect(visibleEditor(pageB, type)).toHaveCount(0);
      await openSharedDocument(harness.clientB, type, directName);
      await waitForMarkers(type, pageB, [markerA, markerB]);

      const offlineMarker = `Offline branch ${runSuffix}`;
      await harness.stopServer();
      await type.makeEdit(pageA, 'Central idea', offlineMarker);
      await expect
        .poll(
          () =>
            pageA
              .getByTestId('collab-sync-dot')
              .first()
              .getAttribute('data-status-kind'),
          { timeout: 10_000 },
        )
        .toMatch(/^(offline-safe|replaying)$/);
      await harness.waitForDurableOutbox('A', documentId, true);
      await waitForPersistedMarkers(type, 'A', documentId, [offlineMarker]);
      await harness.restartClient('A');
      await harness.waitForDocumentReady('A', type.editorSelector);
      expect(await activeDocumentId(harness.clientA.page)).toBe(documentId);
      await waitForMarkers(type, harness.clientA.page, [offlineMarker]);
      await harness.startServer();
      await waitForMarkers(type, harness.clientB.page, [offlineMarker], 40_000);
      await harness.openSharedMode('A');
      await harness.openSharedMode('B');

      const renamed = await renameAndMoveSharedDocument(type, directName);
      await assertSharedPresentation(
        harness.clientB.page,
        type,
        renamed,
        `Certified ${type.documentType.replaceAll('.', '-')} folder/${renamed}`,
      );

      await promoteLocalFileAndAssertRoundTrip(type);
    });
  }
});
