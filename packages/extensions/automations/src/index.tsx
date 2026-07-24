/**
 * Automations Extension
 *
 * Schedule recurring AI-powered tasks in Nimbalyst.
 * Automations are markdown files with YAML frontmatter that define
 * schedules, output modes, and AI prompts.
 */

import './styles.css';
import { AutomationDocumentHeader, setRunNowCallback, setDefinitionChangedCallback } from './components/AutomationDocumentHeader';
import { AutomationScheduler } from './scheduler/AutomationScheduler';
import { OutputWriter } from './output/OutputWriter';
import type { AutomationStatus } from './frontmatter/types';
import type { ExtensionAITool, AIToolContext, ExtensionToolResult } from '@nimbalyst/extension-sdk';

// Module-level scheduler reference for sharing between activate() and components
let scheduler: AutomationScheduler | null = null;

// Re-export types
export type { AutomationStatus } from './frontmatter/types';

/**
 * Extension activation - sets up the scheduler.
 */
export async function activate(context: {
  services: {
    filesystem: {
      readFile: (path: string) => Promise<string>;
      writeFile: (path: string, content: string) => Promise<void>;
      fileExists: (path: string) => Promise<boolean>;
      findFiles: (pattern: string) => Promise<string[]>;
    };
    ui: {
      showInfo: (message: string) => void;
      showWarning: (message: string) => void;
      showError: (message: string) => void;
    };
    ai?: {
      sendPrompt: (options: {
        prompt: string;
        sessionName?: string;
        provider?: 'claude-code' | 'claude' | 'openai' | 'openai-codex';
        model?: string;
      }) => Promise<{ sessionId: string; response: string }>;
    };
  };
  subscriptions: Array<{ dispose: () => void }>;
}): Promise<void> {
  console.log('[Automations] Extension activated');

  const { filesystem, ui, ai } = context.services;
  const outputWriter = new OutputWriter(filesystem);

  scheduler = new AutomationScheduler(filesystem, ui);

  // Wire up the execution callback
  scheduler.setOnFire(async (
    _filePath: string,
    status: AutomationStatus,
    prompt: string,
  ) => {
    let response: string;
    let sessionId: string | undefined;

    if (ai?.sendPrompt) {
      try {
        const result = await ai.sendPrompt({
          prompt,
          sessionName: `Automation: ${status.title}`,
          provider: status.provider || 'claude-code',
          model: status.model,
        });
        response = result.response;
        sessionId = result.sessionId;
      } catch (err) {
        response = `*Automation "${status.title}" failed at ${new Date().toLocaleString()}.*\n\nError: ${err}`;
        const outputFile = await outputWriter.write(status.output, response, status.title);
        return {
          success: false,
          response,
          error: err instanceof Error ? err.message : String(err),
          outputFile,
        };
      }
    } else {
      response = `*Automation "${status.title}" fired at ${new Date().toLocaleString()}.*\n\nThe AI service is not available. Check that the extension has AI permissions enabled.`;
      const outputFile = await outputWriter.write(status.output, response, status.title);
      return {
        success: false,
        response,
        error: 'The AI service is not available. Check that the extension has AI permissions enabled.',
        outputFile,
      };
    }

    const outputFile = await outputWriter.write(status.output, response, status.title);
    return { success: true, response, sessionId, outputFile };
  });

  // Wire up "Run Now" from the document header
  setRunNowCallback(async (filePath: string) => {
    await scheduler?.runNow(filePath);
  });

  // Re-arm immediately when the header edits a definition (enable toggle,
  // schedule change) so it doesn't wait for the 30s poll.
  setDefinitionChangedCallback((filePath: string, content: string) => {
    scheduler?.applyDefinition(filePath, content);
  });

  // Initialize scheduler (discover and schedule automations)
  await scheduler.initialize();

  // Poll for file changes every 30 seconds
  const pollInterval = setInterval(() => scheduler?.rescan(), 30_000);

  context.subscriptions.push({
    dispose: () => {
      clearInterval(pollInterval);
      scheduler?.dispose();
      scheduler = null;
    },
  });
}

/**
 * Extension deactivation.
 */
export async function deactivate(): Promise<void> {
  console.log('[Automations] Extension deactivated');
  scheduler?.dispose();
  scheduler = null;
}

/**
 * Components exported by this extension.
 * Keys match the `component` values in manifest.json contributions.
 */
export const components = {
  AutomationDocumentHeader,
};

/**
 * AI tools exported by this extension.
 */
const listAutomationsTool: ExtensionAITool = {
  name: 'automations.list',
  description: 'List all automation definitions in the workspace. Shows each automation\'s name, schedule, enabled status, and last run info.',
  scope: 'global',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async (_args: Record<string, unknown>, _context: AIToolContext): Promise<ExtensionToolResult> => {
    if (!scheduler) {
      return { success: false, error: 'Automation scheduler is not initialized' };
    }

    const automations = scheduler.getAutomations();
    if (automations.length === 0) {
      return {
        success: true,
        message: 'No automations found. Create a markdown file in nimbalyst-local/automations/ with automationStatus frontmatter to define an automation.',
      };
    }

    const lines = automations.map((a) => {
      const s = a.status;
      return `- **${s.title}** (${s.id}) - ${s.enabled ? 'Enabled' : 'Disabled'} - ${s.schedule.type} schedule - ${s.runCount} runs - Last: ${s.lastRun ?? 'Never'}`;
    });

    return {
      success: true,
      message: `Found ${automations.length} automation(s):\n${lines.join('\n')}`,
    };
  },
};

const createAutomationTool: ExtensionAITool = {
  name: 'automations.create',
  description: 'Create a new automation file in nimbalyst-local/automations/. The automation will be a markdown file with YAML frontmatter defining the schedule, and the markdown body will be the AI prompt.',
  scope: 'global',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Unique kebab-case identifier (e.g., "standup-summary")' },
      title: { type: 'string', description: 'Human-readable name (e.g., "Daily Standup Summary")' },
      prompt: { type: 'string', description: 'The markdown prompt/instructions for the AI to execute on each run' },
      schedule_type: { type: 'string', description: 'Schedule type: "interval", "daily", or "weekly"', enum: ['interval', 'daily', 'weekly'] },
      time: { type: 'string', description: 'Time in 24h format (HH:MM), required for daily/weekly' },
      days: { type: 'string', description: 'Comma-separated days for weekly schedule (e.g., "mon,tue,wed,thu,fri")' },
      interval_minutes: { type: 'number', description: 'Interval in minutes for interval schedule' },
      output_mode: { type: 'string', description: 'Output mode: "new-file", "append", or "replace"', enum: ['new-file', 'append', 'replace'] },
    },
    required: ['id', 'title', 'prompt'],
  },
  handler: async (args: Record<string, unknown>, context: AIToolContext): Promise<ExtensionToolResult> => {
    const id = args.id as string;
    const title = args.title as string;
    const prompt = args.prompt as string;
    const scheduleType = (args.schedule_type as string) ?? 'daily';
    const time = (args.time as string) ?? '09:00';
    const outputMode = (args.output_mode as string) ?? 'new-file';

    let scheduleYaml: string;
    switch (scheduleType) {
      case 'interval': {
        const mins = (args.interval_minutes as number) ?? 60;
        scheduleYaml = `    type: interval\n    intervalMinutes: ${mins}`;
        break;
      }
      case 'weekly': {
        const days = (args.days as string) ?? 'mon,tue,wed,thu,fri';
        const dayList = days.split(',').map((d: string) => d.trim());
        scheduleYaml = `    type: weekly\n    days: [${dayList.join(', ')}]\n    time: "${time}"`;
        break;
      }
      default:
        scheduleYaml = `    type: daily\n    time: "${time}"`;
    }

    const content = `---
automationStatus:
  id: ${id}
  title: ${title}
  enabled: false
  schedule:
${scheduleYaml}
  output:
    mode: ${outputMode}
    location: nimbalyst-local/automations/${id}/
    fileNameTemplate: "{{date}}-output.md"
  runCount: 0
---

# ${title}

${prompt}
`;

    const filePath = `nimbalyst-local/automations/${id}.md`;

    try {
      const fs = context.extensionContext.services.filesystem;
      await fs.writeFile(filePath, content);
      // Trigger rescan to pick up the new file
      scheduler?.rescan();
      return {
        success: true,
        message: `Created automation "${title}" at ${filePath}. Open the file to configure the schedule using the document header controls, then enable it when ready.`,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to create automation: ${err}`,
      };
    }
  },
};

const runAutomationTool: ExtensionAITool = {
  name: 'automations.run',
  description: 'Manually run an automation immediately, regardless of its schedule. The automation must exist in nimbalyst-local/automations/.',
  scope: 'global',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The automation ID (e.g., "standup-summary") or full file path' },
    },
    required: ['id'],
  },
  handler: async (args: Record<string, unknown>, _context: AIToolContext): Promise<ExtensionToolResult> => {
    if (!scheduler) {
      return { success: false, error: 'Automation scheduler is not initialized' };
    }

    const id = args.id as string;

    // Resolve to file path if only an ID was given
    const filePath = id.endsWith('.md') ? id : `nimbalyst-local/automations/${id}.md`;

    try {
      const result = await scheduler.runNow(filePath);
      if (!result.success) {
        return {
          success: false,
          error: result.error,
        };
      }
      return {
        success: true,
        message: `Automation "${id}" has been triggered. Check the output location for results.`,
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to run automation: ${err}`,
      };
    }
  },
};

const historyAutomationTool: ExtensionAITool = {
  name: 'automations.history',
  description: 'Get the execution history for an automation, showing timestamps, duration, status, and session links for past runs.',
  scope: 'global',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The automation ID (e.g., "standup-summary")' },
      limit: { type: 'number', description: 'Max number of records to return (default: 10)' },
    },
    required: ['id'],
  },
  handler: async (args: Record<string, unknown>, _context: AIToolContext): Promise<ExtensionToolResult> => {
    if (!scheduler) {
      return { success: false, error: 'Automation scheduler is not initialized' };
    }

    const id = args.id as string;
    const limit = (args.limit as number) ?? 10;
    const records = await scheduler.getHistory(id, limit);

    if (records.length === 0) {
      return {
        success: true,
        message: `No execution history found for automation "${id}".`,
      };
    }

    const lines = records.map((r) => {
      const duration = r.durationMs < 1000 ? `${r.durationMs}ms` : `${(r.durationMs / 1000).toFixed(1)}s`;
      const status = r.status === 'success' ? 'OK' : `FAILED: ${r.error ?? 'unknown'}`;
      const session = r.sessionId ? ` (session: ${r.sessionId})` : '';
      const output = r.outputFile ? ` -> ${r.outputFile}` : '';
      return `- ${r.timestamp} [${duration}] ${status}${session}${output}`;
    });

    return {
      success: true,
      message: `Execution history for "${id}" (${records.length} records):\n${lines.join('\n')}`,
    };
  },
};

export const aiTools = [listAutomationsTool, createAutomationTool, runAutomationTool, historyAutomationTool];
