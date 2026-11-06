import { randomBytes } from "node:crypto";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { BotSecretDestination } from "@rakazo/contracts";
import type { SpaceKeyRecord } from "@rakazo/db";
import { ContentKeyRing, LocalKeyProvider } from "@rakazo/db";
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import {
  listVaultItems,
  loadBotCommandEnvironment,
  loadLoginPasswordRedactions,
  relabelVaultItem,
  requestWithBotSecret,
  resolveLoginFill,
  resolveVaultCardFill,
  revealBotSecret,
  storeBotSecret,
} from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import { computerTools } from "./run-tools-computer.js";
import { ComposedSecretStore } from "./secret-store-factory.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";
import { migrateVaultValues } from "./vault-values.js";

const scope = { userId: "user-1", spaceId: "space-1" };
// The same store the previous release reads vault values with.
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const login = {
  name: "site",
  origin: "https://login.example.test",
  auth: { type: "login" },
} as BotSecretDestination;
const card = { name: "visa", origin: "", auth: { type: "card" } } as BotSecretDestination;
const loginValue = (password = "fake-password-1") =>
  JSON.stringify({
    fields: [
      { label: "Email", value: "alex@example.test", hidden: false },
      { label: "Password", value: password, hidden: true },
    ],
  });
const fakeCard = { number: "4242424242424242", expMonth: 8, expYear: 2030, cvc: "123", name: "A" };
const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  userId: "user-1",
  spaceId: "space-1",
  signal: new AbortController().signal,
};

/** The fake database with content encryption on, keys kept in memory as space_keys would. */
function encryptedDatabase(encryptWrites = true) {
  const db = fakeDatabase();
  const keys: SpaceKeyRecord[] = [];
  const provider = new LocalKeyProvider([{ id: "test", key: randomBytes(32) }]);
  const ring = new ContentKeyRing(
    provider,
    {
      forSpace: async (spaceId) => keys.filter((key) => key.spaceId === spaceId),
      byId: async (id) => keys.find((key) => key.id === id),
      insert: async (record) => {
        keys.push(record);
        return record;
      },
      rowContext: async () => undefined,
      sampleByMasterKey: async () => [],
    },
    { encryptWrites },
  );
  Object.assign(db.prisma, { $contentEncryption: () => ({ ring }) });
  const reports: string[] = [];
  const migrate = (mode: "encrypt" | "decrypt" = "encrypt", dryRun = false) =>
    migrateVaultValues(db.prisma, secretStore, context, {
      mode,
      dryRun,
      report: (row, status) => reports.push(`${row.id} ${status}`),
    });
  return { ...db, keys, provider, ring, migrate, reports };
}

type Db = ReturnType<typeof encryptedDatabase>;

function save(db: Db, destination: BotSecretDestination, plaintext: string, store?: SecretStore) {
  return storeBotSecret({
    prisma: db.prisma,
    secretStore: store ?? secretStore,
    scope,
    destination,
    plaintext,
  });
}

const row = (db: Db, name: string) => db.rows().find((stored) => stored.name === name)!;

const reveal = (db: Db, name: string, userId = scope.userId) =>
  revealBotSecret({ prisma: db.prisma, secretStore, scope: { ...scope, userId }, name });

const fillPassword = (db: Db) =>
  resolveLoginFill({
    prisma: db.prisma,
    secretStore,
    scope,
    runId: "run-1",
    name: "site",
    field: "password",
  });

describe("vault values under the envelope keys", () => {
  it("keeps the previous release's format until migrate creates the vault's key", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    expect(row(db, "site").ciphertext).toMatch(/^v2:/);
    expect(await secretStore.load(row(db, "site").ciphertext, row(db, "site").id)).toBe(
      loginValue(),
    );
    expect(db.keys).toEqual([]);

    await db.migrate();
    expect(db.keys.map((key) => key.spaceId)).toEqual(["user:user-1"]);
    await save(db, card, JSON.stringify(fakeCard));
    await save(db, { name: "token", origin: "", auth: { type: "command" } }, "fake-command-value");
    expect(db.rows().every((stored) => stored.ciphertext.startsWith("rkz1:"))).toBe(true);
    expect(JSON.stringify(db.rows())).not.toContain("fake-password-1");

    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-1", hidden: true });
    expect(await reveal(db, "site")).toMatchObject({ fields: expect.any(Array) });
    expect(
      await resolveVaultCardFill({
        prisma: db.prisma,
        secretStore,
        scope,
        name: "visa",
        field: "number",
        site: "https://shop.example.test",
        savedAt: row(db, "visa").updatedAt!.toISOString(),
      }),
    ).toMatchObject({ text: "4242424242424242" });
    expect(await loadBotCommandEnvironment(db.prisma, secretStore, scope)).toEqual({
      TOKEN: "fake-command-value",
    });
    expect((await listVaultItems(db.prisma, secretStore, scope))[0]).toMatchObject({
      preview: { username: "alex@example.test" },
    });

    // A Space's own vault gets its key from migrate too, not from the Space's content key.
    db.useOwnVault("space-1");
    await save(db, login, loginValue());
    expect(db.rows().find((stored) => stored.spaceId)!.ciphertext).toMatch(/^v2:/);
    await db.migrate();
    expect(db.keys.map((key) => key.spaceId)).toEqual(["user:user-1", "vault:space-1"]);
    await save(db, login, loginValue("fake-password-2"));
    expect(db.rows().find((stored) => stored.spaceId)!.ciphertext).toMatch(/^rkz1:/);
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-2" });
  });

  it("hides envelope logins and cards in every run, beside an older item", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await save(db, card, JSON.stringify(fakeCard));
    await db.migrate();
    const legacy = await secretStore.put(loginValue("fake-password-old"), context, {
      recordId: "legacy",
    });
    db.rows().push({
      ...row(db, "site"),
      id: "legacy",
      name: "legacy",
      ciphertext: legacy.ciphertext,
    });
    expect(row(db, "site").ciphertext).toMatch(/^rkz1:/);
    expect(await loadLoginPasswordRedactions(db.prisma, secretStore, scope)).toEqual(
      expect.arrayContaining(["fake-password-1", "4242424242424242", "fake-password-old"]),
    );
  });

  it("stops a run whose saved logins can't be hidden while the key manager is down", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await save(db, card, JSON.stringify(fakeCard));
    await db.migrate();
    db.ring.clear();
    const unwrap = vi.spyOn(db.provider, "unwrap").mockRejectedValue(new Error("fake outage"));
    await expect(loadLoginPasswordRedactions(db.prisma, secretStore, scope)).rejects.toThrow(
      "key manager",
    );
    unwrap.mockRestore();
    // One item's own damaged data is skipped, as before.
    const visa = row(db, "visa");
    visa.ciphertext = `${visa.ciphertext.slice(0, -4)}AAAA`;
    const forms = await loadLoginPasswordRedactions(db.prisma, secretStore, scope);
    expect(forms).toContain("fake-password-1");
    expect(forms).not.toContain("4242424242424242");
  });

  it("stops a run whose command variables can't be loaded while the key manager is down", async () => {
    const db = encryptedDatabase();
    const command = (name: string) =>
      ({ name, origin: "", auth: { type: "command" } }) as BotSecretDestination;
    await save(db, command("gh_token"), "fake-gh-token");
    await save(db, command("other_token"), "fake-other-token");
    await db.migrate();
    db.ring.clear();
    const unwrap = vi.spyOn(db.provider, "unwrap").mockRejectedValue(new Error("fake outage"));
    await expect(loadBotCommandEnvironment(db.prisma, secretStore, scope)).rejects.toThrow(
      "key manager",
    );
    // A running run's later commands go on without the variable.
    const unset = new Set<string>();
    expect(await loadBotCommandEnvironment(db.prisma, secretStore, scope, unset, "unset")).toEqual(
      {},
    );
    expect([...unset].sort()).toEqual(["GH_TOKEN", "OTHER_TOKEN"]);
    unwrap.mockRestore();
    // One item's own damaged data is left unset, as before.
    const other = row(db, "other_token");
    other.ciphertext = `${other.ciphertext.slice(0, -4)}AAAA`;
    expect(await loadBotCommandEnvironment(db.prisma, secretStore, scope)).toEqual({
      GH_TOKEN: "fake-gh-token",
    });
  });

  it("runs a shell command mid-run without a variable it can't load while the key manager is down", async () => {
    const db = encryptedDatabase();
    await save(
      db,
      { name: "gh_token", origin: "", auth: { type: "command" } } as BotSecretDestination,
      "fake-gh-token",
    );
    await db.migrate();
    db.ring.clear();
    vi.spyOn(db.provider, "unwrap").mockRejectedValue(new Error("fake outage"));
    const execute = vi.fn(async function* () {
      yield { type: "stdout" as const, data: "ok" };
      yield { type: "exit" as const, code: 0 };
    });
    const ctx = {
      deps: {
        prisma: db.prisma,
        secretStore,
        sandbox: { execute },
        events: { append: async () => {} },
      },
      run: { ...scope, id: "run-1", botId: "bot-1" },
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { id: "thread-1" },
      context,
      computer: {
        mode: "private",
        checkpoint: { markDirty: () => {} },
        get: async () => ({ id: "c1", botId: "bot-1", kind: "fake", providerRef: "c1" }),
        stored: { id: "c1" },
      },
      secrets: [] as string[],
      state: {},
    };
    const call = {
      name: "shell",
      args: { command: "gh pr list" },
      executionId: "e1",
      finish: async (result: unknown) => result,
    };
    expect(await computerTools.shell!(ctx as never, call as never)).toMatchObject({
      stdout: "ok",
      code: 0,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ env: undefined, unsetEnv: ["GH_TOKEN"] }),
      context,
    );
  });

  it("skips an item whose key record is gone, like other damaged items", async () => {
    const db = encryptedDatabase();
    const command = (name: string) =>
      ({ name, origin: "", auth: { type: "command" } }) as BotSecretDestination;
    await save(db, login, loginValue());
    await save(db, command("old_token"), "fake-old-token");
    await db.migrate();
    await db.ring.rotate("user:user-1");
    await save(db, command("new_token"), "fake-new-token");
    // The first key's record is gone, while the key manager itself works.
    db.keys.splice(
      db.keys.findIndex((key) => key.version === 1),
      1,
    );
    db.ring.clear();
    expect(await loadBotCommandEnvironment(db.prisma, secretStore, scope)).toEqual({
      NEW_TOKEN: "fake-new-token",
    });
    expect(await loadLoginPasswordRedactions(db.prisma, secretStore, scope)).not.toContain(
      "fake-password-1",
    );
  });

  it("sends a migrated API key only in its header, and hides it", async () => {
    const db = encryptedDatabase();
    const api = {
      name: "example_api",
      origin: "https://api.example.test",
      auth: { type: "bearer" },
    };
    await save(db, api as BotSecretDestination, "fake-api-key-1");
    await db.migrate();
    expect(row(db, "example_api").ciphertext).toMatch(/^rkz1:/);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true }));
    const registerRedactions = vi.fn();
    await requestWithBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      request: { name: "example_api", url: "https://api.example.test/v1/items" },
      signal: new AbortController().signal,
      remote: { fetch, resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }] },
      registerRedactions,
    });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer fake-api-key-1",
    );
    expect(registerRedactions).toHaveBeenCalledWith(
      expect.arrayContaining(["fake-api-key-1", "Bearer fake-api-key-1"]),
    );
  });

  it("fills a migrated card's postal code from its migrated billing contact", async () => {
    const db = encryptedDatabase();
    const home = { name: "Alex", line1: "12 Elm St", city: "Springfield", postalCode: "12345" };
    await save(
      db,
      { name: "home", origin: "", auth: { type: "contact" } } as BotSecretDestination,
      JSON.stringify(home),
    );
    await save(db, card, JSON.stringify({ ...fakeCard, billing: "home" }));
    await db.migrate();
    expect(row(db, "home").ciphertext).toMatch(/^rkz1:/);
    expect(
      await resolveVaultCardFill({
        prisma: db.prisma,
        secretStore,
        scope,
        name: "visa",
        field: "postal_code",
        site: "https://shop.example.test",
        savedAt: row(db, "visa").updatedAt!.toISOString(),
      }),
    ).toMatchObject({ text: "12345" });
  });

  it("refuses a value moved to another item, member or vault", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await save(db, { ...login, name: "other" } as BotSecretDestination, loginValue());
    await db.migrate();
    row(db, "other").ciphertext = row(db, "site").ciphertext;
    await expect(reveal(db, "other")).rejects.toThrow();

    const site = row(db, "site");
    site.userId = "user-2";
    await expect(reveal(db, "site", "user-2")).rejects.toThrow();
    // Same member, row id and table: only the vault's key scope tells the vaults apart.
    site.userId = "user-1";
    site.spaceId = "space-1";
    db.useOwnVault("space-1");
    await expect(reveal(db, "site")).rejects.toThrow("another vault's key");
  });

  it("keeps today's format with content encryption off or an external store", async () => {
    const off = encryptedDatabase(false);
    await save(off, login, loginValue());
    await off.migrate();
    await save(off, card, JSON.stringify(fakeCard));
    expect(row(off, "visa").ciphertext).toMatch(/^v2:/);

    const fake = infisicalFake();
    const external = new ComposedSecretStore(
      new EncryptedSecretStore("test-only-encryption-key"),
      new InfisicalSecretStore(fake.options),
    );
    await external.start();
    try {
      const db = encryptedDatabase();
      await save(db, card, JSON.stringify(fakeCard));
      await db.migrate();
      await save(db, login, loginValue(), external);
      expect(row(db, "site").ciphertext).toMatch(/^infisical:/);
      expect(
        await revealBotSecret({ prisma: db.prisma, secretStore: external, scope, name: "site" }),
      ).toMatchObject({ fields: expect.any(Array) });
    } finally {
      await external.close();
    }
  });
});

describe("moving vault values to the envelope keys", () => {
  async function mixedVault() {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    await save(db, card, JSON.stringify(fakeCard));
    await save(db, { ...login, name: "broken" } as BotSecretDestination, loginValue());
    row(db, "broken").ciphertext = `v2:${Buffer.alloc(64).toString("base64")}`;
    db.rows().push({
      ...row(db, "broken"),
      id: "remote",
      name: "remote",
      ciphertext: "infisical:v1:remote-ref",
    });
    return db;
  }

  it("previews without creating a key or writing a row", async () => {
    const db = await mixedVault();
    const wrap = vi.spyOn(db.provider, "wrap");
    const before = structuredClone(db.rows());
    expect(await db.migrate("encrypt", true)).toMatchObject({ planned: 2, migrated: 0, failed: 1 });
    expect(db.rows()).toEqual(before);
    expect(db.keys).toEqual([]);
    expect(wrap).not.toHaveBeenCalled();
  });

  it("reports an item already under a vault key that does not open", async () => {
    const db = await mixedVault();
    await db.migrate();
    const site = row(db, "site");
    site.ciphertext = `${site.ciphertext.slice(0, -4)}AAAA`;
    // Copied into the Space's own vault: its header names the member's key.
    row(db, "visa").spaceId = "space-1";
    const before = structuredClone(db.rows());
    const keys = db.keys.length;
    db.reports.length = 0;
    expect(await db.migrate("encrypt", true)).toMatchObject({ verified: 1, failed: 3 });
    expect(await db.migrate()).toMatchObject({ migrated: 0, verified: 1, failed: 3 });
    expect(db.rows()).toEqual(before);
    expect(db.keys).toHaveLength(keys);
    expect(db.reports).toEqual(
      expect.arrayContaining([`${site.id} failed`, `${row(db, "visa").id} failed`]),
    );
  });

  it("rewrites old rows once, keeps their dates, and leaves a failed row as it was", async () => {
    const db = await mixedVault();
    const before = structuredClone(db.rows());
    expect(await db.migrate()).toMatchObject({ migrated: 2, verified: 1, failed: 1 });
    expect(row(db, "site").ciphertext).toMatch(/^rkz1:/);
    expect(row(db, "site").updatedAt).toEqual(before.find((r) => r.name === "site")!.updatedAt);
    expect(row(db, "broken").ciphertext).toBe(before.find((r) => r.name === "broken")!.ciphertext);
    expect(row(db, "remote").ciphertext).toBe("infisical:v1:remote-ref");
    expect(db.reports).toContain(`${row(db, "broken").id} failed`);
    expect(JSON.stringify(db.reports)).not.toContain("fake-password-1");
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-1" });

    const after = structuredClone(db.rows());
    expect(await db.migrate()).toMatchObject({ migrated: 0, verified: 3, failed: 1 });
    expect(db.rows()).toEqual(after);
  });

  /** Runs `change` after migrate has read its batch and before it writes. */
  function between(db: Db, change: () => Promise<unknown>) {
    const findMany = db.prisma.vaultCredential.findMany as unknown as Mock;
    const read = findMany.getMockImplementation()!;
    findMany.mockImplementationOnce(async (args) => {
      const batch = await read(args);
      await change();
      return batch;
    });
  }

  it("lets a save made during migrate win", async () => {
    const db = await mixedVault();
    between(db, () => save(db, login, loginValue("fake-password-2")));
    expect(await db.migrate()).toMatchObject({ migrated: 1, concurrent: 1 });
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-2" });
  });

  it("saves again under the vault key when migrate moves the item during a save", async () => {
    const db = encryptedDatabase();
    await save(db, login, loginValue());
    // The save seals its value before migrate creates the vault's key, and commits after.
    const transaction = db.prisma.$transaction.bind(db.prisma);
    vi.spyOn(db.prisma, "$transaction").mockImplementationOnce((async (run: never) => {
      await db.migrate();
      return transaction(run);
    }) as never);
    await save(db, login, loginValue("fake-password-2"));
    expect(row(db, "site").ciphertext).toMatch(/^rkz1:/);
    expect(await fillPassword(db)).toMatchObject({ text: "fake-password-2" });
  });

  it("lets a label edit made during migrate keep its date", async () => {
    const db = await mixedVault();
    const saved = row(db, "site").updatedAt!;
    between(db, () => relabelVaultItem(db.prisma, scope, "site", { title: "Work" }));
    expect(await db.migrate()).toMatchObject({ migrated: 1, concurrent: 1 });
    expect(row(db, "site")).toMatchObject({
      title: "Work",
      ciphertext: expect.stringMatching(/^v2:/),
    });
    expect(row(db, "site").updatedAt!.getTime()).toBeGreaterThan(saved.getTime());
  });

  it("lets a value moved to Infisical during migrate stay there", async () => {
    const db = await mixedVault();
    const site = row(db, "site");
    // secrets-infisical migrate keeps the item's date, so only the value tells the change apart.
    between(db, () =>
      db.prisma.vaultCredential.updateMany({
        where: { id: site.id },
        data: { ciphertext: "infisical:v1:moved", updatedAt: site.updatedAt },
      }),
    );
    expect(await db.migrate()).toMatchObject({ migrated: 1, concurrent: 1 });
    expect(row(db, "site").ciphertext).toBe("infisical:v1:moved");
  });

  it("visits every row once across batches, in both directions", async () => {
    const db = encryptedDatabase();
    // A store without scrypt keeps 250 rows fast; it binds the value to its row like the real one.
    const store = {
      describe: () => ({ id: "app-encrypted" }),
      put: async (value: string, _context: unknown, options: { recordId: string }) => {
        const ref = `v2:${options.recordId}:${value}`;
        return { id: options.recordId, ref, ciphertext: ref };
      },
      load: async (ref: string, context: string | { recordId: string }) => {
        const prefix = `v2:${typeof context === "string" ? context : context.recordId}:`;
        if (!ref.startsWith(prefix)) throw new Error("bound to another row");
        return ref.slice(prefix.length);
      },
    } as unknown as SecretStore;
    const total = 250;
    // Inserted in neither id nor name order; names sort opposite to ids; three owners, two vaults.
    for (let n = 0; n < total; n++) {
      const i = (n * 7) % total;
      const id = `id-${String(i).padStart(3, "0")}`;
      db.rows().push({
        id,
        userId: `user-${i % 3}`,
        spaceId: i % 2 ? null : `space-${i % 3}`,
        name: `item-${String(total - i).padStart(3, "0")}`,
        origin: "",
        auth: { type: "command" },
        ciphertext: (await store.put(`value-${i}`, context, { recordId: id })).ciphertext,
        updatedAt: new Date(Date.parse("2026-09-01") + i),
      });
    }
    const findMany = db.prisma.vaultCredential.findMany as unknown as Mock;
    const read = findMany.getMockImplementation()!;
    const cursors: string[] = [];
    findMany.mockImplementation(async (args) => {
      // A cursor that never advances would read the first page forever.
      if (cursors.length > 10) throw new Error("migrate did not reach its last page");
      cursors.push(args.where.id.gt);
      return read(args);
    });
    const migrate = async (mode: "encrypt" | "decrypt") => {
      cursors.length = 0;
      const visited: string[] = [];
      const counts = await migrateVaultValues(db.prisma, store, context, {
        mode,
        report: (row, status) => visited.push(`${row.id} ${status}`),
      });
      return { counts, visited, cursors: [...cursors] };
    };
    const ids = db
      .rows()
      .map((stored) => `${stored.id} migrated`)
      .sort();

    for (const mode of ["encrypt", "decrypt"] as const) {
      const first = await migrate(mode);
      expect(first.counts).toMatchObject({ migrated: total, failed: 0, concurrent: 0 });
      expect(first.visited.sort()).toEqual(ids);
      // Two pages: the first full, the second short and last.
      expect(first.cursors).toEqual(["", "id-199"]);
      const again = await migrate(mode);
      expect(again.counts).toMatchObject({ migrated: 0, verified: total, failed: 0 });
      expect(again.visited).toEqual([]);
      for (const stored of db.rows())
        expect(stored.ciphertext.startsWith("rkz1:")).toBe(mode === "encrypt");
    }
    expect(new Set(db.keys.map((key) => key.spaceId))).toEqual(
      new Set([
        "user:user-0",
        "user:user-1",
        "user:user-2",
        "vault:space-0",
        "vault:space-1",
        "vault:space-2",
      ]),
    );
    for (const stored of db.rows())
      expect(await store.load(stored.ciphertext, stored.id)).toBe(
        `value-${Number(stored.id.slice(3))}`,
      );
  });

  it("writes them back in today's format for a rollback", async () => {
    const db = await mixedVault();
    await db.migrate();
    expect(await db.migrate("decrypt")).toMatchObject({ migrated: 2, failed: 0 });
    for (const stored of db.rows().filter((r) => ["site", "visa"].includes(r.name))) {
      expect(stored.ciphertext).toMatch(/^v2:/);
      await expect(secretStore.load(stored.ciphertext, stored.id)).resolves.toBeTruthy();
    }
    expect(await db.migrate("decrypt")).toMatchObject({ migrated: 0 });
  });
});
