// Run with Electron so the explicitly selected Nimbalyst vault stays encrypted on disk.
// Usage: electron scripts/voice-previews/record-live.cjs <user-data-directory> <output-directory> [voice ...]
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const [userData, output, ...requested] = process.argv.slice(2);
const voices = requested.length ? requested : ['ash', 'echo', 'verse', 'cedar', 'coral', 'sage', 'shimmer', 'ballad', 'marin', 'alloy'];
const phrase = 'Hello! I can help you explore ideas, work through problems, and keep your projects moving.';
app.setName('@nimbalyst/electron');

async function record(apiKey, voice) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let transcript = '';
    let resolvedSession;
    let usage;
    let inputTimer;
    let recordingTimer;
    let settled = false;
    const socket = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${apiKey}` } });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(inputTimer);
      clearTimeout(recordingTimer);
      clearTimeout(deadline);
      socket.terminate();
      if (error) reject(error);
      else resolve({ pcm: Buffer.concat(chunks), transcript, session: resolvedSession, usage });
    };
    const deadline = setTimeout(() => finish(new Error(`${voice}: recording/finalization timed out`)), 25000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'session.start', session: {
      model: 'gpt-live-1', store: false,
      instructions: 'You are recording a voice sample. Follow the greeting instruction exactly, then remain silent. Do not delegate.',
      audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice } },
      delegation: { type: 'client' },
    } })));
    socket.on('message', (raw) => {
      try {
        const event = JSON.parse(raw);
        if (event.type === 'session.started') {
          resolvedSession = event.session;
          console.log(`${voice}: started ${event.session.model}`);
          socket.send(JSON.stringify({ type: 'session.instructions.append', event_id: 'preview_greeting', delegation_id: null, content: `Greet immediately in English without waiting for the caller. Say exactly: ${phrase} Then remain silent.` }));
          inputTimer = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'session.input_audio.append', audio: Buffer.alloc(4800).toString('base64') }));
          }, 100);
          // Live has no audio-done event. Capture a bounded interval with a generous
          // tail, then inspect the transcript and trim only the surrounding silence.
          recordingTimer = setTimeout(() => {
            clearInterval(inputTimer);
            socket.send(JSON.stringify({ type: 'session.close' }));
          }, 14000);
        } else if (event.type === 'session.output_audio.delta') chunks.push(Buffer.from(event.delta, 'base64'));
        else if (event.type === 'session.output_transcript.delta') transcript += event.delta;
        else if (event.type === 'session.closed') {
          usage = event.usage;
          finish();
        } else if (event.type === 'error') finish(new Error(`${voice}: ${event.error?.message || 'API rejected recording'}`));
      } catch (error) { finish(error); }
    });
    socket.on('error', finish);
    socket.on('close', () => { if (!settled) finish(new Error(`${voice}: closed without session.closed`)); });
  });
}

app.whenReady().then(async () => {
  let apiKey;
  try {
    if (!userData || !output) throw new Error('Explicit user-data and output directories are required');
    const envelope = JSON.parse(fs.readFileSync(path.join(userData, 'provider-credentials/vault.bin'), 'utf8'));
    const data = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64')));
    apiKey = data.records.find(record => record.name === 'openai' && !record.workspacePath)?.value;
    if (!apiKey) throw new Error('No explicitly configured global OpenAI credential');
    fs.mkdirSync(output, { recursive: true });
    for (const voice of voices) {
      if (!/^[a-z]+$/.test(voice)) throw new Error('Invalid voice name');
      const target = path.join(output, `${voice}.mp3`);
      if (fs.existsSync(target)) throw new Error(`${target} already exists; select a fresh output directory`);
      const result = await record(apiKey, voice);
      const normalize = value => value.toLowerCase().replace(/[^a-z]/g, '');
      if (normalize(result.transcript) !== normalize(phrase)) throw new Error(`${voice}: unexpected transcript: ${result.transcript}`);
      if (result.session.model !== 'gpt-live-1' || result.session.audio?.output?.voice !== voice) throw new Error(`${voice}: resolved model/voice mismatch`);
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0', '-af', 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.15,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.25,areverse', '-codec:a', 'libmp3lame', '-b:a', '96k', target], { input: result.pcm });
      fs.writeFileSync(path.join(output, `${voice}.json`), JSON.stringify({ model: result.session.model, voice, recordedAt: new Date().toISOString(), transcript: result.transcript, usage: result.usage }, null, 2) + '\n');
      console.log(`${voice}: saved; transcript verified`);
    }
    app.exit(0);
  } catch (error) {
    console.error(apiKey ? String(error.message).replaceAll(apiKey, '[redacted]') : 'Recording setup failed: ' + error.message);
    app.exit(1);
  }
});
