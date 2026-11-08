import { describe, expect, it } from "vitest";
import {
  chatActivityAt,
  groupBotsForSidebar,
  orderBotsForSidebar,
  reorderBotTo,
} from "./bot-sections.js";

const sections = [
  { id: "work", name: "Work" },
  { id: "home", name: "Home" },
];

describe("groupBotsForSidebar", () => {
  it("labels only built-in groups and preserves keys and the heading-free list", () => {
    const labels = { pinned: "Angeheftet", unassigned: "Nicht zugewiesen" };
    const bots = [
      { id: "pin", pinned: true, sectionId: null },
      { id: "loose", pinned: false, sectionId: null },
    ];
    expect(
      groupBotsForSidebar(bots, [{ id: "custom", name: "Pinned" }], {
        labels,
        includeEmptySections: true,
      }).map(({ key, title }) => [key, title]),
    ).toEqual([
      ["pinned", labels.pinned],
      ["section:custom", "Pinned"],
      ["unassigned", labels.unassigned],
    ]);
    expect(groupBotsForSidebar([bots[1]!], [], { labels })[0]?.title).toBeNull();
  });
  it("keeps pinned bots in one top-level group without duplicating them", () => {
    const groups = groupBotsForSidebar(
      [
        { id: "pinned", pinned: true, sectionId: "home" },
        { id: "work", pinned: false, sectionId: "work" },
        { id: "home", pinned: false, sectionId: "home" },
        { id: "loose", pinned: false, sectionId: null },
      ],
      sections,
    );

    expect(groups.map((group) => [group.title, group.bots.map((bot) => bot.id)])).toEqual([
      ["Pinned", ["pinned"]],
      ["Work", ["work"]],
      ["Home", ["home"]],
      ["Unassigned", ["loose"]],
    ]);
  });

  it("treats bots pointing at an unavailable section as unassigned", () => {
    const groups = groupBotsForSidebar(
      [{ id: "orphan", pinned: false, sectionId: "missing" }],
      sections,
    );
    expect(groups).toEqual([
      {
        key: "unassigned",
        title: "Unassigned",
        bots: [{ id: "orphan", pinned: false, sectionId: "missing" }],
      },
    ]);
  });

  it("does not add a heading before sections or pins exist", () => {
    const groups = groupBotsForSidebar([{ id: "first", pinned: false, sectionId: null }], []);
    expect(groups[0]?.title).toBeNull();
  });
});

describe("reorderBotTo", () => {
  const bots = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("moves a bot to the target bot's position in either direction", () => {
    expect(reorderBotTo(bots, "a", "c").map((bot) => bot.id)).toEqual(["b", "c", "a"]);
    expect(reorderBotTo(bots, "c", "a").map((bot) => bot.id)).toEqual(["c", "a", "b"]);
  });

  it("leaves the list alone when either bot is missing or unchanged", () => {
    expect(reorderBotTo(bots, "a", "missing")).toBe(bots);
    expect(reorderBotTo(bots, "a", "a")).toBe(bots);
  });
});

describe("orderBotsForSidebar", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 8, 9, minute)).toISOString();
  const chat = (
    id: string,
    lastMessageAt: string | null,
    { pinned = false, createdAt = at(0), updatedAt = at(59) } = {},
  ) => ({ id, pinned, sectionId: null, lastMessageAt, createdAt, updatedAt });
  const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

  it("sorts each section by newest real message, else creation time; ties and Pinned keep drag order", () => {
    const chats = [
      chat("pin-old", at(1), { pinned: true }),
      chat("pin-new", at(9), { pinned: true }),
      chat("old", at(2)),
      chat("tie-a", at(4)),
      chat("tie-b", at(4)),
      // Never messaged (or only system notes and ticket work): its creation time, not its last edit.
      chat("never", null, { createdAt: at(3), updatedAt: at(58) }),
      chat("new", at(9)),
    ];
    expect(ids(orderBotsForSidebar(chats, "recent"))).toEqual([
      "pin-old",
      "pin-new",
      "new",
      "tie-a",
      "tie-b",
      "never",
      "old",
    ]);
    expect(orderBotsForSidebar(chats, "manual")).toBe(chats);
  });

  it("keeps the row time an older server sends", () => {
    expect(chatActivityAt({ updatedAt: at(5) })).toBe(at(5));
    expect(chatActivityAt({ lastMessageAt: null, createdAt: at(1), updatedAt: at(5) })).toBe(at(1));
  });
});
