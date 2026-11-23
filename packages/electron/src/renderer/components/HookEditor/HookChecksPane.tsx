/**
 * Runs main's checks on the text the blocks write, a short time after the
 * last edit. A refused save can pass its own results in `forced`.
 */

import { useEffect, useState } from 'react';

import type { SettingsSource } from '../../../main/services/hookEditor/hookFiles';
import type { CheckResult } from '../../../shared/hookEditor/hookChecks';

const CHECK_NAMES: Readonly<Record<CheckResult['check'], string>> = {
  json: 'The file is valid JSON',
  schema: 'The hooks match the Claude Code format',
  scripts: 'Every script file exists',
};

const WAIT_MS = 400;

interface HookChecksPaneProps {
  workspacePath: string;
  source: SettingsSource;
  text: string | null;
  forced: CheckResult[] | null;
}

export function HookChecksPane({ workspacePath, source, text, forced }: HookChecksPaneProps) {
  const [results, setResults] = useState<CheckResult[]>([]);
  // True from a new text until main answers for it.
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    // No text to check: drop the old results so they never show beside a file they do not describe.
    if (text === null) {
      setResults([]);
      setWaiting(false);
      return;
    }
    setWaiting(true);
    let current = true;
    const timer = setTimeout(() => {
      window.electronAPI
        .invoke('hook-editor:check', workspacePath, source, text)
        .then((found: CheckResult[]) => {
          if (!current) return;
          setResults(found);
          setWaiting(false);
        })
        .catch(() => {
          if (!current) return;
          setResults([]);
          setWaiting(false);
        });
    }, WAIT_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [workspacePath, source, text]);

  return (
    <ul className="hook-checks-pane flex flex-col gap-2 p-3 text-sm">
      {forced === null && waiting && <li className="text-[var(--nim-text-muted)]">Checking...</li>}
      {(forced ?? results).map((result) => (
        <li key={result.check}>
          <span
            className={
              result.status === 'passed'
                ? 'text-[var(--nim-success)]'
                : result.status === 'failed'
                  ? 'text-[var(--nim-error)]'
                  : 'text-[var(--nim-text-faint)]'
            }
          >
            {CHECK_NAMES[result.check]}: {result.status}
          </span>
          {result.problems.map((problem) => (
            <p key={problem} className="select-text pl-4 text-[var(--nim-text-muted)]">
              {problem}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}
