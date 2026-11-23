/**
 * OutputWriter - Handles writing automation results to files.
 *
 * Supports three modes:
 * - new-file: Creates a new file for each run using a name template
 * - append: Appends to a single output file with date headers
 * - replace: Overwrites a single output file each run
 */

import { inProject } from '../paths';
import type { AutomationStatus } from '../frontmatter/types';

interface ExtensionFileSystem {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  fileExists: (path: string) => Promise<boolean>;
}

/**
 * The output file as it stood before the agent ran, captured by `reserve()`.
 * Comparing against this is how `write()` tells "the agent produced this file"
 * from "this is last run's output, safe to replace".
 */
export interface OutputTarget {
  /**
   * Resolved once at run start. A run takes minutes, so resolving `{{date}}` /
   * `{{time}}` again at write time can land on a different file than the one
   * that was reserved (and than the one the prompt told the agent about).
   */
  path: string;
  /** Content before the run; null if the file did not exist. */
  contentBefore: string | null;
}

export interface OutputWriteResult {
  path: string;
  /**
   * True when the agent itself wrote the output file during this run, so the
   * automation left that content alone instead of overwriting it.
   */
  writtenByAgent: boolean;
}

export class OutputWriter {
  private fs: ExtensionFileSystem;

  constructor(fs: ExtensionFileSystem) {
    this.fs = fs;
  }

  /**
   * Capture the output path and its current content before the agent runs.
   * Pass the result to `write()` so it can refuse to clobber a report the agent
   * wrote itself.
   */
  async reserve(status: AutomationStatus, projectRoot?: string): Promise<OutputTarget> {
    const path = this.resolveFilePath(status, projectRoot);
    let contentBefore: string | null = null;
    try {
      if (await this.fs.fileExists(path)) {
        contentBefore = await this.fs.readFile(path);
      }
    } catch {
      // Unreadable is treated as absent; the guard below then only fires if the
      // file becomes readable during the run, which means something wrote it.
    }
    return { path, contentBefore };
  }

  /**
   * Write automation output according to the configured mode.
   * Returns the path of the file that was written.
   */
  async write(
    status: AutomationStatus,
    content: string,
    target?: OutputTarget,
  ): Promise<OutputWriteResult> {
    const filePath = target?.path ?? this.resolveFilePath(status);

    // Automation prompts routinely tell the agent to Write its report
    // into the automation's own output directory, using the same file name
    // template. The agent does that correctly, and then this writer overwrote
    // the finished report with the agent's final chat message — months of
    // reports became session narration ("Report written to <this path>").
    // The agent's file is the report; the final message is not worth destroying
    // it for. Only reachable when the caller reserved the target up front.
    if (target && (await this.agentWroteTarget(target))) {
      return { path: filePath, writtenByAgent: true };
    }

    switch (status.output.mode) {
      case 'new-file':
        await this.writeNewFile(filePath, content, status.title);
        break;
      case 'append':
        await this.writeAppend(filePath, content, status.title);
        break;
      case 'replace':
        await this.writeReplace(filePath, content, status.title);
        break;
      default:
        throw new Error(`Unknown output mode: ${status.output.mode}`);
    }
    return { path: filePath, writtenByAgent: false };
  }

  /**
   * Did the output file change while the agent was running? Nothing else writes
   * there mid-run, so a file that appeared, or whose content moved off the
   * reserved snapshot, came from the agent.
   */
  private async agentWroteTarget(target: OutputTarget): Promise<boolean> {
    let contentNow: string | null = null;
    try {
      if (await this.fs.fileExists(target.path)) {
        contentNow = await this.fs.readFile(target.path);
      }
    } catch {
      // Can't read it, so can't claim the agent wrote it. Fall through to the
      // normal write rather than skipping output on an unreadable file.
      return false;
    }
    if (contentNow === null) return false;
    return contentNow !== target.contentBefore;
  }

  /**
   * Resolve the file this run writes to. `fileNameTemplate` names the output
   * file in every mode — new-file leans on the placeholders to make each run
   * unique, while append/replace normally use a static name. It used to be read
   * only in new-file mode, so an append/replace automation silently wrote to
   * `output.md` no matter what its frontmatter asked for (#1351).
   */
  private resolveFilePath(status: AutomationStatus, projectRoot?: string): string {
    const { output } = status;
    const template =
      output.fileNameTemplate ?? (output.mode === 'new-file' ? '{{date}}-output.md' : 'output.md');
    const location = output.location.endsWith('/') ? output.location : output.location + '/';
    // A relative location belongs to the automation's own project (#1299).
    return inProject(projectRoot, location + this.expandTemplate(template, status.id));
  }

  private async writeNewFile(
    filePath: string,
    content: string,
    automationTitle: string,
  ): Promise<void> {
    const fileContent = `# ${automationTitle} - ${new Date().toLocaleDateString()}\n\n${content}\n`;
    await this.fs.writeFile(filePath, fileContent);
  }

  private async writeAppend(
    filePath: string,
    content: string,
    automationTitle: string,
  ): Promise<void> {
    const dateHeader = `\n---\n\n## ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}\n\n`;

    let existing = '';
    try {
      if (await this.fs.fileExists(filePath)) {
        existing = await this.fs.readFile(filePath);
      }
    } catch {
      // File doesn't exist yet
    }

    if (!existing) {
      existing = `# ${automationTitle} - Output Log\n`;
    }

    await this.fs.writeFile(filePath, existing + dateHeader + content + '\n');
  }

  private async writeReplace(
    filePath: string,
    content: string,
    automationTitle: string,
  ): Promise<void> {
    const fileContent = `# ${automationTitle}\n\n*Last updated: ${new Date().toLocaleString()}*\n\n${content}\n`;
    await this.fs.writeFile(filePath, fileContent);
  }

  private expandTemplate(template: string, automationId: string): string {
    const now = new Date();
    const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const time = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS

    return template
      .replace(/\{\{date\}\}/g, date)
      .replace(/\{\{time\}\}/g, time)
      .replace(/\{\{id\}\}/g, automationId);
  }
}
