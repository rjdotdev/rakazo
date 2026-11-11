import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import { computerControlExpireJobKey } from "@rakazo/adapter-kit";
import type { ComputerExecutionLease } from "@rakazo/adapters";
import {
  applyTeachingDesktopInput,
  COMPUTER_SCREEN_UNAVAILABLE,
  ComputerBusyError,
  checkpointAndStopComputer,
  computerSupportsTerminal,
  computerSupportsUpdate,
  computerUpdateView,
  diskUsedPercent,
  displayBotWorkspacePath,
  ensureComputerWorkspaceLayout,
  expireComputerControl,
  hasActiveComputerControl,
  isComputerScreenUnavailable,
  isSandboxGoneError,
  LocalAgentHomeStore,
  provisionComputer,
  queueComputerUpdate,
  rateLimitEnds,
  releaseComputerExecutionLease,
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  scheduleComputerControlExpiry,
  scheduleComputerSleep,
  screenLeaseIdForRun,
  sleepDeferReason,
  takeoverLeaseMs,
  toComputerRef,
  touchRunningComputer,
} from "@rakazo/adapters";
import type { ComputerMode } from "@rakazo/contracts";
import {
  attachmentMaxBytes,
  attachmentSizeLabel,
  CHAT_FILE_READ_MAX_LINES,
  CHAT_FILE_TEXT_BYTES,
  ComputerCommandSchema,
  foldComputerCommands,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, COMPUTER_USING_RUNS, scrollDirection } from "@rakazo/core";
import { addScreenProxyCapability } from "@rakazo/core/node/screen-capability";
import type { ComputerRunEnd } from "@rakazo/db";
import {
  expireComputerExecutionLeases,
  IsolationError,
  isRecordNotFound,
  parseComputerMode,
  recordComputerRunEnd,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import {
  ChatFileError,
  isOversizedFileError,
  readChatTextPage,
  readSandboxByteRange,
  userWorkspacePath,
} from "../chat-files.js";
import {
  acquireBootLease,
  assertNotAnotherPersonsControl,
  bindWaitingTakeoverToControl,
  clearGoneSandbox,
  computerScreenContext,
  computerStatus,
  expireStaleComputerControl,
  holdsComputerControl,
  keepComputerAwake,
  releaseComputerControl,
  runComputerReplace,
  withViewOnly,
} from "../computer-control.js";
import { scrollPoint } from "../computer-input.js";
import { executionBlocksUserTakeover } from "../computer-status.js";
import type { RouterContext } from "./context.js";
import { computerContext } from "./shared.js";

const CHANGED_CHAT_FILES = 20;

/** Each command writes a running and a done event, so this keeps about 100 commands. */
const COMPUTER_COMMAND_HISTORY_EVENTS = 200;

function fileRpcError(error: unknown): never {
  if (error instanceof ChatFileError || isOversizedFileError(error)) {
    const notText = error instanceof ChatFileError && error.code === "not_text";
    throw new ORPCError("BAD_REQUEST", {
      message: notText ? "file is not a text file" : "file is too large to preview",
    });
  }
  if (error instanceof Error && /escapes/i.test(error.message)) {
    throw new ORPCError("BAD_REQUEST", { message: "Path escapes the bot workspace" });
  }
  if (error instanceof Error && error.message === "agent home entry is not a file") {
    throw new ORPCError("BAD_REQUEST", { message: "file is not a text file" });
  }
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    throw new ORPCError("NOT_FOUND", { message: "file not found" });
  }
  throw error;
}

/** This bot's folder, or shared/. `/` is the bot folder, never the Team Computer root. */
function containedUserPath(scope: ComputerMode, botId: string, requested: string): string {
  try {
    return userWorkspacePath(scope, botId, requested);
  } catch (error) {
    fileRpcError(error);
  }
}

function isWorkspaceDirectory(stored: string): boolean {
  return stored === "" || stored === "shared" || /^bots\/[^/]+$/.test(stored);
}

async function readHomeBytes(
  home: AgentHomeStore,
  homeKey: string,
  storedPath: string,
  ctx: AdapterContext,
  maxBytes: number,
): Promise<Uint8Array> {
  if (home instanceof LocalAgentHomeStore) {
    const { size } = await home.readBytes(homeKey, storedPath, ctx, { maxBytes: 0 });
    if (size > maxBytes) throw new Error(`agent home file exceeds ${maxBytes} bytes`);
    const { bytes } = await home.readBytes(homeKey, storedPath, ctx, { maxBytes });
    return bytes;
  }
  return new TextEncoder().encode(await home.readFile(homeKey, storedPath, ctx, { maxBytes }));
}

async function readHomeRange(
  home: AgentHomeStore,
  homeKey: string,
  storedPath: string,
  ctx: AdapterContext,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  if (!(home instanceof LocalAgentHomeStore)) {
    throw new Error(`agent home file exceeds ${CHAT_FILE_TEXT_BYTES} bytes`);
  }
  const { bytes } = await home.readBytes(homeKey, storedPath, ctx, { offset, maxBytes: length });
  return bytes;
}

export function computerRoutes(ctx: RouterContext) {
  const { deps, repos, taughtSkills, authed } = ctx;
  return {
    computer: {
      status: authed.computer.status.handler(async ({ context, input }) =>
        computerStatus(deps, context.actor, input.botId),
      ),
      boot: authed.computer.boot.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        if (bot.computer.state === "running" && bot.computer.providerRef) {
          try {
            await ensureComputerWorkspaceLayout(
              deps.sandbox,
              toComputerRef(bot.computer),
              parseComputerMode(bot.computer.scope),
              bot.id,
              computerContext(context.actor, bot.id, "boot"),
            );
            scheduleComputerSleep(deps.jobs, bot.computer.id);
            return computerStatus(deps, context.actor, input.botId);
          } catch (error) {
            await clearGoneSandbox(deps, bot.computer, error);
          }
        }
        const ctx = computerContext(context.actor, bot.id, "boot");
        const manualRunId = `boot:${randomUUID()}`;
        let lease: ComputerExecutionLease | null;
        try {
          lease = await acquireBootLease(deps.prisma, {
            computerId: bot.computer.id,
            runId: manualRunId,
            botId: bot.id,
          });
        } catch (error) {
          if (error instanceof ComputerBusyError) {
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          }
          throw error;
        }
        const computerId = bot.computer.id;
        try {
          await getLogger().withContext({ reason: "manual" }, () =>
            provisionComputer(deps, computerId, {
              ...ctx,
              screenLeaseId: screenLeaseIdForRun(lease, manualRunId),
            }),
          );
          scheduleComputerSleep(deps.jobs, bot.computer.id);
        } catch (error) {
          if (error instanceof ComputerBusyError) {
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          }
          // The bot was deleted or moved to another computer while this boot waited.
          if (isRecordNotFound(error)) {
            throw new ORPCError("NOT_FOUND", { message: "Computer no longer exists" });
          }
          throw error;
        } finally {
          await releaseComputerExecutionLease(deps.prisma, lease);
        }
        return computerStatus(deps, context.actor, input.botId);
      }),
      stop: authed.computer.stop.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        assertNotAnotherPersonsControl(bot.computer, context.actor);
        // A repeated Stop must not turn an unsafe guest back into an auto-startable one.
        if (bot.computer.state === "quarantined") {
          if (bot.computer.providerRef)
            await deps.sandbox.stop(
              toComputerRef(bot.computer),
              computerContext(context.actor, bot.id, "stop"),
            );
          return computerStatus(deps, context.actor, input.botId);
        }
        const controlLeaseId = bot.computer.controlLeaseId;
        const now = new Date();
        const claimed = await deps.prisma.computer.updateMany({
          where: {
            id: bot.computer.id,
            // Provision may resume the sandbox after Stop returns; let the boot finish first. Stop
            // acts on the state it read, so one that changed since is busy too.
            state: { equals: bot.computer.state, notIn: ["booting", "suspending", "quarantined"] },
            providerRef: bot.computer.providerRef,
            kind: bot.computer.kind,
            maintenanceId: null,
            executionLeases: {
              none: { botId: { not: bot.id }, expiresAt: { gt: now } },
            },
          },
          data: { state: "suspending" },
        });
        if (claimed.count !== 1) {
          throw new ORPCError("CONFLICT", {
            message: "Computer is busy",
          });
        }
        const otherRun = await deps.prisma.run.findFirst({
          where: {
            botId: { not: bot.id },
            status: { in: [...ACTIVE_RUN_STATUSES] },
            bot: { computerId: bot.computer.id },
            ...COMPUTER_USING_RUNS,
          },
          select: { id: true },
        });
        if (otherRun) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "suspending" },
            data: { state: bot.computer.state },
          });
          throw new ORPCError("CONFLICT", {
            message: "Other Team bots are still using this computer",
          });
        }
        await expireComputerExecutionLeases(deps.prisma, {
          computerId: bot.computer.id,
          botId: bot.id,
        });
        let stopping = false;
        try {
          let end: ComputerRunEnd = "stopped";
          if (bot.computer.providerRef) {
            const ctx = computerContext(context.actor, bot.id, "stop");
            const ref = toComputerRef(bot.computer);
            try {
              if (bot.computer.state === "stopped" || bot.computer.state === "suspended") {
                // It was saved when it went down and its provider keeps the disk, so a save would
                // only wake it.
                stopping = true;
                await deps.sandbox.stop(ref, ctx);
              } else {
                await checkpointAndStopComputer(deps, bot.computer, ref, ctx, () => {
                  stopping = true;
                });
              }
            } catch (error) {
              // The sandbox is already gone: nothing left to checkpoint or stop.
              if (!isSandboxGoneError(error)) throw error;
              end = "gone";
            }
          }
          const stopped = await deps.prisma.computer.updateMany({
            where: {
              id: bot.computer.id,
              state: "suspending",
              providerRef: bot.computer.providerRef,
              kind: bot.computer.kind,
            },
            data: {
              state: "stopped",
              controlHolder: "none",
              controlLeaseId: null,
              controlUserId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
          });
          if (stopped.count !== 1) return computerStatus(deps, context.actor, input.botId);
          await recordComputerRunEnd(deps.prisma, bot.computer, end);
        } catch (error) {
          // A failed save, or a stop the provider put off, leaves the computer up: hand it back
          // to idle sleep and metering instead of hiding it as an error.
          const stillUp = !stopping || sleepDeferReason(error) !== undefined;
          await deps.prisma.computer
            .updateMany({
              where: { id: bot.computer.id, state: "suspending" },
              data: { state: stillUp ? bot.computer.state : "error" },
            })
            .catch(() => undefined);
          if (stillUp)
            scheduleComputerSleep(deps.jobs, bot.computer.id, undefined, rateLimitEnds(error));
          throw error;
        }
        await deps.jobs.cancel(
          computerControlExpireJobKey(bot.computer.id, controlLeaseId ?? undefined),
        );
        return computerStatus(deps, context.actor, input.botId);
      }),
      recover: authed.computer.recover.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        assertNotAnotherPersonsControl(bot.computer, context.actor);
        if (!computerSupportsUpdate(bot.computer.kind))
          throw new ORPCError("BAD_REQUEST", {
            message: "Computer recovery is not available on this device",
          });
        try {
          return await queueComputerUpdate(deps, bot.computer.id, bot.id, "recover");
        } catch (error) {
          if (error instanceof ComputerBusyError)
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          throw error;
        }
      }),
      reset: authed.computer.reset.handler(async ({ context, input }) =>
        runComputerReplace(deps, context, input.botId, "reset", "reset"),
      ),
      update: authed.computer.update.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        assertNotAnotherPersonsControl(bot.computer, context.actor);
        if (!computerSupportsUpdate(bot.computer.kind))
          throw new ORPCError("BAD_REQUEST", {
            message: "Computer update is not available on this device",
          });
        try {
          return await queueComputerUpdate(deps, bot.computer.id, bot.id);
        } catch (error) {
          if (error instanceof ComputerBusyError)
            throw new ORPCError("CONFLICT", { message: "Computer is busy" });
          throw error;
        }
      }),
      updates: authed.computer.updates.handler(async ({ context }) => {
        const rows = await deps.prisma.computerUpdate.findMany({
          where: {
            status: { in: ["queued", "running", "interrupted", "failed"] },
            computer: {
              spaceId: context.actor.spaceId,
              bots: { some: { archivedAt: null } },
            },
          },
          include: {
            computer: {
              include: {
                bots: {
                  where: { archivedAt: null },
                  select: { id: true, name: true },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        });
        return rows.map((row) => computerUpdateView(row));
      }),
      releaseInterrupted: authed.computer.releaseInterrupted.handler(() => {
        throw new ORPCError("FORBIDDEN");
      }),
      dismissUpdate: authed.computer.dismissUpdate.handler(async ({ context, input }) => {
        await deps.prisma.computerUpdate.updateMany({
          where: {
            id: input.id,
            status: "failed",
            computer: {
              spaceId: context.actor.spaceId,
              bots: { some: { archivedAt: null } },
            },
          },
          data: { status: "dismissed" },
        });
        return { ok: true as const };
      }),
      dismissDiskWarning: authed.computer.dismissDiskWarning.handler(async ({ context, input }) => {
        const computer = (await repos.getBot(context.actor, input.botId)).computer;
        const percent = computer ? diskUsedPercent(computer) : null;
        if (computer && percent !== null) {
          await deps.prisma.computer.updateMany({
            where: { id: computer.id },
            data: { diskDismissedPercent: percent },
          });
        }
        return { ok: true as const };
      }),
      takeover: authed.computer.takeover.handler(async ({ context, input }) => {
        let bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer?.providerRef || bot.computer.state !== "running") {
          throw new ORPCError("BAD_REQUEST", { message: "computer must be running" });
        }
        assertNotAnotherPersonsControl(bot.computer, context.actor);
        if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId === bot.id) {
          await bindWaitingTakeoverToControl(deps, {
            spaceId: context.actor.spaceId,
            threadId: bot.thread?.id,
            botId: bot.id,
            computerId: bot.computer.id,
            controlLeaseId: bot.computer.controlLeaseId!,
            controlRunId: bot.computer.controlRunId,
          });
          await scheduleComputerControlExpiry(
            deps.jobs,
            bot.computer.id,
            bot.computer.controlLeaseId!,
            bot.computer.controlLeaseExpiresAt!,
          );
          return {
            leaseId: bot.computer.controlLeaseId!,
            expiresAt: bot.computer.controlLeaseExpiresAt!.toISOString(),
          };
        }
        if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId !== bot.id) {
          await releaseComputerControl(deps, context.actor, bot.computer.controlBotId!, "skipped");
          bot = await repos.getBot(context.actor, input.botId);
          if (!bot.computer) throw new IsolationError();
        }
        // Read again: someone else may have taken the screen since the first check, and their
        // live lease is never expired here.
        assertNotAnotherPersonsControl(bot.computer, context.actor);
        if (bot.computer.controlLeaseId) {
          await expireComputerControl(deps, bot.computer.id, bot.computer.controlLeaseId);
          bot = await repos.getBot(context.actor, input.botId);
        }
        if (!bot.computer) throw new IsolationError();
        // Gone-sandbox revoke may have marked the row stopped; do not fall through to the
        // running-state grant and return a confusing "control changed" conflict.
        if (!bot.computer.providerRef || bot.computer.state !== "running") {
          throw new ORPCError("BAD_REQUEST", { message: "computer must be running" });
        }

        const executionLease = await deps.prisma.computerExecutionLease.findUnique({
          where: { computerId_botId: { computerId: bot.computer.id, botId: bot.id } },
        });
        const executionRun = executionLease
          ? await deps.prisma.run.findUnique({
              where: { id: executionLease.runId },
              select: { botId: true, status: true, userId: true },
            })
          : null;
        const waitingForTakeover =
          executionRun?.botId === bot.id &&
          (executionRun.status === "waiting_takeover" ||
            bot.computer.controlRunId === executionLease?.runId);
        // A run that asked a person to take over waits for that person, not whoever opens the screen.
        if (waitingForTakeover && executionRun?.userId !== context.actor.userId) {
          throw new ORPCError("CONFLICT", { message: "The bot is waiting for someone else" });
        }
        if (
          executionBlocksUserTakeover({
            hasLease: Boolean(executionLease),
            leaseExpiresAt: executionLease?.expiresAt,
            runStatus: executionRun?.status,
            takeoverRequested: waitingForTakeover,
          })
        ) {
          throw new ORPCError("CONFLICT", { message: "Stop the bot first" });
        }
        // Keep an inactive lease as a fencing tombstone. The next run reclaims it
        // with a higher fence, even if this user's screen remains connected.

        const leaseId = randomUUID();
        const expiresAt = new Date(Date.now() + takeoverLeaseMs());
        const granted = await deps.prisma.computer.updateMany({
          where: {
            id: bot.computer.id,
            state: "running",
            maintenanceId: null,
            controlHolder: { not: "user" },
            controlLeaseId: null,
          },
          data: {
            controlHolder: "user",
            controlLeaseId: leaseId,
            controlLeaseExpiresAt: expiresAt,
            controlBotId: bot.id,
            controlRunId: waitingForTakeover ? executionLease?.runId : null,
            controlUserId: context.actor.userId,
            state: "running",
          },
        });
        if (granted.count !== 1) {
          const current = await deps.prisma.computer.findUniqueOrThrow({
            where: { id: bot.computer.id },
          });
          if (!hasActiveComputerControl(current) || current.controlBotId !== bot.id) {
            throw new ORPCError("CONFLICT", { message: "Computer control changed; try again" });
          }
          assertNotAnotherPersonsControl(current, context.actor);
          await bindWaitingTakeoverToControl(deps, {
            spaceId: context.actor.spaceId,
            threadId: bot.thread?.id,
            botId: bot.id,
            computerId: current.id,
            controlLeaseId: current.controlLeaseId!,
            controlRunId: current.controlRunId,
          });
          await scheduleComputerControlExpiry(
            deps.jobs,
            current.id,
            current.controlLeaseId!,
            current.controlLeaseExpiresAt!,
          );
          return {
            leaseId: current.controlLeaseId!,
            expiresAt: current.controlLeaseExpiresAt!.toISOString(),
          };
        }
        const computerId = bot.computer.id;
        const withdrawGrant = () =>
          deps.prisma.computer.updateMany({
            where: { id: computerId, controlLeaseId: leaseId },
            data: {
              controlHolder: "none",
              controlLeaseId: null,
              controlUserId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
          });
        if (waitingForTakeover && executionLease) {
          // The wait can end (expired, or yielded to newer work) between the read above and the
          // grant. Bound to an ended run, the user would share the screen with the next run.
          const waiting = await deps.prisma.run.findUnique({
            where: { id: executionLease.runId },
            select: { status: true },
          });
          if (!ACTIVE_RUN_STATUSES.some((status) => status === waiting?.status)) {
            await withdrawGrant();
            throw new ORPCError("CONFLICT", { message: "Computer control changed; try again" });
          }
        }
        try {
          await scheduleComputerControlExpiry(deps.jobs, computerId, leaseId, expiresAt);
        } catch (error) {
          await withdrawGrant();
          throw error;
        }
        if (bot.thread) {
          await deps.events.append({
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            type: "computer.takeover.granted",
            payload: { leaseId, takeoverRequested: waitingForTakeover },
          });
        }
        scheduleComputerSleep(deps.jobs, bot.computer.id);
        return { leaseId, expiresAt: expiresAt.toISOString() };
      }),
      release: authed.computer.release.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (bot.computer) assertNotAnotherPersonsControl(bot.computer, context.actor);
        await releaseComputerControl(deps, context.actor, input.botId, input.reason);
        return { ok: true as const };
      }),
      input: authed.computer.input.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const computer = bot.computer;
        if (!computer || !holdsComputerControl(computer, bot.id, context.actor)) {
          await expireStaleComputerControl(deps, computer);
          throw new ORPCError("FORBIDDEN");
        }
        if (!computer.providerRef) return { ok: true as const };
        const sensitive = input.payload.sensitive === true;
        const skillId =
          sensitive && typeof input.payload.skillId === "string" && input.payload.skillId
            ? input.payload.skillId
            : undefined;
        const mapped = {
          ...(input.kind === "key"
            ? { kind: "key" as const, key: String(input.payload.key ?? ""), sensitive }
            : input.kind === "clipboard"
              ? {
                  kind: "clipboard" as const,
                  text: String(input.payload.text ?? ""),
                  sensitive,
                }
              : input.kind === "scroll"
                ? {
                    kind: "scroll" as const,
                    direction: scrollDirection(input.payload.direction),
                    amount: Number(input.payload.amount ?? 3),
                    ...scrollPoint(input.payload),
                    sensitive,
                  }
                : {
                    kind: "pointer" as const,
                    x: Number(input.payload.x ?? 0),
                    y: Number(input.payload.y ?? 0),
                    button: (input.payload.button as "left" | "right" | undefined) ?? "left",
                    type:
                      (input.payload.type as "move" | "down" | "up" | "click" | undefined) ??
                      "click",
                    sensitive,
                  }),
          ...(skillId ? { skillId } : {}),
        };
        const outcome = await taughtSkills.recordInput(context.actor, bot.id, mapped);
        if (outcome === "stale") return { ok: true as const };
        if (outcome !== "recorded") {
          await applyTeachingDesktopInput(
            deps.sandbox,
            computer,
            mapped,
            computerContext(context.actor, bot.id, "input"),
          );
        }
        await deps.prisma.computer.updateMany({
          where: { id: computer.id, state: "running" },
          data: { updatedAt: new Date() },
        });
        scheduleComputerSleep(deps.jobs, computer.id);
        return { ok: true as const };
      }),
      files: authed.computer.files.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const computer = bot.computer;
        const computerMode = parseComputerMode(computer.scope);
        const ctx = computerContext(context.actor, bot.id, "files");
        const requested = input.path === "/" || input.path === "." ? "" : input.path;
        const storedPath = containedUserPath(computerMode, bot.id, requested);
        let entries: Awaited<ReturnType<SandboxProvider["listFiles"]>>;
        if (computer.state === "running" && computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          scheduleComputerSleep(deps.jobs, computer.id);
          const ref = toComputerRef(computer);
          await ensureComputerWorkspaceLayout(deps.sandbox, ref, computerMode, bot.id, ctx);
          entries = await deps.sandbox.listFiles(ref, storedPath, ctx);
        } else {
          entries = await deps.home.list(computer.homeKey, storedPath, ctx);
        }
        return entries.map((entry) => ({
          ...entry,
          path: displayBotWorkspacePath(computerMode, bot.id, requested, entry.path),
        }));
      }),
      readFile: authed.computer.readFile.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const computer = bot.computer;
        const computerMode = parseComputerMode(computer.scope);
        const storedPath = containedUserPath(computerMode, bot.id, input.path);
        if (isWorkspaceDirectory(storedPath)) {
          throw new ORPCError("NOT_FOUND", { message: "file not found" });
        }
        const ctx = computerContext(context.actor, bot.id, "read");
        const live = computer.state === "running" && Boolean(computer.providerRef);
        if (live) {
          await deps.prisma.computer.updateMany({
            where: { id: computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          scheduleComputerSleep(deps.jobs, computer.id);
        }
        const ref = toComputerRef(computer);
        const page = await readChatTextPage({
          offset: input.offset ?? 1,
          limit: input.limit ?? CHAT_FILE_READ_MAX_LINES,
          readAll: (maxBytes) =>
            live
              ? deps.sandbox.readFile(ref, storedPath, ctx, { maxBytes })
              : readHomeBytes(deps.home, computer.homeKey, storedPath, ctx, maxBytes),
          readRange: (offset, length) =>
            live
              ? readSandboxByteRange(deps.sandbox, ref, storedPath, offset, length, ctx)
              : readHomeRange(deps.home, computer.homeKey, storedPath, ctx, offset, length),
        }).catch(fileRpcError);
        return { path: input.path, ...page };
      }),
      saveFile: authed.computer.saveFile.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer) throw new IsolationError();
        const computer = bot.computer;
        const computerMode = parseComputerMode(computer.scope);
        const storedPath = containedUserPath(computerMode, bot.id, input.path);
        if (isWorkspaceDirectory(storedPath)) {
          throw new ORPCError("BAD_REQUEST", { message: "Path escapes the bot workspace" });
        }
        const content = new TextEncoder().encode(input.content);
        if (content.byteLength > CHAT_FILE_TEXT_BYTES) {
          throw new ORPCError("BAD_REQUEST", { message: "file is too large to save" });
        }
        const ctx = computerContext(context.actor, bot.id, "save");
        const live = computer.state === "running" && Boolean(computer.providerRef);
        if (live && computer.providerRef) {
          const ref = toComputerRef(computer);
          await ensureComputerWorkspaceLayout(deps.sandbox, ref, computerMode, bot.id, ctx);
          await deps.sandbox.writeFile(ref, { path: storedPath, content }, ctx);
          await deps.prisma.computer.updateMany({
            where: { id: computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          scheduleComputerSleep(deps.jobs, computer.id);
        } else {
          await deps.home.writeFile(computer.homeKey, storedPath, input.content, ctx);
        }
        if (bot.thread) {
          await deps.events
            .append({
              spaceId: context.actor.spaceId,
              threadId: bot.thread.id,
              botId: bot.id,
              type: "computer.command",
              payload: {
                executionId: randomUUID(),
                kind: "write_file",
                command: input.path,
                cwd: ".",
                status: "done",
                exitCode: 0,
                output: "",
                bytes: content.byteLength,
              },
            })
            .catch(() => undefined);
        }
        return { ok: true as const, path: input.path };
      }),
      changedFiles: authed.computer.changedFiles.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (!bot.computer || !bot.thread) throw new IsolationError();
        const computerMode = parseComputerMode(bot.computer.scope);
        const events = await deps.prisma.event.findMany({
          where: {
            spaceId: context.actor.spaceId,
            threadId: bot.thread.id,
            botId: bot.id,
            type: "computer.command",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: COMPUTER_COMMAND_HISTORY_EVENTS,
          select: { payload: true, createdAt: true },
        });
        const seen = new Set<string>();
        const changed: { path: string; at: string }[] = [];
        for (const event of events) {
          const parsed = ComputerCommandSchema.safeParse(event.payload);
          if (!parsed.success) continue;
          const command = parsed.data;
          if (
            command.kind !== "write_file" ||
            command.status !== "done" ||
            command.exitCode !== 0
          ) {
            continue;
          }
          if (seen.has(command.command)) continue;
          try {
            const stored = userWorkspacePath(computerMode, bot.id, command.command);
            if (isWorkspaceDirectory(stored)) continue;
          } catch {
            continue;
          }
          seen.add(command.command);
          changed.push({ path: command.command, at: event.createdAt.toISOString() });
          if (changed.length >= CHANGED_CHAT_FILES) break;
        }
        return changed;
      }),
      downloadFile: authed.computer.downloadFile.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const computer = bot.computer;
        if (!computer) throw new IsolationError();
        const computerMode = parseComputerMode(computer.scope);
        const storedPath = containedUserPath(computerMode, bot.id, input.path);
        if (isWorkspaceDirectory(storedPath)) {
          throw new ORPCError("NOT_FOUND", { message: "file not found" });
        }
        const maxBytes = attachmentMaxBytes(deps.env);
        const ctx = computerContext(context.actor, bot.id, "download");
        if (computer.state === "running" && computer.providerRef) {
          await keepComputerAwake(deps, computer.id);
          const bytes = await deps.sandbox
            .readFile(toComputerRef(computer), storedPath, ctx, { maxBytes })
            .catch((error: unknown) => {
              if (isOversizedFileError(error)) {
                throw new ORPCError("BAD_REQUEST", {
                  message: `File exceeds the ${attachmentSizeLabel(maxBytes)} download limit.`,
                });
              }
              throw error;
            });
          return { path: input.path, contentBase64: Buffer.from(bytes).toString("base64") };
        }
        if (!(deps.home instanceof LocalAgentHomeStore)) {
          throw new ORPCError("CONFLICT", { message: "Start the computer first." });
        }
        let window: { bytes: Uint8Array; size: number };
        try {
          window = await deps.home.readBytes(computer.homeKey, storedPath, ctx, { maxBytes: 0 });
        } catch (error) {
          fileRpcError(error);
        }
        if (window.size > maxBytes) {
          throw new ORPCError("BAD_REQUEST", {
            message: `File exceeds the ${attachmentSizeLabel(maxBytes)} download limit.`,
          });
        }
        const { bytes } = await deps.home
          .readBytes(computer.homeKey, storedPath, ctx, { maxBytes })
          .catch(fileRpcError);
        return { path: input.path, contentBase64: Buffer.from(bytes).toString("base64") };
      }),
      uploadFile: authed.computer.uploadFile.handler(async ({ context, input }) => {
        let bot = await repos.getBot(context.actor, input.botId);
        if (await expireStaleComputerControl(deps, bot.computer)) {
          bot = await repos.getBot(context.actor, input.botId);
        }
        const computer = bot.computer;
        if (!computer) throw new IsolationError();
        if (computer.state !== "running" || !computer.providerRef) {
          throw new ORPCError("CONFLICT", { message: "Start the computer first." });
        }
        if (!holdsComputerControl(computer, bot.id, context.actor)) {
          throw new ORPCError("FORBIDDEN", { message: "Take control first." });
        }
        const maxBytes = attachmentMaxBytes(deps.env);
        if (input.contentBase64.length > Math.ceil(maxBytes / 3) * 4) {
          throw new ORPCError("BAD_REQUEST", {
            message: `File exceeds the ${attachmentSizeLabel(maxBytes)} upload limit.`,
          });
        }
        const content = Buffer.from(input.contentBase64, "base64");
        if (content.byteLength > maxBytes) {
          throw new ORPCError("BAD_REQUEST", {
            message: `File exceeds the ${attachmentSizeLabel(maxBytes)} upload limit.`,
          });
        }
        await keepComputerAwake(deps, computer.id);
        let storedPath: string;
        try {
          storedPath = resolveBotUploadPath(parseComputerMode(computer.scope), bot.id, input.path);
        } catch (error) {
          if (error instanceof Error && /escapes/i.test(error.message)) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
          }
          throw error;
        }
        await deps.sandbox.writeFile(
          toComputerRef(computer),
          { path: storedPath, content },
          computerContext(context.actor, bot.id, "upload"),
        );
        return { ok: true as const };
      }),
      commands: authed.computer.commands.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        const events = await deps.prisma.event.findMany({
          where: { spaceId: context.actor.spaceId, botId: bot.id, type: "computer.command" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: COMPUTER_COMMAND_HISTORY_EVENTS,
          select: { payload: true, createdAt: true },
        });
        return foldComputerCommands(
          events.reverse().flatMap((event) => {
            const parsed = ComputerCommandSchema.safeParse(event.payload);
            return parsed.success
              ? [{ ...parsed.data, createdAt: event.createdAt.toISOString() }]
              : [];
          }),
        );
      }),
      terminalUrl: authed.computer.terminalUrl.handler(async ({ context, input }) => {
        let bot = await repos.getBot(context.actor, input.botId);
        if (await expireStaleComputerControl(deps, bot.computer)) {
          bot = await repos.getBot(context.actor, input.botId);
        }
        const computer = bot.computer;
        if (
          !computer?.providerRef ||
          computer.state !== "running" ||
          !deps.sandbox.connectTerminal ||
          !computerSupportsTerminal(computer.kind)
        ) {
          return { url: null };
        }
        // Same rule as the interactive screen: only the user holding this bot's control lease.
        if (!holdsComputerControl(computer, bot.id, context.actor) || !computer.controlLeaseId) {
          throw new ORPCError("FORBIDDEN", { message: "Take control first." });
        }
        const session = await deps.sandbox
          .connectTerminal(
            toComputerRef(computer),
            {
              controlToken: computer.controlLeaseId,
              cwd: resolveBotWorkspaceCwd(parseComputerMode(computer.scope), bot.id, undefined),
            },
            await computerScreenContext(
              deps.prisma,
              context.actor,
              computer.id,
              bot.id,
              "terminal",
            ),
          )
          .catch((error: unknown) => clearGoneSandbox(deps, computer, error));
        if (!session) return { url: null };
        await keepComputerAwake(deps, computer.id);
        return {
          url: addScreenProxyCapability(
            withViewOnly(session.url, false),
            deps.env.screenProxySecret,
            deps.env.webOrigin,
            {
              botId: bot.id,
              computerId: computer.id,
              botGeneration: bot.screenGeneration,
              computerGeneration: computer.screenGeneration,
              controlLeaseId: computer.controlLeaseId,
            },
            undefined,
            session.headers,
          ),
        };
      }),
      screenUrl: authed.computer.screenUrl.handler(async ({ context, input }) => {
        let bot = await repos.getBot(context.actor, input.botId);
        if (await expireStaleComputerControl(deps, bot.computer)) {
          bot = await repos.getBot(context.actor, input.botId);
        }
        if (
          !bot.computer?.providerRef ||
          (bot.computer.state !== "running" && bot.computer.state !== "booting")
        ) {
          return { url: null };
        }
        const computer = bot.computer;
        // Everyone in the Space can watch; only the person holding control can drive it.
        const holder = holdsComputerControl(computer, bot.id, context.actor);
        const session = await deps.sandbox
          .connectScreen(
            toComputerRef(computer),
            {
              view: "stream",
              interactive: holder,
              controlToken: holder ? (computer.controlLeaseId ?? undefined) : undefined,
            },
            await computerScreenContext(deps.prisma, context.actor, computer.id, bot.id, "screen"),
          )
          .catch(async (error: unknown) => {
            if (isComputerScreenUnavailable(error)) {
              throw new ORPCError("CONFLICT", { message: COMPUTER_SCREEN_UNAVAILABLE });
            }
            return clearGoneSandbox(deps, computer, error);
          });
        if (!session?.url) return { url: null };
        scheduleComputerSleep(deps.jobs, bot.computer.id);
        const viewUrl = withViewOnly(session.url, !holder);
        return {
          url: addScreenProxyCapability(
            viewUrl,
            deps.env.screenProxySecret,
            deps.env.webOrigin,
            {
              botId: bot.id,
              computerId: computer.id,
              botGeneration: bot.screenGeneration,
              computerGeneration: computer.screenGeneration,
              controlLeaseId: computer.controlLeaseId,
            },
            undefined,
            session.headers,
          ),
        };
      }),
      heartbeat: authed.computer.heartbeat.handler(async ({ context, input }) => {
        const bot = await repos.getBot(context.actor, input.botId);
        if (bot.computer?.state === "running" && bot.computer.providerRef) {
          await deps.prisma.computer.updateMany({
            where: { id: bot.computer.id, state: "running" },
            data: { updatedAt: new Date() },
          });
          await touchRunningComputer(
            { sandbox: deps.sandbox, jobs: deps.jobs },
            {
              id: bot.computer.id,
              homeKey: bot.computer.homeKey,
              providerRef: bot.computer.providerRef,
              kind: bot.computer.kind,
              runningSince: bot.computer.runningSince,
              controlHolder: bot.computer.controlHolder,
              controlLeaseId: bot.computer.controlLeaseId,
              controlLeaseExpiresAt: bot.computer.controlLeaseExpiresAt,
            },
          ).catch(() => undefined);
        }
        return { ok: true as const };
      }),
    },
  };
}
