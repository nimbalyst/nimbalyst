// @vitest-environment node
/**
 * The MP4 export's silent failure modes.
 *
 * A video that is the right length and plays is not evidence of much: an odd
 * pixel dimension makes H.264 refuse the configuration, and a duration derived
 * from a frame counter rather than the capture clock yields a file that plays
 * perfectly at the wrong speed. Both look fine in the frame count and the byte
 * size, which is all the caller sees.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ANIMATION_EXPORT_DEFAULTS,
  ANIMATION_EXPORT_LIMITS,
  clampExportOptions,
  toEvenDimensions,
} from '../animationExportOptions';
import {
  chooseBitrate,
  frameDurationsUs,
} from '../AnimationVideoRecorder';
import { buildEncoderScript } from '../animationVideoEncoderScript';

describe('clampExportOptions', () => {
  it('defaults video to a higher frame rate than GIF', () => {
    // H.264 encodes a mostly-static stage nearly for free, so there is no
    // reason for video to inherit the frame rate a GIF's file size forces.
    expect(clampExportOptions({}, 'mp4').fps).toBe(
      ANIMATION_EXPORT_DEFAULTS.mp4.fps
    );
    expect(clampExportOptions({}, 'gif').fps).toBe(
      ANIMATION_EXPORT_DEFAULTS.gif.fps
    );
    expect(clampExportOptions({}, 'mp4').fps).toBeGreaterThan(
      clampExportOptions({}, 'gif').fps
    );
  });

  it('clamps rather than rejecting an out-of-range request', () => {
    expect(clampExportOptions({ fps: 500, maxWidth: 99999 }, 'mp4')).toEqual({
      fps: ANIMATION_EXPORT_LIMITS.maxFps,
      maxWidth: ANIMATION_EXPORT_LIMITS.maxWidth,
    });
    expect(clampExportOptions({ fps: 0, maxWidth: 1 }, 'mp4')).toEqual({
      fps: ANIMATION_EXPORT_LIMITS.minFps,
      maxWidth: ANIMATION_EXPORT_LIMITS.minWidth,
    });
  });
});

describe('toEvenDimensions', () => {
  it('rounds down to even, because 4:2:0 cannot encode an odd edge', () => {
    // A stage aspect that lands on an odd height is the common case, and the
    // encoder rejects the configuration rather than rounding for you.
    expect(toEvenDimensions(1441, 769)).toEqual({ width: 1440, height: 768 });
  });

  it('leaves even dimensions alone', () => {
    expect(toEvenDimensions(1440, 768)).toEqual({ width: 1440, height: 768 });
  });
});

describe('frameDurationsUs', () => {
  it('derives each hold from the capture clock, not the frame index', () => {
    // Capture is wall-clock bound and drops frames under load. Assuming even
    // spacing would make a stuttered recording play back too fast.
    expect(frameDurationsUs([0, 100, 600, 700], 800)).toEqual([
      100_000, 500_000, 100_000, 100_000,
    ]);
  });

  it('holds the last frame to the loop point so the loop does not stutter', () => {
    expect(frameDurationsUs([0, 100], 1000).at(-1)).toBe(900_000);
  });

  it('sums to the animation duration', () => {
    const total = frameDurationsUs([0, 100, 600, 700], 800).reduce(
      (a, b) => a + b,
      0
    );
    expect(total).toBe(800_000);
  });

  it('rebases a delayed first capture to zero without shortening the video', () => {
    // capturePage takes time, so the first frame normally arrives tens of
    // milliseconds after the animation clock starts. MP4 tracks require that
    // first frame at zero and should still span the requested duration.
    const durations = frameDurationsUs([67, 100, 600, 700], 800);
    expect(durations.reduce((a, b) => a + b, 0)).toBe(800_000);
    expect(durations.at(-1)).toBe(167_000);
  });
});

describe('chooseBitrate', () => {
  it('scales with pixels and frame rate', () => {
    expect(chooseBitrate(1440, 768, 30)).toBeGreaterThan(
      chooseBitrate(720, 384, 30)
    );
    expect(chooseBitrate(1440, 768, 30)).toBeGreaterThan(
      chooseBitrate(1440, 768, 12)
    );
  });

  it('holds a floor and a ceiling so a tiny or huge stage stays sane', () => {
    expect(chooseBitrate(160, 90, 2)).toBeGreaterThanOrEqual(1_000_000);
    expect(chooseBitrate(1920, 1080, 60)).toBeLessThanOrEqual(20_000_000);
  });
});

describe('buildEncoderScript', () => {
  it('is syntactically valid JavaScript', () => {
    // The script is a template literal, so a stray backtick or interpolation
    // in it is a runtime error inside a hidden window -- somewhere no stack
    // trace reaches the user.
    const script = buildEncoderScript({
      width: 1440,
      height: 768,
      bitrate: 4_000_000,
      framerate: 30,
      codec: 'avc1.640028',
    });
    expect(() => new Function(script)).not.toThrow();
  });

  it('carries the configuration into the page', () => {
    const script = buildEncoderScript({
      width: 1440,
      height: 768,
      bitrate: 4_000_000,
      framerate: 30,
      codec: 'avc1.640028',
    });
    expect(script).toContain('avc1.640028');
    expect(script).toContain('1440');
    // Muxing needs the AVC decoder description, which only arrives in avcc
    // format; the annexb default produces a file no player will open.
    expect(script).toContain("format: 'avc'");
  });

  it('reports unavailable WebCodecs instead of throwing before the bridge starts', () => {
    const script = buildEncoderScript({
      width: 1440,
      height: 768,
      bitrate: 4_000_000,
      framerate: 30,
      codec: 'avc1.640028',
    });
    const fail = vi.fn();

    expect(() =>
      new Function('window', 'VideoEncoder', 'VideoFrame', script)(
        {
          animationVideoBridge: {
            chunk: vi.fn(),
            done: vi.fn(),
            fail,
            start: vi.fn(),
          },
        },
        undefined,
        undefined
      )
    ).not.toThrow();
    expect(fail).toHaveBeenCalledWith(
      expect.stringContaining('VideoEncoder is unavailable')
    );
  });
});
