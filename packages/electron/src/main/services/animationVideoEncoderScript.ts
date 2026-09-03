/**
 * The script injected into the encoder window's main world.
 *
 * A string rather than a module because it has to run in the page's own realm,
 * where `VideoEncoder` lives. It has no imports for the same reason: muxing
 * happens back in main, so the only thing this needs is WebCodecs itself.
 *
 * Timestamps come from the capture clock, not from a frame counter. Capture is
 * wall-clock bound and drops frames on a slow machine, so an evenly-spaced
 * assumption would stretch or compress the result; a variable frame rate with
 * real timestamps keeps the video the same length as the animation.
 */

export interface VideoEncodeConfig {
  width: number;
  height: number;
  /** Bits per second. */
  bitrate: number;
  framerate: number;
  /** An H.264 codec string, e.g. `avc1.640028` for High profile. */
  codec: string;
}

export function buildEncoderScript(config: VideoEncodeConfig): string {
  return `(() => {
  const config = ${JSON.stringify(config)};
  const bridge = window.animationVideoBridge;
  let failed = false;

  const fail = (message) => {
    if (failed) return;
    failed = true;
    bridge.fail(String(message));
  };

  try {
    if (typeof VideoEncoder !== 'function') {
      throw new Error('VideoEncoder is unavailable in the export window.');
    }
    if (typeof VideoFrame !== 'function') {
      throw new Error('VideoFrame is unavailable in the export window.');
    }

    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        bridge.chunk({
          data,
          type: chunk.type,
          timestampUs: chunk.timestamp,
          durationUs: chunk.duration ?? 0,
          // Only the first chunk carries the decoder description, and the muxer
          // needs it to write a playable file.
          description: meta && meta.decoderConfig && meta.decoderConfig.description
            ? new Uint8Array(meta.decoderConfig.description)
            : null,
        });
      },
      error: fail,
    });

    encoder.configure({
      codec: config.codec,
      width: config.width,
      height: config.height,
      bitrate: config.bitrate,
      framerate: config.framerate,
      // The stage is mostly static, so latency is irrelevant and quality is not.
      latencyMode: 'quality',
      avc: { format: 'avc' },
    });

    const finish = async () => {
      try {
        await encoder.flush();
        encoder.close();
        bridge.done();
      } catch (error) {
        fail(error);
      }
    };

    bridge.start(
      (frame) => {
        if (failed) return;
        try {
          const videoFrame = new VideoFrame(frame.data, {
            format: 'BGRA',
            codedWidth: frame.codedWidth,
            codedHeight: frame.codedHeight,
            // H.264 in 4:2:0 needs even dimensions; cropping a row or column is
            // invisible and keeps the encoder from rejecting the configuration.
            visibleRect: {
              x: 0,
              y: 0,
              width: frame.visibleWidth,
              height: frame.visibleHeight,
            },
            timestamp: frame.timestampUs,
            duration: frame.durationUs,
          });
          // A keyframe every two seconds keeps seeking usable without costing
          // much on a stage that barely changes.
          encoder.encode(videoFrame, {
            keyFrame: frame.timestampUs % 2000000 < 1000,
          });
          videoFrame.close();
        } catch (error) {
          fail(error);
        }
      },
      // flush() is what waits for the queue, so there is nothing to count here.
      () => void finish()
    );
  } catch (error) {
    fail(error);
  }
})();`;
}
