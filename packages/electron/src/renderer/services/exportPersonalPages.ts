/**
 * The Local section's Export action: copies the database Personal pages into
 * the wiki folder as files. Main does the copy, reads every page back and
 * leaves the database rows in place; this only asks and reports.
 */
import { requestConfirmation } from '../dialogs/requestConfirmation';
import { errorNotificationService } from './ErrorNotificationService';

interface ExportReport {
  ok: boolean;
  root: string;
  exported: string[];
  alreadyInWiki: string[];
  skipped: Array<{ id: string; title: string; reason: string }>;
  reparentedToRoot: string[];
  itemPlacementsKept: string[];
  error?: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export async function exportPersonalPagesToFiles(workspacePath: string, pageCount: number): Promise<void> {
  const confirmed = await requestConfirmation({
    title: 'Export pages to files',
    message: `Copy ${plural(pageCount, 'page')} from the app database into this project's wiki folder as markdown files. `
      + 'The database copy is kept, and nothing is overwritten.',
    confirmLabel: 'Export',
  });
  if (!confirmed) return;
  let report: ExportReport;
  try {
    report = await window.electronAPI.invoke('local-wiki:export-personal-pages', workspacePath) as ExportReport;
  } catch (error) {
    errorNotificationService.showError('Export failed', error instanceof Error ? error.message : String(error));
    return;
  }
  if (!report.ok) {
    errorNotificationService.showError(
      'Export stopped',
      `${report.error ?? 'Unknown error'}. ${plural(report.exported.length, 'page')} were copied before it stopped; the database pages are unchanged, and running Export again continues from here.`,
    );
    return;
  }
  const notes = [
    report.skipped.length > 0 ? `${plural(report.skipped.length, 'page')} that are not markdown stayed in the database.` : '',
    report.reparentedToRoot.length > 0 ? `${plural(report.reparentedToRoot.length, 'page')} under a typed page went to the top of the wiki.` : '',
    report.itemPlacementsKept.length > 0 ? `${plural(report.itemPlacementsKept.length, 'typed page')}: not exported (still in the database).` : '',
  ].filter(Boolean).join(' ');
  errorNotificationService.showInfo(
    'Pages exported',
    `${plural(report.exported.length, 'page')} copied to ${report.root}.${notes ? ` ${notes}` : ''}`,
  );
}
