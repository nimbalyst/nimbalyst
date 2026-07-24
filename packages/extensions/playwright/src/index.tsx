import { TestExplorerPanel } from './components/TestExplorerPanel';
import { aiTools as playwrightAITools } from './aiTools';
import './styles.css';

export async function activate() {
  // console.log('[Playwright] Extension activated');
}

export async function deactivate() {
  // console.log('[Playwright] Extension deactivated');
}

export const panels = {
  'test-explorer': {
    component: TestExplorerPanel,
  },
};

export const aiTools = playwrightAITools;
