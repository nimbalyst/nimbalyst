# MCP OAuth

Remote MCP servers reach an agent CLI in one of three ways:

- **CLI-owned OAuth.** An `http`/`sse` config with `oauth.clientId` or `oauth.clientSecret` is handed to CLIs that run that OAuth themselves (Claude Code). Nimbalyst does not intercept its callbacks or tokens.
- **Nimbalyst-owned OAuth through the gateway.** Every other remote server that needs OAuth, and every remote server for a CLI that cannot run the server's own OAuth (Codex, Codex ACP, Copilot) or cannot speak HTTP, is authorized by Nimbalyst's main process and reached through a loopback gateway. Code: `packages/electron/src/main/services/mcpOAuth/`.
- **The legacy `mcp-remote` helper**, only for a stored `npx mcp-remote ...` command that the gateway cannot reproduce exactly (see [Stored mcp-remote commands](#stored-mcp-remote-commands)).

The routing rule lives in `mcpRemoteRequirement.ts` (`requiresMcpRemote`; the name predates the gateway).

## What a CLI receives

A bridged server is never given to a CLI with its remote URL or credential. `MCPConfigService.convertForRemoteBridge` produces either:

- `{ type: "http", url: "http://127.0.0.1:<port>/mcp-remote/<key>", headers: { Authorization: "Bearer <route token>" } }` for CLIs that speak Streamable HTTP, or
- `{ type: "stdio", command: <Electron binary>, args: [<mcp-gateway-stdio.mjs>, <that url>], env: { ELECTRON_RUN_AS_NODE: "1", NIMBALYST_MCP_GATEWAY_TOKEN: <route token> } }` for CLIs that only launch processes. The shim (`packages/electron/resources/mcp-gateway-stdio.mjs`) uses only Node built-ins and runs on Electron's bundled Node, so no system Node or package download is involved.

The route token (`gatewayRouteToken` in `gatewayRoute.ts`) is an HMAC of the per-launch token and the route key. It opens only that one route: not other routes, and not the first-party `/mcp` servers the launch token opens. It stops working when Nimbalyst restarts. This matters where an entry is persisted, such as Cursor's `~/.cursor/mcp.json`. The remote access token, refresh token, client secret and static headers stay in the main process.

Static credentials: a server whose config carries its own `Authorization` header and declares no OAuth gets a route keyed by that header's hash, so two configs for one server with different keys never share a route, and such a route never uses a stored OAuth sign-in. A CLI that speaks HTTP natively receives such a server directly, with the header, as before; the gateway is for credentials Nimbalyst holds. If the gateway is not running, a server that would be bridged is passed to the CLI as configured (a stored `npx mcp-remote` entry runs the helper).

## Gateway

`/mcp-remote/<key>` on the internal MCP server, where `<key>` is the credential binding key. For each request it:

1. Checks the launch bearer (401 otherwise).
2. Gets an access token from `McpOAuthManager.getAccessToken`, refreshing it single-flight per server when it is within 60 seconds of expiry, against the token endpoint pinned at authorization time. Background refresh never rediscovers and never opens a browser.
3. Forwards to the server with the configured static headers plus `Authorization: Bearer <access token>`. Redirects are followed only to the same origin, only for GET/307/308, and never across a scheme change.
4. On a 401, refreshes once and retries; a second 401 marks the binding as needing sign-in.
5. When a credential is missing or needs sign-in, answers **503 with a JSON-RPC error**, never 401 with `WWW-Authenticate`, which would start the CLI's own OAuth against the loopback URL and cache the failure. A missing record first triggers the one-time import below.
6. Streams every upstream body back through a line-based filter that replaces the current access token, any token sent on this route since start, and static header values with `[redacted]`. Messages relayed from a legacy SSE server are filtered the same way.

Upstream transport: Streamable HTTP is forwarded as is. Legacy SSE servers are adapted (SDK `StreamableHTTPServerTransport` on the CLI side, `SSEClientTransport` upstream, whose `endpoint` event must be same-origin). `http-first` (the default) tries SSE when an `initialize` POST gets 404/405, and the route stays on SSE only once an SSE session has started. `sse-first` falls back to Streamable HTTP once if the SSE stream cannot be opened. An SSE adapter session belongs to the route that created it, and the route's credential is checked again on every request to it, so a revoke or a missing sign-in ends the session.

Every OAuth HTTP request (discovery, registration, token, revocation) has a 30-second deadline, so a hung provider cannot hold a sign-in open or block refresh.

## Authorization

`McpOAuthManager.authorize`, started by **Authorize** in MCP settings (`mcp-config:trigger-oauth`):

1. **Discovery** (`discovery.ts`): an unauthenticated `initialize` probe reads a `resource_metadata` URL from the server's 401 challenge (used only when it is on the server's own origin), then protected-resource metadata, then authorization-server metadata. If any discovery request fails to complete, including a body that breaks mid-read, discovery fails rather than falling back to default endpoints. A server on a public address may not send discovery or any OAuth endpoint to a loopback, private or link-local address (`insecure_endpoint`); a server the user configured on such an address may. The metadata `issuer` must equal the authorization server URL, a PRM `resource` must cover the server URL, and an `https` server may not point at `http` endpoints (`urlPolicy.ts`). A plain `http://` server the user configured is allowed. A configured `oauth.resource` is sent verbatim. The discovered endpoints are pinned in the binding.
2. **Client**: a pre-registered client (`oauth.clientId`/`staticClientInfo`), a stored registration reused exactly, or RFC 7591 dynamic registration as client name `Nimbalyst`, `token_endpoint_auth_method: none`.
3. **Redirect URI** (`redirectUri.ts`): `oauth.redirectUri` for a pre-registered client; otherwise a stored registration's URI exactly, including a custom host; otherwise `http://localhost:<port>/oauth/callback` (`127.0.0.1` on Windows, as mcp-remote does) with `oauth.callbackPort` or the port mcp-remote derives from the server hash, so imported registrations keep matching. Changing it re-registers explicitly.
4. **Callback** (`callbackServer.ts`): a one-shot loopback listener on that URI. It accepts GET on the exact path only, compares `state` in constant time, requires `iss` when the server advertises it, and accepts one callback.
5. **Exchange**: PKCE S256, then tokens are stored with a new generation. Starting a second sign-in for the same server cancels the first; a cancelled flow whose exchange was already in flight does not save, and its tokens are revoked. That check runs inside the store's serialized write, so a newer sign-in that starts just before the older one's write still wins. A provider that rejects a stored dynamic client at exchange marks it, so the next sign-in registers a new one.

Errors map to the bounded categories below; a provider that rejects dynamic registration yields `dynamic_registration_unsupported`, whose remedy is a client ID (the panel's **Add a Client ID** button).

## Credential store

`credentialStore.ts`, under `<userData>/mcp-oauth/`, one record per binding key (a hash of the normalized server URL, resource, non-auth headers and static client ID):

- `<key>.enc`, encrypted with Electron `safeStorage`; `<key>.json` with mode 0600 only when `safeStorage` has no backend (Linux without a keyring). An unreadable `.enc` is never overwritten with plaintext.
- Writes are atomic with a `.bak`, serialized per key, and compare-and-set on `generation`, so a refresh that finishes after a revoke or a new sign-in is discarded. A refresh rotates tokens without a new generation, so marking a server for sign-in also requires the stored access token to still be the one that failed, and saving a refresh requires the refresh token it used to still be stored.
- A record that cannot be decrypted is never overwritten: a new sign-in moves it to `<key>.unreadable-<ms>.enc` first. An unreadable result is not cached, so a keyring that unlocks later is picked up. When the keyring is unavailable and an encrypted record exists, Authorize fails with `credential_storage_unavailable` before opening the browser.
- If a disk write fails after a refresh, the rotated tokens are kept in memory for the rest of the run.

At rest the records are as private as the platform makes a same-user file; on Windows and Linux another process running as the same user can decrypt them.

## Import from `~/.mcp-auth`

The first status check, or the first gateway request, for a server with no binding looks for mcp-remote tokens (`legacyImport.ts`) under `~/.mcp-auth` (or `MCP_REMOTE_CONFIG_DIR`), matching mcp-remote's own hashes. The files are read, never modified or deleted. The import is trust-on-first-use: every issuer the legacy files record must match the authorization server found now, which must pass the same discovery checks, and after import the endpoints are pinned. A failed attempt (offline, provider down) is retried at the next check. An imported record with a refresh token is refreshed once right away, whatever expiry the legacy file records; if the provider rejects it, the server shows as needing sign-in instead of signed in, and an imported dynamic client is not reused. A revoked binding's tombstone records the imported tokens' fingerprints so the same tokens are not imported again.

After import, Nimbalyst and any other app using the same `~/.mcp-auth` entry hold copies of one refresh token. With a provider that rotates refresh tokens, whichever refreshes first invalidates the other's copy, and a provider with reuse detection may revoke both.

## Revoke

`McpOAuthManager.revoke`: the tombstone is written at a higher generation first, so the gateway stops using the credential immediately; the record moves to `<key>.revoked-<ms>` (deleted after 7 days); then RFC 7009 revocation is sent to the pinned endpoint when advertised. A refresh that lands after the revoke is discarded and its new tokens are revoked too.

## Stored mcp-remote commands

Built-in templates save `type: "http"` entries. Older ones, and hand-written entries, may be stored as `npx -y mcp-remote <url> ...`. `isBridgeableMcpRemoteCommand` (in `MCPRemoteOAuth.ts`) sends such an entry through the gateway when it is `npx [-y|--yes] mcp-remote[@version] <url> [port]` followed only by `--header`, `--host`, `--transport`, `--resource`, `--auth-timeout`, inline-JSON `--static-oauth-client-info`/`--static-oauth-client-metadata`, `--allow-http`, `--debug` or `--silent`, and every `${VAR}` resolves (see [Variables](#variables)). The saved config is not rewritten.

Any other entry keeps running mcp-remote through `npx`, with the old Authorize, status and revoke behavior against `~/.mcp-auth` (descriptor `source: 'user-command'`).

## Variables

`${VAR}` and `${VAR:-default}` in a remote server's URL and header values:

- **Through the gateway** (Nimbalyst sends the request): resolve from the server's `env` block, then from the user's login-shell environment (`getShellEnvironment`, the same environment the CLIs are given), which is what mcp-remote inherited. Defaults apply. The bridge reads the raw config and does this resolution itself.
- **Given to a CLI directly** (`expandRemoteServerVariables`, also used in validation): substitute only names the server's `env` block defines. Anything else, including a `:-default` for a variable the block does not define, is left for the CLI to expand from its own environment.

In both cases an `env` entry's own value may reference login-shell variables, and an explicitly empty `env` value counts as defined: it overrides the shell rather than falling through to it.

Nimbalyst's own `process.env` is not consulted in either case.

## Result contract

`triggerMcpRemoteOAuth` returns `success`, `outcome` (`authorized`, `rejected`, `timed_out`, `failed`), `errorType` when unsuccessful, and `error`, a user-safe message with no provider response body, authorization URL, code, token, state value or path. `canRetryAfterCacheClear` is only set on the legacy helper path.

Error categories (`mcpOAuth/types.ts`; the renderer allowlist in `mcpOAuthAnalytics.ts` adds `ipc_error`):

`invalid_config`, `timeout`, `browser_launch`, `stale_pending_auth`, `port_conflict`, `command_unavailable`, `provider_rejected`, `dynamic_registration_unsupported`, `callback_validation`, `token_exchange`, `network`, `process_error`, `process_exit`, `issuer_mismatch`, `resource_mismatch`, `insecure_endpoint`, `authorization_server_changed`, `credential_storage_unavailable`, `cancelled`, `unknown`.

The `process_*`, `stale_pending_auth` and `command_unavailable` categories come only from the legacy helper path, where Nimbalyst can only classify what the helper prints. There, an abandoned browser flow is `timed_out`, not `provider_rejected`, and raw helper output stays in a small in-memory buffer that is never returned, logged or sent to analytics.

## Analytics

`mcp_oauth_authorize` sends only `templateId` (a known built-in template ID or `null`), `success`, `outcome`, `errorType` on failure, and `retryAfterCacheClear` when applicable. The renderer builds the payload through an allowlist; raw errors, provider text, URLs, codes, tokens, state values and paths are never included.

## Tests

- `mcpOAuth/__tests__/McpOAuthManager.test.ts`: discovery, issuer/resource/downgrade checks, refresh pinning, revoke fencing, import (negative regressions N1-N5, N7-N9, N11, N12, N14, N15, N17-N19).
- `mcpOAuth/__tests__/gateway.test.ts`: forwarding, 503 on missing credentials, single-flight refresh, redirects, redaction, SSE adapter and its session binding, the stdio shim and its initialize ordering, Test connection (N6, N10, N16).
- `services/__tests__/mcpRemoteRequirement.test.ts`: routing, generated entries carry no remote credential (N13), stored mcp-remote commands, variable resolution.
