import { expect, test } from "@playwright/test";
import { createDb } from "../../../packages/db/src/index";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("Recent lists each section by newest message and leaves the drag order alone", async ({
  page,
}, testInfo) => {
  await signup(page, `sidebar-order-${Date.now()}@rakazo.test`, "password12", "Sidebar Order");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const create = (name: string) =>
    rpc<{ id: string }>(page, "bots/create", { name, computerMode: "team" });
  const alpha = await create("Alpha");
  const beta = await create("Beta");
  const quiet = await create("Quiet");
  for (const bot of [alpha, beta]) {
    await rpc(page, "threads/send", { botId: bot.id, text: "status?" });
    await rpc(page, "threads/stop", { botId: bot.id });
  }
  // Pinned keeps its drag order in Recent, so its row still reorders there.
  await rpc(page, "bots/update", { botId: beta.id, pinned: true });
  type Listed = { id: string; status: string; threadStatus?: string };
  const listed = () => rpc<Listed[]>(page, "bots/list", {});
  // A stopped run can still write its last message; backdate only once every run has ended.
  await expect
    .poll(async () =>
      (await listed()).every(
        (bot) => bot.status === "idle" && (bot.threadStatus ?? "idle") === "idle",
      ),
    )
    .toBe(true);
  // Spread the chats' newest messages over two days so the rows show different times.
  const { prisma: db, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    for (const [botId, at] of [
      [alpha.id, ago(25)],
      [chiefId, ago(3 * 60)],
      [beta.id, ago(26 * 60)],
    ] as const) {
      await db.message.updateMany({ where: { thread: { botId } }, data: { createdAt: at } });
    }
  } finally {
    await db.$disconnect();
    await pool.end();
  }
  const reorders: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/rpc/bots/reorder")) reorders.push(request.url());
  });
  await page.reload();

  const rows = page.getByTestId("bots-sidebar").locator("[data-roster-bot-id]");
  const row = (id: string) =>
    page.getByTestId("bots-sidebar").locator(`[data-roster-bot-id="${id}"]`);
  const order = () => rows.evaluateAll((els) => els.map((el) => el.dataset.rosterBotId));
  await expect(rows).toHaveCount(4);
  const manualOrder = await order();
  expect(manualOrder[0]).toBe(beta.id);
  await expect(rows.nth(1)).toHaveAttribute("draggable", "true");

  const chooseOrder = async (name: "Manual" | "Most recent") => {
    await page
      .getByRole("button", { name: /^Actions for / })
      .first()
      .click();
    const item = page.getByRole("menuitemradio", { name, exact: true });
    await item.click();
    await expect(item).toHaveAttribute("aria-checked", "true");
  };
  await chooseOrder("Most recent");
  await captureScreenshot(page, testInfo, "sidebar-order-menu");
  await page.keyboard.press("Escape");
  // Quiet has no messages yet, so it sorts by when it was created, after the others' messages.
  await expect.poll(order).toEqual([beta.id, quiet.id, alpha.id, chiefId]);
  await expect(row(beta.id)).toHaveAttribute("draggable", "true");
  // Unpinned rows don't reorder in Recent, but still drag to a section or a group.
  await expect(row(quiet.id)).toHaveAttribute("draggable", "true");
  await expect(row(quiet.id)).not.toHaveAttribute("aria-keyshortcuts");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "sidebar-order-recent");

  // The choice is the account's, and the bot shortcuts follow the order on screen.
  await page.reload();
  await expect.poll(order).toEqual([beta.id, quiet.id, alpha.id, chiefId]);
  await row(quiet.id).click();
  await expect(page).toHaveURL(new RegExp(`/app/${quiet.id}$`));
  await page.keyboard.press("Control+Tab");
  await expect(page).toHaveURL(new RegExp(`/app/${alpha.id}$`));
  await row(chiefId).press("Alt+ArrowDown");

  // Move to still works in Recent.
  await row(alpha.id).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menu", { name: "Move to", exact: true }).getByText("New section").click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name").fill("Later");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(
    page.locator('[data-sidebar-group^="section:"] [data-roster-bot-id]'),
  ).toHaveAttribute("data-roster-bot-id", alpha.id);

  await chooseOrder("Manual");
  await page.keyboard.press("Escape");
  await expect
    .poll(order)
    .toEqual([beta.id, alpha.id, ...manualOrder.filter((id) => id !== beta.id && id !== alpha.id)]);
  await expect(rows.nth(1)).toHaveAttribute("draggable", "true");
  expect(reorders).toEqual([]);
});
