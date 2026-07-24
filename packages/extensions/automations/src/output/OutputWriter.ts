/**
 * OutputWriter - Handles writing automation results to files.
 *
 * Supports three modes:
 * - new-file: Creates a new file for each run using a name template
 * - append: Appends to a single output file with date headers
 * - replace: Overwrites a single output file each run
 */

import type { AutomationOutput } from '../frontmatter/types';

interface ExtensionFileSystem {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  fileExists: (path: string) => Promise<boolean>;
}

export class OutputWriter {
  private fs: ExtensionFileSystem;

  constructor(fs: ExtensionFileSystem) {
    this.fs = fs;
  }

  /**
   * Write automation output according to the configured mode.
   * Returns the path of the file that was written.
   */
  async write(
    output: AutomationOutput,
    content: string,
    automationTitle: string,
  ): Promise<string> {
    switch (output.mode) {
      case 'new-file':
        return this.writeNewFile(output, content, automationTitle);
      case 'append':
        return this.writeAppend(output, content, automationTitle);
      case 'replace':
        return this.writeReplace(output, content, automationTitle);
      default:
        throw new Error(`Unknown output mode: ${output.mode}`);
    }
  }

  private async writeNewFile(
    output: AutomationOutput,
    content: string,
    automationTitle: string,
  ): Promise<string> {
    const template = output.fileNameTemplate ?? '{{date}}-output.md';
    const fileName = this.expandTemplate(template);
    const location = output.location.endsWith('/') ? output.location : output.location + '/';
    const filePath = location + fileName;

    const fileContent = `# ${automationTitle} - ${new Date().toLocaleDateString()}\n\n${content}\n`;
    await this.fs.writeFile(filePath, fileContent);
    return filePath;
  }

  private async writeAppend(
    output: AutomationOutput,
    content: string,
    automationTitle: string,
  ): Promise<string> {
    const location = output.location.endsWith('/') ? output.location : output.location + '/';
    const filePath = location + 'output.md';

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
    return filePath;
  }

  private async writeReplace(
    output: AutomationOutput,
    content: string,
    automationTitle: string,
  ): Promise<string> {
    const location = output.location.endsWith('/') ? output.location : output.location + '/';
    const filePath = location + 'output.md';

    const fileContent = `# ${automationTitle}\n\n*Last updated: ${new Date().toLocaleString()}*\n\n${content}\n`;
    await this.fs.writeFile(filePath, fileContent);
    return filePath;
  }

  private expandTemplate(template: string): string {
    const now = new Date();
    const date = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const time = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS

    return template
      .replace(/\{\{date\}\}/g, date)
      .replace(/\{\{time\}\}/g, time);
  }
}
