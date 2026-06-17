# Sync JWT Model — Personal vs Team

Nimbalyst auth uses **Stytch B2B**, where a user has a **different `member_id` per org**. There are **two completely different JWT scopes**. They are not interchangeable. Conflating them is the single most-repeated sync bug in this codebase.

## The two scopes

| | **Personal JWT** | **Team JWT** |
| --- | --- | --- |
| Scoped to | the user's **personal** org | a **team** org |
| `sub` claim | personal-org member id (`PersonalMemberId`) | team-org member id (`TeamMemberId`) |
| Used for | **personal sync ONLY**: the personal index room + session / prompt / draft / settings sync — i.e. the cross-device channel to the **mobile app** | **ALL team collaboration**: tracker rooms, tracker schema sync, document rooms, the team room, the project-access / content gate |
| Getter | `getPersonalSessionJwt()` | `getSessionJwt()` (active) / `getOrgScopedJwt(orgId)` |
| Identity getter | `getPersonalUserId()` → `PersonalMemberId` | `getStytchUserId()` (active member id) |
| Room id uses | `personalUserId` / personal `orgId` | the **team** `orgId` |

## Room → scope map

| Room / feature | Scope | Identity |
| --- | --- | --- |
| Personal **index** room (`org:<personalOrg>:user:<id>:index`) | Personal | `personalUserId` |
| **Session** sync (sessions, prompts, drafts, settings → mobile) | Personal | `personalUserId` |
| **Document** rooms (`org:<teamOrg>:doc:<id>`) | Team | team member id |
| **Tracker** rooms + **schema sync** (Epic B Phase 3) | Team | team member id |
| **Team** room (`org:<teamOrg>:team`) + project-access / content gate | Team | team member id |

## Why it keeps breaking

1. **Different `member_id` per org** → a bare `userId` is ambiguous (personal member id ≠ team member id ≠ cross-org `user_id`). Any unqualified `userId` is a latent mix-up.
2. **Three near-identical getters** all return `string` — grabbing the wrong one type-checks.
3. **The personal id is persisted in two places** (Stytch creds + the session-sync config) that **drift** (root cause of NIM-859: a stale `personalUserId` permanently refused the personal index room).

## Compiler enforcement

`packages/runtime/src/auth/jwtScopes.ts` defines **branded** types so a mix-up is a **compile error**:

- `PersonalJwt` / `TeamJwt` — branded JWT strings.
- `PersonalMemberId` / `TeamMemberId` — branded member ids.
- `asPersonalJwt` / `asTeamJwt` / `asPersonalMemberId` / `asTeamMemberId` — tag a raw string **only at the boundary where its scope is proven**.

Brands are additive (`string & {…}`), so a branded value is still usable anywhere a plain `string` is accepted; only call sites that **demand a specific brand** reject the wrong one. The personal-sync source getters and the personal index-room wiring in `SyncManager` are branded, so a team/active id cannot silently flow into the personal room.

## Checklist before touching sync/auth

- Decide which channel you're in **first**. Personal/mobile sync → personal JWT + `personalUserId`/`personalOrgId`. Anything team/collaborative → team JWT + team `orgId`.
- Never use `getStytchUserId()` / the active-session id for the **personal** index room.
- Never use `getPersonalSessionJwt()` / `personalUserId` for a **team** room.
- "**Team room won't connect / a second client can't see shared data**" → **first verify that client is actually authenticated.** An expired session is silently cleared (logged out) → no team JWT → no collaboration. (This is why a second dev instance "doesn't see shared trackers".)

Related: NIM-859 (stale `personalUserId`), `packages/runtime/src/sync/CollabV3Sync.ts` (`ensureFreshJwt` mismatch guard), `StytchAuthService.resolvePersonalUserId` / `refreshPersonalSession`.
