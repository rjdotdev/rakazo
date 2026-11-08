import { randomUUID } from "node:crypto";
import type { ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { settleUnpinnedConnections } from "./connection-flows.js";
import type { RouterDeps } from "./router.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("settleUnpinnedConnections (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const users: string[] = [];

  async function space(): Promise<{ spaceId: string; userId: string }> {
    const id = `unpinned-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({ data: { id, name: id, email: `${id}@example.test` } });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    await system.space.create({
      data: { id, organizationId: id, name: "Personal", isDefault: true, createdByUserId: id },
    });
    await system.spaceMember.create({
      data: {
        id: `sm-${id}`,
        spaceId: id,
        organizationId: id,
        userId: id,
        role: "owner",
        createdAt,
      },
    });
    return { spaceId: id, userId: id };
  }

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
  });

  afterAll(async () => {
    await system.organization.deleteMany({ where: { id: { in: users } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
  });

  it("stores each owner's account on connected rows that name only their app", async () => {
    const [first, second] = [await space(), await space()];
    const row = (
      owner: { spaceId: string; userId: string },
      fields: { connectorId?: string; provider?: string; status?: string; providerRef?: string },
    ) =>
      system.connection.create({
        data: {
          ...owner,
          connectorId: "accounts",
          provider: "mail",
          displayName: "Mail",
          status: "connected",
          providerRef: "mail",
          ...fields,
        },
      });
    const unpinned = [await row(first, {}), await row(second, {})];
    const untouched = [
      await row(first, { providerRef: "account-kept" }),
      await row(first, { provider: "calendar", providerRef: "calendar", status: "pending" }),
      // No remote account to store, or more than one to choose from.
      await row(second, { provider: "drive", providerRef: "drive" }),
      await row(second, { provider: "photos", providerRef: "photos" }),
      // A connector whose tools load without an account id.
      await row(second, { connectorId: "apps" }),
    ];
    const connector = (toolsNeedAccountId: boolean) =>
      ({
        toolsNeedAccountId,
        describe: () => ({ id: "accounts" }),
        connectionReady: vi.fn(async () => true),
        // Remote accounts per app: none for drive, two for photos.
        resolveConnectedAccountId: vi.fn(
          async (
            userId: string,
            slug: string,
            ref: string | null | undefined,
            exclude: string[],
          ) =>
            ref === slug
              ? { mail: [`account-${userId}`], drive: [], photos: ["work", "home"] }[slug]?.find(
                  (id) => !exclude.includes(id),
                )
              : (ref ?? undefined),
        ),
      }) as unknown as ManagedConnectorProvider;
    const connectors = { accounts: connector(true), apps: connector(false) };

    await settleUnpinnedConnections({
      prisma: db.prisma,
      connectors: { managed: (id: keyof typeof connectors) => connectors[id] },
    } as unknown as Pick<RouterDeps, "prisma" | "connectors">);

    const stored = (rows: Array<{ id: string }>) =>
      Promise.all(
        rows.map(({ id }) =>
          system.connection.findUniqueOrThrow({
            where: { id },
            select: { providerRef: true, status: true, updatedAt: true },
          }),
        ),
      );
    expect(await stored(unpinned)).toEqual([
      expect.objectContaining({ providerRef: `account-${first.userId}`, status: "connected" }),
      expect.objectContaining({ providerRef: `account-${second.userId}`, status: "connected" }),
    ]);
    expect(await stored(untouched)).toEqual(
      untouched.map(({ providerRef, status, updatedAt }) => ({ providerRef, status, updatedAt })),
    );
    expect(connectors.apps.resolveConnectedAccountId).not.toHaveBeenCalled();
  });
});
