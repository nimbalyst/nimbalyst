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

## Cross-org operations (move / merge) — authorize the actor by email

A move/merge (Epic H3) must prove the caller is an **admin of two different orgs** (source + destination, or drained + survivor). But a request carries only **one** org-scoped team JWT, and `auth.userId` is the `member_id` **in that one org** — which, because `member_id` differs per Stytch B2B org, is **not** in the other org's roster. Checking the other org's admin with that `member_id` always fails ("Not a member of this team") even for the org owner.

So cross-org admin checks **map the actor by canonical email**: resolve the actor's email from the org their JWT is scoped to (`resolveActorEmail`), then look that email up in each target org's roster and require an owner/admin role there (`requireAdminByEmail`, `packages/collabv3/src/teamRoomHelpers.ts`). `member_roles.email` is the cross-org join. The same applies to grant transfer — project access is remapped to the destination `member_id` **by email**, never by carrying the source `member_id` across. (Test bypass that reuses one synthetic `user_id` across orgs will hide this bug; the regression test `moveProjectCrossOrgAuth.integration.test.ts` models distinct per-org member ids.)

## Key custody (Epic H2) — a second, orthogonal axis

The JWT scope (personal vs team) decides **who you authenticate as**. A separate axis — **key custody** — decides **who holds the encryption key for team data**. Don't conflate them.

| | Personal lane | Team lane |
| --- | --- | --- |
| Encryption posture | **Always zero-knowledge.** The server holds no key; only the user's devices can decrypt. Unchanged by H2. | **Per-team mode** (`legacy-e2e` or `server-managed`). |
| `legacy-e2e` (default) | n/a | Client-side zero-knowledge ECDH org-key envelopes — the DO is a dumb encrypted relay. |
| `server-managed` (H2) | n/a | The **server** holds a per-team Data Encryption Key (KMS-wrapped, split-knowledge) and encrypts team data **at rest**, serving plaintext to H1-gated clients. Encrypted & operated by Nimbalyst — **not** zero-knowledge. Enables web/CLI/cloud-agent access (no device key needed). |

**The lane boundary is a hard rule.** The personal lane must **never** consult team key-custody status or touch the team DEK path. The client checks mode via `GET /api/teams/{orgId}/key-status` using the **team** JWT only (`OrgKeyService.fetchTeamKeyStatus`); personal index/session/doc sync never call it. In `server-managed`, the client runs the engines in pass-through (sends/receives PLAINTEXT team payloads; the server encrypts at rest) — see the `keyCustody` config on `TrackerSyncEngine` / `DocumentSync` / `TeamSync` / `CollabHistoryClient`.

Server key hierarchy: per-team **DEK** (AES-256-GCM, in DO memory only) wrapped by `HKDF(baseKEK, perTeamSalt)` where the salt lives in the team's DO (split-knowledge — you need BOTH the KEK source AND a DO dump). `baseKEK` from a `KekProvider`: Worker secret (`TEAM_KEK`) for dev/test/self-host, Cloudflare Secrets Store for hosted prod. Honest limit: a compromised/compelled prod deploy can read team data — that's inherent to server-managed keys; the self-host path is the true-zero-knowledge answer. See `nimbalyst-collab/packages/collabv3/src/kms/` and the H2 design docs.

### What users see (the migration gate)

The posture change is surfaced in-product (launch gate, no blog) in **Team settings → Security & encryption** (`SecurityEncryptionSection` / `H2EncryptionMigration.tsx`):

- A legacy-e2e team shows a status chip "End-to-end encrypted · desktop & mobile only". An **owner/admin** sees an "Update team encryption" banner → a modal (`h2-encryption-migration-modal`) with the policy-change copy: *what's changing* (team data moves to server-managed keys), *what stays private* (personal sync stays end-to-end encrypted), and *the honest tradeoff* (Nimbalyst could technically read shared team data; access is audit-logged; self-host for true ZK).
- A **required acknowledgement checkbox** gates the "Acknowledge & migrate" button (`h2-migrate-button`, owner/admin only). Migration runs the client-assisted cutover and flips the mode; on success the chip becomes "Encrypted & operated by Nimbalyst · isolated per team · audit-logged". Non-admins see a read-only note.
- **Migration order (architecture):** the server must already be in `server-managed` mode for re-uploaded plaintext to be DEK-encrypted at rest, so the cutover REST (admin-gated, fails closed for non-admins/network) flips the mode and then the client re-uploads local plaintext. A failed REST call leaves the team on legacy-e2e.

Copy source of truth: `nimbalyst-local/plans/teams/h2-migration-ux-and-copy.md`.
