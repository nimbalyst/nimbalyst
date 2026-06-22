## CRITICAL: Personal JWT vs Team JWT are different things — never interchange them

Stytch B2B gives a user a **different `member_id` per org**, and there are two JWT scopes:

- **Personal JWT** (`getPersonalSessionJwt()`, sub = `personalUserId`): used for **personal sync ONLY** — the personal index room + session/prompt/draft/settings sync (the cross-device channel to the **mobile app**).
- **Team JWT** (`getSessionJwt()` / `getOrgScopedJwt(orgId)`, sub = team member id): authorizes **ALL team collaboration** — tracker rooms, tracker schema sync, document rooms, the team room, project-access / content gate.

Rules:
- Decide which channel you're in **before** touching sync/auth code.
- Never use `getStytchUserId()` / the active-session id for the **personal** index room.
- Never use `getPersonalSessionJwt()` / `personalUserId` for a **team** room.
- A bare `userId` is ambiguous — use the branded types in `packages/runtime/src/auth/jwtScopes.ts` (`PersonalJwt`/`TeamJwt`/`PersonalMemberId`/`TeamMemberId`) so a mix-up is a compile error.
- "**A second client / dev instance can't see shared data**" → **first check it is authenticated.** An expired session is silently cleared (logged out) → no team JWT → no collaboration.

Read [SYNC_JWT_MODEL.md](../../docs/SYNC_JWT_MODEL.md) in full before changing the personal/team sync paths.
