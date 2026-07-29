/**
 * Compiler-enforced org scope (NIM-2232).
 *
 * Stytch B2B gives a user a different member id per org, and Nimbalyst runs two
 * kinds of org: the user's PERSONAL org (personal/mobile sync) and TEAM orgs
 * (all collaboration). Both org ids are plain strings that look identical, and
 * a verified JWT proves only "this token is valid for org X" — never "org X is
 * personal".
 *
 * `member_roles.personal_org_id` is a personal-scope field. Writing a team org
 * id into it produced silently wrong identity data (NIM-2232). The brand below
 * makes that a COMPILE ERROR: a value only becomes `VerifiedPersonalOrgId` by
 * passing through a server-side proof, and the writers accept nothing else.
 *
 * The brand is additive (`string & {…}`), so a branded value is still usable
 * anywhere a plain `string` is expected — only the call sites that demand the
 * brand reject an unproven org id.
 */

declare const verifiedPersonalOrgIdBrand: unique symbol;

/**
 * An org id PROVEN to be a personal org by a server-side check. Never construct
 * one from a client-supplied value or from a JWT's org claim alone.
 */
export type VerifiedPersonalOrgId = string & {
  readonly [verifiedPersonalOrgIdBrand]: true;
};

/**
 * Tag a raw org id as a verified personal org.
 *
 * Call this ONLY from the proof itself (`proveVerifiedPersonalOrg` in the sync
 * server). Every other call site should take an already-branded value. If you
 * are reaching for this to "just make it compile", the answer is to write null
 * instead — a detectable null beats a wrong id that routing will trust.
 */
export const asVerifiedPersonalOrgId = (orgId: string): VerifiedPersonalOrgId =>
  orgId as VerifiedPersonalOrgId;
