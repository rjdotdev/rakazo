import type { BotListOrder } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createBotListOrderStore } from "./bot-list-order.js";

function setup() {
  const saves: Array<{ order: BotListOrder; done: () => void; fail: () => void }> = [];
  const store = createBotListOrderStore(
    (order) =>
      new Promise<void>((resolve, reject) => {
        saves.push({ order, done: resolve, fail: () => reject(new Error("offline")) });
      }),
  );
  const failed = vi.fn();
  const flush = () =>
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  store.serverSaid("manual");
  return { store, saves, failed, flush };
}

describe("createBotListOrderStore", () => {
  it("keeps a pick over refreshes until it saves, then follows another device", async () => {
    const { store, saves, failed, flush } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.begin();
    store.choose("recent", failed);
    expect(store.get()).toBe("recent");
    expect(listener).toHaveBeenCalled();
    // A poll that began before the pick, and one answering while it saves, leave it alone.
    store.serverSaid("manual", before);
    const during = store.begin();
    store.serverSaid("manual", during);
    expect(store.get()).toBe("recent");
    await flush();
    saves[0]!.done();
    await flush();
    store.serverSaid("manual", before);
    store.serverSaid("manual", during);
    expect(store.get()).toBe("recent");
    // A poll that began after the pick is the server's word: another device changed it.
    store.serverSaid("manual", store.begin());
    expect(store.get()).toBe("manual");
  });

  it("saves quick picks in order, so going back to the old order is saved too", async () => {
    const { store, saves, failed, flush } = setup();
    store.choose("recent", failed);
    store.choose("manual", failed);
    store.choose("manual", failed);
    await flush();
    saves[0]!.done();
    await flush();
    saves[1]!.done();
    await flush();
    expect(saves.map((save) => save.order)).toEqual(["recent", "manual"]);
    expect(store.get()).toBe("manual");
  });

  it("goes back to the saved order and says so once when the newest save fails", async () => {
    const { store, saves, failed, flush } = setup();
    store.choose("recent", failed);
    await flush();
    saves[0]!.fail();
    await flush();
    expect(store.get()).toBe("manual");
    expect(failed).toHaveBeenCalledOnce();
  });

  it("forgets the order on reset and never sends a queued save for the next account", async () => {
    const { store, saves, failed, flush } = setup();
    store.choose("recent", failed);
    store.choose("manual", failed);
    await flush();
    store.reset();
    expect(store.get()).toBeUndefined();
    saves[0]!.fail();
    await flush();
    expect(saves.map((save) => save.order)).toEqual(["recent"]);
    expect(failed).not.toHaveBeenCalled();
    store.serverSaid("recent");
    expect(store.get()).toBe("recent");
  });
});
