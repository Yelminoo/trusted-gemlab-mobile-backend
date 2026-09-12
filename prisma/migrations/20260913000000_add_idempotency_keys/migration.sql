-- Prevents duplicate application of admin actions (issue/deduct points,
-- review certificate requests) from double-taps or client retries.
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "route_key" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);
