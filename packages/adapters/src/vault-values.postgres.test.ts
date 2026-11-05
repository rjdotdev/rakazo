import { randomBytes, randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { BotSecretDestination } from "@rakazo/contracts";
import {
  asSystem,
  contentEncryptionOf,
  contentEncryptionStatus,
  createDb,
  LocalKeyProvider,
  masterKeysFromEnv,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveLoginFill, revealBotSecret, storeBotSecret } from "./bot-secrets.js";
import { EncryptedSecretStore } from "./secrets.js";
import { migrateVaultValues } from "./vault-values.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

const login = {
  origin: "https://login.example.test",
  auth: { type: "login" },
} as const;
const value = (password: string) =>
  JSON.stringify({ fields: [{ label: "Password", value: password, hidden: true }] });

describePostgres("vault values under the content keys (PostgreSQL)", () => {
  const address = `vault-values-${randomUUID()}@rakazo.test`;
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");
  const keyProvider = new LocalKeyProvider([
    { id: "vault-test", key: randomBytes(32) },
    ...masterKeysFromEnv(),
  ]);
  let sealing: ReturnType<typeof createDb>;
  // A deployment with content encryption off writes vault values as before.
  let plain: ReturnType<typeof createDb>;
  let system: ReturnType<typeof createDb>["prisma"];
  let scope: { userId: string; spaceId: string };
  let context: AdapterContext;

  beforeAll(async () => {
    sealing = createDb(url!, { keyProvider, encryptContent: true });
    plain = createDb(url!, { keyProvider, encryptContent: false });
    system = asSystem(sealing.prisma);
    scope = await runAsSystem("vault values fixture", () =>
      provisionMessagingIdentity(
        sealing.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    context = {
      operationId: "vault-values",
      traceId: "vault-values",
      ...scope,
      signal: new AbortController().signal,
    };
  });

  afterAll(async () => {
    if (scope) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: scope.spaceId } });
      await system.user.deleteMany({ where: { id: scope.userId } });
    }
    for (const db of [sealing, plain]) {
      if (!db) continue;
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  const save = (prisma: typeof sealing.prisma, name: string, password: string) =>
    runAsTenant(scope, () =>
      storeBotSecret({
        prisma,
        secretStore,
        scope,
        destination: { ...login, name } as BotSecretDestination,
        plaintext: value(password),
      }),
    );
  const fill = (name: string) =>
    runAsTenant(scope, () =>
      resolveLoginFill({
        prisma: sealing.prisma,
        secretStore,
        scope,
        runId: "run-1",
        name,
        field: "password",
      }),
    );
  const rows = () =>
    system.vaultCredential.findMany({ where: { userId: scope.userId }, orderBy: { name: "asc" } });

  const memberKeys = () => system.spaceKey.findMany({ where: { spaceId: `user:${scope.userId}` } });
  const waiting = async () =>
    (await contentEncryptionStatus(system)).tables.find((t) => t.table === "vault_credentials")!
      .plaintext;

  it("moves old rows beside new ones, once, and back for a rollback", async () => {
    await save(plain.prisma, "old", "fake-old-password");
    await save(plain.prisma, "broken", "fake-broken-password");
    // Until migrate creates the vault's key, saves keep the format the previous release reads.
    await save(sealing.prisma, "new", "fake-new-password");
    const [broken, newer, old] = await rows();
    expect(old!.ciphertext).toMatch(/^v2:/);
    expect(newer!.ciphertext).toMatch(/^v2:/);
    await system.vaultCredential.update({
      where: { id: broken!.id },
      data: {
        ciphertext: `v2:${Buffer.alloc(64).toString("base64")}`,
        updatedAt: broken!.updatedAt,
      },
    });
    expect(await fill("old")).toMatchObject({ text: "fake-old-password" });
    expect(await fill("new")).toMatchObject({ text: "fake-new-password" });

    const migrate = (mode: "encrypt" | "decrypt") =>
      runAsSystem("vault values migration", () =>
        migrateVaultValues(sealing.prisma, secretStore, context, { mode }),
      );
    const before = await waiting();
    await runAsSystem("vault values preview", () =>
      migrateVaultValues(sealing.prisma, secretStore, context, { mode: "encrypt", dryRun: true }),
    );
    expect(await memberKeys()).toEqual([]);
    // Other suites may share the database, so only this member's rows are checked by value.
    expect((await migrate("encrypt")).failed).toBeGreaterThanOrEqual(1);
    expect(await waiting()).toBeLessThanOrEqual(before - 2);
    const [key] = await memberKeys();
    expect((await rows()).find((row) => row.name === "new")!.ciphertext).toContain(key!.id);
    const after = await rows();
    expect(after.find((row) => row.name === "old")).toMatchObject({
      ciphertext: expect.stringMatching(/^rkz1:/),
      updatedAt: old!.updatedAt,
    });
    expect(after.find((row) => row.name === "broken")!.ciphertext).toBe(
      `v2:${Buffer.alloc(64).toString("base64")}`,
    );
    expect(await fill("old")).toMatchObject({ text: "fake-old-password" });
    await migrate("encrypt");
    expect(await rows()).toEqual(after);
    await save(sealing.prisma, "newest", "fake-newest-password");
    expect((await rows()).find((row) => row.name === "newest")!.ciphertext).toMatch(/^rkz1:/);
    expect(await fill("newest")).toMatchObject({ text: "fake-newest-password" });

    await migrate("decrypt");
    for (const row of (await rows()).filter((row) => row.name !== "broken")) {
      expect(row.ciphertext).toMatch(/^v2:/);
      expect(await secretStore.load(row.ciphertext, row.id)).toContain("fake-");
    }
    expect(
      await runAsTenant(scope, () =>
        revealBotSecret({ prisma: sealing.prisma, secretStore, scope, name: "new" }),
      ),
    ).toMatchObject({ fields: [{ value: "fake-new-password" }] });
  });

  it("shreds vault keys with their Space and their member", async () => {
    const ring = contentEncryptionOf(sealing.prisma)!.ring;
    await ring.current(`vault:${scope.spaceId}`);
    const scopes = [`vault:${scope.spaceId}`, `user:${scope.userId}`];
    const keys = () => system.spaceKey.count({ where: { spaceId: { in: scopes } } });
    expect(await keys()).toBe(2);
    await system.messagingIdentity.deleteMany({ where: { address } });
    await system.organization.deleteMany({ where: { id: scope.spaceId } });
    expect(await system.spaceKey.count({ where: { spaceId: scopes[0] } })).toBe(0);
    await system.user.deleteMany({ where: { id: scope.userId } });
    expect(await keys()).toBe(0);
  });
});
