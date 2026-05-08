# @nimbalyst/collabv3-metrics

Self-hosted, single-user dashboard that visualizes the `nimbalyst_sync` Cloudflare Analytics Engine dataset captured by the collabv3 Worker.

Deployed as a Cloudflare Pages project at `https://metrics.nimbalyst.com` and gated by Cloudflare Access (Zero Trust) with GitHub OAuth, allowed only for `greg@stravu.com`.

## Architecture

```
Browser  --Cloudflare Access (GitHub OAuth)-->  metrics.nimbalyst.com (Pages)
                                                       |
                                                       |-- public/  (static dashboard)
                                                       |
                                                       `-- functions/api/query  (Pages Function)
                                                                 |
                                                                 `-- Cloudflare Analytics Engine SQL API
```

The Pages Function holds the `CF_API_TOKEN` secret and proxies a strictly whitelisted (`SELECT ... FROM nimbalyst_sync ...`) SQL query to the Analytics Engine SQL API. The browser never sees the API token. Cloudflare Access enforces auth at the edge before any request reaches the origin.

See `nimbalyst-local/plans/sync-metrics-dashboard.md` for the full design rationale.

## Layout

```
packages/collabv3-metrics/
  package.json
  wrangler.toml          Pages project config
  tsconfig.json
  public/
    index.html           Dashboard shell + Chart.js charts
    styles.css           Dark theme styles
  functions/
    api/
      query.ts           POST /api/query -> Analytics Engine SQL API
```

No build step. Chart.js is loaded from a CDN. Pages serves `public/` as static assets, and Cloudflare automatically wires up `functions/` as Pages Functions.

## Initial setup

These steps are manual (one-time per environment) and are deliberately not automated.

### 1. Create a scoped API token

In Cloudflare dashboard: My Profile -> API Tokens -> Create Custom Token.

- Name: `nimbalyst-collabv3-metrics`
- Permissions: `Account.Account Analytics: Read`
- Account resources: Include -> the Nimbalyst account only
- IP filtering / TTL: optional

Save the token. Do not use the Global API Key.

### 2. Find the account ID

```
npx wrangler whoami
```

Copy the account ID associated with the Nimbalyst account.

### 3. Fill in `wrangler.toml`

Update the `CF_ACCOUNT_ID` value in `wrangler.toml` (it is a `vars` entry, not a secret). Leave `CF_API_TOKEN` out of the file.

### 4. Create the Pages project (first deploy)

```
cd packages/collabv3-metrics
npx wrangler pages deploy public --project-name nimbalyst-collabv3-metrics
```

The first deploy creates the project on `https://nimbalyst-collabv3-metrics.pages.dev`. Pages Functions inside `functions/` are uploaded automatically on the same deploy.

### 5. Set the API token secret

```
npx wrangler pages secret put CF_API_TOKEN --project-name nimbalyst-collabv3-metrics
```

Paste the token from step 1 when prompted. (The dashboard at Pages -> Settings -> Environment variables works equivalently.)

### 6. Add GitHub OAuth as an Identity Provider

Cloudflare Zero Trust dashboard (`one.dash.cloudflare.com`):

1. Settings -> Authentication -> Login methods -> Add new -> GitHub
2. In GitHub: Settings -> Developer settings -> OAuth Apps -> New OAuth App
  - Homepage URL: `https://metrics.nimbalyst.com`
  - Callback URL: the value Cloudflare shows on the GitHub IdP setup screen (looks like `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`)
3. Paste the GitHub OAuth client ID and client secret into the Cloudflare IdP form
4. Click "Test" on the Cloudflare side to verify the round trip

### 7. Protect the `*.pages.dev` URL via the Pages-integrated Access policy

The Cloudflare Pages "Enable access policy" feature only covers PREVIEW deployments by default (`<hash>.nimbalyst-collabv3-metrics.pages.dev`). To extend it to the production `nimbalyst-collabv3-metrics.pages.dev` URL too, you have to remove a wildcard:

1. Workers & Pages -> `nimbalyst-collabv3-metrics` -> Settings -> **Enable access policy**
2. On the resulting Access application click **Manage**
3. Under Access -> Applications, find the auto-created app for this project, click **Configure**
4. In the **Public hostname** section, **remove the `*` from the Subdomain field** and save
5. On the application's policy:
   - Include: Login methods -> GitHub
   - Require: Emails -> `greg@stravu.com`

The wildcard removal is the load-bearing step. Without it, the production `pages.dev` URL stays unprotected. Reference: [Cloudflare Pages known issues - Enable Access on your *.pages.dev domain](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain).

### 8. Add DNS for `metrics.nimbalyst.com`

In the Cloudflare dashboard for the `nimbalyst.com` zone:

- Add CNAME record: `metrics` -> `nimbalyst-collabv3-metrics.pages.dev`
- Proxy: orange cloud (proxied through Cloudflare; required for Access)

In the Pages project: Workers & Pages -> `nimbalyst-collabv3-metrics` -> Custom domains -> Set up a custom domain -> `metrics.nimbalyst.com`. Cloudflare will provision the certificate.

### 9. Create a SEPARATE Access application for the custom domain

The Pages-integrated Access policy from step 7 does NOT cover custom domains. Quoting the Cloudflare docs:

> If you do not configure an Access policy for your custom domain, an Access authentication will render but not work for your custom domain visitors.

So the custom domain needs its own Self-hosted Access application:

1. Zero Trust -> Access controls -> **Applications** -> **Add an application** -> **Self-hosted**
2. Application name: `Nimbalyst Sync Metrics (custom domain)`
3. Session duration: 30 days
4. **Add public hostname** -> select `metrics.nimbalyst.com` from the Domain dropdown (only appears after step 8's DNS + custom-domain wiring)
5. Add a policy:
   - Action: Allow
   - Include: Login methods -> GitHub
   - Require: Emails -> `greg@stravu.com`

The email rule is the actual gate. The GitHub rule narrows which IdP can satisfy the policy.

## Operating

### Redeploy after a code change

```
cd packages/collabv3-metrics
npx wrangler pages deploy public --project-name nimbalyst-collabv3-metrics
```

Pages Functions in `functions/api/query.ts` are bundled into the same deployment automatically; no separate command is needed.

### Add a new chart

1. Add a `<div class="chart-card" data-chart="my-chart">` block with a `<canvas id="chart-my-chart">` to `public/index.html`.
2. Add a `loadMyChart()` function in the inline `<script type="module">` that calls `runQuery(...)` and `renderChart(...)`.
3. Add `loadMyChart()` to the `Promise.allSettled([...])` in `refreshAll()`.

Each query must `SELECT ... FROM nimbalyst_sync ...` -- the Pages Function rejects anything else with a 403.

### Local development

```
cd packages/collabv3-metrics
npx wrangler pages dev public --port 8791
```

`wrangler pages dev` serves the static site and the Pages Function locally. The Function still needs `CF_API_TOKEN` and `CF_ACCOUNT_ID` to reach the upstream API; pass them via a local `.dev.vars` file (do NOT commit it):

```
# .dev.vars
CF_API_TOKEN = "scoped-token-here"
CF_ACCOUNT_ID = "..."
```

`.dev.vars` is gitignored by default in Cloudflare projects, but verify it's not staged before committing.

### Typecheck

```
cd packages/collabv3-metrics
npm run typecheck
```

This typechecks `functions/api/query.ts` against `@cloudflare/workers-types`.

## Security notes

- The Pages Function whitelists SQL with two regexes (`/^\s*SELECT\b/i`, `/\bnimbalyst_sync\b/i`). If Access is ever misconfigured, this prevents the dashboard from being a generic SQL proxy against the entire Cloudflare account.
- The API token is scoped to `Account Analytics: Read` only -- it cannot mutate anything.
- Access policy is single-email. To add another viewer, edit the policy in Zero Trust; do not rotate the token.
- The dashboard never displays decrypted content -- only event counts, sizes, and opaque IDs that already exist in the Analytics Engine dataset.
- `CF_API_TOKEN` is never sent to the browser. Verify by viewing the page source.

## Privacy

Same posture as the underlying dataset:

- No PII is captured -- only opaque IDs (userId, sessionId, shareId) and counts/sizes.
- Cloudflare Analytics Engine retains data ~90 days (1 year on paid plan).
- No IP addresses or device fingerprints in the queries.
