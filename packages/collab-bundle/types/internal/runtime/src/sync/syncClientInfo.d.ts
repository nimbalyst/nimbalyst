/**
 * Client build identity for sync WebSocket telemetry.
 *
 * The collabv3 sync server records connect/disconnect telemetry and attributes
 * each connection to a client build via two non-sensitive labels read from the
 * WebSocket upgrade URL's query string: `platform` and `version`. These let us
 * see which build is responsible for reconnect-flapping in the per-client
 * metrics breakdown.
 *
 * This is purely additive and backward-compatible. The auth `token` param is
 * untouched; these are extra labels only.
 *
 * The values are set once at sync init (see SyncManager on desktop) and read by
 * every sync provider through `appendSyncClientParams`, the single chokepoint
 * that all `/sync/{roomId}` socket URLs flow through.
 */
export interface SyncClientInfo {
    /** Coarse client kind: 'desktop' (Electron), 'mobile', 'web', or 'unknown'. */
    platform: string;
    /** App version string, e.g. the package.json/build version like '1.4.2'. */
    version: string;
}
/**
 * Set the client build identity used to label all sync WebSocket connections.
 * Call once during sync init. Safe to call again if values change.
 */
export declare function setSyncClientInfo(info: SyncClientInfo): void;
/** Read the current client build identity. */
export declare function getSyncClientInfo(): SyncClientInfo;
/**
 * Append the non-sensitive `platform` and `version` telemetry params to a sync
 * socket URL that already carries its `?token=...` query. Values are clamped to
 * 32 chars (matching the server) and URL-encoded.
 *
 * Example: `wss://.../sync/<room>?token=<jwt>` ->
 *          `wss://.../sync/<room>?token=<jwt>&platform=desktop&version=1.4.2`
 */
export declare function appendSyncClientParams(urlWithToken: string): string;
