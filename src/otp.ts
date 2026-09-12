import { createHash, randomInt } from 'node:crypto';
import { Resend } from 'resend';

const OTP_LENGTH = 6;
export const OTP_TTL_MINUTES = 10;
// Matches the mobile app's resend-button countdown (see
// verify-email-banner.tsx etc.) — keep these in sync so the button
// re-enabling actually corresponds to the server accepting a resend, rather
// than the UI claiming you can resend while the backend silently no-ops.
export const RESEND_COOLDOWN_SECONDS = 30;
const RESEND_COOLDOWN_MS = RESEND_COOLDOWN_SECONDS * 1000;

export function generateOtp(): string {
  return randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, '0');
}

// OTPs are short-lived, rate-limited, high-entropy-enough (1e6 combinations)
// six-digit codes — sha256 is the right tool here, not bcrypt's slow KDF
// (which is for low-entropy human passwords, not this).
export function hashOtp(otp: string): string {
  return createHash('sha256').update(otp).digest('hex');
}

export function otpExpiresAt(): Date {
  return new Date(Date.now() + OTP_TTL_MINUTES * 60_000);
}

export function withinResendCooldown(lastCreatedAt: Date): boolean {
  return Date.now() - lastCreatedAt.getTime() < RESEND_COOLDOWN_MS;
}

export type OtpPurpose = 'password_reset' | 'email_change' | 'email_verification';

const SUBJECTS: Record<OtpPurpose, string> = {
  password_reset: 'Reset your Trusted Gemlab password',
  email_change: 'Confirm your new email address',
  email_verification: 'Verify your Trusted Gemlab account',
};

const INTROS: Record<OtpPurpose, string> = {
  password_reset: "Use this code to reset your password. If you didn't request this, you can safely ignore this email.",
  email_change: 'Use this code to confirm this is your new email address.',
  email_verification: 'Welcome! Use this code to verify your email and finish creating your account.',
};

// Lazily constructed — RESEND_API_KEY may not be set in every environment
// (e.g. local dev without a real key), and we don't want a missing env var
// to crash the whole process at import time.
let resendClient: Resend | null = null;
function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  if (!resendClient) resendClient = new Resend(apiKey);
  return resendClient;
}

function renderEmailHtml(otp: string, purpose: OtpPurpose): string {
  return `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, Helvetica, Arial, sans-serif; background:#f5f5f5; padding:32px 0; margin:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:12px; padding:32px;">
          <tr><td>
            <h1 style="color:#8d1b20; font-size:20px; margin:0 0 16px;">Trusted Gemlab</h1>
            <p style="color:#333; font-size:15px; line-height:1.5; margin:0 0 24px;">${INTROS[purpose]}</p>
            <div style="background:#f0f0f3; border-radius:8px; padding:16px; text-align:center; margin:0 0 24px;">
              <span style="font-family: 'Courier New', monospace; font-size:32px; font-weight:bold; letter-spacing:8px; color:#000;">${otp}</span>
            </div>
            <p style="color:#888; font-size:13px; margin:0;">This code expires in ${OTP_TTL_MINUTES} minutes.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

// Sends the OTP by real email via Resend (https://resend.com). Requires
// RESEND_API_KEY and RESEND_FROM_EMAIL to be set (see .env.example) — if
// RESEND_API_KEY is missing, falls back to logging to the console instead of
// throwing, so local dev / a not-yet-configured deploy doesn't hard-fail.
export async function sendOtpEmail(toEmail: string, otp: string, purpose: OtpPurpose): Promise<void> {
  const resend = getResendClient();
  const from = process.env.RESEND_FROM_EMAIL;

  if (!resend || !from) {
    console.log(
      `[DEV OTP — RESEND NOT CONFIGURED] Would email ${toEmail} for ${purpose}: ${otp} (expires in ${OTP_TTL_MINUTES}m)`
    );
    return;
  }

  const { error } = await resend.emails.send({
    from,
    to: toEmail,
    subject: SUBJECTS[purpose],
    html: renderEmailHtml(otp, purpose),
  });

  if (error) {
    // Don't leak the OTP or provider error details to the caller — the
    // request-side route already returns a generic "code sent" message
    // regardless of outcome (see index.ts), this is just for server logs.
    console.error('[Resend] failed to send OTP email:', error);
    throw new Error('Failed to send email');
  }
}
