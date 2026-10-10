/**
 * A ULID (FORMAT.md: page ids are 26 Crockford base32 characters, time first),
 * made in the browser so a new page can be routed to before the server answers.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulidLike(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  let rest = '';
  for (let i = 0; i < 16; i += 1) rest += CROCKFORD[random[i] % 32];
  return time + rest;
}
