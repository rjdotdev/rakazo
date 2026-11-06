import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { ContentLocation, PrismaClient } from "@rakazo/db";
import {
  ContentDecryptionError,
  ciphertextKeyId,
  contentEncryptionOf,
  decryptText,
  encryptText,
} from "@rakazo/db";
import { INFISICAL_REF_PREFIX } from "./infisical-secret-store.js";

type VaultRow = { id: string; userId: string; spaceId: string | null };

// Vault keys sit beside the space keys under scopes no Space id can take: the account vault
// belongs to no Space, and a Space's content key exists long before `migrate` moves its vault.
const keyScope = (row: VaultRow) => (row.spaceId ? `vault:${row.spaceId}` : `user:${row.userId}`);
const location = (row: VaultRow): ContentLocation => ({
  table: "vault_credentials",
  column: "ciphertext",
  rowId: row.id,
  owner: row.userId,
});

function ringOf(prisma: PrismaClient) {
  const ring = contentEncryptionOf(prisma)?.ring;
  if (!ring) throw new Error("Vault item encryption is unavailable");
  return ring;
}

async function seal(prisma: PrismaClient, row: VaultRow, plaintext: string) {
  return encryptText(await ringOf(prisma).current(keyScope(row)), location(row), plaintext);
}

/**
 * A vault item's stored value: under its vault's data key once `content-encryption migrate` has
 * created one, as content is. Until then the secret store keeps writing the format the previous
 * release reads, since it keeps running for a while after a deploy. An external secret store
 * always keeps the value itself.
 */
export async function sealVaultValue(
  prisma: PrismaClient,
  store: SecretStore,
  row: VaultRow,
  plaintext: string,
  context: AdapterContext,
): Promise<string> {
  const ring = contentEncryptionOf(prisma)?.ring;
  if (ring?.encryptWrites && store.describe().id === "app-encrypted") {
    const key = (await ring.all(keyScope(row))).at(-1);
    if (key) return encryptText(key, location(row), plaintext);
  }
  return (await store.put(plaintext, context, { recordId: row.id })).ciphertext;
}

/** Reads both formats: values under a vault key, and those the secret store wrote before. */
export async function openVaultValue(
  prisma: PrismaClient,
  store: Pick<SecretStore, "load">,
  row: VaultRow & { ciphertext: string },
  signal?: AbortSignal,
): Promise<string> {
  if (!ciphertextKeyId(row.ciphertext))
    return store.load(row.ciphertext, signal ? { recordId: row.id, signal } : row.id);
  return openSealedVaultValue(prisma, row);
}

/** A value under its vault's key; it names that key, and only a key of the row's vault opens it. */
export async function openSealedVaultValue(
  prisma: PrismaClient,
  row: VaultRow & { ciphertext: string },
): Promise<string> {
  const keyId = ciphertextKeyId(row.ciphertext);
  if (!keyId) throw new ContentDecryptionError("Vault item is not under a vault key");
  const ring = ringOf(prisma);
  const key = await ring.byId(keyId).catch(async (error: unknown) => {
    // A key its vault no longer has is damaged data, not a key manager outage; listing the
    // vault's keys fails in an outage too, which then stands.
    if (!(await ring.all(keyScope(row))).some((stored) => stored.id === keyId))
      throw new ContentDecryptionError("Vault item names a key that no longer exists");
    throw error;
  });
  if (key.spaceId !== keyScope(row))
    throw new ContentDecryptionError("Vault item names another vault's key");
  return decryptText(key, location(row), row.ciphertext);
}

/**
 * `encrypt` moves values the secret store wrote into the envelope format, creating each vault's
 * key, after which new saves in that vault use it too; `decrypt` writes them back, before rolling
 * back to a release that cannot read it. Each row is a compare-and-set on its
 * value and date, so a concurrent save wins; a row that cannot be read or verified stays as it
 * was and is reported, as is an item already under a vault key that does not open. Values in an
 * external store stay there. Safe to interrupt and rerun.
 */
export async function migrateVaultValues(
  prisma: PrismaClient,
  store: SecretStore,
  context: AdapterContext,
  options: {
    mode: "encrypt" | "decrypt";
    dryRun?: boolean;
    report?: (
      row: { id: string },
      status: "planned" | "migrated" | "concurrent" | "failed",
    ) => void;
  },
) {
  const counts = { migrated: 0, verified: 0, planned: 0, concurrent: 0, failed: 0 };
  let cursor = "";
  while (true) {
    context.signal.throwIfAborted();
    const batch = await prisma.vaultCredential.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: "asc" },
      take: 200,
      select: { id: true, userId: true, spaceId: true, ciphertext: true, updatedAt: true },
    });
    if (!batch.length) break;
    cursor = batch.at(-1)!.id;
    for (const row of batch) {
      const sealed = ciphertextKeyId(row.ciphertext) !== undefined;
      if (
        row.ciphertext.startsWith(INFISICAL_REF_PREFIX) ||
        (!sealed && options.mode === "decrypt")
      ) {
        counts.verified++;
        continue;
      }
      if (sealed && options.mode === "encrypt") {
        // Already under its vault's key: read, never rewritten, so an unreadable item is reported.
        try {
          await openSealedVaultValue(prisma, row);
          counts.verified++;
        } catch {
          context.signal.throwIfAborted();
          counts.failed++;
          options.report?.(row, "failed");
        }
        continue;
      }
      let status: "migrated" | "concurrent" | "failed";
      try {
        const plaintext = await openVaultValue(prisma, store, row, context.signal);
        // A preview reads each value but creates no key and writes nothing.
        if (options.dryRun) {
          counts.planned++;
          options.report?.(row, "planned");
          continue;
        }
        const next =
          options.mode === "encrypt"
            ? await seal(prisma, row, plaintext)
            : (await store.put(plaintext, context, { recordId: row.id })).ciphertext;
        if ((await openVaultValue(prisma, store, { ...row, ciphertext: next })) !== plaintext)
          throw new Error("Rewritten vault value did not round-trip");
        const { count } = await prisma.vaultCredential.updateMany({
          where: { id: row.id, ciphertext: row.ciphertext, updatedAt: row.updatedAt },
          data: { ciphertext: next, updatedAt: row.updatedAt },
        });
        status = count === 1 ? "migrated" : "concurrent";
      } catch {
        context.signal.throwIfAborted();
        status = "failed";
      }
      counts[status]++;
      options.report?.(row, status);
    }
    if (batch.length < 200) break;
  }
  return counts;
}
