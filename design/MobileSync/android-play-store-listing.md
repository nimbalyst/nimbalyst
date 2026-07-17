# Android Play Store Listing — Nimbalyst

Working copy for the Play Console app record. Paste each field into the Console; keep this doc as the source of truth so re-submissions stay consistent. Character limits noted inline.

## App details

- **App name** (30 chars max): `Nimbalyst`
- **Package name**: `com.nimbalyst.app`
- **Default language**: English (United States)
- **App or game**: App
- **Category**: Productivity (fallback: Developer Tools if Productivity is contested at review)
- **Tags**: (Console-suggested; pick "Productivity", "Utilities")
- **Contact email**: `support@nimbalyst.com`
- **Website**: `https://nimbalyst.com`
- **Privacy policy URL**: `https://nimbalyst.com/privacy` (verified live; already references PostHog/analytics/mobile/push). Recommend adding explicit lines for email collection, FCM push token, E2E-encrypted content, and Firebase-as-processor to fully match the Data Safety form.

## Short description (80 chars max)

```
Monitor and steer your Nimbalyst AI coding sessions from your phone.
```
(67 chars)

## Full description (4000 chars max)

```
Nimbalyst for Android is the mobile companion to the Nimbalyst desktop
workspace. Pair it with your desktop, then follow and steer your AI coding
sessions from anywhere.

Requires the Nimbalyst desktop app. Android does not run sessions on its own —
it pairs with your desktop over an end-to-end encrypted sync connection and
mirrors what is happening there.

What you can do:
- Pair securely by scanning a QR code from the desktop app.
- See your synced projects and sessions, with unread badges and live
  connection state.
- Open a session transcript and read the full history.
- Send new prompts, including image attachments, to a desktop-backed session.
- Answer interactive requests from the agent (tool permissions, questions,
  plan approvals) without walking back to your desk.
- Get push notifications when a session needs your attention, and tap to jump
  straight to it.

Privacy and security:
- Your session content — prompts, messages, and attachments — is end-to-end
  encrypted between your devices. The sync server relays encrypted data it
  cannot read.
- Analytics are optional and can be turned off in Settings.

Not on Android in this release:
- Voice mode is desktop-only for now.
- Full document editing happens on the desktop; Android focuses on following
  and steering sessions.

Nimbalyst is an AI-native workspace and code editor. This app extends it to
your phone so you are never blocked waiting at your desk.
```

## Graphics assets checklist

- [ ] App icon: 512x512 PNG (32-bit, with alpha). Reuse the branded launcher icon art.
- [ ] Feature graphic: 1024x500 PNG/JPG (no alpha). Required.
- [ ] Phone screenshots (min 2, up to 8; 16:9 or 9:16, min 320px side): capture from the polished app, not mockups:
  - [ ] QR pairing / onboarding
  - [ ] Project list (with synced projects)
  - [ ] Session list with unread badges
  - [ ] Session transcript
  - [ ] Prompt composer with an image attachment
  - [ ] Settings (sync + notifications state)
- [ ] (Optional) 7-inch / 10-inch tablet screenshots only if you claim tablet support.

## App access (reviewer instructions)

Reviewers cannot pair without a desktop, so give them a working path. Fill in
whichever applies before submitting:

```
This app is a companion to the Nimbalyst desktop application and requires a
paired desktop to show any content. To review full functionality:

1. Test account / demo pairing: <TODO — provide a reviewer test account, or a
   pre-paired demo build/QR, or a short screencast of the paired flow>.
2. Without pairing, the app opens to a QR pairing screen. Scan the QR shown in
   the Nimbalyst desktop app (Settings > Devices) to pair.

Contact <TODO support email> for reviewer assistance.
```

Chosen approach: **screencast in review notes** — attach a short video of the
paired flow (pairing, session list, transcript, sending a prompt, a push
notification) so reviewers see full functionality without a desktop. Note in the
review comments that content requires a paired desktop and analytics/notifications
are optional. (If Google pushes back and wants hands-on access, fall back to a
reviewer test account + staging desktop.)

## Content rating

- Complete the IARC questionnaire. Expected outcome: **Everyone** / low.
- No user-generated content shared publicly, no ads, no gambling, no mature
  content. Session content is private between the user's own paired devices.

## Target audience & content

- Target age: 18+ (developer tool; avoid child-directed obligations). Confirm
  the app is not directed at children.
- Ads: **No ads.**

## Data Safety form

> Filled from the code audit — see the worksheet below. This section is
> AUTHORITATIVE for the Console form.

<!-- DATA_SAFETY_WORKSHEET -->

Based on a full code audit of `packages/android`. "Collected" = transmitted off
the device. "Shared" = transferred to a separate company (a service provider
processing on our behalf is NOT "sharing" per Google). Only two external
destinations exist: our sync server (`wss://sync.nimbalyst.com`) and PostHog
analytics (`us.i.posthog.com`); FCM (Google) delivers push. No ads, no
advertising ID, no location, no crash-reporting SDK.

### Data the app COLLECTS

| Data type (Google category) | What | Collected | Shared | Optional/Required | Purposes | Encrypted in transit |
| --- | --- | --- | --- | --- | --- | --- |
| Personal info → Email address | Account email; also set as a PostHog person property | Yes | No | Required (needed to sign in) | App functionality (account), Analytics | Yes |
| Personal info → User IDs | Auth user id, org id, and an app-generated analytics UUID | Yes | No | Required | App functionality, Analytics | Yes |
| Messages → Other in-app messages | Prompt text + AI session transcript content sent through sync | Yes | No | Required | App functionality | Yes (E2E encrypted client-side, then TLS) |
| Photos and videos → Photos | Image attachments the user adds to a prompt | Yes | No | Optional (only if user attaches) | App functionality | Yes (E2E encrypted client-side, then TLS) |
| App activity → App interactions | Product-interaction events (app opened, session viewed, message sent counts — no content) | Yes | No | Optional (Settings opt-out) | Analytics | Yes |

Notes for the reviewer/policy:
- Session content (prompts, transcript, attachments) is **end-to-end encrypted**
  on-device (AES-GCM, PBKDF2-derived key) before it reaches the sync server; the
  server relays ciphertext it cannot read. Declared as collected because it is
  transmitted off the device, per Google's definition.
- The FCM push token + a device id + `platform` label are sent to the sync
  server to deliver notifications. This is app functionality, not an advertising
  or hardware identifier. (Not declared under "Device or other IDs," which
  targets advertising/hardware IDs — none are collected.)
- PostHog is a data processor (service provider), so analytics is "collected"
  but not "shared." Client IP is recorded server-side by PostHog's ingestion by
  default; the app itself sets no IP/location.

### Data the app does NOT collect (declare "No")

Location (precise/approx), Financial info, Health & fitness, Contacts, Calendar,
SMS/call log, Web browsing history, Installed apps, Search history, Audio/voice
(no mic permission), Files/docs other than the photos above, Device or other IDs
(no advertising ID, no hardware identifiers), Crash logs / diagnostics /
performance (no Crashlytics/Sentry/Bugsnag in the build).

### Security practices section

- **Is all user data encrypted in transit?** → **Yes** (WSS/TLS to sync server;
  HTTPS to PostHog; session content additionally E2E-encrypted).
- **Do you provide a way for users to request that their data be deleted?** →
  **Yes — in-app account deletion.** Settings > Delete Account calls the sync
  server's `POST /api/account/delete` (Bearer session JWT), which purges the
  user's server-side rooms/data, then clears all local state. (Mirrors the
  existing iOS implementation; server endpoint already exists.) Sign out / Unpair
  additionally clear local data and unregister the push token.
- **Has your app been independently security reviewed?** → optional; leave No
  unless you have a report to cite.
- **Committed to Google Play Families Policy?** → No (not directed at children).

### Open inputs — RESOLVED

- **Privacy policy URL**: `https://nimbalyst.com/privacy` (live). Recommended
  follow-up (website edit, non-blocking): explicitly list email, FCM push token,
  E2E-encrypted content, and Firebase/Google as a processor so the policy fully
  matches this Data Safety declaration.
- **Support / contact email**: `support@nimbalyst.com`.
- **Data deletion**: **In-app account deletion shipped** (Settings > Delete
  Account → `POST /api/account/delete`). Answers the deletion question as "Yes,
  in-app."
- **Reviewer access**: screencast of the paired flow in review notes.
```

## Store listing "Done" checklist

- [ ] Short + full description pasted
- [ ] Icon, feature graphic, 4-6 screenshots uploaded
- [ ] Privacy policy URL live and reachable
- [ ] Support email set
- [ ] App access / reviewer path provided
- [ ] Content rating questionnaire submitted
- [ ] Target audience + ads declaration
- [ ] Data Safety form submitted (matches worksheet below)
```
