import type { PrismaClient } from "@rakazo/db";
import { vi } from "vitest";

// No database is available offline, so these run against an in-memory stand-in for the
// vault_credentials table. Encryption, validation, and redaction are the real implementations.
type Row = {
  id: string;
  userId: string;
  /** Null in the account vault. */
  spaceId: string | null;
  name: string;
  origin: string;
  auth: unknown;
  ciphertext: string;
  title?: string;
  note?: string;
  policy?: string;
  createdAt?: Date;
  updatedAt?: Date;
};
type Where = Record<string, unknown>;
/** A bot an item is limited to, in the bot's Space. */
type Assignment = { credentialId: string; botId: string; userId: string; spaceId: string };
/** A Space in which an item is limited to its chosen bots. */
type Limit = { credentialId: string; userId: string; spaceId: string };
type Scoping = { chosen: Assignment[]; limited: Limit[] };

function matches<T extends object>(
  row: T,
  where: Where,
  scoping: Scoping = { chosen: [], limited: [] },
): boolean {
  const id = (row as { id?: string }).id;
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Where[]).some((branch) => matches(row, branch, scoping));
    if (key === "bots") {
      const { botId } = (value as { some: { botId: string } }).some;
      return scoping.chosen.some((entry) => entry.credentialId === id && entry.botId === botId);
    }
    if (key === "limits") {
      const { spaceId } = (value as { none: { spaceId: string } }).none;
      return !scoping.limited.some(
        (entry) => entry.credentialId === id && entry.spaceId === spaceId,
      );
    }
    const field = row[key as keyof T] as unknown;
    if (value && typeof value === "object" && "in" in value)
      return (value.in as unknown[]).includes(field);
    if (value && typeof value === "object" && "notIn" in value)
      return !(value.notIn as unknown[]).includes(field);
    if (value && typeof value === "object" && "not" in value) return field !== value.not;
    if (value && typeof value === "object" && "startsWith" in value)
      return String(field).startsWith(String(value.startsWith));
    if (value && typeof value === "object" && "path" in value) {
      const filter = value as { path: string[]; equals: unknown };
      return (field as Record<string, unknown> | null)?.[filter.path[0]!] === filter.equals;
    }
    return field === value;
  });
}

/** A row in the member's account vault, which every Space without its own vault uses. */
export const accountVault = { userId: "user-1", spaceId: null };

export function fakeDatabase() {
  let rows: Row[] = [];
  let assignments: Assignment[] = [];
  let limits: Limit[] = [];
  const scoping = () => ({ chosen: assignments, limited: limits });
  // The member's bots, by Space.
  const bots = [
    { id: "bot-1", userId: "user-1", spaceId: "space-1" },
    { id: "bot-2", userId: "user-1", spaceId: "space-1" },
    { id: "bot-other-space", userId: "user-1", spaceId: "space-2" },
    { id: "bot-of-another-member", userId: "user-2", spaceId: "space-1" },
  ];
  // A clock that moves on every write, as updatedAt does, so a changed row is told apart.
  let tick = Date.parse("2026-09-01T00:00:00.000Z");
  const now = () => {
    tick += 1000;
    return new Date(tick);
  };
  // Spaces that customized "credentials" and so use their own vault.
  const ownVaults = new Set<string>();
  const vaultCredential = {
    findFirst: vi.fn(
      async ({ where }: { where: Where }) => rows.find((r) => matches(r, where, scoping())) ?? null,
    ),
    findMany: vi.fn(async ({ where, take }: { where: Where; take?: number }) =>
      rows
        .filter((row) => matches(row, where, scoping()))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, take ?? rows.length),
    ),
    count: vi.fn(
      async ({ where }: { where: Where }) =>
        rows.filter((r) => matches(r, where, scoping())).length,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const at = now();
      rows.push({ policy: "allow", createdAt: at, updatedAt: at, ...data });
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      Object.assign(rows.find((row) => row.id === where.id)!, data, { updatedAt: now() });
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const matched = rows.filter((row) => matches(row, where, scoping()));
      for (const row of matched) Object.assign(row, data, { updatedAt: now() });
      return { count: matched.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = rows.length;
      rows = rows.filter((row) => !matches(row, where, scoping()));
      // Its bots go with it, as the foreign key cascades.
      assignments = assignments.filter((entry) =>
        rows.some((row) => row.id === entry.credentialId),
      );
      limits = limits.filter((entry) => rows.some((row) => row.id === entry.credentialId));
      return { count: before - rows.length };
    }),
  };
  const vaultCredentialLimit = {
    findMany: vi.fn(async ({ where }: { where: Where }) =>
      limits.filter((entry) => matches(entry, where)),
    ),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = limits.length;
      limits = limits.filter((entry) => !matches(entry, where));
      return { count: before - limits.length };
    }),
    createMany: vi.fn(async ({ data }: { data: Limit[] }) => {
      for (const entry of data)
        if (
          !limits.some(
            (saved) => saved.credentialId === entry.credentialId && saved.spaceId === entry.spaceId,
          )
        )
          limits.push(entry);
    }),
  };
  const vaultCredentialBot = {
    findMany: vi.fn(async ({ where }: { where: Where }) =>
      assignments.filter((entry) => matches(entry, where)),
    ),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = assignments.length;
      assignments = assignments.filter((entry) => !matches(entry, where));
      return { count: before - assignments.length };
    }),
    createMany: vi.fn(async ({ data }: { data: Assignment[] }) => {
      const fresh = data.filter(
        (entry) =>
          !assignments.some(
            (saved) => saved.credentialId === entry.credentialId && saved.botId === entry.botId,
          ),
      );
      assignments.push(...fresh);
      return { count: fresh.length };
    }),
  };
  const client: Record<string, unknown> = {
    vaultCredential,
    vaultCredentialBot,
    vaultCredentialLimit,
    bot: {
      count: vi.fn(
        async ({ where }: { where: Where }) => bots.filter((b) => matches(b, where)).length,
      ),
    },
    spaceSettingOverride: {
      findUnique: vi.fn(
        async ({ where }: { where: { spaceId_userId_setting: { spaceId: string } } }) =>
          ownVaults.has(where.spaceId_userId_setting.spaceId) ? { setting: "credentials" } : null,
      ),
    },
    secret: { count: vi.fn(async () => 0), findFirst: vi.fn(async () => null) },
    // The previous release's table, still counted before a stored value is deleted.
    botSecret: { count: vi.fn(async () => 0) },
    integrationProviderConfig: { count: vi.fn(async () => 0) },
    // The member's settings lock always finds the membership row.
    $queryRaw: vi.fn(async () => [{ locked: 1 }]),
  };
  // One transaction at a time, as the bot row lock serializes them in Postgres, and a failed
  // one leaves the rows as they were.
  let queue: Promise<unknown> = Promise.resolve();
  client.$transaction = (fn: (tx: unknown) => Promise<unknown>) => {
    const next = queue.then(async () => {
      const before = rows.map((row) => ({ ...row }));
      const chosenBefore = [...assignments];
      const limitsBefore = [...limits];
      try {
        return await fn(client);
      } catch (error) {
        rows = before;
        assignments = chosenBefore;
        limits = limitsBefore;
        throw error;
      }
    });
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    rows: () => rows,
    assignments: () => assignments,
    limits: () => limits,
    useOwnVault: (spaceId: string) => ownVaults.add(spaceId),
    prisma: client as unknown as PrismaClient,
  };
}
