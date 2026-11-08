// @vitest-environment jsdom
import type { AppBootstrap, Bot, BotListOrder } from "@rakazo/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { botListOrder, useBotListOrder } from "../../lib/bot-list-order";
import type { createSpaceRpc } from "../../lib/rpc";
import { useRosterDrop, useSpaceRoster } from "./use-space-roster";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
const savePreferences = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
vi.mock("../../lib/rpc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rpc: { preferences: { update: savePreferences } },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot = (id: string, pinned = false) =>
  ({ id, spaceId: "space", pinned, sectionId: null }) as Bot;

async function mountRoster(rpc: ReturnType<typeof createSpaceRpc>, bots: Bot[]) {
  const seed = {
    me: { spaceId: "space" },
    bots,
    groups: [],
    botSections: [],
    spaces: [],
    archivedBots: [],
    archivedGroups: [],
  } as unknown as AppBootstrap;
  let state:
    | { roster: ReturnType<typeof useSpaceRoster>; drop: ReturnType<typeof useRosterDrop> }
    | undefined;
  function Harness() {
    const roster = useSpaceRoster({
      rpc,
      seed,
      botId: "a",
      groupId: undefined,
      navigate: vi.fn(),
      redirectKeepingOverlay: vi.fn(),
    });
    const drop = useRosterDrop({
      rpc,
      bots: roster.bots,
      botListOrder: useBotListOrder(),
      reorderRosterBot: roster.reorderRosterBot,
      refreshBots: async () => undefined,
      refreshGroupThread: vi.fn(),
      activeGroupId: { current: undefined },
      setSendError: vi.fn(),
    });
    state = { roster, drop };
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
  return { state: () => state!, unmount: () => act(async () => root.unmount()) };
}

afterEach(() => botListOrder.reset());

it.each([
  ["manual", "manual", false, true],
  // A drag started in Manual and dropped after the list switched to Recent saves nothing.
  ["manual", "recent", false, false],
  // Pinned keeps its drag order in Recent, so it still reorders.
  ["recent", "recent", true, true],
] as const)(
  "a drag started in %s and dropped in %s (pinned: %s) saves: %s",
  async (start: BotListOrder, atDrop: BotListOrder, pinned: boolean, saves: boolean) => {
    const reorder = vi.fn(async () => undefined);
    const rpc = { bots: { reorder } } as unknown as ReturnType<typeof createSpaceRpc>;
    botListOrder.serverSaid(start);
    const { state, unmount } = await mountRoster(rpc, [bot("a", pinned), bot("b", pinned)]);

    await act(async () => state().drop.setDraggedBotId("a"));
    await act(async () => botListOrder.serverSaid(atDrop));
    // In Recent an unpinned sibling is no drop target, and the move is refused as it lands.
    const sibling = { kind: "bot", chat: bot("b", pinned) } as const;
    expect(Boolean(state().drop.rosterDropAction(sibling, true))).toBe(saves);
    await act(async () => state().roster.reorderRosterBot("a", "b", ["a", "b"]));

    expect(reorder).toHaveBeenCalledTimes(saves ? 1 : 0);
    expect(state().roster.bots.map((item) => item.id)).toEqual(saves ? ["b", "a"] : ["a", "b"]);
    await unmount();
  },
);

it("the roster poll keeps a pending pick and then follows a change from another device", async () => {
  const [first, second] = [deferred<unknown>(), deferred<unknown>()];
  savePreferences.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  let answer = deferred<BotListOrder>();
  const list = vi.fn(async () => ({
    current: { id: "space", name: "Space", bots: [bot("a")], groups: [], botSections: [] },
    spaces: [],
    botListOrder: await answer.promise,
  }));
  const rpc = { spaces: { list } } as unknown as ReturnType<typeof createSpaceRpc>;
  botListOrder.serverSaid("manual");
  const { state, unmount } = await mountRoster(rpc, [bot("a")]);
  async function poll(server: BotListOrder, beforeAnswer?: () => Promise<unknown>) {
    answer = deferred<BotListOrder>();
    let refreshed: Promise<void> | undefined;
    await act(async () => {
      refreshed = state().roster.refreshBots();
    });
    await act(async () => beforeAnswer?.());
    await act(async () => {
      answer.resolve(server);
      await refreshed;
    });
  }

  // A poll that asked before the pick is older than it, even once the save has settled.
  await poll("manual", async () => {
    botListOrder.choose("recent", vi.fn());
    first.resolve({});
    await first.promise;
  });
  expect(savePreferences).toHaveBeenCalledWith({ botListOrder: "recent" });
  expect(botListOrder.get()).toBe("recent");
  // While a pick is still saving, a poll reporting the old order cannot undo it.
  await act(async () => botListOrder.choose("manual", vi.fn()));
  await poll("recent");
  expect(botListOrder.get()).toBe("manual");
  // Once it has saved, a later poll that disagrees means another device changed it: follow it.
  await act(async () => second.resolve({}));
  await poll("recent");
  expect(botListOrder.get()).toBe("recent");
  await unmount();
});
