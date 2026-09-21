/** Unlock audio in the initial click, then signal readiness after startup completes. */
export function prepareVoiceReadyChime(): { play: () => Promise<boolean>; dispose: () => void } {
  let context: AudioContext | null = null;
  let used = false;
  const dispose = (): void => {
    const current = context;
    context = null;
    if (current) void current.close().catch(() => {});
  };
  try {
    context = new AudioContext();
    // The click's user activation may be gone by the time the network connects.
    const unlocked = context.resume().then(() => true, () => false);
    return {
      dispose,
      play: async () => {
        if (used || !context) return false;
        used = true;
        // A blocked resume must not leave the startup diagnostic unfinished
        // or retain an audio context indefinitely. It never blocks listening.
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const canPlay = await Promise.race([
          unlocked,
          new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 1000); }),
        ]);
        clearTimeout(timeout);
        if (!canPlay || !context || context.state !== 'running') {
          dispose();
          return false;
        }
        try {
          const ctx = context;
          const now = ctx.currentTime;
          for (const [index, frequency] of [880, 1319].entries()) {
            const oscillator = ctx.createOscillator();
            const gain = ctx.createGain();
            const start = now + index * 0.1;
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(frequency, start);
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.08, start + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
            oscillator.connect(gain);
            gain.connect(ctx.destination);
            if (index === 1) oscillator.onended = dispose;
            oscillator.start(start);
            oscillator.stop(start + 0.18);
          }
          return true;
        } catch {
          dispose();
          return false;
        }
      },
    };
  } catch {
    dispose();
    return { play: async () => false, dispose };
  }
}
