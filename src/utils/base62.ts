//62 character alphabet encoding for encoding
//10 digits+26lowercase+26uppercase = 62 total

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE = BigInt(62);

/**
 * Converts a database auto-increment ID to a short alphanumeric code.
 *
 * How it works (same as converting decimal to binary, but base 62):
 *   decimal 125 → binary: 125 % 2 = 1, 62 % 2 = 0, 31 % 2 = 1, ...
 *   decimal 125 → base62: 125 % 62 = 1 (char '1'), 2 % 62 = 2 (char '2') → "21"
 *
 * We use BigInt because PostgreSQL BIGSERIAL can produce numbers larger
 * than JavaScript's safe integer limit (Number.MAX_SAFE_INTEGER = 2^53 - 1).
 * PostgreSQL BIGSERIAL goes up to 2^63 - 1. BigInt handles this safely.
 */
export function toBase62(id: number): string {
  let num = BigInt(id);

  if (num === 0n) {
    return '000000';
  }

  const chars: string[] = [];

  while (num > 0n) {
    const remainder = num % BASE;         // which character at this position?
    chars.unshift(ALPHABET[Number(remainder)]!); // prepend (we're building right-to-left)
    num = num / BASE;                     // integer division, move to next position
  }

  // Pad to minimum 6 characters with leading '0'
  // ID 1 → '1' → padded to '000001'
  // ID 56800235584 → '99999' (just 5 chars) → padded to '099999'
  return chars.join('').padStart(6, '0');
}

/**
 * Validates that a string is a legitimate short code format.
 * Used to reject obviously invalid codes before hitting the DB.
 */
export function isValidCode(code: string): boolean {
  return /^[0-9a-zA-Z]{4,12}$/.test(code);
}
