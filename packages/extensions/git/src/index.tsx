import { GitLogPanel } from './components/GitLogPanel';
import './styles.css';

export async function activate() {
  // console.log('[Git] Extension activated');
}

export async function deactivate() {
  // console.log('[Git] Extension deactivated');
}

export const panels = {
  'git-log': {
    component: GitLogPanel,
  },
};
