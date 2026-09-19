-- AlterTable
ALTER TABLE "customers"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "data_consent_at" TIMESTAMP(3);
