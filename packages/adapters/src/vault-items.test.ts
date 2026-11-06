import type { BotSecretDestination, VaultPolicy } from "@rakazo/contracts";
import {
  BLOCKED_ITEM_ANSWER,
  encodeCardSecret,
  encodeContactSecret,
  UNCHOSEN_ITEM_ANSWER,
} from "@rakazo/contracts";
import { runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { BotSecretScope, VaultItemBots } from "./bot-secrets.js";
import {
  defaultVaultItemTitle,
  findCommandVariableConflict,
  findSiteLogin,
  forgetBotSecret,
  HIDDEN_ITEM,
  listBotSecrets,
  listVaultItems,
  loadBotCommandEnvironment,
  loadCommandRedactions,
  loadLoginPasswordRedactions,
  newVaultItemName,
  prepareBotSecret,
  relabelVaultItem,
  requestWithBotSecret,
  resolveLoginFill,
  resolveVaultCardFill,
  revealBotSecret,
  storeBotSecret,
} from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { secretTools } from "./run-tools-secrets.js";
import { EncryptedSecretStore } from "./secrets.js";
import { listVaultItemUses } from "./vault-activity.js";
import {
  cardUseSummary,
  loginUseSummary,
  requestedCardUse,
  requestedLoginFills,
  vaultCardUseOf,
  vaultLoginUseOf,
} from "./vault-card-use.js";

const scope = { userId: "user-1", spaceId: "space-1" };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const card = { type: "card" } as const;
const contact = { type: "contact" } as const;
const fakeCard = {
  number: "4242 4242 4242 4242",
  expMonth: 8,
  expYear: 2030,
  cvc: "123",
  name: "Alex Rivera",
  billing: "home",
};
const fakeHome = {
  name: "Alex Rivera",
  line1: "12 Elm St",
  city: "Springfield",
  postalCode: "12345",
  phone: "+1 555 0100",
};

function save(
  db: ReturnType<typeof fakeDatabase>,
  name: string,
  plaintext: string,
  auth: BotSecretDestination["auth"],
  labels: { title?: string; note?: string } = {},
) {
  return storeBotSecret({
    prisma: db.prisma,
    secretStore,
    scope,
    destination: { name, origin: "", auth },
    plaintext,
    ...labels,
  });
}

async function vaultWithCard() {
  const db = fakeDatabase();
  await save(db, "home", JSON.stringify(fakeHome), contact, { title: "Home" });
  await save(db, "visa", JSON.stringify(fakeCard), card, { note: "For travel" });
  return db;
}

describe("saving cards and contacts", () => {
  it("encrypts the whole value and saves it in its canonical shape", async () => {
    const db = await vaultWithCard();
    const row = db.rows().find((stored) => stored.name === "visa")!;
    // Random base64 can hold a short substring by chance, so look for whole plaintext
    // pieces it cannot produce: the full card number (as saved and as typed), and a street
    // line with spaces.
    expect(row.ciphertext).not.toContain("4242424242424242");
    expect(row.ciphertext).not.toContain(fakeCard.number);
    expect(JSON.parse(await secretStore.load(row.ciphertext, row.id))).toMatchObject({
      number: "4242424242424242",
    });
    const home = db.rows().find((stored) => stored.name === "home")!;
    expect(home.ciphertext).not.toContain("12 Elm St");
  });

  it("refuses a value that is not a card or contact without quoting it", async () => {
    const db = fakeDatabase();
    await expect(
      save(db, "visa", JSON.stringify({ ...fakeCard, number: "4242424242424241" }), card),
    ).rejects.toThrow(/^Invalid card$/);
    await expect(save(db, "home", "12 Elm St", contact)).rejects.toThrow(/^Invalid contact$/);
  });
});

describe("the owner's list", () => {
  it("shows titles and previews, never a card's number or security code", async () => {
    const db = await vaultWithCard();
    const items = await listVaultItems(db.prisma, secretStore, scope);
    expect(items.map(({ name, title, note, preview }) => ({ name, title, note, preview }))).toEqual(
      [
        { name: "home", title: "Home", note: undefined, preview: { contact: fakeHome } },
        {
          name: "visa",
          title: "Visa ·· 4242",
          note: "For travel",
          preview: {
            card: {
              brand: "Visa",
              last4: "4242",
              expMonth: 8,
              expYear: 2030,
              name: "Alex Rivera",
              billing: "home",
            },
          },
        },
      ],
    );
    expect(JSON.stringify(items)).not.toContain("4242424242424242");
    expect(JSON.stringify(items)).not.toContain('"123"');
  });

  it("shows a login's first visible field under its site", async () => {
    const db = fakeDatabase();
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination: { name: "github", origin: "https://www.github.com", auth: { type: "login" } },
      plaintext: JSON.stringify({
        fields: [
          { label: "Email", value: "octo@example.com", hidden: false },
          { label: "Password", value: "fake-password-1", hidden: true },
        ],
      }),
    });
    const [item] = await listVaultItems(db.prisma, secretStore, scope);
    expect(item).toMatchObject({ title: "github.com", preview: { username: "octo@example.com" } });
    expect(JSON.stringify(item)).not.toContain("fake-password-1");
  });

  it("reveals a card to its owner in full", async () => {
    const db = await vaultWithCard();
    expect(await revealBotSecret({ prisma: db.prisma, secretStore, scope, name: "visa" })).toEqual({
      card: { ...fakeCard, number: "4242424242424242" },
    });
  });

  it("names a new item after its title or value, and changes only its labels", async () => {
    const db = await vaultWithCard();
    expect(await newVaultItemName(db.prisma, scope, "Home", "contact")).toBe("home-2");
    expect(await newVaultItemName(db.prisma, scope, "Café de Flore", "contact")).toBe(
      "cafe-de-flore",
    );
    expect(await newVaultItemName(db.prisma, scope, "בית", "contact")).toBe("contact");
    expect(defaultVaultItemTitle({ origin: "", auth: card }, encodeCardSecret(fakeCard))).toBe(
      "Visa ·· 4242",
    );
    expect(
      defaultVaultItemTitle({ origin: "", auth: contact }, encodeContactSecret({ city: "Paris" })),
    ).toBe("");
    expect(await relabelVaultItem(db.prisma, scope, "visa", { title: "Work card" })).toBe(true);
    const [, visa] = await listVaultItems(db.prisma, secretStore, scope);
    expect(visa).toMatchObject({ title: "Work card", note: "For travel" });
  });
});

describe("what the bot sees", () => {
  it("lists a contact in full and a card only by its summary", async () => {
    const db = await vaultWithCard();
    const listed = await listBotSecrets(db.prisma, secretStore, scope);
    expect(listed).toEqual([
      { name: "home", origin: "", auth: contact, title: "Home", contact: fakeHome },
      {
        name: "visa",
        origin: "",
        auth: card,
        note: "For travel",
        card: expect.objectContaining({ brand: "Visa", last4: "4242", expiry: "08/30" }),
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("4242424242424242");
    expect(JSON.stringify(listed)).not.toContain('"123"');
  });

  it("hides every saved card number in every run", async () => {
    const db = await vaultWithCard();
    const forms = await loadLoginPasswordRedactions(db.prisma, secretStore, scope);
    expect(forms).toEqual(
      expect.arrayContaining(["4242424242424242", "4242 4242 4242 4242", "4242-4242-4242-4242"]),
    );
  });

  it("never fills a card or contact as a login", async () => {
    const db = await vaultWithCard();
    const fill = (name: string) =>
      resolveLoginFill({ prisma: db.prisma, secretStore, scope, runId: "run-1", name, field: "x" });
    expect(await fill("visa")).toEqual({ error: expect.stringContaining("fill_card") });
    expect(await fill("home")).toEqual({ error: expect.stringContaining("list_secrets") });
  });
});

describe("filling a saved card", () => {
  const savedAt = (db: ReturnType<typeof fakeDatabase>, name = "visa") =>
    db
      .rows()
      .find((row) => row.name === name)!
      .updatedAt!.toISOString();
  const fill = (
    db: ReturnType<typeof fakeDatabase>,
    field: string,
    site = "https://shop.example.test",
  ) =>
    resolveVaultCardFill({
      prisma: db.prisma,
      secretStore,
      scope,
      name: "visa",
      field: field as "number",
      site,
      savedAt: savedAt(db),
    });

  it("types each field only on the approved checkout's origin", async () => {
    const db = await vaultWithCard();
    expect(await fill(db, "number")).toEqual({
      text: "4242424242424242",
      origin: "https://shop.example.test",
      redactions: expect.arrayContaining(["4242424242424242"]),
      used: expect.objectContaining({ name: "visa", kind: "card" }),
    });
    expect(await fill(db, "expiry")).toMatchObject({ text: "08/30" });
    const cvc = await fill(db, "cvc");
    expect(cvc).toMatchObject({ text: "123" });
    // Hiding 3 digits would blank every total and order number that contains them.
    expect("redactions" in cvc && cvc.redactions).not.toContain("123");
    // The billing contact's postal code.
    expect(await fill(db, "postal_code")).toMatchObject({ text: "12345" });
  });

  it("refuses a site that is not an HTTPS origin, or a name that is not a card", async () => {
    const db = await vaultWithCard();
    expect(await fill(db, "number", "http://shop.example.test")).toEqual({
      error: expect.stringContaining("HTTPS"),
    });
    expect(
      await resolveVaultCardFill({
        prisma: db.prisma,
        secretStore,
        scope,
        name: "home",
        field: "number",
        site: "https://shop.example.test",
        savedAt: savedAt(db, "home"),
      }),
    ).toEqual({ error: expect.stringContaining("No card") });
  });

  it("refuses a card replaced after the user approved it", async () => {
    const db = await vaultWithCard();
    const approved = savedAt(db);
    await save(db, "visa", JSON.stringify({ ...fakeCard, number: "5555555555554444" }), card);
    expect(
      await resolveVaultCardFill({
        prisma: db.prisma,
        secretStore,
        scope,
        name: "visa",
        field: "number",
        site: "https://shop.example.test",
        savedAt: approved,
      }),
    ).toEqual({ error: expect.stringContaining("changed after the user approved") });
  });
});

describe("approving a saved card", () => {
  it("reads one card on one site from a browser_act call", () => {
    const step = { kind: "fill_card", card: "visa", site: "https://shop.example.test/checkout" };
    expect(
      requestedCardUse([
        { ...step, field: "number" },
        { ...step, field: "cvc" },
        { kind: "click", ref: "e1" },
      ]),
    ).toEqual({ card: "visa", site: "https://shop.example.test" });
    expect(requestedCardUse([{ kind: "fill_card", purchase: "p1" }])).toBeUndefined();
    expect(requestedCardUse([{ kind: "fill_card", purchase: "p1", card: "" }])).toBeUndefined();
    expect(requestedCardUse([{ kind: "fill_card", purchase: "p1", card: null }])).toBeUndefined();
    expect(
      requestedCardUse([
        { ...step, field: "number" },
        { ...step, site: "https://other.example.test", field: "cvc" },
      ]),
    ).toEqual({ error: expect.stringContaining("one site") });
    expect(requestedCardUse([{ kind: "fill_card", card: "visa", site: "" }])).toEqual({
      error: expect.stringContaining("HTTPS origin"),
    });
  });

  it("asks once, naming the card and the site, and keeps only a well-formed approval", () => {
    const use = {
      card: "visa",
      site: "https://shop.example.test",
      title: "Visa ·· 4242",
      savedAt: "2026-09-01T00:00:01.000Z",
    };
    expect(cardUseSummary(use)).toEqual({
      onceOnly: true,
      title: "Pay with Visa ·· 4242 on shop.example.test?",
      lines: [],
    });
    // Typed together with the click that pays: the card names what the page lists for the order.
    const purchase = {
      steps: [0],
      site: "shop.example.test",
      label: "Place order",
      amount: "$9.00",
      amountSource: "page" as const,
      items: [{ name: "Bananas × 6", amount: "$3.00" }],
    };
    expect(cardUseSummary(use, purchase).lines).toEqual([
      'Button: "Place order"',
      "Bananas × 6: $3.00",
      "Total on the page: $9.00",
      "The button label, items and total are read from the page. The bot has not checked them.",
    ]);
    expect(vaultCardUseOf(use)).toEqual(use);
    expect(vaultCardUseOf({ ...use, site: "http://shop.example.test" })).toBeUndefined();
    expect(vaultCardUseOf({ ...use, card: "Visa Card" })).toBeUndefined();
  });
});

describe("approving a saved login", () => {
  it("reads every field one call fills, asks once naming the login's title, and keeps only a well-formed approval", () => {
    const step = { kind: "fill_secret", ref: "e1", secret: "site" };
    expect(
      requestedLoginFills([
        { ...step, field: "Email" },
        { ...step, field: " Password " },
        { ...step, field: "Email" },
        { kind: "fill_secret", ref: "e2", secret: "other", field: "PIN" },
        { kind: "click", ref: "e3" },
      ]),
    ).toEqual(
      new Map([
        ["site", ["Email", "Password"]],
        ["other", ["PIN"]],
      ]),
    );
    const use = {
      kind: "login" as const,
      login: "site",
      site: "https://login.example.test",
      title: "Work login",
      fields: ["Email", "Password"],
      savedAt: "2026-09-01T00:00:01.000Z",
    };
    expect(loginUseSummary(use)).toEqual({
      onceOnly: true,
      title: "Sign in to login.example.test with Work login?",
      lines: [],
    });
    expect(vaultLoginUseOf(use)).toEqual(use);
    expect(vaultLoginUseOf({ ...use, account: "alice" })).toEqual(use);
    expect(vaultLoginUseOf({ ...use, site: "http://login.example.test" })).toBeUndefined();
    expect(vaultLoginUseOf({ ...use, fields: "Password" })).toBeUndefined();
    // A card's approval is never a login's, nor a login's a card's, and an older card one reads.
    const card = { card: "visa", site: "https://shop.example.test", title: "Visa", savedAt: "x" };
    expect(vaultLoginUseOf(card)).toBeUndefined();
    expect(vaultCardUseOf(use)).toBeUndefined();
    expect(vaultCardUseOf(card)).toEqual(card);
  });
});

describe("an item's uses, for its owner", () => {
  it("reads its latest uses by id, naming only the owner's chats, and nothing for another member", async () => {
    const db = await vaultWithCard();
    const visa = db.rows().find((row) => row.name === "visa")!;
    const use = { actorLabel: "Shopper" };
    const events = vi.fn(async () => [
      {
        ...use,
        createdAt: new Date("2026-11-04T10:00:00.000Z"),
        threadId: "thread-1",
        metadata: { site: "https://shop.example.test" },
      },
      { ...use, createdAt: new Date("2026-11-03T10:00:00.000Z"), threadId: "other", metadata: {} },
    ]);
    const threads = vi.fn(async () => [{ id: "thread-1", bot: { name: "Shopper" } }]);
    Object.assign(db.prisma, { auditEvent: { findMany: events }, thread: { findMany: threads } });
    expect(await listVaultItemUses(db.prisma, scope, "visa")).toEqual([
      {
        at: "2026-11-04T10:00:00.000Z",
        botName: "Shopper",
        site: "https://shop.example.test",
        chat: { title: "Shopper" },
      },
      { at: "2026-11-03T10:00:00.000Z", botName: "Shopper", site: null, chat: null },
    ]);
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { targetType: "vault_credential", targetId: visa.id, action: "credential.used" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 20,
      }),
    );
    expect(threads).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["thread-1", "other"] }, userId: "user-1" } }),
    );
    events.mockClear();
    expect(
      await listVaultItemUses(db.prisma, { ...scope, userId: "user-2" }, "visa"),
    ).toBeUndefined();
    expect(events).not.toHaveBeenCalled();
  });
});

describe("an item bots may not use", () => {
  const bot = { ...scope, botId: "bot-1" };
  const site = "https://login.example.test";
  const login = JSON.stringify({
    fields: [
      { label: "Email", value: "fake-user@example.test", hidden: false },
      { label: "Password", value: "fake-password-1", hidden: true },
    ],
  });
  const api = { type: "bearer" } as const;
  const remote = {
    fetch: vi.fn<typeof globalThis.fetch>(async () => Response.json({ ok: true })),
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
  };
  async function vault() {
    const db = await vaultWithCard();
    const row = (name: string) => db.rows().find((entry) => entry.name === name)!;
    Object.assign(db.prisma.secret, { deleteMany: async () => ({ count: 0 }) });
    const store = (
      name: string,
      origin: string,
      auth: BotSecretDestination["auth"],
      value: string,
      policy?: VaultPolicy,
      botIds?: string[],
    ) =>
      storeBotSecret({
        prisma: db.prisma,
        secretStore,
        scope,
        destination: { name, origin, auth },
        plaintext: value,
        policy,
        ...(botIds ? { bots: { allBots: false, botIds } } : {}),
      });
    await store("site", site, { type: "login" }, login);
    await store("stripe", "https://api.example.test", api, "fake-key-1");
    await store("deploy", "", { type: "command" }, "fake-command-1");
    const uses = {
      list: async () =>
        (await listBotSecrets(db.prisma, secretStore, bot)).map((item) => item.name),
      fill: () =>
        resolveLoginFill({
          prisma: db.prisma,
          secretStore,
          scope: bot,
          runId: "run-1",
          name: "site",
          field: "Password",
        }),
      card: () =>
        resolveVaultCardFill({
          prisma: db.prisma,
          secretStore,
          scope: bot,
          name: "visa",
          field: "number",
          site: "https://shop.example.test",
          savedAt: row("visa").updatedAt!.toISOString(),
        }),
      send: () =>
        requestWithBotSecret({
          prisma: db.prisma,
          secretStore,
          scope: bot,
          request: { name: "stripe", url: "https://api.example.test/v1" },
          signal: new AbortController().signal,
          remote,
        }),
      env: () => loadBotCommandEnvironment(db.prisma, secretStore, bot),
    };
    const ctx = {
      deps: { prisma: db.prisma, secretStore },
      run: { ...bot, id: "run-1", trigger: "user" },
      runId: "run-1",
      bot: { id: "bot-1" },
      thread: { id: "thread-1" },
      state: { walletHosts: new Set(), reply: { pendingProgress: "" } },
      context: { signal: new AbortController().signal },
      secrets: [],
    };
    const tool = (name: keyof typeof secretTools, args: Record<string, unknown>) =>
      secretTools[name]!(ctx as never, { name, args, finish: async (r: unknown) => r } as never);
    return { db, row, uses, store, ctx, tool };
  }

  it("hides an item turned off, or not for this bot, from it everywhere, and still redacts it", async () => {
    const { db, row, uses, store, tool } = await vault();
    await store("ci-token", "", { type: "command" }, "fake-command-2");
    expect(await uses.list()).toEqual(["ci-token", "deploy", "home", "site", "stripe", "visa"]);
    for (const name of ["site", "visa", "deploy", "ci-token"]) row(name).policy = "off";
    row("stripe").policy = "off";
    expect(await uses.list()).toEqual(["home"]);
    expect(await uses.fill()).toEqual({ error: expect.stringContaining("unavailable") });
    expect(await uses.card()).toEqual({ error: expect.stringContaining("No card") });
    expect(await uses.send()).toEqual({ error: expect.stringContaining("unavailable") });
    expect(await uses.env()).toEqual({});
    expect(remote.fetch).not.toHaveBeenCalled();
    // Asking for it, generating one over it, or forgetting it says nothing about it.
    const hidden = { error: HIDDEN_ITEM };
    const credential = { name: "stripe", origin: "https://api.example.test", auth: api };
    expect(await tool("request_secret", { label: "Key", purpose: "api_key", credential })).toEqual(
      hidden,
    );
    expect(
      await tool("generate_secret", { name: "site", type: "login", origin: site, username: "x" }),
    ).toEqual(hidden);
    expect(await tool("forget_secret", { name: "stripe" })).toEqual({ removed: false });
    expect(row("stripe")).toBeDefined();
    expect(
      await findCommandVariableConflict(db.prisma, bot, {
        name: "ci_token",
        origin: "",
        auth: { type: "command" },
      }),
    ).toBe("another saved item");
    // Every run still hides the values it can no longer use.
    expect(await loadLoginPasswordRedactions(db.prisma, secretStore, bot)).toContain(
      "fake-password-1",
    );
    expect(await loadCommandRedactions(db.prisma, secretStore, bot)).toContain("fake-command-1");
    // The owner still sees each item, and can remove it.
    expect(
      (await listVaultItems(db.prisma, secretStore, scope)).map((item) => [item.name, item.policy]),
    ).toContainEqual(["site", "off"]);
    await forgetBotSecret(db.prisma, scope, "stripe");
    expect(db.rows().some((entry) => entry.name === "stripe")).toBe(false);
  });

  it("treats an item chosen for other bots exactly as a missing one, and still redacts it", async () => {
    const { db, row, uses, store, tool } = await vault();
    await store("new-password", "", { type: "command" }, "fake-command-3");
    const limited = ["site", "visa", "stripe", "deploy", "home", "new-password"];
    const limit = (name: string, botIds: string[]) =>
      relabelVaultItem(db.prisma, scope, name, { bots: { allBots: false, botIds } });
    for (const name of limited) await limit(name, ["bot-2"]);
    const credential = { name: "stripe", origin: "https://api.example.test", auth: api };
    const savedAt = row("visa").updatedAt!.toISOString();
    const seen = async () => ({
      list: await uses.list(),
      fill: await uses.fill(),
      card: await resolveVaultCardFill({
        prisma: db.prisma,
        secretStore,
        scope: bot,
        name: "visa",
        field: "number",
        site: "https://shop.example.test",
        savedAt,
      }),
      send: await uses.send(),
      env: await uses.env(),
      siteLogin: await findSiteLogin(db.prisma, bot, site),
      forget: await tool("forget_secret", { name: "stripe" }),
    });
    const scoped = await seen();
    expect(scoped.list).toEqual([]);
    expect(scoped.forget).toEqual({ removed: false });
    expect(remote.fetch).not.toHaveBeenCalled();
    expect(row("stripe")).toBeDefined();
    // The bot it was chosen for still uses it.
    expect(
      (await listBotSecrets(db.prisma, secretStore, { ...bot, botId: "bot-2" })).map(
        (item) => item.name,
      ),
    ).toEqual(["deploy", "home", "new-password", "site", "stripe", "visa"]);
    // Every run still hides the values this bot can't use.
    expect(await loadLoginPasswordRedactions(db.prisma, secretStore, bot)).toContain(
      "fake-password-1",
    );
    expect(await loadCommandRedactions(db.prisma, secretStore, bot)).toContain("fake-command-1");
    // Saving over its name says only that the name can't be used, nothing of the item.
    for (const answer of [
      await tool("request_secret", { label: "Key", purpose: "api_key", credential }),
      await tool("generate_secret", { name: "site", type: "login", origin: site, username: "x" }),
      await tool("generate_secret", {
        name: "new",
        type: "login",
        origin: site,
        username: "x",
        command: true,
      }),
    ])
      expect(answer).toEqual({ error: HIDDEN_ITEM });
    expect(HIDDEN_ITEM).not.toMatch(/item|login|key|site|user/i);
    // Removed by its owner, it looks the same to the bot as it did while chosen for another.
    for (const name of limited) await forgetBotSecret(db.prisma, scope, name);
    expect(await seen()).toEqual(scoped);
  });

  it("limits an item to chosen bots in one Space, through older saves and other Spaces' choices", async () => {
    const { db, row, store } = await vault();
    const there = { userId: scope.userId, spaceId: "space-2" };
    const names = async (botId: string, spaceId = "space-1") =>
      (await listBotSecrets(db.prisma, secretStore, { ...scope, spaceId, botId })).map(
        (item) => item.name,
      );
    const bots = (where: BotSecretScope, name: string, choice: VaultItemBots) =>
      relabelVaultItem(db.prisma, where, name, { bots: choice });
    await store("new-key", "https://api.example.test", api, "fake-key-2", undefined, ["bot-1"]);
    await bots(scope, "home", { allBots: false, botIds: [] });
    expect(await names("bot-1")).toEqual(["deploy", "new-key", "site", "stripe", "visa"]);
    expect(await names("bot-2")).toEqual(["deploy", "site", "stripe", "visa"]);
    // An older app's save, with or without a new value, keeps the choice.
    await relabelVaultItem(db.prisma, scope, "new-key", { title: "Renamed" });
    await store("new-key", "https://api.example.test", api, "fake-key-3");
    expect(await names("bot-2")).not.toContain("new-key");
    expect((await listVaultItems(db.prisma, secretStore, scope, "new-key"))[0]).toMatchObject({
      allBots: false,
      botIds: ["bot-1"],
    });
    // Another Space using the account vault chooses for its own bots, and never widens this one's.
    expect((await listVaultItems(db.prisma, secretStore, there, "new-key"))[0]).toMatchObject({
      allBots: true,
      botIds: [],
    });
    await bots(there, "new-key", { allBots: false, botIds: ["bot-other-space"] });
    await bots(there, "new-key", { allBots: true });
    expect(await names("bot-other-space", "space-2")).toContain("new-key");
    expect(await names("bot-2")).not.toContain("new-key");
    // A card's billing contact the bot may not use is never typed.
    const postal = await resolveVaultCardFill({
      prisma: db.prisma,
      secretStore,
      scope: bot,
      name: "visa",
      field: "postal_code",
      site: "https://shop.example.test",
      savedAt: row("visa").updatedAt!.toISOString(),
    });
    // Nothing invites the bot to type the withheld address itself.
    expect(postal).toEqual({ error: "This card has no billing address this bot can use." });
    // Only bots of a Space that uses this vault; nothing is saved otherwise.
    for (const botIds of [["bot-other-space"], ["missing-bot"]]) {
      await expect(bots(scope, "new-key", { allBots: false, botIds })).rejects.toThrow(
        "Choose from your bots in this Space",
      );
      await expect(
        store("refused", "https://api.example.test", api, "fake-key-4", undefined, botIds),
      ).rejects.toThrow("Choose from your bots in this Space");
    }
    db.useOwnVault("space-2");
    await expect(
      bots({ ...there, vault: "account" }, "new-key", { botIds: ["bot-other-space"] }),
    ).rejects.toThrow("Choose from your bots in this Space");
    expect(db.rows().some((entry) => entry.name === "refused")).toBe(false);
    // Row security shows only the read's own Space's limits, so a bot's read is answered only
    // inside its run's Space: elsewhere it finds nothing, never an item it was limited from.
    const visible = (spaceId: string) =>
      runAsTenant({ userId: scope.userId, spaceId }, () => names("bot-2"));
    expect(await visible("space-1")).toEqual(["deploy", "site", "stripe", "visa"]);
    expect(await visible("space-2")).toEqual([]);
    // Every bot here again, and removing the item removes every choice.
    await bots(scope, "new-key", { allBots: true });
    expect(await names("bot-2")).toContain("new-key");
    for (const name of ["new-key", "home"]) await forgetBotSecret(db.prisma, scope, name);
    expect(db.assignments()).toEqual([]);
    expect(db.limits()).toEqual([]);
  });

  it("lets each member of a shared Space limit their own item to any of its bots, for their runs only", async () => {
    const { db } = await vault();
    // user-2 shares space-1, where user-1 made bot-1 and bot-2 and user-2 made a bot of their own.
    const member = { userId: "user-2", spaceId: "space-1" };
    const names = async (userId: string, botId: string) =>
      (await listBotSecrets(db.prisma, secretStore, { userId, spaceId: "space-1", botId })).map(
        (item) => item.name,
      );
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope: member,
      destination: { name: "member-key", origin: "https://api.example.test", auth: api },
      plaintext: "fake-key-5",
      bots: { allBots: false, botIds: ["bot-1"] },
    });
    // bot-1's runs for user-2 use it; another bot's runs for user-2, and bot-1's for user-1, don't.
    expect(await names("user-2", "bot-1")).toEqual(["member-key"]);
    expect(await names("user-2", "bot-2")).toEqual([]);
    expect(await names("user-2", "bot-of-another-member")).toEqual([]);
    expect(await names("user-1", "bot-1")).not.toContain("member-key");
    // user-1 may choose user-2's bot for user-1's own item, which leaves user-2's item as it was.
    await relabelVaultItem(db.prisma, scope, "stripe", {
      bots: { allBots: false, botIds: ["bot-of-another-member"] },
    });
    expect(await names("user-1", "bot-of-another-member")).toContain("stripe");
    expect(await names("user-1", "bot-1")).not.toContain("stripe");
    expect(await names("user-2", "bot-of-another-member")).toEqual([]);
    expect(await names("user-2", "bot-1")).toEqual(["member-key"]);
  });

  it("saves Block or Ask first with the item in one write, and keeps it through an older app's save", async () => {
    const { db, row, store } = await vault();
    // Refused with the item, so nothing is saved and a retry makes one item.
    await expect(
      store("new-home", "", { type: "contact" }, JSON.stringify(fakeHome), "off"),
    ).rejects.toThrow("can't be used that way");
    expect(db.rows().some((entry) => entry.name === "new-home")).toBe(false);
    await store("new-key", "https://api.example.test", api, "fake-key-2", "off");
    expect(db.rows().filter((entry) => entry.name === "new-key")).toEqual([
      expect.objectContaining({ policy: "off" }),
    ]);
    const relabel = (name: string, policy?: VaultPolicy) =>
      relabelVaultItem(db.prisma, scope, name, { title: "Renamed", ...(policy ? { policy } : {}) });
    expect(await relabel("new-key")).toBe(true);
    expect(row("new-key")).toMatchObject({ title: "Renamed", policy: "off" });
    expect(await relabel("new-key", "allow")).toBe(true);
    expect(row("new-key")).toMatchObject({ policy: "allow" });
    await expect(relabel("home", "off")).rejects.toThrow("can't be used that way");
    expect(await relabel("missing", "off")).toBe(false);
    // Only a login asks first, and a bot still finds it, to fill once the user agrees.
    expect(await relabel("site", "ask")).toBe(true);
    for (const name of ["new-key", "deploy", "visa", "home"])
      await expect(relabel(name, "ask")).rejects.toThrow("can't be used that way");
    expect((await listBotSecrets(db.prisma, secretStore, bot)).map((item) => item.name)).toContain(
      "site",
    );
  });

  it("never lets an answer a bot asked for replace an item blocked while it waited", async () => {
    const { db, row } = await vault();
    const before = row("stripe").ciphertext;
    const destination = { name: "stripe", origin: "https://api.example.test", auth: api };
    const pending = await prepareBotSecret({
      prisma: db.prisma,
      secretStore,
      scope: bot,
      destination,
      plaintext: "fake-key-replacement",
    });
    await relabelVaultItem(db.prisma, scope, "stripe", { policy: "off" });
    await expect(db.prisma.$transaction(async (tx) => pending.store(tx as never))).rejects.toThrow(
      BLOCKED_ITEM_ANSWER,
    );
    expect(row("stripe").ciphertext).toBe(before);
    // An item saved and blocked under a new name while the request waited is refused as blocked,
    // not for its other site.
    const fresh = { ...destination, name: "fresh" };
    const waiting = await prepareBotSecret({
      prisma: db.prisma,
      secretStore,
      scope: bot,
      destination: fresh,
      plaintext: "fake-key-fresh",
    });
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination: { ...fresh, origin: "https://other.example.test" },
      plaintext: "fake-key-owner",
      policy: "off",
    });
    await expect(db.prisma.$transaction(async (tx) => waiting.store(tx as never))).rejects.toThrow(
      BLOCKED_ITEM_ANSWER,
    );
    // Blocked under another site before the answer is even prepared: the same message.
    await expect(
      prepareBotSecret({
        prisma: db.prisma,
        secretStore,
        scope: bot,
        destination: fresh,
        plaintext: "fake-key-late",
      }),
    ).rejects.toThrow(BLOCKED_ITEM_ANSWER);
    // One limited to other bots while the answer waited, or before it, says this bot can't use it.
    const waitingKey = await prepareBotSecret({
      prisma: db.prisma,
      secretStore,
      scope: bot,
      destination: { name: "deploy", origin: "", auth: { type: "command" } },
      plaintext: "fake-command-late",
    });
    await relabelVaultItem(db.prisma, scope, "deploy", { bots: { allBots: false, botIds: [] } });
    await expect(
      db.prisma.$transaction(async (tx) => waitingKey.store(tx as never)),
    ).rejects.toThrow(UNCHOSEN_ITEM_ANSWER);
    await relabelVaultItem(db.prisma, scope, "site", { bots: { allBots: false, botIds: [] } });
    await expect(
      prepareBotSecret({
        prisma: db.prisma,
        secretStore,
        scope: bot,
        destination: {
          name: "site",
          origin: "https://other.example.test",
          auth: { type: "login" },
        },
        plaintext: login,
      }),
    ).rejects.toThrow(UNCHOSEN_ITEM_ANSWER);
    // The owner's own save still replaces it.
    await storeBotSecret({ prisma: db.prisma, secretStore, scope, destination, plaintext: "k2" });
    expect(row("stripe").ciphertext).not.toBe(before);
  });
});
