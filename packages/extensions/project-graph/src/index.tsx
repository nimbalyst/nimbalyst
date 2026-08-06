import { ProjectGraphPanel } from './components/ProjectGraphPanel';
import './styles.css';

export async function activate() {
  // No-op. State is held in panel storage; the panel itself initializes on
  // first mount.
}

export async function deactivate() {
  // No-op.
}

export const panels = {
  graph: {
    component: ProjectGraphPanel,
  },
};
