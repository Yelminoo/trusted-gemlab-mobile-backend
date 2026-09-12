-- Column for the account-creation email-verification flow (OTP purpose
-- 'email_verification'). Null until the customer confirms the code emailed
-- to them at registration.
ALTER TABLE "customers" ADD COLUMN     "email_verified_at" TIMESTAMP(3);
