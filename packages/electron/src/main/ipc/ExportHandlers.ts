import { dialog, BrowserWindow, clipboard } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { writeFile } from 'fs/promises';
import { logger } from '../utils/logger';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { AISessionsRepository } from '@nimbalyst/runtime';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import { exportSessionToHtml, getExportFilename } from '../services/SessionHtmlExporter';
import { loadViewMessages } from '../utils/transcriptHelpers';
import { getDialogDefaultPath, rememberDialogSelection } from '../utils/dialogPaths';

/**
 * Registers IPC handlers for export functionality.
 */
export function registerExportHandlers() {
  /**
   * Show save dialog for PDF export and return the selected path.
   */
  safeHandle(
    'export:showSaveDialogPdf',
    async (
      event,
      options: {
        defaultPath?: string;
      }
    ): Promise<string | null> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions: Electron.SaveDialogOptions = {
        title: 'Export to PDF',
        buttonLabel: 'Export',
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
        defaultPath: getDialogDefaultPath({ window, explicitPath: options?.defaultPath }),
      };

      const result = window
        ? await dialog.showSaveDialog(window, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

      if (result.canceled || !result.filePath) {
        return null;
      }

      rememberDialogSelection(result.filePath, 'file');

      return result.filePath;
    }
  );

  /**
   * Export HTML content to PDF using Electron's printToPDF.
   * Creates a hidden window, loads the HTML, and generates a PDF.
   */
  safeHandle(
    'export:htmlToPdf',
    async (
      _event,
      options: {
        html: string;
        outputPath: string;
        pageSize?: 'A4' | 'Letter' | 'Legal';
        landscape?: boolean;
        generateDocumentOutline?: boolean;
        generateTaggedPDF?: boolean;
        margins?: {
          top?: number;
          bottom?: number;
          left?: number;
          right?: number;
        };
      }
    ): Promise<{ success: boolean; error?: string }> => {
      const {
        html,
        outputPath,
        pageSize = 'Letter',
        landscape = false,
        generateDocumentOutline = false,
        generateTaggedPDF = false,
        margins,
      } = options;

      let hiddenWindow: BrowserWindow | null = null;

      try {
        // Create a hidden window for PDF generation
        hiddenWindow = new BrowserWindow({
          show: false,
          width: 800,
          height: 600,
          webPreferences: {
            offscreen: true,
            nodeIntegration: false,
            contextIsolation: true,
          },
        });

        // Load the HTML content
        await hiddenWindow.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
        );

        // Wait for content to be fully rendered
        // Give the page a moment to render any dynamic content
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Generate PDF with options
        const pdfBuffer = await hiddenWindow.webContents.printToPDF({
          printBackground: true,
          pageSize: pageSize,
          landscape: landscape,
          generateDocumentOutline,
          generateTaggedPDF,
          margins: margins
            ? {
                marginType: 'custom',
                top: margins.top ?? 0.4,
                bottom: margins.bottom ?? 0.4,
                left: margins.left ?? 0.4,
                right: margins.right ?? 0.4,
              }
            : {
                marginType: 'default',
              },
        });

        // Write the PDF to file
        await writeFile(outputPath, pdfBuffer);

        logger.file.info(`[ExportHandlers] PDF exported successfully to: ${outputPath}`);

        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.file.error(`[ExportHandlers] PDF export failed: ${errorMessage}`);
        return { success: false, error: errorMessage };
      } finally {
        // Clean up the hidden window
        if (hiddenWindow && !hiddenWindow.isDestroyed()) {
          hiddenWindow.close();
        }
      }
    }
  );

  /**
   * Export an AI session as a self-contained HTML file.
   * Loads the session, renders it to HTML, shows a save dialog, and writes the file.
   */
  safeHandle(
    'export:sessionToHtml',
    async (
      event,
      options: { sessionId: string }
    ): Promise<{ success: boolean; filePath?: string; error?: string }> => {
      const { sessionId } = options;

      if (!sessionId) {
        return { success: false, error: 'sessionId is required' };
      }

      try {
        // Load session and messages directly from repositories
        // (avoids needing a SessionManager instance with workspace state)
        const chatSession = await AISessionsRepository.get(sessionId);
        if (!chatSession) {
          return { success: false, error: `Session not found: ${sessionId}` };
        }

        const msgResult = await loadViewMessages(sessionId, chatSession.provider ?? 'unknown');
        if (!msgResult.success) {
          return { success: false, error: msgResult.error };
        }

        const session: SessionData = {
          id: chatSession.id,
          provider: chatSession.provider as any,
          model: chatSession.model ?? undefined,
          sessionType: chatSession.sessionType,
          mode: chatSession.mode,
          createdAt: new Date(chatSession.createdAt as any).getTime(),
          updatedAt: new Date(chatSession.updatedAt as any).getTime(),
          messages: msgResult.messages,
          workspacePath: (chatSession.metadata as any)?.workspaceId ?? chatSession.workspacePath ?? '',
          title: chatSession.title ?? 'New conversation',
        };

        // Generate HTML (async to avoid blocking main process on large sessions)
        const html = await exportSessionToHtml(session);
        const defaultFilename = getExportFilename(session);

        // Show save dialog
        const window = BrowserWindow.fromWebContents(event.sender);
        const dialogOptions: Electron.SaveDialogOptions = {
          title: 'Export Session as HTML',
          buttonLabel: 'Export',
          filters: [{ name: 'HTML Files', extensions: ['html'] }],
          defaultPath: getDialogDefaultPath({ window, explicitPath: defaultFilename }),
        };

        const result = window
          ? await dialog.showSaveDialog(window, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions);

        if (result.canceled || !result.filePath) {
          return { success: false, error: 'Export cancelled' };
        }

        rememberDialogSelection(result.filePath, 'file');

        // Write the file
        await writeFile(result.filePath, html, 'utf-8');

        logger.file.info(`[ExportHandlers] Session HTML exported: ${result.filePath}`);

        // Track successful session export
        AnalyticsService.getInstance().sendEvent('session_exported', {
          format: 'html',
        });

        return { success: true, filePath: result.filePath };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.file.error(`[ExportHandlers] Session HTML export failed: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }
    }
  );

  /**
   * Copy an AI session transcript as plain text to the clipboard.
   */
  safeHandle(
    'export:sessionToClipboard',
    async (
      _event,
      options: { sessionId: string }
    ): Promise<{ success: boolean; error?: string }> => {
      const { sessionId } = options;

      if (!sessionId) {
        return { success: false, error: 'sessionId is required' };
      }

      try {
        const chatSession = await AISessionsRepository.get(sessionId);
        if (!chatSession) {
          return { success: false, error: `Session not found: ${sessionId}` };
        }

        const msgResult = await loadViewMessages(sessionId, chatSession.provider ?? 'unknown');
        if (!msgResult.success) {
          return { success: false, error: msgResult.error };
        }
        const uiMessages = msgResult.messages;

        const title = chatSession.title ?? 'Untitled Session';
        const provider = chatSession.provider ?? 'unknown';
        const model = chatSession.model ?? '';
        const workspacePath = (chatSession.metadata as any)?.workspaceId ?? chatSession.workspacePath ?? '';
        const stripPaths = (s: string) => {
          if (!workspacePath) return s;
          return s.split(workspacePath + '/').join('').split(workspacePath).join('');
        };

        const lines: string[] = [];
        lines.push(`# ${title}`);
        lines.push(`Provider: ${provider}${model ? ` / ${model}` : ''}`);
        lines.push('');

        for (const msg of uiMessages) {
          if (msg.type === 'tool_call' || msg.type === 'interactive_prompt' || msg.type === 'subagent') continue;
          if (msg.type === 'turn_ended') continue;

          const role = msg.type === 'user_message' ? 'User' : 'Assistant';
          lines.push(`## ${role}`);
          if (msg.text?.trim()) {
            lines.push(stripPaths(msg.text.trim()));
          }
          if (msg.toolCall) {
            const toolName = msg.toolCall.toolName || 'Unknown tool';
            lines.push(`[Tool: ${toolName}]`);
          }
          lines.push('');
        }

        clipboard.writeText(lines.join('\n'));

        // Track successful session export to clipboard
        AnalyticsService.getInstance().sendEvent('session_exported', {
          format: 'clipboard',
        });

        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { success: false, error: errorMessage };
      }
    }
  );
}
