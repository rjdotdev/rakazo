import type {
  AdapterContext,
  BrowserProvider,
  ComputerRef,
  JobPublisher,
} from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { extractOneTimeCode } from "@rakazo/contracts";
import { isMessagingChannelRun } from "@rakazo/core";
import { hostSite } from "@rakazo/core/egress";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { findPendingAsk, teamChatRunFromOwner } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** How long before a code request an email may have arrived and still answer it. */
export const EMAILED_CODE_WINDOW_MS = 5 * 60 * 1000;
/** The earliest an email may have arrived to answer a code request: in its run, shortly before. */
export function emailedCodeWindowStart(requestedAt: Date, runStartedAt: Date): Date {
  return new Date(Math.max(requestedAt.getTime() - EMAILED_CODE_WINDOW_MS, runStartedAt.getTime()));
}
/** The newest emails looked through for one from the site. */
const CANDIDATE_EMAILS = 50;

/**
 * Whether a run may read its bot's inbox: the owner's own run, never another bot's message, a
 * group, or a chat that reaches people besides the owner.
 */
export function readsBotInbox(input: {
  run: { userId: string; trigger: string };
  bot: { userId: string };
  thread: { groupId: string | null };
  nonOwnerChatRun: boolean;
}): boolean {
  return (
    input.run.userId === input.bot.userId &&
    input.run.trigger !== "bot_message" &&
    !input.thread.groupId &&
    !input.nonOwnerChatRun
  );
}

/**
 * A run started from a messaging channel, or from team chat by anyone the owner did not link to
 * themselves: either reaches people besides the owner.
 */
export async function isNonOwnerChatRun(
  prisma: PrismaClient,
  input: {
    trigger: string;
    sourceBlocks: MessageBlock[] | undefined;
    sourceClientNonce: string | null | undefined;
    externalConversationId: string | null;
  },
): Promise<boolean> {
  if (isMessagingChannelRun(input.trigger, input.sourceBlocks)) return true;
  if (input.trigger !== "messaging" || !input.externalConversationId) return false;
  return !(await teamChatRunFromOwner(prisma, {
    externalConversationId: input.externalConversationId,
    sourceClientNonce: input.sourceClientNonce,
  }));
}

/**
 * Records of the inbox's codes, kept as effects of the run that took them: `idempotencyKey` is
 * unique, so inserting one is the claim, and two runs (or a run and the inbox) never both get it.
 * Their status is none a tool's effect has, so nothing replays or reads them as tool calls.
 */
const EMAILED_CODE_EFFECT = "emailed_code";
const emailClaimKey = (emailId: string) => `emailed-code:email:${emailId}`;
const runSiteClaimKey = (runId: string, site: string) => `emailed-code:run:${runId}:${site}`;
const pageSeenKey = (requestId: string) => `emailed-code:page:${requestId}`;

function httpsSite(origin: string): string | undefined {
  const url = URL.canParse(origin) ? new URL(origin) : undefined;
  return url?.protocol === "https:" ? hostSite(url.hostname) : undefined;
}

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/**
 * The code for `origin` in the bot's own inbox, if there is exactly one to take. It comes from
 * signed mail from the site's own domain (subdomains of a shared hosting suffix are each their
 * own site), received since `after`, that the bot did not send and no bot on this server did,
 * that no run took a code from, and that holds exactly one code. Emails with none or several are
 * skipped, and two such emails with different codes give nothing. An email that came before any
 * of the bot's secret requests was answered may hold the code that answer used, so it is not one.
 * A run takes at most one emailed code per site; after that the owner answers the card.
 */
export async function findEmailedCode(
  prisma: PrismaClient,
  input: {
    botId: string;
    spaceId: string;
    runId: string;
    origin: string;
    after: Date;
    /** The domain this server's bots send mail from. */
    botEmailDomain: string | undefined;
  },
): Promise<{ code: string; emailId: string; site: string } | undefined> {
  const site = httpsSite(input.origin);
  if (!site) return undefined;
  const filled = await prisma.externalEffect.findUnique({
    where: { idempotencyKey: runSiteClaimKey(input.runId, site) },
    select: { id: true },
  });
  if (filled) return undefined;
  const answered = await prisma.externalEffect.findFirst({
    where: {
      spaceId: input.spaceId,
      kind: "request_secret",
      status: { not: "intended" },
      updatedAt: { gte: input.after },
      run: { botId: input.botId },
    },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  const emails = await prisma.botEmailMessage.findMany({
    where: {
      botId: input.botId,
      sent: false,
      verified: true,
      mailingList: false,
      receivedAt: { gte: input.after, ...(answered ? { gt: answered.updatedAt } : {}) },
    },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: CANDIDATE_EMAILS,
    select: { id: true, fromAddress: true, subject: true, text: true },
  });
  const fromSite = emails.filter((email) => {
    const domain = domainOf(email.fromAddress);
    return domain !== input.botEmailDomain && hostSite(domain) === site;
  });
  if (fromSite.length === 0) return undefined;
  const claimed = new Set(
    (
      await prisma.externalEffect.findMany({
        where: { idempotencyKey: { in: fromSite.map((email) => emailClaimKey(email.id)) } },
        select: { idempotencyKey: true },
      })
    ).map((effect) => effect.idempotencyKey),
  );
  const candidates = fromSite.flatMap((email) => {
    const code = claimed.has(emailClaimKey(email.id)) ? undefined : extractOneTimeCode(email);
    return code ? [{ code, emailId: email.id }] : [];
  });
  const [newest] = candidates;
  if (!newest || candidates.some((candidate) => candidate.code !== newest.code)) return undefined;
  return { ...newest, site };
}

class ClaimTaken extends Error {}

/**
 * Take the email's code for `runId`, atomically: false when another run, or this run for the same
 * site, already took one. A claim is never given back, so a code is offered once.
 */
export async function claimEmailedCode(
  prisma: PrismaClient,
  input: { runId: string; spaceId: string; emailId: string; site: string },
): Promise<boolean> {
  const keys = [runSiteClaimKey(input.runId, input.site), emailClaimKey(input.emailId)];
  try {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.externalEffect.createMany({
        data: keys.map((idempotencyKey) => ({
          runId: input.runId,
          spaceId: input.spaceId,
          kind: EMAILED_CODE_EFFECT,
          status: "taken",
          idempotencyKey,
          request: { emailId: input.emailId, site: input.site },
        })),
        skipDuplicates: true,
      });
      if (count !== keys.length) throw new ClaimTaken();
    });
    return true;
  } catch (error) {
    if (error instanceof ClaimTaken) return false;
    throw error;
  }
}

/** Find the inbox's code for a request and claim it, as one step. */
export async function takeEmailedCode(
  prisma: PrismaClient,
  input: Parameters<typeof findEmailedCode>[1],
): Promise<{ code: string; emailId: string } | undefined> {
  const found = await findEmailedCode(prisma, input);
  if (!found) return undefined;
  const claimed = await claimEmailedCode(prisma, {
    runId: input.runId,
    spaceId: input.spaceId,
    emailId: found.emailId,
    site: found.site,
  });
  return claimed ? { code: found.code, emailId: found.emailId } : undefined;
}

/**
 * Note that the run's page was on `origin`, as its browser reported, when it asked for the code
 * of request `requestId`. Mail that comes while the card waits answers only such a card.
 */
export async function notePageForEmailedCode(
  prisma: PrismaClient,
  input: { runId: string; spaceId: string; requestId: string; origin: string },
): Promise<void> {
  await prisma.externalEffect.createMany({
    data: [
      {
        runId: input.runId,
        spaceId: input.spaceId,
        kind: EMAILED_CODE_EFFECT,
        status: "page",
        idempotencyKey: pageSeenKey(input.requestId),
        request: { origin: input.origin },
      },
    ],
    skipDuplicates: true,
  });
}

/** The page's origin as the run's browser reports it, when its computer is already running. */
export async function runPageOrigin(ctx: {
  computer: { heldForTakeover: boolean; lazy: { ready: ComputerRef | undefined } };
  providers: { browser: Pick<BrowserProvider, "snapshot"> };
  context: AdapterContext;
}): Promise<string | undefined> {
  const computer = ctx.computer.lazy.ready;
  if (!computer || ctx.computer.heldForTakeover) return undefined;
  try {
    const page = await ctx.providers.browser.snapshot(
      computer,
      { signal: ctx.context.signal },
      ctx.context,
    );
    return !page.error && URL.canParse(page.url) ? new URL(page.url).origin : undefined;
  } catch (error) {
    ctx.context.signal.throwIfAborted();
    getLogger().warn("page origin could not be read for an emailed code", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

/**
 * New mail in a bot's inbox answers the code card its owner's run is waiting on, when the mail
 * holds the one code for the card's site, as the owner would by typing it in; the run then goes
 * on. Only a card whose run's browser was on the card's origin when it asked, and an email
 * claimed for that run, as findEmailedCode and claimEmailedCode decide. An email that would answer
 * two waiting cards answers neither. The card's own answer path settles a race with the owner:
 * whichever comes second finds the card answered and does nothing. With `runId`, only that run's
 * card: the run looks again once it waits, for mail that came while it was saving the card.
 * Returns how many cards it answered.
 */
export async function answerCodeCardsFromInbox(
  deps: {
    prisma: PrismaClient;
    events: Pick<ThreadEvents, "answerRunInput">;
    jobs: Pick<JobPublisher, "enqueue">;
    /** The domain this server's bots send mail from. */
    botEmailDomain: string | undefined;
  },
  bot: { id: string; userId: string },
  runId?: string,
): Promise<number> {
  let count = 0;
  try {
    const runs = await deps.prisma.run.findMany({
      where: {
        botId: bot.id,
        userId: bot.userId,
        status: "waiting_input",
        ...(runId ? { id: runId } : {}),
      },
      select: {
        id: true,
        spaceId: true,
        threadId: true,
        userId: true,
        trigger: true,
        createdAt: true,
        sourceMessage: { select: { blocks: true, clientNonce: true } },
        thread: { select: { groupId: true, externalConversationId: true } },
      },
    });
    const answers: Array<{
      run: (typeof runs)[number];
      messageId: string;
      found: { code: string; emailId: string; site: string };
    }> = [];
    for (const run of runs) {
      const nonOwnerChatRun = await isNonOwnerChatRun(deps.prisma, {
        trigger: run.trigger,
        sourceBlocks: run.sourceMessage?.blocks as MessageBlock[] | undefined,
        sourceClientNonce: run.sourceMessage?.clientNonce,
        externalConversationId: run.thread.externalConversationId,
      });
      if (!readsBotInbox({ run, bot, thread: run.thread, nonOwnerChatRun })) continue;
      const pending = await findPendingAsk(deps.prisma, { threadId: run.threadId, runId: run.id });
      const origin = pending?.pendingAsk.oneTimeCode?.origin;
      if (!pending || !origin || pending.pendingAsk.credential) continue;
      const request = await deps.prisma.externalEffect.findFirst({
        where: { runId: run.id, spaceId: run.spaceId, kind: "request_secret", status: "intended" },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true },
      });
      if (!request) continue;
      const page = await deps.prisma.externalEffect.findUnique({
        where: { idempotencyKey: pageSeenKey(request.id) },
        select: { runId: true, request: true },
      });
      if (page?.runId !== run.id || (page.request as { origin?: unknown }).origin !== origin)
        continue;
      const found = await findEmailedCode(deps.prisma, {
        botId: bot.id,
        spaceId: run.spaceId,
        runId: run.id,
        origin,
        after: emailedCodeWindowStart(request.createdAt, run.createdAt),
        botEmailDomain: deps.botEmailDomain,
      });
      if (found) answers.push({ run, messageId: pending.messageId, found });
    }
    for (const { run, messageId, found } of answers) {
      if (answers.filter((other) => other.found.emailId === found.emailId).length > 1) continue;
      try {
        const claimed = await claimEmailedCode(deps.prisma, {
          runId: run.id,
          spaceId: run.spaceId,
          emailId: found.emailId,
          site: found.site,
        });
        if (!claimed) continue;
        const answered = await deps.events.answerRunInput({
          spaceId: run.spaceId,
          threadId: run.threadId,
          runId: run.id,
          messageId,
          answeredByUserId: run.userId,
          answer: found.code,
          fromEmail: found.emailId,
        });
        if (!answered) continue;
        count += 1;
        await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
          // The answered run is durable; reconciliation will repair a missed wake.
          getLogger().error("emailed code continue enqueue", error);
        });
      } catch (error) {
        // The card changed under this answer, usually because the owner answered it first.
        getLogger().warn("emailed code did not answer its card", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  } catch (error) {
    // The email is saved either way; the card stays open for the owner.
    getLogger().error("emailed code lookup", error);
  }
  return count;
}
