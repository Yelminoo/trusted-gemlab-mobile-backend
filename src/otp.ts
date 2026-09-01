import { createHash, randomInt } from 'node:crypto';

const OTP_LENGTH = 6;
export const OTP_TTL_MINUTES = 10;
const RESEND_COOLDOWN_MS = 60_000;

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

// Dev-only "send" — logs the OTP to the server console instead of emailing
// it. Swap this for a real provider (Resend/SES/SendGrid/etc.) before this
// goes anywhere near production; there is no email infrastructure wired up
// yet anywhere in this project.
export function sendOtpEmail(toEmail: string, otp: string, purpose: 'password_reset' | 'email_change') {
  console.log(`[DEV OTP] Would email ${toEmail} for ${purpose}: ${otp} (expires in ${OTP_TTL_MINUTES}m)`);
}
