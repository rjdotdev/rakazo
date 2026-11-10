import { randomUUID } from "node:crypto";
import { createDb, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimEmailedCode, findEmailedCode, takeEmailedCode } from "./emailed-code.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

postgres("emailed code claims (PostgreSQL)", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "");
  const id = `emailed-code-${randomUUID()}`;
  const spaceId = `${id}-space`;
  const userId = `${id}-user`;
  const organizationId = `${id}-org`;
  const system = <T>(fn: () => Promise<T>) => runAsSystem("test fixture", fn);
  const origin = "https://login.example.test";
  let botId = "";
  let runs: string[] = [];
  /** The run that won the race in the first case. */
  let winner = "";

  beforeAll(async () => {
    await system(async () => {
      await prisma.user.create({
        data: { id: userId, name: "Code tester", email: `${id}@rakazo.test` },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Code tests", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "Code tests" } });
      const bot = await prisma.bot.create({
        data: {
          spaceId,
          userId,
          name: "Signer",
          color: "ink",
          thread: { create: { spaceId, userId } },
        },
        include: { thread: true },
      });
      botId = bot.id;
      const threadId = bot.thread!.id;
      runs = [];
      for (const prompt of ["Sign in", "Sign in too"]) {
        const task = await prisma.task.create({
          data: { spaceId, userId, botId, threadId, prompt, status: "running" },
        });
        const run = await prisma.run.create({
          data: {
            spaceId,
            userId,
            botId,
            threadId,
            taskId: task.id,
            status: "running",
            trigger: "user_message",
          },
          select: { id: true },
        });
        runs.push(run.id);
      }
    });
  });

  afterAll(async () => {
    try {
      // The organization cascades to the space, bot, runs, their effects and the inbox.
      await system(async () => {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      });
      await prisma.$disconnect();
    } finally {
      await pool.end();
    }
  });

  async function receive(code: string) {
    return system(() =>
      prisma.botEmailMessage.create({
        data: {
          spaceId,
          botId,
          key: `<${randomUUID()}@example.test>`,
          fromAddress: "no-reply@example.test",
          fromName: "Example",
          verified: true,
          to: ["signer@bots.test"],
          cc: [],
          subject: "Your sign-in code",
          text: `Your verification code is ${code}.`,
        },
        select: { id: true },
      }),
    );
  }

  const lookup = (runId: string) => ({
    botId,
    spaceId,
    runId,
    origin,
    after: new Date(Date.now() - 60_000),
    botEmailDomain: "bots.test",
  });

  it("gives an email's code to one of two runs that claim it at once", async () => {
    const email = await receive("482913");
    const [runA, runB] = runs as [string, string];
    // Both looked before either claimed, as a request and arriving mail can.
    const found = await system(() =>
      Promise.all([findEmailedCode(prisma, lookup(runA)), findEmailedCode(prisma, lookup(runB))]),
    );
    expect(found).toMatchObject([{ emailId: email.id }, { emailId: email.id }]);
    const claimed = await system(() =>
      Promise.all(
        [runA, runB].map((runId) =>
          claimEmailedCode(prisma, { runId, spaceId, emailId: email.id, site: "example.test" }),
        ),
      ),
    );
    expect(claimed.filter(Boolean)).toHaveLength(1);
    winner = claimed[0] ? runA : runB;
    // Taken: neither run finds it again.
    for (const runId of [runA, runB])
      expect(await system(() => findEmailedCode(prisma, lookup(runId)))).toBeUndefined();
    const effects = await system(() =>
      prisma.externalEffect.findMany({
        where: { idempotencyKey: `emailed-code:email:${email.id}` },
        select: { runId: true, kind: true, status: true },
      }),
    );
    expect(effects).toEqual([{ runId: winner, kind: "emailed_code", status: "taken" }]);
  });

  it("takes one emailed code per site in a run, and leaves the next email for another run", async () => {
    const email = await receive("731905");
    const claim = (runId: string) =>
      system(() =>
        claimEmailedCode(prisma, { runId, spaceId, emailId: email.id, site: "example.test" }),
      );
    // The run that won above already took this site's code.
    expect(await claim(winner)).toBe(false);
    expect(await system(() => takeEmailedCode(prisma, lookup(winner)))).toBeUndefined();
    // The refused claim wrote nothing, so the email is still free for the other run.
    const loser = runs.find((runId) => runId !== winner)!;
    expect(await claim(loser)).toBe(true);
  });
});
