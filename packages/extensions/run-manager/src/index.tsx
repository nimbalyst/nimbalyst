/**
 * Run Manager extension: panel bundle.
 *
 * The panel is the whole UI. Processes, config and status live in the backend
 * module (dist/backend.js), reached through `host.callBackendTool`.
 */
import './styles.css';
import { RunsPanel } from './components/RunsPanel';

export { RunsPanel };

export const panels = {
  runs: { component: RunsPanel },
};

export async function activate(): Promise<void> {}

export async function deactivate(): Promise<void> {}
