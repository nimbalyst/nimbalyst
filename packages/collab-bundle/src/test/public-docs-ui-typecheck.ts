import {
  CollabDocsUIProvider,
  createCollabDocsSession,
  type CollabDocsSession,
} from '@nimbalyst/collab-bundle/docs-ui';

const factory: typeof createCollabDocsSession = createCollabDocsSession;
type FactorySession = ReturnType<typeof factory>;
const sessionTypeCheck = null as unknown as FactorySession satisfies CollabDocsSession;

void factory;
void sessionTypeCheck;
void CollabDocsUIProvider;
