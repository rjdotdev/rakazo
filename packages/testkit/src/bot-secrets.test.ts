import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import {
  EncryptedSecretStore,
  forgetBotSecret,
  relabelVaultItem,
  ScriptedAgentRuntime,
} from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import { resolveEncryptionKey } from "@rakazo/core";
import { answerRunInput, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { asSystem } from "./system-db.js";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeIntegration = hasDb ? describe : describe.skip;
const destination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};
const key = "fake-reusable-api-key";

describeIntegration("reusable credential lifecycle", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let db: Awaited<ReturnType<typeof createApp>>["prisma"];
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-secret-lifecycle-"));
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const auth = new Headers(init?.headers).get("Authorization");
    return Response.json({
      authenticated: auth === `Bearer ${key}` || auth === `Bearer ${key}-rotated`,
      echo: auth,
    });
  });

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      remoteConnectors: {
        fetch,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      },
    });
    db = asSystem(handles.prisma);
  });
  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each([false, true])(
    "saves, reuses, rotates and revokes without model-visible plaintext (approval rule: %s)",
    async (requireApproval) => {
      fetch.mockClear();
      const seen: string[] = [];
      let calls: Array<{ name: string; args: Record<string, unknown> }> = [
        {
          name: "request_secret",
          args: { label: "API key", purpose: "api_key", credential: destination },
        },
      ];
      const runtime = vi
        .spyOn(ScriptedAgentRuntime.prototype, "run")
        .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
          seen.push(
            JSON.stringify({
              prompt: request.prompt,
              history: request.history,
              tools: request.tools,
            }),
          );
          for (const [index, call] of calls.entries()) {
            yield { type: "tool", ...call, executionId: `${request.runId}:${index}` };
          }
          yield { type: "done", text: "Done" };
        });
      try {
        const seeded = await seedRun(`reusable-${requireApproval}`, "Save the API credential");
        // The owner allowed using and forgetting saved credentials, so only request_secret asks.
        await db.userActionApprovalRule.createMany({
          data: ["secret_request", "forget_secret"].map((matchValue) => ({
            userId: seeded.me.userId,
            effect: "always_allow",
            matchKind: "tool",
            matchValue,
          })),
        });
        if (requireApproval) {
          await db.userActionApprovalRule.create({
            data: {
              userId: seeded.me.userId,
              effect: "require_approval",
              matchKind: "tool",
              matchValue: "request_secret",
            },
          });
        }
        await runAsSystem("background job run.continue", () =>
          handles.executor.continueRun(seeded.run.id, "test-worker"),
        );
        const approve = async (runId: string, interruptBeforeCard = false) => {
          if (!requireApproval) return;
          // A just-continued run can still sit requeued while the previous run's
          // worker releases the computer lease, so the card may land a moment later.
          const message = await vi.waitFor(
            async () =>
              db.message.findFirstOrThrow({
                where: { runId, role: "bot" },
                orderBy: { createdAt: "desc" },
              }),
            { timeout: 15_000 },
          );
          expect(message.blocks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ approvalEffectId: expect.any(String) }),
            ]),
          );
          if (interruptBeforeCard) {
            // Reproduce a worker stopping after releasing the approved effect to intended,
            // before the protected card transaction commits. No background job is enqueued.
            expect(
              await runAsTenant(seeded.me, () =>
                answerRunInput(handles.prisma, {
                  spaceId: seeded.me.spaceId,
                  threadId: seeded.thread.id,
                  runId,
                  messageId: message.id,
                  answeredByUserId: seeded.me.userId,
                  answer: "allow",
                }),
              ),
            ).toBe(true);
            await db.externalEffect.updateMany({
              where: { runId, kind: "request_secret", status: "approved" },
              data: { status: "intended" },
            });
            await db.run.update({
              where: { id: runId },
              data: {
                status: "running",
                leaseOwner: "interrupted-worker",
                leaseExpiresAt: new Date(Date.now() - 60_000),
              },
            });
            await runAsSystem("background job run.continue", () =>
              handles.executor.continueRun(runId, "recovery-worker"),
            );
          } else {
            await rpc(seeded.cookie, "threads/answer", {
              botId: seeded.bot.id,
              runId,
              messageId: message.id,
              answer: "allow",
            });
          }
          await vi.waitFor(
            async () => {
              const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
              expect(["completed", "waiting_input"]).toContain(run.status);
            },
            { timeout: 15_000 },
          );
        };
        await approve(seeded.run.id);
        const answer = async (runId: string, value: string) => {
          const message = await db.message.findFirstOrThrow({
            where: { runId, role: "bot" },
            orderBy: { createdAt: "desc" },
          });
          expect(message.blocks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ input: "secret", credential: destination }),
            ]),
          );
          await rpc(seeded.cookie, "threads/answer", {
            botId: seeded.bot.id,
            runId,
            messageId: message.id,
            answer: value,
          });
          await vi.waitFor(
            async () => {
              expect(await db.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
                status: "completed",
                error: null,
              });
            },
            { timeout: 15_000 },
          );
        };
        expect(await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
          status: "waiting_input",
          error: null,
        });
        // An invalid value rolls back the run transition and leaves the card pending.
        const pending = await db.message.findFirstOrThrow({
          where: { runId: seeded.run.id, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(pending.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "ask",
              input: "secret",
              status: "pending",
              credential: destination,
            }),
          ]),
        );
        for (const invalid of ["x".repeat(16_385), "key\r\nX-Evil: injected", "key "]) {
          await expect(
            rpc(seeded.cookie, "threads/answer", {
              botId: seeded.bot.id,
              runId: seeded.run.id,
              messageId: pending.id,
              answer: invalid,
            }),
          ).rejects.toThrow();
        }
        expect(await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
          status: "waiting_input",
        });
        expect(await db.vaultCredential.count({ where: { userId: seeded.me.userId } })).toBe(0);
        await answer(seeded.run.id, key);
        const stored = await db.vaultCredential.findFirstOrThrow({
          where: { userId: seeded.me.userId },
        });
        // Saved in the account vault, which the Space uses until it has its own.
        expect(stored).toMatchObject({
          ...destination,
          userId: seeded.me.userId,
          spaceId: null,
        });
        expect(stored.ciphertext).toMatch(/^v2:/);
        expect(stored.ciphertext).not.toContain(key);
        expect(await db.secret.count({ where: { kind: `run-secret:${seeded.run.id}` } })).toBe(0);

        const nextRun = async (nextCalls: typeof calls) => {
          calls = nextCalls;
          const task = await db.task.create({
            data: {
              userId: seeded.me.userId,
              spaceId: seeded.me.spaceId,
              botId: seeded.bot.id,
              threadId: seeded.thread.id,
              prompt: "Use the saved credential",
              status: "queued",
            },
          });
          const run = await db.run.create({
            data: {
              userId: seeded.me.userId,
              spaceId: seeded.me.spaceId,
              botId: seeded.bot.id,
              threadId: seeded.thread.id,
              taskId: task.id,
              trigger: "user",
              status: "queued",
            },
          });
          await runAsSystem("background job run.continue", () =>
            handles.executor.continueRun(run.id, "test-worker"),
          );
          return run.id;
        };
        const request = {
          name: "secret_request",
          args: { name: destination.name, url: `${destination.origin}/v1/items` },
        };
        const useRun = await nextRun([
          { name: "list_secrets", args: {} },
          {
            name: "request_secret",
            args: { label: "API key", purpose: "api_key", credential: destination },
          },
          request,
        ]);
        await approve(useRun);
        await vi.waitFor(
          async () => {
            expect(await db.run.findUniqueOrThrow({ where: { id: useRun } })).toMatchObject({
              status: "completed",
              error: null,
            });
          },
          { timeout: 15_000 },
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(
          await db.externalEffect.findFirstOrThrow({
            where: { runId: useRun, kind: "secret_request" },
          }),
        ).toMatchObject({
          status: "completed",
          result: {
            status: 200,
            body: { authenticated: true, echo: expect.stringContaining("[redacted]") },
          },
        });

        const rotateRun = await nextRun([
          {
            name: "request_secret",
            args: { label: "API key", purpose: "api_key", credential: destination, replace: true },
          },
        ]);
        await vi.waitFor(
          async () => {
            expect(await db.run.findUniqueOrThrow({ where: { id: rotateRun } })).toMatchObject({
              status: "waiting_input",
            });
          },
          { timeout: 15_000 },
        );
        await approve(rotateRun, true);
        expect(await db.run.findUniqueOrThrow({ where: { id: rotateRun } })).toMatchObject({
          status: "waiting_input",
        });
        expect(
          await db.vaultCredential.findUniqueOrThrow({ where: { id: stored.id } }),
        ).toMatchObject({
          ciphertext: stored.ciphertext,
        });
        await answer(rotateRun, `${key}-rotated`);
        expect(
          await db.vaultCredential.findUniqueOrThrow({ where: { id: stored.id } }),
        ).not.toMatchObject({ ciphertext: stored.ciphertext });
        const rotatedUseRun = await nextRun([request]);
        await vi.waitFor(
          async () => {
            expect(await db.run.findUniqueOrThrow({ where: { id: rotatedUseRun } })).toMatchObject({
              status: "completed",
              error: null,
            });
          },
          { timeout: 15_000 },
        );
        expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBe(
          `Bearer ${key}-rotated`,
        );
        // The owner sees each use, newest first, with its chat; another member finds no such item.
        const title = `Executor reusable-${requireApproval}`;
        const uses = await rpc<Array<{ at: string }>>(seeded.cookie, "vault/activity", {
          name: destination.name,
        });
        expect(uses).toEqual(
          [rotatedUseRun, useRun].map(() => ({
            at: expect.any(String),
            botName: title,
            site: destination.origin,
            chat: { title },
          })),
        );
        expect(uses[0]!.at >= uses[1]!.at).toBe(true);
        const stranger = await signup(
          `vault-stranger-${requireApproval}-${stamp}@rakazo.test`,
          "S",
        );
        await expect(rpc(stranger, "vault/activity", { name: destination.name })).rejects.toThrow(
          "vault/activity failed (404)",
        );
        const count = fetch.mock.calls.length;
        const forgotten = await nextRun([
          { name: "forget_secret", args: { name: destination.name } },
          request,
        ]);
        // The deletion alone does not prove the run finished: the trailing use request and
        // its writes can still be pending. Wait for the run itself, then assert the effects.
        await vi.waitFor(
          async () => {
            expect(await db.run.findUniqueOrThrow({ where: { id: forgotten } })).toMatchObject({
              status: "completed",
              error: null,
            });
          },
          { timeout: 15_000 },
        );
        expect(await db.vaultCredential.count({ where: { userId: seeded.me.userId } })).toBe(0);
        expect(fetch).toHaveBeenCalledTimes(count);
        // Each run that sent the key has its own use; the refused one after forgetting has none.
        const used = await db.auditEvent.findMany({
          where: { action: "credential.used", targetId: stored.id },
          orderBy: { createdAt: "asc" },
        });
        expect(used).toEqual(
          [useRun, rotatedUseRun].map((runId) =>
            expect.objectContaining({
              targetType: "vault_credential",
              runId,
              actorType: "bot",
              actorId: seeded.bot.id,
            }),
          ),
        );
        const [messages, events, effects, tasks] = await Promise.all([
          db.message.findMany({ where: { threadId: seeded.thread.id } }),
          db.event.findMany({ where: { threadId: seeded.thread.id } }),
          db.externalEffect.findMany({ where: { spaceId: seeded.me.spaceId } }),
          db.task.findMany({ where: { botId: seeded.bot.id } }),
        ]);
        expect(JSON.stringify({ seen, messages, events, effects, tasks, used })).not.toContain(key);
      } finally {
        runtime.mockRestore();
      }
    },
  );

  it("saves Block with an item in one write, and keeps it through an older app's save", async () => {
    const seeded = await seedRun("vault-access", "Use the key");
    const auth = { type: "bearer" };
    // A contact can't be blocked: refused with the item, so nothing is saved.
    await expect(
      rpc(seeded.cookie, "vault/put", {
        destination: { origin: "", auth: { type: "contact" } },
        value: JSON.stringify({ name: "Alex Rivera" }),
        title: "Home",
        policy: "off",
      }),
    ).rejects.toThrow("vault/put failed (400)");
    const saved = await rpc<{ name: string; policy: string }>(seeded.cookie, "vault/put", {
      destination: { origin: destination.origin, auth },
      value: "fake-access-key",
      title: "Stripe",
      policy: "off",
    });
    expect(saved.policy).toBe("off");
    // An app from before Block saves the item without it.
    await rpc(seeded.cookie, "vault/put", {
      destination: { name: saved.name, origin: destination.origin, auth },
      title: "Stripe live",
    });
    expect(await rpc(seeded.cookie, "vault/list", {})).toEqual([
      expect.objectContaining({ title: "Stripe live", policy: "off" }),
    ]);
    const stranger = await signup(`vault-access-stranger-${stamp}@rakazo.test`, "S");
    await expect(
      rpc(stranger, "vault/put", {
        destination: { name: saved.name, origin: destination.origin, auth },
        policy: "allow",
      }),
    ).rejects.toThrow("vault/put failed (404)");
  });

  it.each([
    ["Block", { policy: "off" as const }],
    ["choice of no bots", { bots: { allBots: false, botIds: [] } }],
  ])("makes a bot's removal wait for the owner's %s, then refuses it", async (label, edit) => {
    const seeded = await seedRun(`vault-lock-${label.length}`, "Use the key");
    const saved = await rpc<{ name: string }>(seeded.cookie, "vault/put", {
      destination: { origin: destination.origin, auth: { type: "bearer" } },
      value: "fake-lock-key",
    });
    const row = () => db.vaultCredential.findFirst({ where: { userId: seeded.me.userId } });
    const before = await row();
    // The owner's Block holds its transaction open after writing, until `commit` is called.
    let commit = () => {};
    let written = () => {};
    const held = new Promise<void>((resolve) => {
      written = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const owner = new Proxy(handles.prisma, {
      get: (target, key) =>
        key === "$transaction"
          ? (fn: (tx: unknown) => Promise<unknown>) =>
              target.$transaction(async (tx) => {
                const result = await fn(tx);
                written();
                await gate;
                return result;
              })
          : Reflect.get(target, key),
    });
    const blocking = runAsTenant(seeded.me, () =>
      relabelVaultItem(owner, seeded.me, saved.name, edit),
    );
    await held;
    let settled = false;
    const removal = runAsTenant(seeded.me, () =>
      forgetBotSecret(handles.prisma, { ...seeded.me, botId: seeded.bot.id }, saved.name),
    ).finally(() => {
      settled = true;
    });
    // Without the vault lock in the Block, the removal would read the item as allowed and delete it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    commit();
    await blocking;
    // Told what it would be of a missing item, and the item stays.
    expect(await removal).toEqual({ removed: false });
    expect(await row()).toMatchObject({ id: before!.id, ciphertext: before!.ciphertext });
  });

  it("limits an item to the owner's chosen bots in each Space, row-secured and cascaded", async () => {
    const seeded = await seedRun("vault-bots", "Use the key");
    const newBot = (cookie: string, space?: string) =>
      rpc<{ id: string }>(
        cookie,
        "bots/create",
        { name: "Helper", title: "", description: "", instructions: "", notifyOnFinish: false },
        space,
      );
    const helper = await newBot(seeded.cookie);
    const auth = { type: "bearer" };
    const saved = await rpc<{ name: string; allBots: boolean; botIds: string[] }>(
      seeded.cookie,
      "vault/put",
      {
        destination: { origin: destination.origin, auth },
        value: "fake-chosen-key",
        allBots: false,
        botIds: [seeded.bot.id],
      },
    );
    expect(saved).toMatchObject({ allBots: false, botIds: [seeded.bot.id] });
    const item = { name: saved.name, origin: destination.origin, auth };
    // Only the owner's own bots of the Space they act in.
    const stranger = await signup(`vault-bots-stranger-${stamp}@rakazo.test`, "S");
    const second = await rpc<{ id: string }>(seeded.cookie, "spaces/create", { name: "Second" });
    const there = await newBot(seeded.cookie, second.id);
    for (const botId of [(await newBot(stranger)).id, there.id, "missing-bot"]) {
      await expect(
        rpc(seeded.cookie, "vault/put", { destination: item, botIds: [botId] }),
      ).rejects.toThrow("vault/put failed (400)");
    }
    // The account item's other Space chooses for its own bots, and its All bots never widens the
    // first Space's choice.
    const inSecond = (choice: object) =>
      rpc(seeded.cookie, "vault/put", { destination: item, ...choice }, second.id);
    expect(await inSecond({ allBots: false, botIds: [there.id] })).toMatchObject({
      allBots: false,
      botIds: [there.id],
    });
    expect(await inSecond({ allBots: true })).toMatchObject({ allBots: true });
    expect(await rpc(seeded.cookie, "vault/list", {})).toEqual([
      expect.objectContaining({ allBots: false, botIds: [seeded.bot.id] }),
    ]);
    // Each Space's choices are row-secured to that Space and member. This database login is the
    // owner, which row security doesn't bind, so the policies themselves are checked.
    const policies = await db.$queryRaw<Array<{ tablename: string; qual: string }>>`
      SELECT tablename, qual FROM pg_policies
      WHERE tablename IN ('vault_credential_bots', 'vault_credential_limits')
        AND policyname LIKE '%_tenant'
      ORDER BY tablename`;
    expect(policies.map((policy) => policy.tablename)).toEqual([
      "vault_credential_bots",
      "vault_credential_limits",
    ]);
    for (const { qual } of policies) {
      expect(qual).toContain("app.user_id");
      expect(qual).toContain("app.space_id");
    }
    // A bot not chosen finds nothing to remove; the chosen one can.
    const forget = (botId: string) =>
      runAsTenant(seeded.me, () =>
        forgetBotSecret(handles.prisma, { ...seeded.me, botId }, saved.name),
      );
    expect(await forget(helper.id)).toEqual({ removed: false });
    // Read under another Space's tenant, where the runtime login sees none of this Space's limit
    // rows, it still finds nothing rather than an item it was limited from.
    expect(
      await runAsTenant({ ...seeded.me, spaceId: second.id }, () =>
        forgetBotSecret(handles.prisma, { ...seeded.me, botId: helper.id }, saved.name),
      ),
    ).toEqual({ removed: false });
    expect(await db.vaultCredential.count({ where: { userId: seeded.me.userId } })).toBe(1);
    // Removing a bot removes its choice.
    await rpc(seeded.cookie, "bots/remove", { botId: there.id }, second.id);
    await vi.waitFor(async () =>
      expect(await db.vaultCredentialBot.count({ where: { botId: there.id } })).toBe(0),
    );
    expect(await forget(seeded.bot.id)).toEqual({ removed: true });
    expect(await db.vaultCredential.count({ where: { userId: seeded.me.userId } })).toBe(0);
    expect(await db.vaultCredentialBot.count({ where: { userId: seeded.me.userId } })).toBe(0);
    expect(await db.vaultCredentialLimit.count({ where: { userId: seeded.me.userId } })).toBe(0);
  });

  it("reuses a website login saved for the same site under another name", async () => {
    const site = "https://www.login.example.test";
    const password = "fake-site-password-3b9e";
    const seen: string[] = [];
    let calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const requestLogin = (name: string, origin = site) => ({
      name: "request_secret",
      args: {
        label: "Sign in",
        purpose: "password",
        credential: { name, origin, auth: { type: "login" } },
        fields: ["Username", "Password"],
      },
    });
    const runtime = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
        seen.push(JSON.stringify({ prompt: request.prompt, history: request.history }));
        for (const [index, call] of calls.entries()) {
          yield { type: "tool", ...call, executionId: `${request.runId}:${index}` };
        }
        yield { type: "done", text: "Done" };
      });
    try {
      calls = [requestLogin("site_login")];
      const seeded = await seedRun("site-login", "Sign in to the site");
      await runAsSystem("background job run.continue", () =>
        handles.executor.continueRun(seeded.run.id, "test-worker"),
      );
      const card = await db.message.findFirstOrThrow({
        where: { runId: seeded.run.id, role: "bot" },
        orderBy: { seq: "desc" },
      });
      await rpc(seeded.cookie, "threads/answer", {
        botId: seeded.bot.id,
        runId: seeded.run.id,
        messageId: card.id,
        answer: "",
        fields: [
          { label: "Username", value: "fake-user", hidden: false },
          { label: "Password", value: password, hidden: true },
        ],
      });
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: seeded.run.id } })).toMatchObject({
            status: "completed",
            error: null,
          });
        },
        { timeout: 15_000 },
      );

      const nextRun = async (owner: typeof seeded, nextCalls: typeof calls) => {
        calls = nextCalls;
        const task = await db.task.create({
          data: {
            userId: owner.me.userId,
            spaceId: owner.me.spaceId,
            botId: owner.bot.id,
            threadId: owner.thread.id,
            prompt: "Sign in again",
            status: "queued",
          },
        });
        const run = await db.run.create({
          data: {
            userId: owner.me.userId,
            spaceId: owner.me.spaceId,
            botId: owner.bot.id,
            threadId: owner.thread.id,
            taskId: task.id,
            trigger: "user",
            status: "queued",
          },
        });
        await runAsSystem("background job run.continue", () =>
          handles.executor.continueRun(run.id, "test-worker"),
        );
        return db.run.findUniqueOrThrow({ where: { id: run.id } });
      };

      // Another name for the same site gets the saved login's name, without a card.
      const reused = await nextRun(seeded, [requestLogin("my_site_account")]);
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: reused.id } })).toMatchObject({
            status: "completed",
            error: null,
          });
        },
        { timeout: 15_000 },
      );
      expect(
        await db.externalEffect.findFirstOrThrow({
          where: { runId: reused.id, kind: "request_secret" },
        }),
      ).toMatchObject({
        status: "completed",
        result: { saved: true, name: "site_login", origin: site, auth: { type: "login" } },
      });
      // The host without www. is another site.
      const bare = await nextRun(seeded, [
        requestLogin("bare_login", "https://login.example.test"),
      ]);
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: bare.id } })).toMatchObject({
            status: "waiting_input",
          });
        },
        { timeout: 15_000 },
      );
      // Another member's vault is not searched.
      const other = await seedRun("site-login-other", "Sign in to the site");
      const otherRun = await nextRun(other, [requestLogin("my_site_account")]);
      await vi.waitFor(
        async () => {
          expect(await db.run.findUniqueOrThrow({ where: { id: otherRun.id } })).toMatchObject({
            status: "waiting_input",
          });
        },
        { timeout: 15_000 },
      );
      expect(await db.vaultCredential.count({ where: { origin: site } })).toBe(1);

      const [messages, events, effects] = await Promise.all([
        db.message.findMany({ where: { threadId: seeded.thread.id } }),
        db.event.findMany({ where: { threadId: seeded.thread.id } }),
        db.externalEffect.findMany({ where: { spaceId: seeded.me.spaceId } }),
      ]);
      expect(JSON.stringify({ seen, messages, events, effects })).not.toContain(password);
    } finally {
      runtime.mockRestore();
    }
  });

  it("moves a saved login to the site of the card answered last, with that card's value", async () => {
    const www = { name: "acme", origin: "https://www.acme.example.test", auth: { type: "login" } };
    const sites = {
      login: { ...www, origin: "https://login.acme.example.test" },
      other: { ...www, origin: "https://acme-insure.example.test" },
    };
    const runtime = vi
      .spyOn(ScriptedAgentRuntime.prototype, "run")
      .mockImplementation(async function* (request): AsyncIterable<AgentRuntimeEvent> {
        const credential = request.runId === runs.login.runId ? sites.login : sites.other;
        yield {
          type: "tool",
          name: "request_secret",
          args: { label: "Sign in", purpose: "password", credential, replace: true },
          executionId: `${request.runId}:0`,
        };
        yield { type: "done", text: "Done" };
      });
    const runs = {} as Record<keyof typeof sites, { runId: string; botId: string; card: string }>;
    try {
      const seeded = await seedRun("login-replace", "Sign in");
      const { userId, spaceId } = seeded.me;
      await rpc(seeded.cookie, "vault/put", {
        destination: www,
        value: JSON.stringify({ username: "fake-user", password: "fake-password-www" }),
      });
      const saved = await db.vaultCredential.findFirstOrThrow({ where: { userId } });
      // A second bot of the same member asks to replace the same login for another site.
      const bot = await rpc<{ id: string }>(seeded.cookie, "bots/create", {
        name: "Executor login-replace 2",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      const thread = await db.thread.findUniqueOrThrow({ where: { botId: bot.id } });
      const task = await db.task.create({
        data: {
          userId,
          spaceId,
          botId: bot.id,
          threadId: thread.id,
          prompt: "Sign in",
          status: "queued",
        },
      });
      const run = await db.run.create({
        data: {
          userId,
          spaceId,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          trigger: "user",
          status: "queued",
        },
      });
      runs.login = { runId: seeded.run.id, botId: seeded.bot.id, card: "" };
      runs.other = { runId: run.id, botId: bot.id, card: "" };
      for (const site of ["login", "other"] as const) {
        await runAsSystem("background job run.continue", () =>
          handles.executor.continueRun(runs[site].runId, "test-worker"),
        );
        const message = await db.message.findFirstOrThrow({
          where: { runId: runs[site].runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(message.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              credential: sites[site],
              replaces: { id: saved.id, origin: www.origin },
            }),
          ]),
        );
        runs[site].card = message.id;
      }
      expect(await db.vaultCredential.findMany({ where: { userId } })).toEqual([saved]);

      // Both answered at once, as the apps send them.
      const results = await Promise.all(
        (["login", "other"] as const).map(async (site) => {
          const response = await handles.app.request("/rpc/threads/answer", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://127.0.0.1:5173",
              cookie: seeded.cookie,
            },
            body: JSON.stringify({
              json: {
                botId: runs[site].botId,
                runId: runs[site].runId,
                messageId: runs[site].card,
                answer: "",
                fields: [
                  { label: "Username", value: "fake-user", hidden: false },
                  { label: "Password", value: `fake-password-${site}`, hidden: true },
                ],
              },
            }),
          });
          return response.status;
        }),
      );
      expect(results).toEqual([200, 200]);
      // One row, the same one, with the site and value of whichever card was saved last.
      const rows = await db.vaultCredential.findMany({ where: { userId } });
      expect(rows).toEqual([expect.objectContaining({ id: saved.id, name: www.name })]);
      const last = rows[0]!.origin === sites.login.origin ? "login" : "other";
      expect(rows[0]!.origin).toBe(sites[last].origin);
      const value = await new EncryptedSecretStore(resolveEncryptionKey()).load(
        rows[0]!.ciphertext,
        rows[0]!.id,
      );
      expect(value).toContain(`fake-password-${last}`);
      for (const other of ["www", last === "login" ? "other" : "login"]) {
        expect(value).not.toContain(`fake-password-${other}`);
      }
    } finally {
      runtime.mockRestore();
    }
  });

  async function seedRun(
    label: string,
    prompt: string,
    runState: {
      status?: string;
      leaseOwner?: string;
      leaseFence?: number;
      leaseExpiresAt?: Date;
      startedAt?: Date;
      completedAt?: Date;
    } = {},
  ) {
    const cookie = await signup(`executor-${label}-${stamp}@rakazo.test`, `Executor ${label}`);
    const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: `Executor ${label}`,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const thread = await db.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const task = await db.task.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        userId: me.userId,
        prompt,
        status: "queued",
      },
    });
    const run = await db.run.create({
      data: {
        spaceId: me.spaceId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: me.userId,
        status: runState.status ?? "queued",
        trigger: "user",
        leaseOwner: runState.leaseOwner,
        leaseFence: runState.leaseFence,
        leaseExpiresAt: runState.leaseExpiresAt,
        startedAt: runState.startedAt,
        completedAt: runState.completedAt,
      },
    });
    return { cookie, me, bot, thread, task, run };
  }

  async function signup(email: string, name: string) {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name }),
    });
    expect(response.status).toBeLessThan(400);
    const raw = response.headers.get("set-cookie") ?? "";
    const match = raw.match(/better-auth\.session_token=([^;]+)/);
    expect(match?.[1]).toBeTruthy();
    return `better-auth.session_token=${match![1]}`;
  }

  async function rpc<T>(
    cookie: string,
    procedure: string,
    body: unknown = {},
    space?: string,
  ): Promise<T> {
    const response = await handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        cookie,
        ...(space ? { "x-rakazo-space-id": space } : {}),
      },
      body: JSON.stringify({ json: body }),
    });
    const payload = (await response.json()) as { json?: T; error?: { message?: string } };
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message ?? `${procedure} failed (${response.status})`);
    }
    return discardBotIntroFromCreate(handles, cookie, procedure, payload.json as T);
  }
});
