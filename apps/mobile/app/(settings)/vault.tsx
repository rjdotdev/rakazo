import { MenuView } from "@expo/ui/community/menu";
import type {
  BotSecretMetadata,
  VaultKind,
  VaultPolicy,
  VaultRevealed,
  VaultUse,
} from "@rakazo/contracts";
import {
  cardExpiry,
  isIdentityConfirmationRequired,
  VAULT_KINDS,
  vaultKind,
} from "@rakazo/contracts";
import * as Clipboard from "expo-clipboard";
import type { NativeStackNavigationOptions } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ViewStyle } from "react-native";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotEmailAddressesGroup } from "../../components/bot-email";
import { useIdentityConfirmation } from "../../components/confirm-identity";
import { ListSearchInput } from "../../components/list-search-input";
import { LoadFailure } from "../../components/load-failure";
import { LongPressMenu } from "../../components/long-press-menu";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsFooter, SettingsGroup, SettingsRow } from "../../components/settings-group";
import { VaultItemEditor } from "../../components/vault-item-editor";
import { VaultItemSheet } from "../../components/vault-item-sheet";
import type { MobileBot } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { presentMessageActionSheet } from "../../lib/message-action-sheet";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { iosAtLeast } from "../../lib/native-controls";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";
import type { VaultBots, VaultItem, VaultSave } from "../../lib/vault";
import {
  billingChoices,
  filterVaultItems,
  readableItem,
  VAULT_SEARCH_MIN_ITEMS,
  vaultItemSubtitle,
  vaultKindLabel,
  vaultKindSymbol,
  vaultKindsPresent,
  withItem,
} from "../../lib/vault";

type RowAction = "edit" | "remove";
type Editing = { kind: VaultKind; item?: VaultItem; revealed?: VaultRevealed };

/**
 * Logins, cards, contacts, API keys and variables bots can use. Opened with a Space that keeps its
 * own vault, it edits that Space's items instead of the account's. Show reads a protected value
 * back once the person confirms it's them; the value lives only in the native alert that shows it,
 * never in this screen's state.
 */
export default function Vault() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const navigation = useNavigation();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const scope = target.scope;
  const { t } = useI18n();
  const colorScheme = useResolvedAppearance();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState<BotSecretMetadata[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<VaultKind | "all">("all");
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [uses, setUses] = useState<{ key: string; list: VaultUse[] } | null>(null);
  // A saved item to open once the editor has gone, so two sheets are never up at once.
  const afterEditing = useRef<{ name: string; notice: string } | null>(null);
  const [notice, setNotice] = useState<{ name: string; text: string } | null>(null);
  // Counts changes, so a read that started before one never shows what it replaced.
  const changes = useRef(0);
  // A value that arrives after the screen lost focus is dropped instead of shown.
  const focused = useRef(false);
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      let current = true;
      const changesAtRead = changes.current;
      void rpc("vault/list", { scope })
        .then((next) => {
          if (!current || changes.current !== changesAtRead) return;
          setItems(next);
          setError(null);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          if (current) setLoadError(errorText(err, t("Something went wrong. Try again.")));
        });
      return () => {
        current = false;
      };
    }, [attempt, rpc, scope, t]),
  );

  useEffect(() => {
    // An item's uses are never shown for another one, or after a read of them fails.
    setUses(null);
    if (!opened) return;
    let current = true;
    void rpc("vault/activity", { scope, name: opened })
      .then((list) => {
        if (current) setUses({ key: `${scope}:${opened}`, list });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [opened, rpc, scope]);

  // Items can be limited to chosen bots unless the saved ones show this server can't.
  const canChooseBots = !items?.length || items.some((item) => item.allBots !== undefined);
  // Read for each edit, so bots added or a Space's vault changed since are what it offers.
  const [picker, setPicker] = useState<{
    bots: MobileBot[];
    spaces: number;
    ownVault: boolean;
  } | null>(null);
  useEffect(() => {
    setPicker(null);
    if (!editing || !canChooseBots) return;
    let current = true;
    void Promise.all([
      rpc("bots/list"),
      scope === "account" ? rpc("spaces/list") : null,
      scope === "account" ? rpc("spaceSettings/overrides") : null,
    ])
      .then(([list, navigation, overrides]) => {
        if (!current) return;
        // An archived bot the item is limited to is named so, as restoring it brings the choice
        // back, and can be let go of.
        const chosen = editing.item?.allBots === false ? (editing.item.botIds ?? []) : [];
        setPicker({
          bots: list
            .filter((bot) => !bot.archivedAt || chosen.includes(bot.id))
            .map((bot) =>
              bot.archivedAt ? { ...bot, name: `${bot.name} · ${t("Archived")}` } : bot,
            ),
          spaces: navigation?.spaces.length ?? 1,
          ownVault: Boolean(overrides?.includes("credentials")),
        });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [canChooseBots, editing, rpc, scope]);
  const botsNote = picker?.ownVault
    ? t("This Space keeps its own vault, so its bots can't use account items.")
    : picker && picker.spaces > 1
      ? t("This limits only this Space's bots. Your other Spaces choose for their own.")
      : undefined;

  const startAdding = useCallback((kind: VaultKind) => {
    setOpened(null);
    setEditing({ kind });
  }, []);

  useLayoutEffect(() => {
    if (!iosAtLeast(26)) return;
    navigation.setOptions({
      unstable_headerRightItems: () => [
        {
          type: "menu" as const,
          label: t("New item"),
          accessibilityLabel: t("New item"),
          icon: { type: "sfSymbol" as const, name: "plus" },
          menu: {
            items: VAULT_KINDS.map((kind) => ({
              type: "action" as const,
              label: vaultKindLabel(kind),
              icon: { type: "sfSymbol" as const, name: vaultKindSymbol(kind).ios as never },
              onPress: () => startAdding(kind),
            })),
          },
        },
      ],
    } satisfies NativeStackNavigationOptions);
  }, [navigation, startAdding, t]);

  async function save(change: VaultSave, policy?: VaultPolicy, access?: VaultBots) {
    changes.current += 1;
    setError(null);
    const saved = await rpc("vault/put", {
      scope,
      ...change,
      ...access,
      ...(policy ? { policy } : {}),
    });
    setItems((current) => withItem(current ?? [], saved));
    // A server from before Block drops it silently, but the item is saved, so say so.
    if (policy === "ask" && saved.policy !== "ask")
      afterEditing.current = {
        name: saved.name,
        notice: t("Saved, but this server can't ask you first."),
      };
    else if (policy && saved.policy === undefined)
      afterEditing.current = {
        name: saved.name,
        notice: t("Saved, but this server can't block bots yet."),
      };
    else if (access?.allBots === false && saved.allBots === undefined)
      afterEditing.current = {
        name: saved.name,
        notice: t("Saved, but this server can't limit an item to chosen bots."),
      };
  }

  async function remove(name: string) {
    changes.current += 1;
    setPending(true);
    setError(null);
    try {
      await rpc("vault/remove", { scope, name });
      setItems((current) => current?.filter((entry) => entry.name !== name) ?? null);
      setOpened(null);
      setUses(null);
    } catch (err) {
      setError(errorText(err, t("Could not remove the item")));
    } finally {
      setPending(false);
    }
  }

  function confirmRemove(item: BotSecretMetadata) {
    Alert.alert(t("Remove {name}?", { name: item.title }), undefined, [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Remove"), style: "destructive", onPress: () => void remove(item.name) },
    ]);
  }

  async function show(item: BotSecretMetadata) {
    setPending(true);
    setError(null);
    try {
      const revealed = await withIdentityConfirmation(() =>
        rpc("vault/reveal", { scope, name: item.name }),
      );
      if (focused.current) showRevealed(item.title, revealed);
    } catch (err) {
      // Dismissing the confirmation prompt is the person's choice, not a failure.
      if (!isIdentityConfirmationRequired(err)) {
        setError(errorText(err, t("Could not show the item")));
      }
    } finally {
      setPending(false);
    }
  }

  function showRevealed(title: string, revealed: VaultRevealed) {
    const copy = (text: string) => void Clipboard.setStringAsync(text).catch(() => undefined);
    if ("value" in revealed) {
      Alert.alert(title, revealed.value, [
        { text: t("Copy"), onPress: () => copy(revealed.value) },
        { text: t("Done"), style: "cancel" },
      ]);
      return;
    }
    const fields =
      "card" in revealed
        ? [
            { label: t("Card number"), value: revealed.card.number },
            { label: t("Expires"), value: cardExpiry(revealed.card) },
            ...(revealed.card.cvc ? [{ label: t("Security code"), value: revealed.card.cvc }] : []),
          ]
        : revealed.fields;
    Alert.alert(title, fields.map((field) => `${field.label}\n${field.value}`).join("\n\n"), [
      {
        text: t("Copy"),
        // An item can have more fields than an Android alert has buttons, so each gets a sheet row.
        onPress: () =>
          presentMessageActionSheet({
            title,
            actions: fields.map((field) => ({
              text: t("Copy {label}", { label: field.label }),
              onPress: () => copy(field.value),
            })),
            cancel: t("Cancel"),
            more: t("More"),
            colorScheme,
          }),
      },
      { text: t("Done"), style: "cancel" },
    ]);
  }

  /** A login or card opens with its value, after the person confirms it's them, so Save keeps all of it. */
  async function edit(item: BotSecretMetadata) {
    const readable = readableItem(item);
    if (!readable) return;
    const kind = vaultKind(readable.auth.type);
    let revealed: VaultRevealed | undefined;
    if (kind === "login" || kind === "card") {
      setPending(true);
      setError(null);
      try {
        revealed = await withIdentityConfirmation(() =>
          rpc("vault/reveal", { scope, name: readable.name }),
        );
      } catch (err) {
        // Dismissing the confirmation prompt is the person's choice, not a failure.
        if (!isIdentityConfirmationRequired(err)) {
          setError(errorText(err, t("Could not show the item")));
        }
        return;
      } finally {
        setPending(false);
      }
      if (!focused.current) return;
    }
    setOpened(null);
    setEditing({ kind, item: readable, revealed });
  }

  function runAction(item: BotSecretMetadata, action: RowAction) {
    if (pending) return;
    if (action === "edit") void edit(item);
    if (action === "remove") confirmRemove(item);
  }

  const kinds = items ? vaultKindsPresent(items) : [];
  const activeFilter = filter !== "all" && !kinds.includes(filter) ? "all" : filter;
  const shown = items ? filterVaultItems(items, activeFilter, query) : [];
  const failure = error ?? loadError;
  const shownError = error ?? (items ? loadError : null);
  const openedItem = items?.find((item) => item.name === opened);
  const contacts = items ? billingChoices(items) : [];
  const billingTitle = (name?: string) => contacts.find((contact) => contact.key === name)?.label;

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {failure && !items ? (
          <LoadFailure
            message={failure}
            onRetry={() => {
              setError(null);
              setLoadError(null);
              setAttempt((count) => count + 1);
            }}
          />
        ) : shownError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {shownError}
          </Text>
        ) : null}
        <SettingsFooter>{t("Logins, cards and details your bots can use for you.")}</SettingsFooter>
        {items && !iosAtLeast(26) ? (
          // Older iOS and Android have no header menu, so New sits above the list.
          <MenuView
            colorScheme={colorScheme}
            title={t("New item")}
            actions={VAULT_KINDS.map((kind) => ({ id: kind, title: vaultKindLabel(kind) }))}
            onPressAction={({ nativeEvent }) => startAdding(nativeEvent.event as VaultKind)}
          >
            {/* A plain view: on Android the menu opens from its own Pressable, which a
                nested Pressable would take the touch from. */}
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel={t("New item")}
              style={styles.add}
            >
              <NativeSymbol ios="plus" android="add" size={18} />
              <Text style={styles.addLabel}>{t("New item")}</Text>
            </View>
          </MenuView>
        ) : null}
        {items && items.length >= VAULT_SEARCH_MIN_ITEMS ? (
          <ListSearchInput query={query} setQuery={setQuery} />
        ) : null}
        {kinds.length > 1 ? (
          <NativeSegmentedControl
            accessibilityLabel={t("Kind")}
            value={activeFilter}
            onChange={setFilter}
            options={[
              { value: "all" as const, label: t("All") },
              ...kinds.map((kind) => ({ value: kind, label: filterLabel(kind) })),
            ]}
          />
        ) : null}
        {/* A read that failed can't show the vault is empty. */}
        {items && items.length === 0 && !failure ? (
          <SettingsGroup
            label={t("Add your first item")}
            footer={t("Bots type saved passwords and card numbers without seeing them.")}
          >
            {VAULT_KINDS.map((kind) => (
              <SettingsRow
                key={kind}
                accessibilityRole="button"
                dimmed={pending}
                onPress={() => startAdding(kind)}
                title={vaultKindLabel(kind)}
                detail={kindHint(kind)}
                leading={<KindTile kind={kind} style={styles.tile} />}
              />
            ))}
          </SettingsGroup>
        ) : null}
        {shown.length ? (
          <SettingsGroup>
            {shown.map((item) => {
              const readable = readableItem(item);
              const kind = readable ? vaultKind(readable.auth.type) : null;
              return (
                // A long press opens the row's actions; a tap opens the item.
                <LongPressMenu
                  key={item.name}
                  actions={[
                    ...(readable
                      ? [{ id: "edit", title: t("Edit"), attributes: { disabled: pending } }]
                      : []),
                    {
                      id: "remove",
                      title: t("Remove"),
                      attributes: { destructive: true, disabled: pending },
                    },
                  ]}
                  colorScheme={colorScheme}
                  onPressAction={(event) => {
                    const action = event.nativeEvent.event;
                    if (action === "edit" || action === "remove") runAction(item, action);
                  }}
                  title={item.title}
                >
                  {(onLongPress) => (
                    <SettingsRow
                      accessibilityRole="button"
                      dimmed={pending}
                      onPress={() => {
                        setNotice(null);
                        setOpened(item.name);
                      }}
                      onLongPress={onLongPress}
                      title={item.title}
                      detail={vaultItemSubtitle(item) || undefined}
                      chevron="right"
                      leading={<KindTile kind={kind} style={styles.tile} />}
                    />
                  )}
                </LongPressMenu>
              );
            })}
          </SettingsGroup>
        ) : null}
        {scope === "account" ? <BotEmailAddressesGroup /> : null}
      </ScrollView>
      {openedItem ? (
        <VaultItemSheet
          item={openedItem}
          billingTitle={billingTitle(openedItem.preview?.card?.billing)}
          uses={uses?.key === `${scope}:${openedItem.name}` ? uses.list : []}
          notice={notice?.name === openedItem.name ? notice.text : undefined}
          busy={pending}
          onClose={() => {
            setOpened(null);
            setNotice(null);
          }}
          onShow={() => void show(openedItem)}
          onEdit={() => void edit(openedItem)}
          onRemove={() => confirmRemove(openedItem)}
        />
      ) : null}
      {editing ? (
        <VaultItemEditor
          kind={editing.kind}
          item={editing.item}
          revealed={editing.revealed}
          contacts={contacts}
          onClose={() => {
            setEditing(null);
            const next = afterEditing.current;
            afterEditing.current = null;
            if (next) {
              setOpened(next.name);
              setNotice({ name: next.name, text: next.notice });
            }
          }}
          bots={canChooseBots && !picker?.ownVault ? picker?.bots : undefined}
          botsNote={botsNote}
          onSave={save}
        />
      ) : null}
      {identityDialog}
    </SafeAreaView>
  );

  function kindHint(kind: VaultKind) {
    if (kind === "login") return t("Signs in only on its own site");
    if (kind === "card") return t("Asks you before every payment");
    if (kind === "contact") return t("Fills in a name, address or phone");
    if (kind === "api_key") return t("Lets a bot call a service");
    return t("Set in the bot's commands");
  }

  function filterLabel(kind: VaultKind) {
    if (kind === "login") return t("Logins");
    if (kind === "card") return t("Cards");
    if (kind === "contact") return t("Contacts");
    if (kind === "api_key") return t("Keys");
    return t("Variables");
  }
}

/** A kind's symbol on a tile; an item whose settings can't be read shows a warning. */
function KindTile({ kind, style }: { kind: VaultKind | null; style: ViewStyle }) {
  const symbol = kind
    ? vaultKindSymbol(kind)
    : { ios: "exclamationmark.triangle", android: "warning-outline" };
  return (
    <View style={style}>
      <NativeSymbol ios={symbol.ios} android={symbol.android as never} size={17} />
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 16, paddingBottom: 40 },
    error: { color: tokens.destructive, fontSize: 14 },
    add: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-end", padding: 8 },
    addLabel: { color: native.label, fontSize: 17 },
    tile: {
      width: 32,
      height: 32,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: native.fill,
      marginEnd: 12,
    },
  });
}
