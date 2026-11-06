import type { SecretMigrationRepository, SecretMigrationRow } from "@rakazo/adapters";
import { openSealedVaultValue } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { isCiphertext } from "@rakazo/db";

const tables = ["secret", "botSecret", "vaultCredential", "integrationProviderConfig"] as const;

export function createSecretMigrationRepository(prisma: PrismaClient): SecretMigrationRepository {
  // A card approval checks its vault item's date, so moving the value keeps it.
  const vaultDates = new Map<string, Date>();
  return {
    async *rows() {
      for (const label of tables) {
        let cursor: string | undefined;
        while (true) {
          const delegate = prisma[label];
          const batch = (await Reflect.apply(delegate.findMany, delegate, [
            {
              orderBy: { id: "asc" },
              take: 100,
              ...(cursor ? { where: { id: { gt: cursor } } } : {}),
            },
          ])) as Array<{
            id: string;
            ciphertext: string;
            kind?: string;
            userId: string;
            spaceId: string | null;
            updatedAt?: Date;
          }>;
          for (const row of batch) {
            if (label === "vaultCredential" && row.updatedAt) vaultDates.set(row.id, row.updatedAt);
            yield {
              id: row.id,
              label,
              ref: row.ciphertext,
              recordId:
                label === "integrationProviderConfig" ? `integration-provider:${row.id}` : row.id,
              ephemeral: ["run-secret:", "run-login:", "run-code:", "run-code-spent:"].some(
                (prefix) => row.kind?.startsWith(prefix),
              ),
              ...(label === "vaultCredential" && isCiphertext(row.ciphertext)
                ? { open: () => openSealedVaultValue(prisma, row) }
                : {}),
            };
          }
          if (batch.length < 100) break;
          cursor = batch.at(-1)?.id;
        }
      }
    },
    async replace(row: SecretMigrationRow, ref: string) {
      const delegate = prisma[row.label as (typeof tables)[number]];
      const updatedAt = row.label === "vaultCredential" ? vaultDates.get(row.id) : undefined;
      const kept = updatedAt ? { updatedAt } : {};
      const result = (await Reflect.apply(delegate.updateMany, delegate, [
        { where: { id: row.id, ciphertext: row.ref, ...kept }, data: { ciphertext: ref, ...kept } },
      ])) as { count: number };
      return result.count === 1;
    },
    async referenced(ref) {
      return Boolean(
        (await prisma.secret.count({ where: { ciphertext: ref } })) ||
          (await prisma.botSecret.count({ where: { ciphertext: ref } })) ||
          (await prisma.vaultCredential.count({ where: { ciphertext: ref } })) ||
          (await prisma.integrationProviderConfig.count({ where: { ciphertext: ref } })),
      );
    },
  };
}
