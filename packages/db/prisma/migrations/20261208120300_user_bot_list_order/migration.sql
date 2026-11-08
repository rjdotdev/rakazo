-- Additive: the previous release never reads it, and every account starts on the drag order.
-- Its own lock timeout: a run that also builds an index concurrently deploys without one.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "user" ADD COLUMN "botListOrder" TEXT NOT NULL DEFAULT 'manual';
