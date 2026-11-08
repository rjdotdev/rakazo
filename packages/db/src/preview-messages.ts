import { BACKGROUND_HELPER_TRIGGER, BACKGROUND_RUN_TRIGGERS } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { contentEncryptionOf } from "./content-encryption.js";

/** Scalar columns the sidebar preview and its older-page fallback both read. */
export interface SidebarPreviewMessage {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Prisma.JsonValue;
  botId: string | null;
  replyToMessageId: string | null;
  replyQuote: string | null;
  runId: string | null;
  clientNonce: string | null;
  createdAt: Date;
}

/**
 * One indexed read of the newest `limit` messages per thread. A nested `take`
 * on `findMany` is applied in memory and would load every message.
 */
export async function withNewestThreadMessages<T extends { thread: { id: string } | null }>(
  prisma: PrismaClient,
  parents: T[],
  limit: number,
) {
  const threadIds = parents.flatMap((parent) => (parent.thread ? [parent.thread.id] : []));
  const loaded =
    threadIds.length === 0
      ? []
      : await prisma.$queryRaw<SidebarPreviewMessage[]>(Prisma.sql`
          SELECT m.id, m."threadId", m.seq, m.role, m.blocks, m."botId",
            m."replyToMessageId", m."replyQuote", m."runId", m."clientNonce", m."createdAt"
          FROM unnest(${threadIds}::text[]) AS t(id)
          CROSS JOIN LATERAL (
            SELECT id, "threadId", seq, role, blocks, "botId", "replyToMessageId", "replyQuote",
              "runId", "clientNonce", "createdAt"
            FROM messages
            WHERE "threadId" = t.id
            ORDER BY seq DESC
            LIMIT ${limit}
          ) m
          ORDER BY m."threadId", m.seq DESC
        `);
  const opened = (await contentEncryptionOf(prisma)?.openRows("Message", loaded)) ?? loaded;
  const byThread = new Map<string, SidebarPreviewMessage[]>();
  for (const row of opened) {
    const list = byThread.get(row.threadId);
    if (list) list.push(row);
    else byThread.set(row.threadId, [row]);
  }
  return parents.map((parent) => ({
    ...parent,
    thread: parent.thread
      ? { ...parent.thread, messages: byThread.get(parent.thread.id) ?? [] }
      : null,
  }));
}

/** How many of a thread's newest messages the activity probe reads. */
const RECENT_MESSAGE_LIMIT = 20;

/** Whether the helper run `helper` was started by background ticket work (its nonce leads with the starting run's id). */
function helperStartedInBackground(helper: Prisma.Sql) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM runs p
    WHERE p.id = split_part(${helper}."clientNonce", ':', 2)
      AND p.trigger = ANY(${[...BACKGROUND_RUN_TRIGGERS]}::text[])
  )`;
}

/**
 * The time of the newest message from a person or a bot among the thread's newest
 * RECENT_MESSAGE_LIMIT messages. System notes, background ticket work and the card of a helper that
 * ticket work started don't count; a thread whose newest messages are all of those has none.
 */
function newestRealMessage(threadId: Prisma.Sql) {
  return Prisma.sql`
    SELECT recent."createdAt" FROM (
      SELECT id, seq, role, "runId", "createdAt" FROM messages
      WHERE "threadId" = ${threadId}
      ORDER BY seq DESC LIMIT ${RECENT_MESSAGE_LIMIT}
    ) recent
    WHERE recent.role <> 'system'
      AND NOT EXISTS (
        SELECT 1 FROM runs r
        WHERE r.id = recent."runId" AND r.trigger = ANY(${[...BACKGROUND_RUN_TRIGGERS]}::text[])
      )
      AND NOT EXISTS (
        SELECT 1 FROM runs h
        WHERE h."sourceMessageId" = recent.id AND h.trigger = ${BACKGROUND_HELPER_TRIGGER}
          AND ${helperStartedInBackground(Prisma.sql`h`)}
      )
    ORDER BY recent.seq DESC LIMIT 1`;
}

/** When each thread last had a message from a person or a bot (see newestRealMessage), by thread id. */
export async function newestThreadMessageTimes(
  client: PrismaClient | Prisma.TransactionClient,
  threadIds: string[],
): Promise<Map<string, Date>> {
  if (threadIds.length === 0) return new Map();
  const rows = await client.$queryRaw<Array<{ threadId: string; createdAt: Date }>>(Prisma.sql`
    SELECT t.id AS "threadId", m."createdAt"
    FROM unnest(${threadIds}::text[]) AS t(id)
    CROSS JOIN LATERAL (${newestRealMessage(Prisma.sql`t.id`)}) m
  `);
  return new Map(rows.map((row) => [row.threadId, row.createdAt]));
}

/** How far back newestBotMessageTimes looks for helper and external-conversation activity. */
const RECENT_ACTIVITY_LIMIT = 20;

/**
 * When each bot's conversation last moved: the newest real message (see newestRealMessage) across
 * its own chat, the threads of helpers among its newest RECENT_ACTIVITY_LIMIT runs (not those ticket
 * work started) and its RECENT_ACTIVITY_LIMIT most recently touched external conversations (every
 * inbound message touches its conversation). External conversations are listed to every member;
 * a helper's thread isn't, but its card in the bot's shared chat already shows that it ran.
 */
export async function newestBotMessageTimes(
  prisma: PrismaClient,
  bots: Array<{ id: string; spaceId: string }>,
): Promise<Map<string, Date>> {
  if (bots.length === 0) return new Map();
  const botIds = bots.map((bot) => bot.id);
  const spaceIds = bots.map((bot) => bot.spaceId);
  const rows = await prisma.$queryRaw<Array<{ botId: string; lastMessageAt: Date }>>(Prisma.sql`
    SELECT b.id AS "botId", max(m."createdAt") AS "lastMessageAt"
    FROM unnest(${botIds}::text[], ${spaceIds}::text[]) AS b(id, "spaceId")
    CROSS JOIN LATERAL (
      SELECT id FROM threads WHERE "botId" = b.id
      UNION
      SELECT r."threadId" FROM (
        SELECT "threadId", trigger, "clientNonce" FROM runs
        WHERE "botId" = b.id ORDER BY "createdAt" DESC LIMIT ${RECENT_ACTIVITY_LIMIT}
      ) r
      WHERE r.trigger = ${BACKGROUND_HELPER_TRIGGER}
        AND NOT ${helperStartedInBackground(Prisma.sql`r`)}
      UNION
      SELECT t.id FROM (
        SELECT id FROM external_conversations
        WHERE "spaceId" = b."spaceId" AND "botId" = b.id
        ORDER BY "updatedAt" DESC LIMIT ${RECENT_ACTIVITY_LIMIT}
      ) c
      JOIN threads t ON t."externalConversationId" = c.id
    ) bt
    CROSS JOIN LATERAL (${newestRealMessage(Prisma.sql`bt.id`)}) m
    GROUP BY b.id
  `);
  return new Map(rows.map((row) => [row.botId, row.lastMessageAt]));
}
