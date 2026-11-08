// @vitest-environment jsdom

import type { BotListOrder } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { botListOrderStore, chooseBotListOrder, useBotListOrder } from "./use-bot-list-order";
import { useHomeInbox } from "./use-home-inbox";

const server = vi.hoisted(() => ({
  me: [] as Array<(order: BotListOrder) => void>,
  saves: [] as Array<{ order: unknown; done: () => void; fail: () => void }>,
  alert: vi.fn(),
  sessionEnd: [] as Array<(sameAccount: boolean) => void>,
}));

vi.mock("react-native", () => ({ Alert: { alert: server.alert } }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./i18n", () => {
  const i18n = { t: (text: string) => text, locale: "en" };
  return { ...i18n, useI18n: () => i18n, getActiveUiLocale: () => "en" };
});
vi.mock("./api", () => ({
  currentApiBase: () => "https://api.example.test",
  selectedSpaceId: () => "space-a",
  rpc: (method: string, input?: { botListOrder?: BotListOrder }) => {
    if (method === "spaces/list")
      return Promise.resolve({
        current: { id: "space-a", bots: [], groups: [], botSections: [] },
        spaces: [],
      });
    if (method === "me")
      return new Promise((resolve) => {
        server.me.push((botListOrder) =>
          resolve({ userId: "user-a", spaceId: "space-a", name: "Ada", botListOrder }),
        );
      });
    if (method === "preferences/update")
      return new Promise((resolve, reject) => {
        server.saves.push({
          order: input?.botListOrder,
          done: () => resolve({}),
          fail: () => reject(new Error("offline")),
        });
      });
    throw new Error(`unexpected ${method}`);
  },
}));
vi.mock("./api-server", () => ({ selectInitialSpace: async () => true }));
vi.mock("./app-badge", () => ({ appBadgeGeneration: () => 0 }));
vi.mock("./billing", () => ({ isPaywallShown: () => false }));
vi.mock("./organizations", () => ({ ensureOrganizations: async () => undefined }));
vi.mock("./referral", () => ({ forgetReferrals: vi.fn(), rememberReferral: vi.fn() }));
vi.mock("./saved-chats", () => ({ saveInbox: vi.fn() }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => 1,
  registerSessionDiskCache: (clear: (sameAccount: boolean) => void) =>
    server.sessionEnd.push(clear),
}));
vi.mock("./user-error", () => ({ errorText: String, loadFailureKind: () => "other" }));

let inbox: ReturnType<typeof useHomeInbox>;
let shown: BotListOrder | undefined;
const spaceAction = { current: { busy: false, recoveryId: null } };

function Inbox() {
  inbox = useHomeInbox(spaceAction);
  shown = useBotListOrder();
  return null;
}

let root: Root;
const flush = () =>
  act(
    () =>
      new Promise((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

async function poll(order: BotListOrder) {
  server.me.shift()!(order);
  await flush();
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  server.me.length = 0;
  server.saves.length = 0;
  server.alert.mockReset();
  botListOrderStore.reset();
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Inbox />));
  void inbox.loadBots();
  await flush();
  await poll("manual");
});

afterEach(() => act(() => root.unmount()));

it("keeps a pick over a poll that began before it, then follows the server again", async () => {
  void inbox.loadBots();
  await flush();
  act(() => chooseBotListOrder("recent"));
  expect(shown).toBe("recent");
  await flush();
  server.saves[0]!.done();
  await flush();
  await poll("manual");
  expect(shown).toBe("recent");
  // Another device picked Manual since: the next poll shows it.
  void inbox.loadBots();
  await flush();
  await poll("manual");
  expect(shown).toBe("manual");
});

it("goes back to the server's order and says so once when the save fails", async () => {
  act(() => chooseBotListOrder("recent"));
  await flush();
  server.saves[0]!.fail();
  await flush();
  expect(shown).toBe("manual");
  expect(server.alert).toHaveBeenCalledExactlyOnceWith("Could not save");
});

it("forgets the order when the session ends, unless it is the same account", () => {
  const endSession = (sameAccount: boolean) => {
    for (const clear of server.sessionEnd) act(() => clear(sameAccount));
  };
  endSession(true);
  expect(shown).toBe("manual");
  endSession(false);
  expect(shown).toBeUndefined();
});
