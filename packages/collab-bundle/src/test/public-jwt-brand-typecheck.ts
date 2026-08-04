import type {
  TeamJwt,
  TeamMemberId,
  TeamRoomAuth,
} from '@nimbalyst/collab-bundle/editor';
import { createCollabDocsScopeLifecycle } from '@nimbalyst/collab-bundle/docs-ui';
import type { PersonalJwt } from '@nimbalyst/runtime/auth/jwtScopes';

declare const auth: TeamRoomAuth;
declare const editorJwt: TeamJwt;
declare const personalJwt: PersonalJwt;

type DocsHost = Parameters<typeof createCollabDocsScopeLifecycle>[0];
type DocsTeamJwt = Awaited<ReturnType<DocsHost['getTeamJwt']>>;

// Both package entries resolve the exact runtime-owned team-scoped brand.
const publicHostJwt: Promise<TeamJwt> = auth.getTeamJwt();
const editorJwtAcceptedByDocsHost: DocsTeamJwt = editorJwt;
// @ts-expect-error A consumer cannot hand the bundle an unverified JWT string.
const rawPublicJwt: TeamJwt = 'unverified-jwt';
// @ts-expect-error A personal-org JWT cannot authorize the docs-ui team host.
const personalPublicJwt: DocsTeamJwt = personalJwt;
// @ts-expect-error A consumer cannot hand the bundle an unverified member id.
const rawPublicMemberId: TeamMemberId = 'unverified-member';

void publicHostJwt;
void editorJwtAcceptedByDocsHost;
void rawPublicJwt;
void personalPublicJwt;
void rawPublicMemberId;
