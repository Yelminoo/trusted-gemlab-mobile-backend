// Runtime input validation/sanitization — TypeScript's `Body: {...}`
// generics on Fastify routes are compile-time hints ONLY; they don't check
// anything at runtime. Without this, a request could send `{ email: 123 }`
// or a 500KB "name" and every `typeof`/truthiness check in index.ts would
// happily coerce/accept it. These helpers are the actual runtime guard.

// A pragmatic format check, not a fully RFC-5322-compliant one — this is
// intentionally the same "good enough" level of strictness almost every
// production app uses (perfect email regexes are famously not worth it;
// the OTP confirmation step is the real proof the address is reachable).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Normalizes to lowercase + trimmed — without this, "John@Example.com" at
// registration and "john@example.com" at login are treated as two
// different accounts by Prisma's exact-match `where: { email }` lookups.
// Returns null if the input isn't a valid-looking email at all.
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed) || trimmed.length > 254) return null; // 254 = RFC 5321's own max
  return trimmed;
}

// For passwords specifically — bcrypt silently truncates/ignores anything
// past 72 bytes and hashing itself gets meaningfully more CPU-expensive on
// very long inputs, so an unbounded password is a real (if minor) DoS
// surface as well as a footgun (a 500-char password "succeeding" but only
// its first 72 bytes actually mattering). No minimum enforced here — each
// route already checks its own minimum (registration: 8, reset: 8).
export function isValidPasswordLength(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128;
}

// Trims and caps length; returns null for anything that isn't a non-empty
// string once trimmed — works equally for "required" callers (just check
// for null) and "optional" ones (null → omit/undefined), since "not
// provided" and "provided but blank" should be treated the same either way.
export function sanitizeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}
