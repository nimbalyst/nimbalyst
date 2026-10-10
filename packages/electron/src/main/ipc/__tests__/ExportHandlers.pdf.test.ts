// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type PdfRequest = {
  html: string;
  outputPath: string;
  margins?: Electron.PrintToPDFOptions['margins'];
};
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, options: PdfRequest) => Promise<unknown>>(),
  printToPDF: vi.fn<(options: Electron.PrintToPDFOptions) => Promise<Buffer>>(),
  writeFile: vi.fn(),
  loadURL: vi.fn(),
  close: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { printToPDF: mocks.printToPDF };
    loadURL = mocks.loadURL;
    close = mocks.close;
    isDestroyed = () => false;
  },
  dialog: {},
  clipboard: {},
}));
vi.mock('fs/promises', () => ({ writeFile: mocks.writeFile }));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (event: unknown, options: PdfRequest) => Promise<unknown>) => {
    mocks.handlers.set(channel, handler);
  },
}));
vi.mock('../../utils/logger', () => ({ logger: { file: { info: vi.fn(), error: vi.fn() } } }));
vi.mock('../../services/analytics/AnalyticsService', () => ({ AnalyticsService: {} }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: {} }));
vi.mock('../../services/SessionHtmlExporter', () => ({ exportSessionToHtml: vi.fn(), getExportFilename: vi.fn() }));
vi.mock('../../utils/transcriptHelpers', () => ({ loadViewMessages: vi.fn() }));
vi.mock('../../utils/dialogPaths', () => ({ getDialogDefaultPath: vi.fn(), rememberDialogSelection: vi.fn() }));
vi.mock('../../services/AnimationGifRecorder', () => ({ recordAnimationGif: vi.fn() }));
vi.mock('../../services/AnimationVideoRecorder', () => ({ recordAnimationVideo: vi.fn() }));

import { registerExportHandlers } from '../ExportHandlers';

const pdfBuffer = Buffer.from('%PDF-export-regression');
const request = { html: '<p>Export</p>', outputPath: '/unused/pdf-export.pdf' };

async function exportPdf(margins?: Electron.PrintToPDFOptions['margins']) {
  const pending = mocks.handlers.get('export:htmlToPdf')!({}, { ...request, margins });
  await vi.advanceTimersByTimeAsync(500);
  return pending;
}

describe('PDF export margins', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.printToPDF.mockResolvedValue(pdfBuffer);
    mocks.loadURL.mockResolvedValue(undefined);
    registerExportHandlers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    { label: 'Electron defaults when margins are absent', input: undefined, expected: undefined },
    { label: 'existing custom defaults for an empty input', input: {}, expected: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } },
    { label: 'partial inch values including zero', input: { top: 0, left: 0.75 }, expected: { top: 0, bottom: 0.4, left: 0.75, right: 0.4 } },
    { label: 'all custom inch values', input: { top: 0.5, bottom: 1.25, left: 0, right: 2 }, expected: { top: 0.5, bottom: 1.25, left: 0, right: 2 } },
  ])('uses $label without printer-only marginType', async ({ input, expected }) => {
    expect(await exportPdf(input)).toEqual({ success: true });
    expect(mocks.printToPDF).toHaveBeenCalledOnce();
    expect(mocks.printToPDF.mock.calls[0][0].margins).toEqual(expected);
    expect(mocks.writeFile).toHaveBeenCalledWith(request.outputPath, pdfBuffer);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
