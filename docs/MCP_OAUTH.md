# MCP OAuth

Nimbalyst supports two remote MCP OAuth paths:

- Native OAuth configs (`oauth.clientId` or `oauth.clientSecret`) are authorized by the selected AI provider. The MCP settings panel does not intercept their callbacks or tokens.
- Other HTTP/SSE OAuth configs use `mcp-remote` as a local stdio bridge. The settings panel can start this authorization flow and inspect `mcp-remote`'s token cache after it completes.

## `mcp-remote` authorization flow

1. The renderer sends the selected server configuration to `mcp-config:trigger-oauth`.
2. `MCPRemoteOAuth` starts `mcp-remote` with the configured remote URL, callback port/host, resource, transport, timeout, headers, and static client metadata.
3. `mcp-remote` performs protected-resource and authorization-server discovery, opens the system browser, owns the loopback callback server, and performs the authorization-code exchange.
4. The MCP SDK and `mcp-remote` own state generation, PKCE verifier/challenge handling, redirect URI registration, and token persistence.
5. Nimbalyst treats a usable token-cache entry as the authoritative success signal, stops the temporary helper, and reports a bounded result to the renderer.

Nimbalyst must not weaken or bypass state/PKCE validation, accept a broader redirect target, read authorization codes from the browser, or copy OAuth tokens into application analytics or settings.

## Result contract

`triggerMcpRemoteOAuth` returns:

- `success`: compatibility boolean.
- `outcome`: `authorized`, `rejected`, `timed_out`, or `failed`.
- `errorType`: a bounded category when unsuccessful.
- `error`: a user-safe message that contains no provider response body, authorization URL, code, token, state value, or filesystem path.
- `canRetryAfterCacheClear`: present when a callback-port conflict or stale pending authorization makes cache cleanup relevant.

The bounded error categories are:

- `invalid_config`
- `timeout`
- `browser_launch`
- `stale_pending_auth`
- `port_conflict`
- `command_unavailable`
- `provider_rejected`
- `dynamic_registration_unsupported`
- `callback_validation`
- `token_exchange`
- `network`
- `process_error`
- `process_exit`
- `ipc_error`
- `unknown`

The configured `oauth.authTimeoutSeconds` value is passed to `mcp-remote`, and Nimbalyst's outer wait is never shorter than that configured timeout plus a small completion grace period.

## Observability limits

Nimbalyst only classifies evidence emitted by the helper process or confirmed by the token cache.

- A provider denial is `provider_rejected` only when the helper exposes an explicit denial signal.
- `mcp-remote` always attempts RFC 7591 dynamic client registration. A provider that only accepts pre-registered clients fails the helper before a browser opens; that is `dynamic_registration_unsupported`, and the remedy is a pre-registered client ID in `oauth.staticClientInfo`, not a cache clear.
- A callback without an authorization code, an invalid state, and a PKCE/token-exchange failure are separate categories only when the helper reports them.
- If the browser flow is abandoned without a terminal helper signal, the honest outcome is `timed_out`, not `provider_rejected`.
- Duplicate callbacks and provider callback query parameters are not visible to Nimbalyst and must not be inferred from a generic process exit.

Raw helper output is retained only in a small in-memory diagnostic buffer for local classification. It is not returned through IPC, logged by Nimbalyst, or included in PostHog events.

## Analytics

`mcp_oauth_authorize` sends only:

- `templateId` (known built-in template ID or `null`)
- `success`
- `outcome`
- `errorType` on failure
- `retryAfterCacheClear` when applicable

The renderer builds this payload through an allowlist. Raw errors, provider text, URLs, codes, tokens, state values, and paths are never spread into the event.
