import { BrowserEditor } from './components/BrowserEditor';
import { BrowserSessionEditor } from './components/BrowserSessionEditor';
import { aiTools } from './aiTools';
import './styles.css';

export const components = {
  BrowserEditor,
  BrowserSessionEditor,
};

export { aiTools };

export async function activate(): Promise<void> {
  // No-op: the extension is purely a custom-editor contribution; all state
  // lives in the main-process BrowserSessionService.
}

export async function deactivate(): Promise<void> {
  // No-op.
}
