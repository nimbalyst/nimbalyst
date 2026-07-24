/**
 * ID Generation system using ULID with type prefixes
 */

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier)
 * Format: 26 characters, Base32 encoded
 * Structure: 10 chars timestamp + 16 chars random
 */
function generateULID(): string {
  // Timestamp part (10 characters)
  const now = Date.now();
  const timestamp = encodeTime(now, 10);

  // Random part (16 characters)
  const randomness = encodeRandom(16);

  return timestamp + randomness;
}

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford's Base32

function encodeTime(time: number, length: number): string {
  let str = '';
  for (let i = length - 1; i >= 0; i--) {
    const mod = time % 32;
    str = ENCODING[mod] + str;
    time = Math.floor(time / 32);
  }
  return str;
}

function encodeRandom(length: number): string {
  let str = '';
  for (let i = 0; i < length; i++) {
    const rand = Math.floor(Math.random() * 32);
    str += ENCODING[rand];
  }
  return str;
}

/**
 * Generate a type prefix by removing vowels and limiting to 4 characters
 * Examples:
 *   plan -> pln
 *   decision -> dcsn
 *   bug -> bug
 *   task -> tsk
 */
export function generatePrefix(type: string): string {
  const vowels = 'aeiouAEIOU';
  let prefix = type[0]; // Always keep first character

  for (let i = 1; i < type.length && prefix.length < 4; i++) {
    const char = type[i];
    // Skip vowels and hyphens
    if (!vowels.includes(char) && char !== '-' && char !== '_') {
      prefix += char;
    }
  }

  return prefix.toLowerCase();
}

/**
 * Generate a tracker item ID with type prefix
 * Format: {prefix}_{ulid}
 * Example: pln_01HQXYZ7890ABCDEF12345
 */
export function generateTrackerId(type: string): string {
  const prefix = generatePrefix(type);
  const ulid = generateULID();
  return `${prefix}_${ulid}`;
}

/**
 * Parse a tracker ID to extract type prefix and ULID
 */
export function parseTrackerId(id: string): { prefix: string; ulid: string } | null {
  const parts = id.split('_');
  if (parts.length !== 2) {
    return null;
  }

  return {
    prefix: parts[0],
    ulid: parts[1],
  };
}

/**
 * Validate a tracker ID format
 */
export function validateTrackerId(id: string): boolean {
  const parsed = parseTrackerId(id);
  if (!parsed) return false;

  // Check prefix length (1-4 chars)
  if (parsed.prefix.length < 1 || parsed.prefix.length > 4) {
    return false;
  }

  // Check ULID length (26 chars)
  if (parsed.ulid.length !== 26) {
    return false;
  }

  // Check ULID characters (Base32)
  const validChars = /^[0-9A-Z]+$/;
  if (!validChars.test(parsed.ulid)) {
    return false;
  }

  return true;
}
