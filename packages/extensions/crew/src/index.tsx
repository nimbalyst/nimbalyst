/**
 * Crew extension: panel bundle.
 *
 * The panel is the whole UI; all state and scheduling live in the backend
 * module (dist/backend.js), reached through `host.callBackendTool`.
 */
import './styles.css';
import { CrewPanel } from './components/CrewPanel';

export { CrewPanel };

export const panels = {
  crew: { component: CrewPanel },
};

export async function activate(): Promise<void> {}

export async function deactivate(): Promise<void> {}
