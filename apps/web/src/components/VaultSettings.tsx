import { Trans, useLingui } from "@lingui/react/macro";
import type { BotSecretMetadata, SettingsScope, VaultKind, VaultRevealed } from "@rakazo/contracts";
import { isIdentityConfirmationRequired, VAULT_KINDS, vaultKind } from "@rakazo/contracts";
import { fetchFresh, writeSaved } from "@rakazo/core/query";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ListSearchInput,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { useIdentityConfirmation } from "./ConfirmIdentityDialog";
import { useOwnSpaces } from "./integrations/space-availability";
import { BotEmailAddresses } from "./vault/BotEmailAddresses";
import { useVaultKindLabels, useVaultSubtitle, VaultTile } from "./vault/kinds";
import { VaultItemDetail } from "./vault/VaultItemDetail";
import type { VaultEditorInitial, VaultEditorResult } from "./vault/VaultItemEditor";
import { VaultItemEditorPage } from "./vault/VaultItemEditor";

export { REVEAL_MS } from "./vault/VaultItemDetail";

/** Filters and search appear only once a vault holds enough to need them. */
const SEARCH_FROM = 8;
const REVEAL_CANCELLED = new Error("Reveal cancelled");

type Editing = { kind: VaultKind; mode: "new" | "edit"; initial?: VaultEditorInitial };

/** The items in the account's vault, or in the bound Space's own once it customizes them. */
export function VaultSettings({
  scope,
  onBusyChange,
}: {
  scope: SettingsScope;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const list = queries.vault.list.queryOptions({ input: { scope } });
  const listQuery = useQuery({ ...list, refetchOnMount: "always" });
  // Bots are chosen in the Space they're in, and a Space with its own vault never uses the account's.
  const overrides = useQuery({
    ...queries.spaceSettings.overrides.queryOptions(),
    enabled: scope === "account",
  });
  const otherSpaces = useOwnSpaces().length > 1;
  const ownVault = scope === "account" && Boolean(overrides.data?.includes("credentials"));
  const botsNote = ownVault
    ? t`This Space keeps its own vault, so its bots can't use account items.`
    : scope === "account" && otherSpaces
      ? t`This limits only this Space's bots. Your other Spaces choose for their own.`
      : undefined;
  const items = listQuery.data;
  const { one, many } = useVaultKindLabels();
  const subtitle = useVaultSubtitle();
  const emptyHeading = useId();
  const hints: Record<VaultKind, string> = {
    login: t`Signs in only on its own site`,
    card: t`Asks you before every payment`,
    contact: t`Fills in a name, address or phone`,
    api_key: t`Lets a bot call a service`,
    variable: t`Set in the bot's commands`,
  };
  const [filter, setFilter] = useState<VaultKind | "all">("all");
  const [search, setSearch] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const revealAttempt = useRef(0);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  async function refresh() {
    try {
      await fetchFresh(queryClient, list);
      return true;
    } catch {
      return false;
    }
  }

  const activityKey = (name: string) => queries.vault.activity.queryKey({ input: { scope, name } });

  async function save(result: VaultEditorResult) {
    setBusy(true);
    let saved: BotSecretMetadata;
    const input = {
      scope,
      destination: result.destination,
      ...(result.value !== undefined ? { value: result.value } : {}),
      ...(result.title !== undefined ? { title: result.title } : {}),
      ...(result.note !== undefined ? { note: result.note } : {}),
      ...(result.allBots !== undefined ? { allBots: result.allBots } : {}),
      ...(result.botIds ? { botIds: result.botIds } : {}),
      ...(result.policy ? { policy: result.policy } : {}),
    };
    try {
      saved = await rpc.vault.put(input);
    } finally {
      setBusy(false);
    }
    void queryClient.invalidateQueries({ queryKey: activityKey(saved.name) });
    if (await refresh()) setError(null);
    else {
      // The save landed even though the list can't be read again, so it stays listed.
      await writeSaved(queryClient, list.queryKey, (prev = []) => [
        ...prev.filter((row) => row.name !== saved.name),
        saved,
      ]);
      setError(t`Could not load credentials.`);
    }
    // A server from before Block drops it silently, but the item is saved, so say so.
    if (result.policy === "ask" && saved.policy !== "ask") {
      setOpened(saved.name);
      setDetailError(t`Saved, but this server can't ask you first.`);
    } else if (result.policy && saved.policy === undefined) {
      setOpened(saved.name);
      setDetailError(t`Saved, but this server can't block bots yet.`);
    } else if (result.allBots === false && saved.allBots === undefined) {
      setOpened(saved.name);
      setDetailError(t`Saved, but this server can't limit an item to chosen bots.`);
    }
  }

  async function reveal(name: string): Promise<VaultRevealed | null> {
    setDetailError(null);
    const attempt = revealAttempt.current;
    const current = () => revealAttempt.current === attempt;
    try {
      const shown = await withIdentityConfirmation(async () => {
        try {
          return await rpc.vault.reveal({ scope, name });
        } catch (err) {
          // A reveal whose item closed while it waited must not ask the person to confirm.
          throw current() ? err : REVEAL_CANCELLED;
        }
      });
      return current() ? shown : null;
    } catch (err) {
      // Closing the confirmation is a choice, not a failure.
      if (current() && err !== REVEAL_CANCELLED && !isIdentityConfirmationRequired(err))
        setDetailError(errorText(err, t`Could not show the credential`));
      return null;
    }
  }

  /** Leaves the opened item; a reveal still waiting for it is dropped. */
  function closeItem() {
    revealAttempt.current += 1;
    setOpened(null);
  }

  async function remove(name: string) {
    if (busy) return false;
    setDetailError(null);
    setBusy(true);
    try {
      await rpc.vault.remove({ scope, name });
    } catch (err) {
      setDetailError(errorText(err, t`Could not remove the credential`));
      return false;
    } finally {
      setBusy(false);
    }
    // The name can be saved again at once, and a new item must not show this one's uses.
    queryClient.removeQueries({ queryKey: activityKey(name) });
    closeItem();
    if (!(await refresh())) {
      await writeSaved(queryClient, list.queryKey, (prev = []) =>
        prev.filter((row) => row.name !== name),
      );
      setError(t`Could not load credentials.`);
    }
    return true;
  }

  function startEdit(item: BotSecretMetadata, revealed?: VaultRevealed) {
    if (!item.auth) return;
    const kind = vaultKind(item.auth.type);
    // The item stays opened underneath, so saving or going back returns to it.
    setEditing({
      kind,
      mode: "edit",
      initial: {
        name: item.name,
        title: item.title,
        note: item.note,
        origin: item.origin,
        auth: item.auth,
        ...(revealed && "fields" in revealed ? { loginFields: revealed.fields } : {}),
        ...(revealed && "card" in revealed ? { card: revealed.card } : {}),
        ...(item.preview?.contact ? { contact: item.preview.contact } : {}),
        ...(item.policy ? { policy: item.policy } : {}),
        ...(item.allBots !== undefined
          ? {
              ...(ownVault ? {} : { access: { allBots: item.allBots, botIds: item.botIds ?? [] } }),
              botsNote,
            }
          : {}),
      },
    });
  }

  // A new item can be limited to chosen bots unless the saved ones show this server can't.
  const newItem = (kind: VaultKind): Editing => ({
    kind,
    mode: "new",
    ...(items?.length && items.every((item) => item.allBots === undefined)
      ? {}
      : {
          initial: {
            ...(ownVault ? {} : { access: { allBots: true, botIds: [] } }),
            botsNote,
          },
        }),
  });

  const contacts = (items ?? []).flatMap((item) =>
    item.auth?.type === "contact" ? [{ name: item.name, title: item.title }] : [],
  );
  const counts = new Map<VaultKind, number>();
  for (const item of items ?? [])
    if (item.auth)
      counts.set(vaultKind(item.auth.type), (counts.get(vaultKind(item.auth.type)) ?? 0) + 1);
  const kindsShown = VAULT_KINDS.filter((kind) => counts.has(kind));
  const activeFilter = filter !== "all" && counts.has(filter) ? filter : "all";
  const searching = (items?.length ?? 0) >= SEARCH_FROM;
  const needle = searching ? search.trim().toLowerCase() : "";
  const shown = (items ?? []).filter(
    (item) =>
      (activeFilter === "all" || (item.auth && vaultKind(item.auth.type) === activeFilter)) &&
      (!needle ||
        [item.title, subtitle(item), item.origin, item.name].some((text) =>
          text.toLowerCase().includes(needle),
        )),
  );
  const openedItem = items?.find((item) => item.name === opened);

  // An item or form takes the list's place in this panel instead of opening a dialog over Settings.
  if (editing)
    return (
      <section data-testid="vault">
        <VaultItemEditorPage
          key={`${editing.mode}-${editing.kind}-${editing.initial?.name ?? ""}`}
          onBack={() => setEditing(null)}
          kind={editing.kind}
          mode={editing.mode}
          heading={
            editing.mode === "edit"
              ? (editing.initial?.title ?? one[editing.kind])
              : {
                  login: t`New login`,
                  card: t`New card`,
                  contact: t`New contact`,
                  api_key: t`New API key`,
                  variable: t`New variable`,
                }[editing.kind]
          }
          initial={editing.initial}
          contacts={contacts}
          onSave={save}
          failureText={(err) => errorText(err, t`Could not save the credential`)}
        />
      </section>
    );
  if (openedItem)
    return (
      <section data-testid="vault">
        <VaultItemDetail
          key={openedItem.name}
          scope={scope}
          item={openedItem}
          contactTitles={new Map(contacts.map((contact) => [contact.name, contact.title]))}
          busy={busy}
          error={detailError}
          onClose={closeItem}
          onReveal={() => reveal(openedItem.name)}
          onEdit={(revealed) => startEdit(openedItem, revealed)}
          onRemove={() => remove(openedItem.name)}
        />
        {identityDialog}
      </section>
    );

  return (
    <section data-testid="vault" className="space-y-3">
      {/* What the Vault is for is the page's subtitle, from the settings nav. */}
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="vault-new"
            disabled={busy}
            render={<Button size="sm" className="shrink-0 rounded-full" />}
          >
            <Plus />
            <Trans>New</Trans>
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {VAULT_KINDS.map((kind) => (
              <Fragment key={kind}>
                {kind === "api_key" ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  data-testid={`vault-new-${kind}`}
                  onClick={() => setEditing(newItem(kind))}
                >
                  <VaultTile kind={kind} title="" className="size-5 rounded-none bg-transparent" />
                  {one[kind]}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {kindsShown.length > 1 || searching ? (
        <div className="flex flex-wrap items-center gap-2">
          {kindsShown.length > 1 ? (
            <fieldset
              className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0"
              aria-label={t`Show`}
            >
              {(["all", ...kindsShown] as const).map((kind) => (
                <Button
                  key={kind}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={activeFilter === kind}
                  data-testid={`vault-filter-${kind}`}
                  className="rounded-full text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
                  onClick={() => setFilter(kind)}
                >
                  {kind === "all" ? t`All` : many[kind]}
                  <span className="text-faint-foreground tabular-nums">
                    {kind === "all" ? items?.length : counts.get(kind)}
                  </span>
                </Button>
              ))}
            </fieldset>
          ) : null}
          <span className="flex-1" />
          {searching ? (
            <div className="w-44">
              <ListSearchInput
                query={search}
                setQuery={setSearch}
                label={t`Search Vault`}
                placeholder={t`Search`}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {/* A read that failed can't show the Vault is empty. */}
      {items?.length === 0 && !listQuery.isError && !error ? (
        <div data-testid="vault-empty" className="space-y-2 pt-2">
          <SectionHeading id={emptyHeading} className="px-1">
            <Trans>Add your first item</Trans>
          </SectionHeading>
          <ul aria-labelledby={emptyHeading} className="overflow-hidden rounded-xl bg-muted/50">
            {VAULT_KINDS.map((kind) => (
              <li key={kind} className="border-t border-border first:border-t-0">
                <button
                  type="button"
                  data-testid={`vault-start-${kind}`}
                  disabled={busy}
                  className="flex w-full items-center gap-3 px-3.5 py-2.5 text-start hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-50"
                  onClick={() => setEditing(newItem(kind))}
                >
                  <VaultTile kind={kind} title="" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body font-medium text-foreground">{one[kind]}</span>
                    <span className="block text-body-sm text-muted-foreground">{hints[kind]}</span>
                  </span>
                  <Plus className="size-4 shrink-0 text-faint-foreground" />
                </button>
              </li>
            ))}
          </ul>
          <p className="px-1 text-body-sm text-muted-foreground">
            <Trans>Bots type saved passwords and card numbers without seeing them.</Trans>
          </p>
        </div>
      ) : null}
      {listQuery.isError ? (
        <p className="text-body-sm text-destructive">
          <Trans>Could not load credentials.</Trans>
        </p>
      ) : null}
      {shown.length ? (
        <ul data-testid="vault-card" className="overflow-hidden rounded-xl bg-muted/50">
          {shown.map((item) => {
            const kind = item.auth ? vaultKind(item.auth.type) : null;
            const line = item.auth ? subtitle(item) : "";
            return (
              <li key={item.name} className="border-t border-border first:border-t-0">
                <button
                  type="button"
                  data-testid="vault-credential-row"
                  data-name={item.name}
                  className="flex w-full items-center gap-3 px-3.5 py-2.5 text-start hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  onClick={() => {
                    setDetailError(null);
                    setOpened(item.name);
                  }}
                >
                  <VaultTile kind={kind} title={item.title} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-foreground">
                      {item.title}
                    </span>
                    {item.auth ? (
                      line ? (
                        <span
                          className={`block truncate text-body-sm text-muted-foreground ${kind === "variable" ? "font-mono" : ""}`}
                        >
                          {line}
                        </span>
                      ) : null
                    ) : (
                      <span className="block truncate text-body-sm text-destructive">
                        <Trans>
                          These saved settings can't be read. Remove it and add it again.
                        </Trans>
                      </span>
                    )}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-faint-foreground rtl:rotate-180" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : needle && items?.length ? (
        <p className="py-6 text-center text-body-sm text-muted-foreground">
          <Trans>No matches</Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      {scope === "account" ? <BotEmailAddresses /> : null}
      {identityDialog}
    </section>
  );
}
