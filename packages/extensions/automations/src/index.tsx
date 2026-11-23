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

const AUTOMATIONS_DIR = /[\\/]nimbalyst-local[\\/]automations[\\/]/g;

/**
 * The project root an absolute automation file path lives under, or undefined
 * for a relative path (main then uses the window's active project).
 */
export function owningWorkspacePath(filePath: string): string | undefined {
  let lastIndex = -1;
  for (const match of filePath.matchAll(AUTOMATIONS_DIR)) lastIndex = match.index ?? -1;
  if (lastIndex <= 0) return undefined;
  if (!filePath.startsWith('/') && !/^[a-zA-Z]:/.test(filePath)) return undefined;
  return filePath.slice(0, lastIndex);
}

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
        workspacePath?: string;
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
    filePath: string,
    status: AutomationStatus,
    prompt: string,
  ) => {
    let response: string;
    let sessionId: string | undefined;

    // Snapshot the output file before the agent runs, so the write below can
    // tell "the agent wrote its report here" from "this is last run's output"
    // and never overwrite the former.
    const target = await outputWriter.reserve(status);

    if (ai?.sendPrompt) {
      try {
        const result = await ai.sendPrompt({
          prompt,
          sessionName: `Automation: ${status.title}`,
          provider: status.provider || 'claude-code',
          model: status.model,
          // Run in the project that owns this file. Without it main picks the
          // window's active rail project, which a timer has no reason to use (#1299).
          workspacePath: owningWorkspacePath(filePath),
        });
        response = result.response;
        sessionId = result.sessionId;
      } catch (err) {
        response = `*Automation "${status.title}" failed at ${new Date().toLocaleString()}.*\n\nError: ${err}`;
        const written = await outputWriter.write(status, response, target);
        return {
          success: false,
          response,
          error: err instanceof Error ? err.message : String(err),
          outputFile: written.path,
        };
      }
    } else {
      response = `*Automation "${status.title}" fired at ${new Date().toLocaleString()}.*\n\nThe AI service is not available. Check that the extension has AI permissions enabled.`;
      const written = await outputWriter.write(status, response, target);
      return {
        success: false,
        response,
        error: 'The AI service is not available. Check that the extension has AI permissions enabled.',
        outputFile: written.path,
      };
    }

    const written = await outputWriter.write(status, response, target);
    if (written.writtenByAgent) {
      // Say it out loud. The old behaviour was silent, which is why this ran
      // for months with every run still reporting success.
      ui.showWarning(
        `Automation "${status.title}" wrote ${written.path} itself, so its final message was not saved over it. Drop the "write a file" instruction from the prompt to silence this.`,
      );
    }
    return {
      success: true,
      response,
      sessionId,
      outputFile: written.path,
      outputWrittenByAgent: written.writtenByAgent,
    };
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

  // Poll for file changes every 30 seconds. Nothing awaits the rescan, so its
  // rejection would surface as an app-level unhandled-rejection toast (#1374).
  const pollInterval = setInterval(() => {
    scheduler?.rescan().catch((err) => {
      console.error('[Automations] Scheduled rescan failed:', err);
    });
  }, 30_000);

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
      output_location: { type: 'string', description: 'Directory for output files, relative to the workspace root (default: "nimbalyst-local/automations/<id>/")' },
      output_file_name: { type: 'string', description: 'Name of the output file. Supports {{date}}, {{time}}, and {{id}}. Defaults to "{{date}}-output.md" for new-file mode and "output.md" for append/replace.' },
      enabled: { type: 'boolean', description: 'Start the automation enabled and running on its schedule (default: false)' },
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
    const enabled = args.enabled === true;

    const rawLocation = (args.output_location as string) ?? `nimbalyst-local/automations/${id}/`;
    const location = rawLocation.endsWith('/') ? rawLocation : rawLocation + '/';
    const fileName = args.output_file_name as string | undefined;
    // Only write a template the caller actually asked for — emitting the
    // new-file default into an append/replace automation would name its log
    // after the date and split it per run.
    const fileNameLine = fileName ? `\n    fileNameTemplate: ${JSON.stringify(fileName)}` : '';

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

    // `title` is free prose — a colon or quote in it would otherwise produce
    // YAML the parser rejects, leaving a file that reports as created but never
    // loads as an automation.
    const content = `---
automationStatus:
  id: ${id}
  title: ${JSON.stringify(title)}
  enabled: ${enabled}
  schedule:
${scheduleYaml}
  output:
    mode: ${outputMode}
    location: ${location}${fileNameLine}
  runCount: 0
---

# ${title}

${prompt}
`;

    const filePath = `nimbalyst-local/automations/${id}.md`;

    try {
      const fs = context.extensionContext.services.filesystem;
      await fs.writeFile(filePath, content);
      // Await the rescan so an enabled automation is actually scheduled by the
      // time this reports success.
      await scheduler?.rescan();
      return {
        success: true,
        message: enabled
          ? `Created automation "${title}" at ${filePath}, enabled and scheduled. It will run on its schedule until you disable it.`
          : `Created automation "${title}" at ${filePath}. It is DISABLED and will not run — enable it from the document header, or pass enabled: true when creating it.`,
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
