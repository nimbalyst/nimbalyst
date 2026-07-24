/**
 * Audio capture utility for Voice Mode
 *
 * Captures audio from microphone at 24kHz sample rate and converts to PCM16 format
 * required by OpenAI Realtime API.
 */

export class AudioCapture {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private isCapturing: boolean = false;
  private onAudioData: ((pcm16Base64: string) => void) | null = null;

  /**
   * Start capturing audio from microphone
   */
  async start(onAudioData: (pcm16Base64: string) => void): Promise<void> {
    if (this.isCapturing) {
      throw new Error('Audio capture already started');
    }

    this.onAudioData = onAudioData;

    try {
      // Request microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1, // Mono
          sampleRate: 24000, // 24kHz required by OpenAI
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Create audio context with 24kHz sample rate
      this.audioContext = new AudioContext({ sampleRate: 24000 });

      // Create source node from microphone stream
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      // Create script processor for audio processing
      // Buffer size of 4096 samples = ~170ms at 24kHz
      const bufferSize = 4096;
      this.processorNode = this.audioContext.createScriptProcessor(
        bufferSize,
        1, // mono input
        1  // mono output
      );

      // Process audio data
      this.processorNode.onaudioprocess = (event) => {
        if (!this.isCapturing) return;

        const inputBuffer = event.inputBuffer;
        const inputData = inputBuffer.getChannelData(0); // Float32Array

        // Convert Float32 (-1 to 1) to PCM16 (-32768 to 32767)
        const pcm16 = this.floatToPCM16(inputData);

        // Convert to base64
        const base64 = this.arrayBufferToBase64(pcm16.buffer as ArrayBuffer);

        // Send to callback
        if (this.onAudioData) {
          this.onAudioData(base64);
        }
      };

      // Connect nodes
      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.audioContext.destination);

      this.isCapturing = true;

      console.log('[AudioCapture] Started capturing at 24kHz');
    } catch (error) {
      console.error('[AudioCapture] Failed to start:', error);
      this.cleanup();
      throw normalizeAudioCaptureError(error);
    }
  }

  /**
   * Stop capturing audio
   */
  stop(): void {
    if (!this.isCapturing) {
      return;
    }

    this.isCapturing = false;
    this.cleanup();
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.onAudioData = null;
  }

  /**
   * Convert Float32Array to Int16Array (PCM16)
   */
  private floatToPCM16(float32Array: Float32Array): Int16Array {
    const pcm16 = new Int16Array(float32Array.length);

    for (let i = 0; i < float32Array.length; i++) {
      // Clamp to -1, 1 range
      let sample = Math.max(-1, Math.min(1, float32Array[i]));

      // Convert to 16-bit integer
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      pcm16[i] = sample;
    }

    return pcm16;
  }

  /**
   * Convert ArrayBuffer to base64 string
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';

    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }

    return btoa(binary);
  }

  /**
   * Check if currently capturing
   */
  isCaptureActive(): boolean {
    return this.isCapturing;
  }
}

export function normalizeAudioCaptureError(error: unknown): Error {
  if (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'NotFoundError'
  ) {
    return new Error(
      'No usable microphone was found. Connect or enable a microphone, check your system microphone settings, and try again.',
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}
