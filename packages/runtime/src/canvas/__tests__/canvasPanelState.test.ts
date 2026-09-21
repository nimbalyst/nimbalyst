// @vitest-environment node
/**
 * Chrome preferences are read back from host storage that may predate any given
 * field. The merge is the whole risk: a missing `minimap` that comes back
 * `undefined` reaches React Flow as "render the minimap? maybe", and a board
 * stored before smart guides existed must not silently turn them off.
 */
import { describe, expect, it } from 'vitest';

import {
  CANVAS_PANEL_DEFAULTS,
  canvasPanelStateFrom,
  canvasPanelStateKey,
} from '../canvasPanelState';

describe('canvasPanelStateFrom', () => {
  it('defaults everything on when the host has stored nothing', () => {
    expect(canvasPanelStateFrom(undefined)).toEqual({
      minimap: true,
      gridSnap: true,
      smartGuides: true,
      tool: 'select',
    });
    expect(canvasPanelStateFrom(null)).toEqual({ ...CANVAS_PANEL_DEFAULTS });
  });

  it('fills in fields a older build never wrote', () => {
    expect(canvasPanelStateFrom({ minimap: false })).toEqual({
      minimap: false,
      gridSnap: true,
      smartGuides: true,
      tool: 'select',
    });
  });

  it('rejects values of the wrong type rather than passing them through', () => {
    expect(
      canvasPanelStateFrom({
        minimap: 'yes',
        gridSnap: 0,
        smartGuides: null,
        tool: 'lasso',
      })
    ).toEqual({ ...CANVAS_PANEL_DEFAULTS });
    expect(canvasPanelStateFrom('minimap=false')).toEqual({
      ...CANVAS_PANEL_DEFAULTS,
    });
  });

  it('keeps a stored hand tool', () => {
    expect(canvasPanelStateFrom({ tool: 'hand' }).tool).toBe('hand');
  });

  it('keys storage per board', () => {
    expect(canvasPanelStateKey('docs/plan.canvas')).toBe(
      'canvas.panel:docs/plan.canvas'
    );
  });
});
