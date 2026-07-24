/**
 * Prompt sent to an agent session to (re)generate the voice-mode project summary.
 *
 * The agent uses its own tools to read whatever files it thinks are relevant
 * and writes the result to nimbalyst-local/voice-project-summary.md. Voice mode
 * loads that file at session start (see VoiceModeService.ts loadSessionContext).
 */
export const VOICE_PROJECT_SUMMARY_PATH = 'nimbalyst-local/voice-project-summary.md';

export function buildVoiceProjectSummaryPrompt(): string {
  return [
    "Generate a voice-friendly project summary for Nimbalyst's voice mode and write it to",
    `\`${VOICE_PROJECT_SUMMARY_PATH}\` using your Write tool.`,
    '',
    'The voice assistant reads this summary aloud as context during conversations, so the writing',
    'has to work as spoken English: complete natural sentences, no bullets, no symbols, no code',
    'blocks, no headings, no markdown formatting at all. Plain paragraphs only.',
    '',
    'To gather context, read whichever project files seem most useful. Good starting points are',
    '`CLAUDE.md`, `README.md`, and `package.json` at the workspace root. If those reveal a monorepo',
    'or a non-obvious structure, read enough additional files to understand it. Stop reading once',
    'you have a clear picture; do not exhaustively explore the codebase.',
    '',
    'The summary should be 400 to 600 words and cover, in this order:',
    '1. What the project is and what it does, in one or two sentences.',
    '2. The key technologies, frameworks, and runtimes in use.',
    '3. The main directory or package structure if it is a monorepo or otherwise non-trivial.',
    '4. Important conventions, patterns, or constraints a developer should know about.',
    '5. The current focus areas or notable in-progress work, if discoverable.',
    '',
    `Create the \`nimbalyst-local\` directory if it does not already exist. Overwrite any existing`,
    `\`${VOICE_PROJECT_SUMMARY_PATH}\` rather than appending. Once the file is written, stop. Do not`,
    'continue working on anything else after the summary is saved.',
  ].join('\n');
}
