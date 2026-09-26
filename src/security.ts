// CORS: an explicit allowlist rather than reflecting any origin back
// (`origin: true`, the previous setting). The mobile app's native fetch
// calls carry no Origin header at all — this only ever restricts
// browser-based clients, i.e. exactly the web app's own domain (plus
// localhost for local dev). Override via CORS_ALLOWED_ORIGINS (comma-
// separated) if another origin ever needs to reach this API directly.
const ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ?? 'https://point.trustedgemlab.com,http://localhost:4321,http://localhost:4322'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// A plain string array is enough — @fastify/cors only ever consults this for
// requests that DO carry an Origin header (i.e. from a browser); a request
// with no Origin header at all (the mobile app's native fetch, curl,
// server-to-server calls) is never blocked by CORS either way, since CORS
// is a browser-side enforcement mechanism, not a server-side access check.
export const corsOptions = {
  origin: ALLOWED_ORIGINS,
};

// A hidden form field ("website") real users never see or fill in — any
// value in it means whatever submitted the form is a bot, not a person.
// Callers should treat a tripped honeypot as a normal-looking success
// response (never a 400/error), so a bot gets no signal it was caught and
// doesn't learn to leave the field blank next time.
export function isHoneypotTripped(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

// Cloudflare Turnstile (https://developers.cloudflare.com/turnstile/) —
// verifies a token was actually solved for this exact site key, server-side
// (a client-side-only check is trivially bypassed by calling the API
// directly). No-ops (returns true, i.e. "allow") if TURNSTILE_SECRET_KEY
// isn't configured — same fallback spirit as Resend/VAPID elsewhere in this
// codebase: don't hard-fail registration over a not-yet-configured optional
// feature in dev or before the key is set up.
export async function verifyTurnstile(token: string | undefined, remoteIp?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
    });
    const data = (await res.json()) as { success: boolean };
    return data.success === true;
  } catch (error) {
    console.error('[security] Turnstile verification request failed:', error);
    return false; // fail closed on a verification-request error (unlike "not configured")
  }
}

// Stricter rate-limit config for the handful of routes that are genuine
// abuse targets: account creation, login (both customer and staff), and
// anything that triggers an outbound email (cost + spam vector). Applied
// per-route via `{ config: { rateLimit: SENSITIVE_RATE_LIMIT } }` — see
// index.ts's global app.register(rateLimit, ...) for the default that
// covers every other route.
export const SENSITIVE_RATE_LIMIT = { max: 5, timeWindow: '1 minute' };

// ---- IP strikes + temporary bans ----
//
// Deliberately in-memory (a plain Map), not Redis/a DB table — this is a
// single always-fork-mode pm2 process (see ecosystem.config.js), so there's
// no multi-instance state-sharing problem to solve, and losing the strike
// history on a restart/redeploy is an acceptable trade-off for the
// simplicity of not standing up a separate store just for this. Every event
// is still logged (see recordSecurityEvent) to stdout, which pm2 persists
// to its own log files regardless of this Map's lifetime — that's the
// actual audit trail; the Map is just the live enforcement mechanism.
interface IpRecord {
  strikes: number;
  bannedUntil?: number;
}
const ipRecords = new Map<string, IpRecord>();

const STRIKE_THRESHOLD = 5;
const BAN_DURATION_MS = 60 * 60 * 1000; // 1 hour

// Call this at every point that represents a real abuse signal: a tripped
// honeypot, a failed login, a failed Turnstile check. Strikes accumulate
// until STRIKE_THRESHOLD, at which point the IP is banned outright for
// BAN_DURATION_MS and the counter resets — a fresh run of strikes after a
// ban expires starts from zero rather than banning again on the very next
// strike.
export function strikeIp(ip: string): void {
  const record = ipRecords.get(ip) ?? { strikes: 0 };
  record.strikes += 1;
  if (record.strikes >= STRIKE_THRESHOLD) {
    record.bannedUntil = Date.now() + BAN_DURATION_MS;
    record.strikes = 0;
    console.warn(`[security] banning IP ${ip} for ${BAN_DURATION_MS / 60_000} minutes after repeated strikes`);
  }
  ipRecords.set(ip, record);
}

export function isIpBanned(ip: string): boolean {
  const record = ipRecords.get(ip);
  if (!record?.bannedUntil) return false;
  if (record.bannedUntil < Date.now()) {
    ipRecords.delete(ip); // ban expired — clean up rather than check-and-ignore forever
    return false;
  }
  return true;
}

// One consistent, greppable log line shape for every security-relevant
// event (honeypot trips, invalid logins, failed Turnstile checks, banned-IP
// hits) — `pm2 logs mobile-backend | grep '\[security\]'` (or feed pm2's
// log files to any log shipper) is the monitoring story for now; there's no
// dashboard/alerting layer here yet, just a structured, filterable trail.
export function recordSecurityEvent(kind: string, ip: string, extra?: Record<string, unknown>): void {
  console.warn(`[security] ${kind}`, { ip, ...extra });
}
