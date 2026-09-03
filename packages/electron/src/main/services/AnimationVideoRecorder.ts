/**
 * Recording a self-playing HTML animation to an H.264 MP4.
 *
 * This is the format to reach for. Social platforms transcode an uploaded GIF
 * to H.264 anyway, so a GIF pays a 256-colour quantization and then gets
 * re-encoded from the quantized result; sending MP4 skips the lossy middle step
 * and lands roughly an order of magnitude smaller.
 *
 * The split of work: capture stays in main because `capturePage` is an Electron
 * API, encoding happens in a hidden window because `VideoEncoder` is a DOM one,
 * and muxing happens back in main because it is byte assembly with no pixels in
 * it. Frames stream to the encoder as they are captured -- holding 240 frames of
 * a 1440px capture would be a gigabyte.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { captureAnimationFrames } from './AnimationCapture';
import {
  ANIMATION_EXPORT_LIMITS,
  clampExportOptions,
  toEvenDimensions,
} from './animationExportOptions';
import { buildEncoderScript } from './animationVideoEncoderScript';
import {
  getAnimationVideoPagePath,
  getAnimationVideoPreloadPath,
} from '../utils/appPaths';
import { logger } from '../utils/logger';

export interface AnimationVideoRequest {
  /** Self-contained HTML built with `captureHooks: true`. */
  html: string;
  outputPath: string;
  /** Stage dimensions; the capture window is sized from these. */
  width: number;
  height: number;
  /** How long one pass of the animation takes, in milliseconds. */
  durationMs: number;
  /** Target frames per second. Clamped. */
  fps?: number;
  /** Width of the output. Clamped. */
  maxWidth?: number;
}

export interface AnimationVideoResult {
  outputPath: string;
  frames: number;
  width: number;
  height: number;
  bytes: number;
  effectiveFps: number;
}

/**
 * High profile. Baseline is not supported by this Chromium at export sizes, and
 * High is what every target platform decodes.
 */
const H264_CODEC = 'avc1.640028';

/**
 * Bits per pixel per second. A flat vector stage compresses far better than
 * camera footage, but text is exactly what low bitrates destroy, so this is
 * deliberately generous -- the files still land near a megabyte.
 */
const BITS_PER_PIXEL_SECOND = 0.12;

const MIN_BITRATE = 1_000_000;
const MAX_BITRATE = 20_000_000;

interface EncodedChunkPayload {
  data: Uint8Array;
  type: 'key' | 'delta';
  timestampUs: number;
  durationUs: number;
  description: Uint8Array | null;
}

export function chooseBitrate(
  width: number,
  height: number,
  fps: number
): number {
  const raw = width * height * fps * BITS_PER_PIXEL_SECOND;
  return Math.round(Math.max(MIN_BITRATE, Math.min(MAX_BITRATE, raw)));
}

/**
 * Per-frame durations in microseconds, from the capture clock.
 *
 * The last frame is held to the loop point for the same reason the GIF's is:
 * otherwise the video ends a frame early and the loop stutters.
 */
export function frameDurationsUs(
  captureTimes: number[],
  durationMs: number
): number[] {
  const originMs = captureTimes[0] ?? 0;
  const timeline = captureTimes.map((at) => Math.max(0, at - originMs));

  return timeline.map((at, index) => {
    const nextAt =
      index + 1 < timeline.length ? timeline[index + 1] : durationMs;
    return Math.max(1000, Math.round((nextAt - at) * 1000));
  });
}

export async function recordAnimationVideo(
  request: AnimationVideoRequest
): Promise<AnimationVideoResult> {
  const { fps, maxWidth } = clampExportOptions(request, 'mp4');

  // The encoder window renders nothing; it exists to host WebCodecs.
  const encoderWindow = new BrowserWindow({
    show: false,
    width: 16,
    height: 16,
    webPreferences: {
      preload: getAnimationVideoPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  const encoderId = encoderWindow.webContents.id;

  const chunks: EncodedChunkPayload[] = [];
  let description: Uint8Array | null = null;
  let settle: ((error: Error | null) => void) | null = null;

  const onChunk = (
    event: Electron.IpcMainEvent,
    payload: EncodedChunkPayload
  ) => {
    if (event.sender.id !== encoderId) return;
    if (payload.description && !description) description = payload.description;
    chunks.push(payload);
  };
  const onDone = (event: Electron.IpcMainEvent) => {
    if (event.sender.id === encoderId) settle?.(null);
  };
  const onError = (event: Electron.IpcMainEvent, message: string) => {
    if (event.sender.id === encoderId) settle?.(new Error(message));
  };

  ipcMain.on('animation-video:chunk', onChunk);
  ipcMain.on('animation-video:done', onDone);
  ipcMain.on('animation-video:error', onError);

  const encoded = new Promise<void>((resolve, reject) => {
    settle = (error) => {
      settle = null;
      if (error) reject(error);
      else resolve();
    };
  });

  try {
    await encoderWindow.loadFile(getAnimationVideoPagePath());

    // Dimensions are only known once a frame has been reduced, so the encoder
    // is configured from the first one rather than up front.
    let configured = false;
    let output = { width: 0, height: 0 };
    let captureOriginMs: number | null = null;

    const capture = await captureAnimationFrames(
      {
        html: request.html,
        width: request.width,
        height: request.height,
        durationMs: request.durationMs,
        fps,
        maxWidth,
        maxFrames: ANIMATION_EXPORT_LIMITS.maxFrames,
      },
      (frame, atMs) => {
        captureOriginMs ??= atMs;
        if (!configured) {
          configured = true;
          output = toEvenDimensions(frame.width, frame.height);
          void encoderWindow.webContents
            .executeJavaScript(
              buildEncoderScript({
                width: output.width,
                height: output.height,
                bitrate: chooseBitrate(output.width, output.height, fps),
                framerate: fps,
                codec: H264_CODEC,
              })
            )
            .catch((error: unknown) => {
              settle?.(
                error instanceof Error
                  ? error
                  : new Error(`Could not start the video encoder: ${error}`)
              );
            });
        }

        encoderWindow.webContents.send('animation-video:frame', {
          data: frame.data,
          codedWidth: frame.width,
          codedHeight: frame.height,
          visibleWidth: output.width,
          visibleHeight: output.height,
          // capturePage cannot produce a frame at the exact instant playback
          // starts. MP4 tracks require their first timestamp to be zero, so
          // rebase the capture clock to the first image we actually have.
          timestampUs: (atMs - captureOriginMs) * 1000,
          // Replaced below; the real hold is only known once the next frame
          // has been taken, and the encoder does not use this for rate control.
          durationUs: Math.round(1_000_000 / fps),
        });
      }
    );

    encoderWindow.webContents.send('animation-video:end');
    const timeout = setTimeout(() => {
      settle?.(new Error('The video encoder did not finish within 30 seconds.'));
    }, 30_000);
    try {
      await encoded;
    } finally {
      clearTimeout(timeout);
    }

    if (chunks.length === 0) {
      throw new Error('The encoder produced no video data.');
    }

    const durations = frameDurationsUs(capture.captureTimes, request.durationMs);
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: output.width, height: output.height },
      // Rewrites the index to the front so the file starts playing before it
      // has fully downloaded, which is what every web player wants.
      fastStart: 'in-memory',
    });

    chunks.forEach((chunk, index) => {
      muxer.addVideoChunkRaw(
        chunk.data,
        chunk.type,
        chunk.timestampUs,
        durations[index] ?? chunk.durationUs,
        index === 0 && description
          ? ({ decoderConfig: { codec: H264_CODEC, description } } as never)
          : undefined
      );
    });
    muxer.finalize();

    const buffer = Buffer.from(muxer.target.buffer);
    await writeFile(request.outputPath, buffer);

    const totalMs =
      capture.captureTimes[capture.captureTimes.length - 1] || request.durationMs;
    const result: AnimationVideoResult = {
      outputPath: request.outputPath,
      frames: capture.captureTimes.length,
      width: output.width,
      height: output.height,
      bytes: buffer.length,
      effectiveFps:
        Math.round(
          (capture.captureTimes.length / Math.max(1, totalMs)) * 1000 * 10
        ) / 10,
    };

    logger.file.info(
      `[AnimationVideoRecorder] Wrote ${result.frames} frames to ${request.outputPath} ` +
        `(${result.width}x${result.height} from ${capture.captureWidth}x${capture.captureHeight}, ` +
        `${result.effectiveFps} fps, ${result.bytes} bytes, ${chunks.length} chunks)`
    );
    return result;
  } finally {
    ipcMain.removeListener('animation-video:chunk', onChunk);
    ipcMain.removeListener('animation-video:done', onDone);
    ipcMain.removeListener('animation-video:error', onError);
    if (!encoderWindow.isDestroyed()) encoderWindow.destroy();
  }
}
