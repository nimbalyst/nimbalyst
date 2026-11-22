# Identity, Auth, Encryption, and Rooms

Where the design actually is, derived from the code in both repos as of 2026-07-27. Every substantive claim cites `file:line`. Paths starting with `packages/collabv3/` are in the **nimbalyst-collab** repo; everything else is **stravu-editor**. Both working trees have substantial uncommitted work; this doc reads the working trees, not HEAD.

**Revised after the client-managed-custody removal.** Legacy client-managed (`legacy-e2e`) team encryption has been deleted from both repos. Team content is server-managed only, and a team that never migrated is now **refused**, not degraded. The NIM-2212 personal-index inbox fanout and its D1 identity directory went with it. Sections 3, 5, and 6 were rewritten; sections 7 and 8 re-verified. Personal/mobile sync is untouched and remains zero-knowledge.

## Relationship to `docs/SYNC_JWT_MODEL.md`

`SYNC_JWT_MODEL.md` is the **rule sheet**: the two JWT scopes, why they keep getting conflated, the branded types, and the cross-org email mapping. It stays authoritative for those.

This doc is the **map**: the complete room taxonomy, inbox delivery, and the verified gap list. It does not restate the rules.

Three places where `SYNC_JWT_MODEL.md` is now **out of date** — trust this doc where they disagree:

- Its "Room → scope map" lists five rooms. The system has eight room types (`packages/collabv3/src/index.ts:312-379`). ConversationRoom, TeamInboxRoom, and ProjectSyncRoom are missing.
- It says the branded types make a mix-up "a compile error". True on the personal side only, plus the new org-scope brand — see [The two JWTs](#2-the-two-jwts).
- Its whole "What users see (the migration gate)" section describes a migration modal, an acknowledgement checkbox, and a `legacy-e2e` status chip. **That retired flow is gone.** An explicit admin recovery flow now preserves existing identities; see [Encryption and key custody](#6-encryption-and-key-custody).

---

## 1. Stytch org model

Auth is Stytch B2B. A JWT's `sub` is a **member id**, and the org comes from the reserved `https://stytch.com/organization` claim; the server extracts both and rejects a token with no org claim (`packages/collabv3/src/auth.ts:200-216`). Stytch issues a different `member_id` per org, so a bare user id is meaningless without knowing its org.

Org type is not a Stytch primitive. Nimbalyst tags it in `trusted_metadata.nimbalyst_org_type`, and treats **the existence of a TeamRoom DO as the definitive signal** for `team`, backfilling the tag when they disagree; absence of a TeamRoom is *not* treated as definitive proof of `personal` (`packages/collabv3/src/personalOrg.ts:60-104`). Personal-org selection prefers an active-member personal org (`personalOrg.ts:106-116`).

### Where the two member ids are stored

| Value | Client storage | Server storage |
| --- | --- | --- |
| personal org id | `authState.personalOrgId`, persisted per account; accounts map is **keyed by** `personalOrgId` (`packages/electron/src/main/services/StytchAuthService.ts:72,100,118,348`) | `member_roles.personal_org_id` in each TeamRoom DO (`packages/collabv3/src/TeamRoom.ts:245`) |
| personal member id | `authState.personalUserId` (`StytchAuthService.ts:77`), plus a copy in the session-sync config | `member_roles.personal_user_id` (`TeamRoom.ts:246`) and D1 `personal_identities` (`packages/collabv3/migrations/0014_create_personal_identities.sql:25-29`) |
| team member id | `authState.user.user_id` after exchange, read via `getStytchUserId()` (`StytchAuthService.ts:701`); also derived from the team JWT `sub` (`TeamInboxService.ts:158,236`) | `member_roles.user_id` — the primary key (`TeamRoom.ts:242`) |
| active org id | `authState.orgId`, changes on session exchange (`StytchAuthService.ts:715`) | `team_metadata.org_id` |

The client keeps a one-time migration that seeds `personalUserId` from `userId` **only** when `orgId === personalOrgId`, and warns rather than guessing otherwise (`StytchAuthService.ts:467-485`).

## 2. The two JWTs

### Server verification points

Everything public goes through `parseAuth` → `validateJWT` (JWKS signature, issuer host must be exactly `stytch.com` or `*.stytch.com`, audience = project id, exp/nbf with 30s skew) — `packages/collabv3/src/auth.ts:103-221`. That returns `{ userId, orgId }` and **nothing about scope**. Scope is decided per route:

| Route class | Check | Location |
| --- | --- | --- |
| `inbox` rooms | `auth.orgId === room org` **and** `auth.userId === room member` | `index.ts:467-484` |
| `document` / `tracker` / `team` / `conversation` | `auth.orgId === room org`; plus the Epic H1 content gate for tracker+document | `index.ts:485-523` |
| `session` / `index` / `projects` / `projectSync` | `auth.userId === room member` only — **orgId is deliberately not enforced** | `index.ts:524-537` |
| REST `/api/*` | authenticated, then room derived from `auth.userId` with no scope proof | `index.ts:736-804` |

The content gate (`canAccessContentRoom`) asks the org's TeamRoom for the authoritative role + project grant and **fails closed** on any error (`packages/collabv3/src/teamRoomHelpers.ts:157-179`). It runs **only at WebSocket connect** (`index.ts:516-523`).

After the worker authenticates, it stamps `x-nimbalyst-worker-auth` (shared secret) + `x-nimbalyst-auth: <userId>:<orgId>` and forwards to the DO (`index.ts:658`). DOs read identity only from those headers; the old URL-param channel is gone (`packages/collabv3/src/workerAuth.ts:83-99`).

### Credentials that are not Stytch JWTs

Three collabv3-issued credentials reach `/sync/` or `/api/` without being a Stytch JWT. Each has its own resolver and its own type, is consulted only after `parseAuth` fails, and is never written into the Stytch `AuthResult`, so no team branch can see it by mistake:

| Credential | Issued by | Admits | Location |
| --- | --- | --- | --- |
| Node credential | headless node pairing | the owner's personal rooms only | `nodeAuth.ts` |
| GitHub MCP token | GitHub-native sign-in (behind its switch) | a wiki's TrackerRoom and its item-body DocumentRooms, sync channel only | `wiki/wikiGate.ts` |
| Wiki import credential (`mcpimp_v1~...`) | the `pages_import_token` MCP tool, after the same project-write check as `pages_import`; 15 minutes | WebSocket upgrade on a DocumentRoom whose document is in the credential's project with write access, and document asset PUT/GET under the same check. Nothing else | `mcp/importToken.ts`, `importAuth.ts` |

The import credential exists so `nim wiki move-to-team`, which holds only an MCP OAuth token, can write editor pages and attachments into the team documents `pages_import` registered. It is an HMAC over the MCP signing keys with its own prefix, so `parseAuth`, the node verifier and the MCP access-token verifier reject it on shape.

### Client acquisition points

|  | Personal | Team |
| --- | --- | --- |
| JWT getter | `getPersonalSessionJwt()` → `PersonalJwt` (`StytchAuthService.ts:980`) | `getSessionJwt()` → **`string`** (`StytchAuthService.ts:855`); `getOrgScopedJwt(orgId)` (`TeamService.ts`) |
| member id | `getPersonalUserId()` / `resolvePersonalUserId()` → `PersonalMemberId` (`StytchAuthService.ts:736,748`) | `getStytchUserId()` → **`string`** (`StytchAuthService.ts:701`); or the JWT `sub` (`TeamInboxService.ts:158`) |

### Are the branded types actually used at the boundaries?

Partly. `packages/runtime/src/auth/jwtScopes.ts:32-58` defines the four JWT/member-id brands; `packages/collab-protocol/src/identityScope.ts` adds `VerifiedPersonalOrgId` (there, not in `jwtScopes`, because the **server** enforces it and both sides must speak the same type — `jwtScopes.ts:60-69` re-exports it so all scope brands are reachable from one module). Real (non-test, non-`dist`) usage is seven files: `StytchAuthService.ts`, `TeamService.ts`, `SyncManager.ts`, `TeamInboxService.ts`, `TeamInboxSync.ts`, `electronMain.ts`, `identityScope.ts`.

- **Personal side is branded end to end.** `getPersonalSessionJwt`/`getPersonalUserId` return branded values, and `SyncManager` re-derives `personalUserId` authoritatively before building the sync provider (`SyncManager.ts:389-402`).
- **Team side is mostly unbranded.** `getSessionJwt()` and `getStytchUserId()` return plain `string`. Because the brands are additive (`string & {…}`), a plain `string` cannot be passed where `PersonalJwt` is required — so the *personal* direction is protected. Nothing prevents a personal value flowing into a team slot, because most team call sites accept `string`.
- **One laundering path exists.** `getPersonalSessionJwt()` is `authState.personalSessionJwt || authState.sessionJwt`, and the result is tagged `asPersonalJwt(...)` (`StytchAuthService.ts:980-983`). `authState.sessionJwt` is documented as possibly team-scoped after an exchange (`StytchAuthService.ts:853-857`). Same shape at `:986-990` for the per-account variant. So a team JWT can be branded `PersonalJwt`. It fails closed at the personal index room (the `sub` won't match `personalUserId`), and the client refuses to even open the socket on that mismatch (`packages/runtime/src/sync/CollabV3Sync.ts:917-957`) — but see [gap G2](#g2-nim-2229--personal-scope-is-never-proved-on-rest), where nothing catches it.

## 3. The identity bridge (NIM-2212) — removed

The bridge mapped `team member id → member_roles.personal_org_id → personal_identities (D1) → personal member id`. It existed for exactly one caller: addressing a recipient's PersonalIndexRoom for inbox fanout. That fanout is gone (§5), so the bridge went with it — `recordPersonalIdentity`, `lookupPersonalMemberId`, `resolveRecipientPersonalMemberId`, the `announcePersonalOrg` client announcement and its TeamRoom handler.

The `personal_identities` D1 table is left in place as inert storage; dropping it is a data operation, not a code one. `member_roles.personal_org_id` / `personal_user_id` survive as roster columns written by the server-mediated join paths and surfaced in `MemberInfo`. Nothing routes on them any more — see NIM-2232 below for why they were also being written wrong.

### NIM-2232 — a verified token is not a personal-scoped token

`AuthResult.orgId` is the org claim of a verified Stytch JWT. It proves "this token is valid for org X"; it does **not** prove "org X is personal". Team creation and org switching wrote it straight into `personal_org_id`, so a team-scoped token — which a client holds legitimately after a session exchange — put a TEAM org id in a personal-identity column. Reported from the NIM-2232 production investigation: 4 of 69 distinct recorded personal-org ids resolved to real TeamRooms, including one healthy server-managed org, and 84 of 208 member rows were null. (Those figures come from that investigation, not from anything in this repo, and were not re-measured here.)

Both writers now go through `proveVerifiedPersonalOrg` (`packages/collabv3/src/personalOrgScope.ts`), which is the only place that mints the `VerifiedPersonalOrgId` brand. Two server-derived signals, neither client-assertable:

1. **TeamRoom presence disqualifies.** `createTeam` initializes the TeamRoom before adding any member, so every team org in this system has one. Presence is definitive evidence of a team org and wins even over a Stytch tag that says otherwise — this is exactly the production corruption signature.
2. **Stytch `trusted_metadata.nimbalyst_org_type === 'personal'`** is the only positive proof accepted. That tag is written by this worker using the project secret.

Anything else — untagged org, failed lookup, missing id — resolves to null. **Unproven means write nothing.** Team creation and org switching still succeed; only the identity claim is dropped, and a warning names the org. Note the asymmetry with `resolveDiscoveredOrgType`, which may fall back to "assume personal" for read-side org listing: a wrong guess there is cosmetic, whereas a wrong guess in an identity column is what NIM-2232 is.

**What this means for a new org, concretely.** Proof depends entirely on the creator's personal org carrying the `personal` tag. That tag is written once, at personal-org creation, best-effort with a `.catch` that only warns (`index.ts:1889-1903`), and it landed in `7aa5fac` on 2026-03-06. `resolveDiscoveredOrgType` deliberately refuses to backfill `personal` ("incorrect 'personal' tags are destructive", `personalOrg.ts:100-103`), so there is no repair path. Therefore:

- Creator's personal org **is** tagged → the new team records a correct `personal_org_id` + `personal_user_id`. This is the intended path.
- Creator's personal org is **untagged** (signed up before 2026-03-06, or the best-effort tag write failed) → the team is created correctly and everything works, but both identity columns stay **null**.

Null is the designed safe outcome, not a regression — it is precisely the "detectable null beats a wrong id" trade. But it is *absent* identity data, not *correct* identity data, and nothing currently reads these columns except member listings, so the absence is silent. How large that untagged population is cannot be determined from this repo; it needs a production query. If those columns are ever load-bearing again, a proof-backed backfill (TeamRoom-absence plus a fresh personal-scoped connect) is the prerequisite.

The storage side matches. Both `add-member` and `bind-account` COALESCE the two identity columns (`TeamRoom.ts:2082-2089,2117-2125`), and `bind-account` now accepts an absent `personalOrgId`. So an unproven write never clobbers a proven value, and a proven write still corrects a wrong one — the column is deliberately **not** sticky. The retired socket repair path (`announcePersonalOrg`) was the opposite: it took a client-asserted org id under an `IS NULL` guard, which made a wrong value permanent. It is gone.

### Was the NIM-2212 routing fallback ever sound? No.

Commit `8fa19d7` (unpushed, in nimbalyst-collab) contains the version of `resolveRecipientPersonalMemberId` that fell back from `member_roles.personal_user_id` to `member_roles.personal_org_id` → the D1 directory. Assessed on its own terms, that fallback should not have existed:

- It **trusts `personal_org_id`**, the field NIM-2232 shows was written from unproven org ids. A corrupt value there is a TEAM org id.
- The D1 directory is keyed by personal org id, so a team org id normally misses and the delivery is skipped — safe. But a poisoned row **is** reachable: `recordPersonalIdentity` fired whenever `parsed.type === 'index' && auth.orgId === parsed.orgId`, and a client whose personal identity had degraded to team values (the documented `SyncManager` fallback at `SyncManager.ts:389-402` does exactly that) would satisfy both halves and write `personal_identities[teamOrg] = teamMemberId`.
- On a hit, the resolved id is **cached back** into `personal_user_id` under `WHERE personal_user_id IS NULL`. So a single wrong resolution becomes permanent and is never corrected by that path — converting a detectable null into a sticky wrong id that routing trusts.

So: **`8fa19d7` is not deployable as-is even with the NIM-2232 writers fixed.** Fixing the writers makes *new* rows trustworthy; it does nothing for existing rows, and nothing in the fallback distinguishes the two. The rest of `8fa19d7` (ConversationRoom, TeamInboxRoom) does not depend on the fallback and is unaffected by this. In the current working tree the question is moot — the fanout, the resolver, and the directory are all deleted (§3, §5) — but the commit itself still carries the code, so it should not be pushed and deployed unchanged.

## 4. Room taxonomy

Room id is the URL path segment (`/sync/{roomId}`); the **DO name** is what `idFromName` actually receives, and for two room types they differ. Parsing: `index.ts:322-379`. Routing: `index.ts:582-626`.

| Room | Room id | DO name | Addressed by | JWT | Auth check | Stores | Encrypted? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **PersonalIndexRoom** (`IndexRoom`) | `org:{personalOrg}:user:{personalMember}:index` | `user:{member}:index` — **org dropped** (`index.ts:588`) | personal member id | Personal | `sub` == room member; **org not checked** (`index.ts:524-537`) | session/project/file index, devices, push tokens, Live Activity tokens + fleet card state, settings | Yes — client-held key; DO is a relay (`IndexRoom.ts:1-6`). **Exception:** the two push lanes (alert titles, Live Activity `content-state`) leave in plaintext, because APNs renders them |
| `projects` | `org:{personalOrg}:user:{personalMember}:projects` | same DO as `index` (`index.ts:586-589`) | personal member id | Personal | as above | (same DO) | as above |
| **PersonalSessionRoom** | `org:{personalOrg}:user:{personalMember}:session:{id}` | full room id | personal member id | Personal | as above | one AI session's transcript/state | Yes — client-held key |
| **PersonalProjectSyncRoom** | `org:{personalOrg}:user:{personalMember}:project:{projectId}` | full room id | personal member id | Personal | as above, plus DO pins the first-seen owner | project `.md` content + Y.Docs | Yes — "dumb encrypted relay" (`ProjectSyncRoom.ts:1-19`) |
| **TeamRoom** | `org:{teamOrg}:team` | full room id | org (one per org) | Team | org match only — **exempt from the content gate** so a member can bootstrap (`index.ts:485-505`) | `member_roles`, `project_access`, `team_key`, document index, conversation registry, audit log | Mixed: `member_roles` plaintext in the DO; wrapped DEK; doc-index titles DEK-encrypted at rest |
| **DocumentRoom** | `org:{teamOrg}:doc:{documentId}` | `org:{teamOrg}:doc:{decoded documentId}` — **URL-decoded** (`index.ts:590-605`) | org + document | Team | org match + content gate (`projectId = null`) | Y.Doc updates, snapshots, revisions, assets | DEK-encrypted at rest, plaintext on the wire |
| **TrackerRoom** | `org:{teamOrg}:tracker:{teamProjectId}` | full room id | org + project | Team | org match + content gate **with** `projectId` | tracker items, schema, saved views, navigation | DEK-encrypted at rest, plaintext on the wire (`TrackerRoom.ts:67-74`) |
| **ConversationRoom** | `org:{teamOrg}:conversation:{conversationId}` | full room id | org + conversation | Team | org match at the worker; DO re-checks org **and** runs a capability `authorize()` on upgrade (`ConversationRoom.ts:321-330`) | append-only event log | Message body ciphertext under the team DEK. **Readable for routing:** `sequence`, `event_id`, `actor_kind`, `actor_user_id`, `on_behalf_of_user_id`, `operation`, `target_message_id`, timestamps (`ConversationRoom.ts:180-196`) |
| **TeamInboxRoom** | `org:{teamOrg}:user:{teamMember}:inbox` | full room id | **team** member id, org-scoped | Team | **dual check** — `auth.orgId === room org` **and** `auth.userId === room member`, at the worker (`index.ts:467-484`) and again in the DO (`TeamInboxRoom.ts:345-357`); the DO also pins its identity from the path on first bind and refuses a conflicting one (`TeamInboxRoom.ts:241-266`) | per-member deliveries, watermarks, subscriptions | Delivery/source metadata encrypted under the org DEK. **Readable:** `created_at`, `read_at`, `dismissed_at`, `dek_fingerprint`, and an HKDF-derived opaque `source_event_hash` used as the idempotency key (`TeamInboxRoom.ts:1-8,67-77,1012-1036`) |

Notes on the two DO-name divergences:

- **IndexRoom drops the org segment**, so `org:A:user:U:index` and `org:B:user:U:index` are the *same* Durable Object. This is intentional (the same room must be reachable whichever org the JWT is currently scoped to — `index.ts:534-537`). Consequence: the org segment in a personal room id is decorative and unauthenticated.
- **DocumentRoom decodes the id** so filename-shaped document ids match the raw ids server-internal callers use.

The inbox check comment is explicit that neither half may be relaxed during cross-org JWT churn (`index.ts:464-466`) — this is the only user-scoped room that enforces org.

## 5. Inbox delivery — one path

Conversation activity (`messageCreated`) is derived server-side inside `ConversationRoom.afterEventAppended` and delivered to **TeamInboxRoom** (`org:{orgId}:user:{teamMemberId}:inbox`), addressed by **team** member id, with delivery/source metadata encrypted under the org DEK. Mobile push is not attached yet — the hook point is marked as a future attachment (`TeamInboxRoom.ts:533-535`).

**The second path is gone.** The old lane fanned document comment `@`-mentions out of the TeamRoom into each recipient's **PersonalIndexRoom**, encrypted under the client-held org key. It was removed in full: `TeamSync.fanoutInboxEvent` and its call sites, TeamRoom `inboxEventFanout` / `handleInboxEventFanout` / `deliverInboxEvent`, IndexRoom's `inbox_events` table, `inboxSyncRequest` / `inboxSyncResponse` / `inboxEventBroadcast` / `markInboxRead` / `markInboxReadResponse` / `rpc_deliverInboxEvent` and its mobile push, and the `inbox.ts` protocol module.

It was not a working path retired early. Nothing consumed it: a repo-wide search for a client consumer of the *personal-index* variants finds none — not in the renderer, not in `packages/runtime`, not in `packages/ios`. Events delivered there produced a mobile push and were otherwise unread. Keeping it would have left a dead lookalike beside the TeamInboxRoom work that replaces it.

**Consequence, stated plainly:** document comment `@`-mention notifications are not delivered at all today. The `onMention` / `onReply` seams on `CommentsConfig` are intact and deliberately unwired; wiring them to TeamInboxRoom is the replacement work.

`TeamInboxRoom` and `ConversationRoom` both hard-fail without a server-managed DEK (`TeamInboxRoom.ts:958-998`; `ConversationRoom.ts:1610-1648`), and the client latches `custodyBlocked` on that error code and stops reconnecting (`packages/runtime/src/sync/TeamInboxSync.ts:15,308`).

## 6. Encryption and key custody

**Server-managed custody is the only mode.** Per-team DEK (AES-256-GCM), generated in the TeamRoom DO, wrapped by `HKDF(baseKEK, perTeamSalt)`; only the wrapped form is stored. `baseKEK` comes from a `KekProvider` — a Worker secret for dev/test/self-host, Cloudflare Secrets Store for hosted prod; the file states the honest limit that KEK material is in Worker memory during wrap/unwrap (`packages/collabv3/src/kms/KekProvider.ts:1-23`). The DEK is never returned to a client: `/internal/get-team-dek` is DO-to-DO only and the worker hard-blocks client access to `/internal/`. `key-status` returns only mode/epoch/fingerprint.

The client holds **no** team key. It sends plaintext; the server encrypts at rest and serves plaintext back with the empty-string iv sentinel.

**The retired client-managed ("legacy-e2e") lane is gone.** The ECDH identity key pairs, per-org AES keys, wrapped key envelopes, per-member trust verification, org-key rotation, and the client-driven migration have all been deleted from both repos. Personal sync is unaffected and stays zero-knowledge.

### The custody marker, and what happens without it

`key_custody_mode` survives as a one-way marker, not a branch. An organization that does not carry `server-managed` was never migrated; it has no usable team key, and **every team content operation for it is refused**:

| Consumer | Behavior without a server-managed DEK |
| --- | --- |
| `/internal/get-team-dek` | 409 `ORG_SERVER_MANAGED_DEK_REQUIRED` |
| ConversationRoom persistence | 503, room unusable (`ConversationRoom.ts:1633-1640`) |
| TeamInboxRoom persistence | 503 (`TeamInboxRoom.ts:457-460,991-998`) |
| DocumentRoom | `key_custody_unavailable` on sync, update, compaction, and revision read/write |
| TrackerRoom | `key_custody_unavailable` on sync; `custodyUnavailable` mutation reject |
| TeamRoom doc index | `key_custody_unavailable` on register/update/remove/trash/restore/move and folder mutations |
| Document/tracker export/import (move engine) | 409, server-managed required |

This is deliberate and is the point of NIM-2231. `DocumentRoom.loadKeyContext` / `TrackerRoom.loadKeyContext` used to return `'legacy-e2e'` both for a genuinely unmigrated org **and** for a failed custody probe — and that value was also the relay lane, so a transient DO-to-DO failure silently changed how bytes were stored and served. The replacement, `ensureTeamKey`, returns a boolean and has no fallback: probe failure and unmigrated org both refuse.

A non-empty `iv` on inbound content is likewise refused (`legacy_encryption_retired`) instead of being stored as a passthrough row, and pre-cutover rows already in storage are served with their stored iv and logged; the client treats a non-empty iv as unreadable and marks the row locked rather than rendering ciphertext.

### The client-side names lie — read the lane, not the identifier

Everything above describes the server. On the **client** the retired lane left its vocabulary behind, and the names now assert the opposite of what the code does. `EncryptedTrackerItemEnvelope`, `encryptedPayload`, `TrackerEnvelopeCrypto.ts`, and `DocumentSync`'s `encryptForWire` all sound like E2E and are not: the tracker "crypto" helpers are `JSON.stringify` / `JSON.parse` (`TrackerEnvelopeCrypto.ts:37-48`) and `encryptForWire` is a base64 pass-through returning the empty-iv sentinel (`DocumentSync.ts:602`).

They survive because renaming a wire field or a DO column breaks every deployed client and **there is no protocol version handshake in this lane** — old and new clients are distinguished only by which optional fields they send.

The codebase is genuinely mixed, which is what makes the false names plausible: real `crypto.subtle.encrypt` calls sit a few files away.

| Lane | Wire | At rest | Client holds a key? | Names |
| --- | --- | --- | --- | --- |
| Team trackers — items, schemas, saved views, navigation | **Plaintext** | Server DEK | No | Wrong |
| Team documents — `DocumentRoom` Y.Doc | **Plaintext** | Server DEK | No | Wrong |
| Personal sync — `CollabV3Sync`, `ProjectSyncProvider` | AES-256-GCM | Ciphertext | **Yes** | Correct |
| Local document replica on disk — `CollabDocumentReplicaStore` | n/a | AES-256-GCM | **Yes** | Correct |

**Wire encryption and at-rest encryption are separate axes, and the team lanes dropped only the first.** Before "cleaning up" any encryption reference, establish which axis and which lane the sentence is about. `LocalDocumentReplica.ts:448` — "durable outbox rows are independently encrypted and checksummed" — reads vestigial beside the team-lane names and is true; it is the stated grounds for replaying the outbox during corruption recovery, so deleting it would remove the justification for a data-recovery path.

Two more that look dead and are not:

- **`iv`** is a live sentinel, not a leftover parameter. Empty means a server-managed row; non-empty means pre-cutover ciphertext no supported client can read, and `decryptFromWire` throws rather than hand Yjs bytes that decode to garbage.
- **`orgKeyFingerprint`** is still populated. It now identifies the **server's** DEK, for diagnostics.

**Past incident (2026-08-24).** Comparing our tracker sync against a third-party sync engine, an agent read the type names, concluded tracker payloads were end-to-end encrypted and unreadable by the server, and on that basis declared server-side per-field conflict merge architecturally impossible — ruling out the correct design until the user caught it. The names are not a cosmetic debt; they change conclusions.

### The unmigrated population

Cutover is admin-gated and one-way (`legacy-e2e` is explicitly rejected as a target: `teamKeyCustody.ts:56-58`). New orgs are marked server-managed at creation (`TeamService.ts`). Populated legacy organizations use [in-place recovery](LEGACY_ORG_RECOVERY.md): admin-scoped read-only diagnostics, encrypted source bundles, durable write fences, identity-preserving restoration, and independent-client readback before the one-way marker changes. The marker-only endpoint refuses populated legacy orgs. This does not restore the retired client-encryption sync lane. Retained historical keys can be read only by the explicit offline recovery collector; startup no longer deletes those source files.

The census tooling (`packages/collabv3/src/custodyCensus.ts`, `packages/collabv3/scripts/custody-census*.{mjs,ts}`) and the read-only `/internal/get-key-custody-mode` diagnostic are retained so the remaining population can be identified; the diagnostic still reports the legacy string for exactly that purpose.

## 7. Known gaps — verified against the code

### G1 (NIM-2223) — a WebSocket never re-authenticates after connect. **Confirmed, with nuance.**

There is no JWT-expiry re-check or periodic re-auth on any open socket; the worker validates once at upgrade and the DO thereafter trusts the hibernation tags (`index.ts:428-462`; e.g. `IndexRoom.ts:431-461`). Forced closure exists but is uneven:

| Event | Closes sockets? |
| --- | --- |
| `remove-member` | **Yes** — fans `close-user-connections` to every doc/tracker/conversation room plus the inbox room, and **aborts the removal** if closure fails (`TeamRoom.ts:2144-2160,4166`) |
| Account deletion | Yes (`IndexRoom.ts:2097`, `SessionRoom.ts:824`, `DocumentRoom.ts:2123`, `TrackerRoom.ts:2057`, `ProjectSyncRoom.ts:906`, `TeamRoom.ts:4389`) |
| `update-role` (e.g. admin → viewer) | **No** — broadcasts `memberRoleChanged` only (`TeamRoom.ts:2187`) |
| `revoke-project-access` | **No** — broadcasts `projectAccessChanged` only (`TeamRoom.ts:2230`) |
| Conversation membership/ACL change | **Yes** — ConversationRoom is the exception: it revalidates every connection on snapshot push and again on each broadcast (`ConversationRoom.ts:1024-1039,1041-1058`) |

`canAccessContentRoom` appears at exactly three call sites, all in `index.ts` (`:501,:733,:769`) — **never inside TrackerRoom or DocumentRoom**. So the accurate statement is narrower and more actionable than "a revoked member keeps write access": a **removed** member is kicked immediately, but a member **downgraded in role** or **stripped of a project grant** keeps full write access to already-open tracker and document sockets until the socket closes on its own. ConversationRoom already demonstrates the fix pattern.

### G2 (NIM-2229) — personal-scope is never proved on REST. **Confirmed, and the impact is worse than "wrong room".**

`handleApiRequest` authenticates and then derives the target room from `auth.userId` with no check that the token is personal-scoped (`index.ts:670-725`). Two routes remain in this shape: `/api/sessions` (`:713`) and `/api/account/delete` (`:722`). (`/api/session/{id}/status` and `/api/bulk-index`, both previously listed here, have been deleted — see G4.)

This is **not** cross-user access — the room follows the caller's own `sub`. The real hazard is `/api/account/delete`, which uses the presented token's org and member id for the final step: `DELETE /v1/b2b/organizations/{auth.orgId}/members/{auth.userId}` (`packages/collabv3/src/accountDeletion.ts:128-129`). Called with a **team**-scoped JWT it would purge a team-member-keyed (empty) index room, leave all personal data intact, and delete the caller's membership **in that team org** — i.e. "delete my account" silently becomes "leave this team". The client currently sends the personal JWT (`StytchAuthService.ts:1454-1484`), so this is latent, not active — but the only thing holding it is a client getter that can itself return a team JWT (`StytchAuthService.ts:980-983`, see §2).

**Still open, deliberately.** `proveVerifiedPersonalOrg` (§3) is now exactly the tool this needs — the server could require a proven personal org before touching these routes. It was not applied here as part of the custody removal: changing what "delete my account" destroys is a destructive-path behavior change and belongs in its own reviewed change, not a cleanup sweep.

### G3 (NIM-2230) — D1 vs Durable Object for the identity directory. **Moot.**

The question was where to host `personal_identities`. The directory and its only consumer were deleted with the inbox fanout (§3), so there is nothing left to place. The D1 table remains as inert storage until someone drops it. If a personal-member-id lookup is ever needed again, this decision returns — with the added lesson that the field it keyed on was itself untrustworthy (NIM-2232).

### G4 — dead personal-sync REST routes. **Fixed.**

`/api/session/{id}/status` named its SessionRoom without the `org:` prefix that the WebSocket route and account deletion both use, so it could only ever hit a fresh empty DO; `/api/bulk-index` forwarded to a `/bulk` path `IndexRoom.fetch` does not handle. Neither had a client caller and both are now deleted. The only route left in that group with a live caller is `/api/sessions` (`PersonalSyncDevicesService.ts:22`).

### G5 — comment-mention notifications have no delivery path. **Open.**

The legacy fanout is deleted (§5) and the TeamInboxRoom replacement is not wired to the comment seams. Mentions are recorded in the document's comment thread and are visible there; no notification is raised.

### G6 — the custody-probe failure branch is untested. **Open, and known.**

`ensureTeamKey` refuses for two reasons: TeamRoom answers 409 (org never migrated) and the probe itself failed (transport error, the 503 `ORG_SERVER_MANAGED_DEK_MISSING` branch, malformed body). `custodyFailClosed.integration.test.ts` exercises only the first. The call sites that refuse are the same for both, so the refusal behavior is pinned; the second branch of `ensureTeamKey` is not. Reaching it needs a TeamRoom reporting server-managed custody with no persisted DEK row, and no test-only hook constructs one. Adding a production endpoint purely to reach it was judged the wrong trade; the limitation is recorded in the test file's header rather than left implicit.

## 8. Design inconsistencies

### I1 — comment-mention notifications have no delivery path

Was: the fanout skipped every server-managed org. Now: the fanout is gone entirely, along with the identity bridge that existed to route it (§3, §5). The `onMention` / `onReply` seams remain. The open decision is no longer "extend the bridge or retire it" — the bridge is retired, and the remaining work is to deliver mentions as TeamInboxRoom deliveries addressed by team member id, which needs no personal-id mapping at all.

### I2 — two systems both called "the inbox", addressed by different member ids

**Resolved.** There is one inbox now: TeamInboxRoom, addressed by **team** member id. `:user:{id}:index` is a personal session index; `:user:{id}:inbox` is the team inbox.

### I3 — the same message names mean different things in different rooms

**Resolved.** These names used to exist in both protocols with incompatible payloads. The IndexRoom variants are deleted; only the TeamInboxRoom shapes (`deliveries` / `deliveryIds`) remain.

### I4 — the "team collaboration is always server-managed" invariant is client-enforced

An org without the `server-managed` marker is created by the server and only marked by a follow-up REST call from `createTeam`. That call is **not** wrapped in a try/catch inside `createTeam`, so a failure throws and team creation fails loudly rather than silently leaving a half-configured org — good. The residual issue is placement: the invariant lives in one client code path, while the server will hand out an unmarked org to any caller that skips that step (an older build, a script, a future API client).

This is now much less dangerous than it was: an unmarked org is refused by every content room rather than silently falling back to a relay lane (§6), so the failure is loud and immediate. Both migration backstops are gone, though, so the invariant genuinely belongs in server-side team creation.

### I5 — user-scoped room ids carry an org segment that is neither authenticated nor used

`org:{org}:user:{member}:index` is parsed into an `orgId` (`index.ts:311-314`) that is then deliberately not checked (`index.ts:517-520`) and dropped from the DO name (`index.ts:554`). It now has **no** live use at all: its one consumer was the `recordPersonalIdentity` gate, deleted with the identity bridge (§3). It looks like a scope constraint and is not one — the exact shape that produces "I checked the org, it's fine" reasoning errors. G2 is a direct consequence. Now that nothing reads it, dropping the segment from personal room ids is a cheaper option than it was.

### I6 — `personal_org_id` / `personal_user_id` are write-only columns

Both survive on `member_roles` and are still written by the two proven paths (§3). `personal_org_id` is still **read** — it is surfaced in member listings (`TeamRoom.ts:792,2788,2913,3032`) and the client uses it for account binding. `personal_user_id` has no reader left: its only consumer was `resolveRecipientPersonalMemberId`, deleted with the fanout. It is maintained storage with no purpose today. Keeping it is defensible (re-deriving the mapping later is expensive and the writes are already proven-only); leaving it undocumented is not, hence this entry.

## Verification notes

- **Verified by execution** (2026-07-27): collabv3 `tsc --noEmit` clean; collabv3 unit suite 23 files / 166 tests pass; collabv3 full wrangler suite 61 files / 352 tests pass; client `npm run typecheck` clean across all workspaces; client `test:prepush` 924 files / 7323 tests pass with two pre-existing unrelated failures (a gitignored `temptests/` tracker-schema file, and the known `out-devurl-test` baseline); Electron production bundle (`electron-vite build` + `build:worker`) exits 0.
- Not verified: the production corruption numbers quoted in §3 (4 of 69 org ids, 84 of 208 rows). These come from the NIM-2232 investigation, not from anything readable in this repo; they were not independently re-measured here and would need a production query.
- Not verified: live runtime behavior against production rooms. No live room state was inspected and no production data was touched.
- Not exhaustively verified: whether any surface outside the searched packages consumed the (now deleted) personal-index inbox protocol. The search covered `packages/runtime`, `packages/electron`, `packages/ios` (Swift), and `packages/collab-protocol`, excluding `dist`/`out`. An Android/Capacitor client outside those paths was not checked.
- `docs/COLLABORATION_GUIDE.md` and `docs/TEAMMATE_IMPLEMENTATION.md` were not reconciled against this doc. `docs/SYNC_JWT_MODEL.md` **is** now partly contradicted by it — see the note at the top.
