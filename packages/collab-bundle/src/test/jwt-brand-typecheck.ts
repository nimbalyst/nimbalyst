import type {
  PersonalJwt,
  TeamJwt,
  TeamMemberId,
} from '@nimbalyst/runtime/auth/jwtScopes';
import type { TeamRoomAuth } from '../editor/types';

declare const personalJwt: PersonalJwt;
declare const hostAuth: TeamRoomAuth;

// The in-page host contract returns the runtime's exact team-scoped brand.
const hostJwt: Promise<TeamJwt> = hostAuth.getTeamJwt();

// These assertions deliberately fail if the runtime's nominal brands are ever
// erased or replaced with local structural copies.
// @ts-expect-error A raw string has not been proven to be scoped to a team org.
const rawJwtIsNotTeamJwt: TeamJwt = 'unscoped-jwt';
// @ts-expect-error A personal-org JWT cannot authorize a team collaboration room.
const personalJwtIsNotTeamJwt: TeamJwt = personalJwt;
// @ts-expect-error A raw member id has not been associated with the team org.
const rawMemberIdIsNotTeamMemberId: TeamMemberId = 'unscoped-member';

void rawJwtIsNotTeamJwt;
void personalJwtIsNotTeamJwt;
void rawMemberIdIsNotTeamMemberId;
void hostJwt;
