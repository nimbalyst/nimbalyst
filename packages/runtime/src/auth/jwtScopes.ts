/**
 * The two-JWT model — compiler-enforced.
 *
 * Nimbalyst auth uses Stytch B2B, where a user has a DIFFERENT member id per
 * org. There are two completely different JWT scopes, and they must never be
 * interchanged:
 *
 * - PERSONAL JWT (`PersonalJwt`): scoped to the user's PERSONAL org. Its `sub`
 *   is the personal-org member id (`PersonalMemberId`). It is used for EXACTLY
 *   ONE thing: personal sync — the personal index room and session / prompt /
 *   draft / settings sync, i.e. the cross-device channel to the MOBILE app.
 *   Source: `getPersonalSessionJwt()`. Room ids use `PersonalMemberId` /
 *   personal `orgId`.
 *
 * - TEAM JWT (`TeamJwt`): scoped to a TEAM org. Its `sub` is the user's
 *   team-org member id (`TeamMemberId`). It authorizes ALL team collaboration:
 *   tracker rooms, tracker schema sync, document rooms, the team room, and the
 *   project-access / content gate. Source: `getSessionJwt()` (active) /
 *   `getOrgScopedJwt(orgId)`. Room ids use the TEAM `orgId`.
 *
 * Because both are `string` at runtime, the brands below exist purely to make a
 * mix-up a COMPILE ERROR: a `TeamJwt` cannot be passed where a `PersonalJwt` is
 * required, and a `TeamMemberId` cannot be assigned to a `PersonalMemberId`.
 * The brands are additive (`string & {…}`), so a branded value is still freely
 * usable anywhere a plain `string` is expected (`.split('.')`, template
 * literals, room-url building, etc.) — only call sites that demand a specific
 * brand reject the wrong one.
 *
 * See docs/SYNC_JWT_MODEL.md for the full room→JWT→identity table.
 */

declare const personalJwtBrand: unique symbol;
declare const teamJwtBrand: unique symbol;
declare const personalMemberIdBrand: unique symbol;
declare const teamMemberIdBrand: unique symbol;

/** A JWT scoped to the user's PERSONAL org. ONLY for personal/mobile sync. */
export type PersonalJwt = string & { readonly [personalJwtBrand]: true };
/** A JWT scoped to a TEAM org. Authorizes ALL team collaboration. */
export type TeamJwt = string & { readonly [teamJwtBrand]: true };

/** The user's member id in their PERSONAL org. Routes personal/mobile sync rooms. */
export type PersonalMemberId = string & { readonly [personalMemberIdBrand]: true };
/** The user's member id in a TEAM org. Routes team collaboration rooms. */
export type TeamMemberId = string & { readonly [teamMemberIdBrand]: true };

/**
 * Tag a raw string as a PERSONAL-scoped JWT. Use ONLY at the boundary where the
 * value provably came from the personal-org session (e.g. the personal session
 * exchange). Never use to launder a team JWT.
 */
export const asPersonalJwt = (jwt: string): PersonalJwt => jwt as PersonalJwt;
/** Tag a raw string as a TEAM-scoped JWT. Use ONLY where the value is an org-scoped/active session JWT. */
export const asTeamJwt = (jwt: string): TeamJwt => jwt as TeamJwt;
/** Tag a raw string as a personal-org member id. */
export const asPersonalMemberId = (id: string): PersonalMemberId => id as PersonalMemberId;
/** Tag a raw string as a team-org member id. */
export const asTeamMemberId = (id: string): TeamMemberId => id as TeamMemberId;
