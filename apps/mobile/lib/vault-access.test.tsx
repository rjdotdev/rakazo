// @vitest-environment jsdom

import type { BotSecretMetadata, VaultUse } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VaultItemEditor } from "../components/vault-item-editor";
import { VaultItemSheet } from "../components/vault-item-sheet";

const { element } = vi.hoisted(() => ({
  element:
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children),
}));

vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./native", () => ({ native: {}, useThemedStyles: (factory: () => unknown) => factory() }));
vi.mock("./i18n", () => {
  const t = (text: string, values?: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key);
  return { t, useI18n: () => ({ t }) };
});
vi.mock("./activity", () => ({ formatActivityRelativeTime: () => "2h ago" }));
vi.mock("react-native", () => ({
  Modal: element("div"),
  Platform: { OS: "ios" },
  ScrollView: element("div"),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: element("span"),
  TextInput: () => null,
  View: element("div"),
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({}) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: async () => true }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/menu-picker", () => ({ MenuPicker: () => null }));
vi.mock("../components/login-fields-editor", () => ({ LoginFieldsEditor: () => null }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { type: "button", onClick: onPress }, label),
}));
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: ({
    options,
    value,
    disabled,
    onChange,
  }: {
    options: { value: string; label: string }[];
    value: string;
    disabled?: boolean;
    onChange: (value: string) => void;
  }) =>
    createElement(
      "nav",
      null,
      options.map((option) =>
        createElement(
          "button",
          {
            key: option.value,
            type: "button",
            disabled,
            "aria-pressed": option.value === value,
            onClick: () => onChange(option.value),
          },
          option.label,
        ),
      ),
    ),
}));

vi.mock("../components/settings-group", () => ({
  SettingsGroup: element("section"),
  SettingsRow: ({
    title,
    detail,
    value,
    onPress,
  }: {
    title: string;
    detail?: string;
    value?: string;
    onPress?: () => void;
  }) =>
    createElement(
      "button",
      { type: "button", role: "row", onClick: onPress },
      [title, detail, value].filter(Boolean).join(" | "),
    ),
}));

const key = (change: Partial<BotSecretMetadata> = {}) =>
  ({
    name: "stripe",
    origin: "https://api.example.test",
    auth: { type: "bearer" },
    title: "api.example.test",
    note: "",
    policy: "allow",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...change,
  }) as BotSecretMetadata & { auth: { type: "bearer" } };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
const click = (node: HTMLElement) => act(async () => node.click());

let mounts = 0;
async function edit(
  onSave: (...args: unknown[]) => Promise<void> = vi.fn(async () => {}),
  item = key(),
  bots?: { id: string; name: string }[],
  kind: "api_key" | "login" = "api_key",
) {
  mounts += 1;
  await act(async () =>
    root.render(
      createElement(VaultItemEditor, {
        key: mounts,
        kind,
        item,
        // A login is edited from its revealed fields.
        revealed:
          kind === "login"
            ? { fields: [{ label: "Email", value: "alice@example.test", hidden: false }] }
            : undefined,
        bots: bots as never,
        onClose: () => {},
        onSave,
      }),
    ),
  );
  return onSave;
}

it("sends no policy for an untouched item, Block or Allow when changed, and holds still while saving", async () => {
  const onSave = await edit();
  expect(button("Allow").getAttribute("aria-pressed")).toBe("true");
  await click(button("Save"));
  expect(onSave).toHaveBeenLastCalledWith(expect.anything(), undefined, undefined);
  await edit(onSave);
  await click(button("Block"));
  await click(button("Save"));
  expect(onSave).toHaveBeenLastCalledWith(expect.anything(), "off", undefined);
  await edit(onSave, key({ policy: "off" }));
  await click(button("Allow"));
  await click(button("Save"));
  expect(onSave).toHaveBeenLastCalledWith(expect.anything(), "allow", undefined);
  await edit(vi.fn(() => new Promise<void>(() => {})));
  await click(button("Save"));
  expect(button("Block").disabled).toBe(true);
});

it("shows a choice that isn't the default, and the latest use opening the list", async () => {
  const use: VaultUse = {
    at: "2026-11-04T10:00:00.000Z",
    botName: "Research bot",
    site: "https://api.example.test",
    chat: null,
  };
  const sheet = (item: BotSecretMetadata, uses: VaultUse[] = [], notice?: string) =>
    act(async () =>
      root.render(
        createElement(VaultItemSheet, {
          item,
          uses,
          notice,
          busy: false,
          onClose: () => {},
          onShow: () => {},
          onEdit: () => {},
          onRemove: () => {},
        }),
      ),
    );
  const rows = () => [...container.querySelectorAll('[role="row"]')].map((row) => row.textContent);
  await sheet(key());
  expect(rows().some((row) => row?.startsWith("Bots"))).toBe(false);
  expect(rows().some((row) => row?.startsWith("Used"))).toBe(false);
  await sheet(key({ policy: "off" }));
  expect(container.textContent).not.toContain("Saved, but");
  await sheet(key({ policy: "off" }), [], "Saved, but this server can't block bots yet.");
  expect(container.textContent).toContain("Saved, but this server can't block bots yet.");
  expect(rows()).toContain("Bots | Block");
  await sheet(key(), [use, { ...use, botName: "Helper", site: null }]);
  expect(rows()).toContain("Used 2h ago by Research bot");
  expect(rows()).not.toContain("Helper | 2h ago");
  await click(button("Used 2h ago by Research bot"));
  expect(rows()).toEqual(
    expect.arrayContaining(["Research bot | api.example.test | 2h ago", "Helper | 2h ago"]),
  );
});

it("limits an item to chosen bots, keeping one the list doesn't show, and only when changed", async () => {
  const bots = [
    { id: "bot-1", name: "Ada" },
    { id: "bot-2", name: "Grace" },
  ];
  const chosen = key({ allBots: false, botIds: ["bot-archived", "bot-1"] });
  const onSave = await edit(undefined, chosen, bots);
  expect(button("Chosen bots").getAttribute("aria-pressed")).toBe("true");
  await click(button("Grace"));
  await click(button("Save"));
  expect(onSave).toHaveBeenLastCalledWith(expect.anything(), undefined, {
    allBots: false,
    botIds: ["bot-archived", "bot-1", "bot-2"],
  });
  await edit(onSave, chosen, bots);
  await click(button("Save"));
  expect(onSave).toHaveBeenLastCalledWith(expect.anything(), undefined, undefined);
  // Every bot by default; choosing none is a choice too.
  await edit(onSave, key(), bots);
  expect(button("Ada")).toBeUndefined();
  await click(button("Chosen bots"));
  await click(button("Save"));
  expect(onSave).toHaveBeenLastCalledWith(expect.anything(), undefined, {
    allBots: false,
    botIds: [],
  });
  // Blocked, no bot may use it at all; on a server that can't keep a choice, there is none.
  await edit(onSave, key(), bots);
  await click(button("Block"));
  expect(button("Chosen bots")).toBeUndefined();
  await edit(onSave, chosen);
  expect(button("Chosen bots")).toBeUndefined();
  // A Space without bots has nothing to choose from.
  await edit(onSave, key(), []);
  expect(button("Chosen bots")).toBeUndefined();
  await act(async () =>
    root.render(
      createElement(VaultItemSheet, {
        item: chosen,
        uses: [],
        busy: false,
        onClose: () => {},
        onShow: () => {},
        onEdit: () => {},
        onRemove: () => {},
      }),
    ),
  );
  expect([...container.querySelectorAll('[role="row"]')].map((row) => row.textContent)).toContain(
    "Bots | Chosen bots",
  );
});

it("offers Ask first for any login, and shows it on the item", async () => {
  const login = key({ name: "work", auth: { type: "login" } as never, policy: "ask" });
  const onSave = await edit(undefined, login, undefined, "login");
  expect(button("Ask first").getAttribute("aria-pressed")).toBe("true");
  await click(button("Allow"));
  await click(button("Save"));
  expect(onSave).toHaveBeenLastCalledWith(expect.anything(), "allow", undefined);
  await edit(onSave, key({ name: "work", auth: { type: "login" } as never }), undefined, "login");
  await click(button("Ask first"));
  await click(button("Save"));
  expect(onSave).toHaveBeenLastCalledWith(expect.anything(), "ask", undefined);
  // Not for an API key; for a login, whatever the server.
  await edit(onSave, key(), undefined, "api_key");
  expect(button("Ask first")).toBeUndefined();
  await edit(onSave, key({ name: "work", auth: { type: "login" } as never }), undefined, "login");
  expect(button("Ask first")).toBeDefined();
  await act(async () =>
    root.render(
      createElement(VaultItemSheet, {
        item: login,
        uses: [],
        busy: false,
        onClose: () => {},
        onShow: () => {},
        onEdit: () => {},
        onRemove: () => {},
      }),
    ),
  );
  expect([...container.querySelectorAll('[role="row"]')].map((row) => row.textContent)).toContain(
    "Bots | Ask first",
  );
  await act(async () =>
    root.render(
      createElement(VaultItemSheet, {
        item: { ...login, allBots: false, botIds: ["bot-1"] },
        uses: [],
        busy: false,
        onClose: () => {},
        onShow: () => {},
        onEdit: () => {},
        onRemove: () => {},
      }),
    ),
  );
  expect([...container.querySelectorAll('[role="row"]')].map((row) => row.textContent)).toContain(
    "Bots | Ask first · Chosen bots",
  );
  // Chosen, but none: no bot may use it, said as the web says it.
  await act(async () =>
    root.render(
      createElement(VaultItemSheet, {
        item: { ...login, allBots: false, botIds: [] },
        uses: [],
        busy: false,
        onClose: () => {},
        onShow: () => {},
        onEdit: () => {},
        onRemove: () => {},
      }),
    ),
  );
  expect([...container.querySelectorAll('[role="row"]')].map((row) => row.textContent)).toContain(
    "Bots | Ask first · No bots",
  );
});

it("says under the bots what a choice covers, or why none can be made", async () => {
  const note = "This limits only this Space's bots. Your other Spaces choose for their own.";
  const editor = (item: BotSecretMetadata, bots?: { id: string; name: string }[]) => {
    mounts += 1;
    return act(async () =>
      root.render(
        createElement(VaultItemEditor, {
          key: mounts,
          kind: "api_key",
          item: item as never,
          bots: bots as never,
          botsNote: note,
          onClose: () => {},
          onSave: async () => {},
        }),
      ),
    );
  };
  const bots = [{ id: "bot-1", name: "Ada" }];
  await editor(key(), bots);
  expect(container.textContent).not.toContain(note);
  await click(button("Chosen bots"));
  expect(container.textContent).toContain(note);
  await click(button("Block"));
  expect(container.textContent).not.toContain(note);
  // No bots to choose from: the reason stands alone.
  await editor(key());
  expect(container.textContent).toContain(note);
});
