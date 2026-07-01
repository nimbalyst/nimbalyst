/**
 * Audio playback utility for Voice Mode
 *
 * Plays back PCM16 audio received from OpenAI Realtime API.
 *
 * Audio is routed through a MediaStreamDestination -> <audio> element
 * so the browser's echo cancellation (AEC) can correlate the output
 * with getUserMedia input and cancel echo from speakers. Without this,
 * raw AudioContext.destination playback is invisible to AEC and the
 * assistant's voice gets picked up by the mic, causing self-interruption.
 */

let instanceCounter = 0;

export class AudioPlayback {
  private audioContext: AudioContext | null = null;
  private streamDestination: MediaStreamAudioDestinationNode | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private audioQueue: AudioBuffer[] = [];
  private isPlaying: boolean = false;
  private scheduledSources: AudioBufferSourceNode[] = [];
  private nextStartTime: number = 0;
  private instanceId: number;
  private onDrainedCallback: (() => void) | null = null;
  // True while stop() is tearing down the queue. Suppresses the natural
  // onended -> onDrained chain so a user interrupt doesn't fire the
  // "playback finished" signal that the listen-window timer is waiting for.
  private suppressDrainedCallback: boolean = false;

  constructor() {
    this.instanceId = ++instanceCounter;
    // Create audio context with 24kHz sample rate to match input
    this.audioContext = new AudioContext({ sampleRate: 24000 });

    // Create a MediaStream destination so audio is visible to echo cancellation.
    // AudioBufferSourceNodes connect to this instead of audioContext.destination.
    this.streamDestination = this.audioContext.createMediaStreamDestination();

    // Create an <audio> element to play the stream. The browser's AEC
    // processes audio played through <audio> elements, allowing it to
    // subtract the output from the microphone input.
    this.audioElement = new Audio();
    this.audioElement.srcObject = this.streamDestination.stream;
    this.audioElement.autoplay = true;
  }

  /**
   * Play PCM16 audio chunk
   * @param pcm16Base64 Base64-encoded PCM16 audio data
   */
  async play(pcm16Base64: string): Promise<void> {
    if (!this.audioContext || !this.streamDestination) {
      throw new Error('Audio context not initialized');
    }

    // Resume AudioContext if it's suspended (required by browser autoplay policies)
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    try {
      // Decode base64 to ArrayBuffer
      const pcm16Buffer = this.base64ToArrayBuffer(pcm16Base64);

      // Convert PCM16 (Int16) to Float32
      const int16Array = new Int16Array(pcm16Buffer);
      const float32Array = this.pcm16ToFloat32(int16Array);

      // Create audio buffer
      const audioBuffer = this.audioContext.createBuffer(
        1, // mono
        float32Array.length,
        24000 // 24kHz sample rate
      );

      // Copy data to audio buffer
      audioBuffer.copyToChannel(new Float32Array(float32Array), 0);

      // Add to queue and play
      this.audioQueue.push(audioBuffer);
      this.playQueue();
    } catch (error) {
      console.error('[AudioPlayback] Failed to play audio:', error);
    }
  }

  /**
   * Play queued audio buffers
   */
  private playQueue(): void {
    if (this.audioQueue.length === 0 || !this.audioContext || !this.streamDestination) {
      return;
    }

    if (!this.isPlaying) {
      this.isPlaying = true;
      // Only reset nextStartTime if it's in the past (or hasn't been set)
      if (this.nextStartTime < this.audioContext.currentTime) {
        this.nextStartTime = this.audioContext.currentTime;
      }
    }

    while (this.audioQueue.length > 0) {
      const audioBuffer = this.audioQueue.shift()!;

      // Create source node
      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      // Connect to stream destination (routed through <audio> for AEC)
      // instead of audioContext.destination directly
      source.connect(this.streamDestination);

      // Never schedule a chunk in the past. Within a single turn nextStartTime
      // accumulates by buffer duration while currentTime advances in real time.
      // If chunk delivery lags realtime over a long response, the cumulative
      // scheduled duration falls behind elapsed time and nextStartTime drifts
      // *before* currentTime. Calling source.start() with a past time makes Web
      // Audio play that buffer immediately, so a backlog of tail chunks all fire
      // at once and overlap -- heard as the voice "speeding up" (chipmunk) near
      // the end of a response. Clamp to now so each chunk plays sequentially.
      if (this.nextStartTime < this.audioContext.currentTime) {
        this.nextStartTime = this.audioContext.currentTime;
      }

      // Schedule playback
      source.start(this.nextStartTime);

      // Track this scheduled source
      this.scheduledSources.push(source);

      // Update next start time
      this.nextStartTime += audioBuffer.duration;

      // Handle completion
      source.onended = () => {
        // Remove from scheduled sources
        const index = this.scheduledSources.indexOf(source);
        if (index > -1) {
          this.scheduledSources.splice(index, 1);
        }

        if (this.audioQueue.length === 0 && this.scheduledSources.length === 0) {
          this.isPlaying = false;
          if (this.onDrainedCallback && !this.suppressDrainedCallback) {
            this.onDrainedCallback();
          }
        }
      };
    }
  }

  /**
   * Stop all audio playback
   */
  stop(): void {
    // Suppress the drained callback for sources that fire onended after stop().
    // The closure read of this flag happens when onended actually fires, not when
    // stop() runs, so the flag stays true until we explicitly reset it.
    this.suppressDrainedCallback = true;

    // Stop ALL scheduled sources, not just the current one
    for (const source of this.scheduledSources) {
      try {
        source.stop();
      } catch (e) {
        // Ignore - may already be stopped
      }
    }

    this.scheduledSources = [];
    this.audioQueue = [];
    this.isPlaying = false;
    this.nextStartTime = 0;

    // Re-enable the drained callback for the next play() cycle.
    // queueMicrotask defers past any onended fired in this tick by stopped sources.
    queueMicrotask(() => {
      this.suppressDrainedCallback = false;
    });
  }

  /**
   * Register a callback that fires when the playback queue fully drains
   * (every queued buffer has finished playing in the user's speakers).
   * Used by voice mode to start the listen-window timer at *audible* end of
   * turn rather than when the server finished streaming chunks.
   */
  setOnDrained(callback: (() => void) | null): void {
    this.onDrainedCallback = callback;
  }

  /**
   * Convert base64 string to ArrayBuffer
   */
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes.buffer;
  }

  /**
   * Convert PCM16 (Int16Array) to Float32Array
   */
  private pcm16ToFloat32(int16Array: Int16Array): Float32Array {
    const float32Array = new Float32Array(int16Array.length);

    for (let i = 0; i < int16Array.length; i++) {
      // Convert from 16-bit integer to float (-1 to 1)
      const sample = int16Array[i];
      float32Array[i] = sample < 0 ? sample / 0x8000 : sample / 0x7FFF;
    }

    return float32Array;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stop();

    if (this.audioElement) {
      this.audioElement.srcObject = null;
      this.audioElement = null;
    }

    if (this.streamDestination) {
      this.streamDestination.disconnect();
      this.streamDestination = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  /**
   * Check if currently playing
   */
  isPlaybackActive(): boolean {
    return this.isPlaying;
  }
}
