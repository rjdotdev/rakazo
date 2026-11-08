import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Bot, Group, SpaceNavigation } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createThreadMessage } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeRoster = hasDb ? describe : describe.skip;

describeRoster("sidebar roster lastMessageAt", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-roster-last-message-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    prisma = asSystem(handles.prisma);
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("reports each chat's newest message across the bot's threads, not its settings writes", async () => {
    const cookie = await signup(app, `roster-${Date.now()}@rakazo.test`, "Roster User");
    const bridged = await createBot(app, cookie, "Bridged");
    const helped = await createBot(app, cookie, "Helped");
    const quiet = await createBot(app, cookie, "Quiet");
    const group = await rpc<Group>(app, cookie, "groups/create", {
      name: "Pair",
      botIds: [bridged.id, helped.id],
    });
    const spaceId = bridged.spaceId;
    // Only seeded messages count; drop anything creation wrote.
    await prisma.message.deleteMany({ where: { thread: { spaceId } } });

    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000);
    const { userId } = await prisma.thread.findUniqueOrThrow({ where: { id: bridged.threadId } });
    const external = await prisma.externalConversation.create({
      data: {
        provider: "team-chat",
        workspaceId: "workspace",
        externalKey: `roster-${spaceId}`,
        conversationId: `roster-${spaceId}`,
        spaceId,
        botId: bridged.id,
        userId,
        thread: { create: { spaceId, userId } },
      },
      include: { thread: true },
    });
    // Started the way the bot starts a background helper: its own thread, task and run.
    const helperThread = await prisma.thread.create({
      data: { spaceId, userId, helperBotId: helped.id },
    });
    await startRun(prisma, helped, helperThread.id, "helper");
    // The bot answering in the group chat is not a helper: its newer group message stays out.
    await startRun(prisma, helped, group.threadId, "user");
    await seedMessage(prisma, bridged.threadId, at(5));
    await seedMessage(prisma, external.thread!.id, at(1));
    await seedMessage(prisma, helped.threadId, at(5));
    await seedMessage(prisma, helperThread.id, at(2));
    await seedMessage(prisma, group.threadId, at(0.5));
    // Newer system notes (stop notices, computer and routine notes) don't move either chat, and
    // neither does background ticket work, which the chat never shows.
    await seedMessage(prisma, bridged.threadId, at(0.1), "system");
    await seedMessage(prisma, group.threadId, at(0.1), "system");
    const ticketRun = await startRun(prisma, bridged, bridged.threadId, "tickets");
    await seedMessage(prisma, bridged.threadId, at(0.2), "bot", ticketRun.id);

    // Settings writes after the last message leave it where it is.
    await rpc(app, cookie, "bots/update", { botId: bridged.id, pinned: true, name: "Renamed" });
    // A never-messaged chat stays never-messaged after settings writes; it sorts by creation time.
    await rpc(app, cookie, "bots/update", { botId: quiet.id, pinned: true, name: "Still quiet" });

    const expected = {
      [bridged.id]: at(1).toISOString(),
      [helped.id]: at(2).toISOString(),
      [quiet.id]: null,
    };
    const bots = await rpc<Bot[]>(app, cookie, "bots/list");
    expect(times(bots, expected)).toEqual(expected);
    const groups = await rpc<Group[]>(app, cookie, "groups/list");
    expect(groups.find((row) => row.id === group.id)?.lastMessageAt).toBe(at(0.5).toISOString());

    // The same space listed while another one is open goes through the inactive-space roster.
    const other = await rpc<{ id: string }>(app, cookie, "spaces/create", { name: "Other" });
    const navigation = await rpc<SpaceNavigation>(app, cookie, "spaces/list", {}, other.id);
    const listed = navigation.spaces.find((space) => space.id === spaceId);
    expect(times(listed?.bots ?? [], expected)).toEqual(expected);
    for (const roster of [bots, listed?.bots ?? []]) {
      expect(roster.find((bot) => bot.id === quiet.id)?.createdAt).toBe(quiet.createdAt);
    }
    expect(listed?.groups.find((row) => row.id === group.id)?.createdAt).toBe(group.createdAt);
    expect(listed?.groups.find((row) => row.id === group.id)?.lastMessageAt).toBe(
      at(0.5).toISOString(),
    );
  });

  it("counts a chat with only system notes, ticket work and helpers ticket work started as never messaged", async () => {
    const cookie = await signup(app, `roster-ticket-${Date.now()}@rakazo.test`, "Ticket User");
    const ticketed = await createBot(app, cookie, "Ticketed");
    await prisma.message.deleteMany({ where: { threadId: ticketed.threadId } });
    const { userId } = await prisma.thread.findUniqueOrThrow({ where: { id: ticketed.threadId } });
    const ticketRun = await startRun(prisma, ticketed, ticketed.threadId, "tickets");
    await seedMessage(prisma, ticketed.threadId, new Date(Date.now() - 60_000), "system");
    await seedMessage(
      prisma,
      ticketed.threadId,
      new Date(Date.now() - 50_000),
      "bot",
      ticketRun.id,
    );
    // The ticket run starts a background helper: its card lands in the chat with no run id, and
    // the helper's nonce leads with the ticket run's id (see startBackgroundHelper).
    const card = await createThreadMessage(prisma, {
      threadId: ticketed.threadId,
      role: "bot",
      blocks: [
        { kind: "subagent", agentId: "call-1", name: "helper", task: "t", status: "running" },
      ],
    });
    const helperThread = await prisma.thread.create({
      data: { spaceId: ticketed.spaceId, userId, helperBotId: ticketed.id },
    });
    await startRun(prisma, ticketed, helperThread.id, "helper", {
      sourceMessageId: card.id,
      clientNonce: `background-helper:${ticketRun.id}:run_subagent:digest`,
    });
    await seedMessage(prisma, helperThread.id, new Date(), "bot");

    const [bot] = (await rpc<Bot[]>(app, cookie, "bots/list")).filter(
      (row) => row.id === ticketed.id,
    );
    expect(bot?.lastMessageAt).toBeNull();
    expect(bot?.createdAt).toBe(ticketed.createdAt);
  });

  it("reads only each bot's most recently touched external conversations", async () => {
    const cookie = await signup(app, `roster-bound-${Date.now()}@rakazo.test`, "Bound User");
    const busy = await createBot(app, cookie, "Busy");
    await prisma.message.deleteMany({ where: { threadId: busy.threadId } });
    const { userId } = await prisma.thread.findUniqueOrThrow({ where: { id: busy.threadId } });
    // RECENT_ACTIVITY_LIMIT (20) newer conversations hide the 21st, even with the newest message.
    for (let index = 0; index <= 20; index++) {
      const conversation = await prisma.externalConversation.create({
        data: {
          provider: "team-chat",
          workspaceId: "workspace",
          externalKey: `bound-${busy.id}-${index}`,
          conversationId: `bound-${busy.id}-${index}`,
          spaceId: busy.spaceId,
          botId: busy.id,
          userId,
          thread: { create: { spaceId: busy.spaceId, userId } },
        },
        include: { thread: true },
      });
      await prisma.$executeRaw`UPDATE external_conversations SET "updatedAt" = ${new Date(Date.now() - (index + 1) * 3_600_000)} WHERE id = ${conversation.id}`;
      if (index === 20) await seedMessage(prisma, conversation.thread!.id, new Date());
    }

    const [bot] = (await rpc<Bot[]>(app, cookie, "bots/list")).filter((row) => row.id === busy.id);
    expect(bot?.lastMessageAt).toBeNull();
  });

  it("reads only a thread's newest messages", async () => {
    const cookie = await signup(app, `roster-tail-${Date.now()}@rakazo.test`, "Tail User");
    const noted = await createBot(app, cookie, "Noted");
    await prisma.message.deleteMany({ where: { threadId: noted.threadId } });
    // A real message older than RECENT_MESSAGE_LIMIT (20) newer system notes is past the probe.
    await seedMessage(prisma, noted.threadId, new Date(Date.now() - 3_600_000));
    for (let index = 0; index < 20; index++) {
      await seedMessage(prisma, noted.threadId, new Date(), "system");
    }

    const [bot] = (await rpc<Bot[]>(app, cookie, "bots/list")).filter((row) => row.id === noted.id);
    expect(bot?.lastMessageAt).toBeNull();
  });
});

function times(
  bots: Array<{ id: string; lastMessageAt?: string | null }>,
  expected: Record<string, string | null>,
) {
  return Object.fromEntries(
    Object.keys(expected).map((id) => [id, bots.find((bot) => bot.id === id)?.lastMessageAt]),
  );
}

async function seedMessage(
  prisma: PrismaClient,
  threadId: string,
  createdAt: Date,
  role: "user" | "bot" | "system" = "user",
  runId?: string,
) {
  const message = await createThreadMessage(prisma, {
    threadId,
    role,
    ...(runId ? { runId } : {}),
    blocks: [{ kind: "text", text: "hello" }],
  });
  await prisma.message.update({ where: { id: message.id }, data: { createdAt } });
}

async function startRun(
  prisma: PrismaClient,
  bot: Pick<Bot, "id" | "spaceId">,
  threadId: string,
  trigger: string,
  data: { sourceMessageId?: string; clientNonce?: string } = {},
) {
  const { userId } = await prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
  const task = await prisma.task.create({
    data: {
      spaceId: bot.spaceId,
      botId: bot.id,
      threadId,
      userId,
      prompt: "Work",
      status: "completed",
    },
  });
  return prisma.run.create({
    data: {
      spaceId: bot.spaceId,
      botId: bot.id,
      threadId,
      taskId: task.id,
      userId,
      status: "completed",
      trigger,
      ...data,
    },
  });
}

async function createBot(app: App, cookie: string, name: string) {
  return rpc<Bot>(app, cookie, "bots/create", {
    name,
    title: name,
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(
  app: App,
  cookie: string,
  proc: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
