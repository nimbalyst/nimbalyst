/**
 * Backend-module panel API: `ctx.services.panels`.
 *
 * Lets a backend module update its own panels' gutter buttons while the panel
 * is not mounted (a fullscreen panel unmounts when the user leaves it), so an
 * event the module sees in the background (a new flag, a budget crossing)
 * reaches the gutter without the user reopening the panel.
 *
 * No permission is required: the only thing a module can change is the badge
 * on a panel its own manifest declares.
 */

export type PanelGutterBadgeTone = 'default' | 'warning';

export interface BackendPanelsService {
  /**
   * Show a badge on one of this extension's panel gutter buttons, in the
   * windows showing this module's workspace. Same values as the panel's own
   * `host.setGutterBadge`: `null` clears, `0` shows a dot, a positive number
   * shows the count. Whichever of the two writes last wins.
   *
   * `panelId` is the id from this extension's manifest `contributions.panels`
   * (not prefixed with the extension id). Rejects for any other id.
   */
  setGutterBadge(
    panelId: string,
    value: number | null,
    options?: { tone?: PanelGutterBadgeTone }
  ): Promise<void>;
}
