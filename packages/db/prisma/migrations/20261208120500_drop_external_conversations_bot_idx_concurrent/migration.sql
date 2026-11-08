-- Sole statement: the (spaceId, botId, updatedAt) index serves every query this one did.
DROP INDEX CONCURRENTLY IF EXISTS "external_conversations_spaceId_botId_idx";
