// Host-owned observation only. Failure never blocks or rewrites an agent tool.
const http = require('node:http');
let input = '',
  tooLarge = false;
process.stdin.on('data', (chunk) => {
  if (input.length + chunk.length > 2 * 1024 * 1024) {
    tooLarge = true;
    input = '';
  } else if (!tooLarge) input += chunk;
});
process.stdin.on('end', () => {
  try {
    if (tooLarge) return;
    const p = JSON.parse(input),
      url = process.env.NIMBALYST_SHELL_HOOK_URL;
    if (!url) return;
    const req = http.request(url, { method: 'POST', timeout: 2000 }, (res) => {
      res.resume();
      res.on('end', () => process.stdout.write('{}'));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.end(JSON.stringify({ event: p.hook_event_name, id: p.tool_use_id, tool: p.tool_name }));
  } catch {
    /* Missing/invalid observation is not permission to block a command. */
  }
});
