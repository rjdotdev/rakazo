-- Sole statement so the index builds without blocking writes. It also serves a bot's most
-- recently active conversations, which the roster reads for each chat's newest message.
CREATE INDEX CONCURRENTLY "external_conversations_spaceId_botId_updatedAt_idx" ON "external_conversations"("spaceId", "botId", "updatedAt");
