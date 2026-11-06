import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("saves a contact, a card billed to it, and a login from Settings, showing no protected value", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `vault-${stamp}@rakazo.test`, "password12", "Vault Owner");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "vault");
  const vault = settings.getByTestId("vault");
  const editor = page.getByTestId("vault-editor");

  async function startNew(kind: string) {
    await vault.getByTestId("vault-new").click();
    await page.getByTestId(`vault-new-${kind}`).click();
    await expect(editor).toBeVisible();
  }

  const empty = vault.getByTestId("vault-empty");
  await expect(page.getByText("Logins and keys your bots can use.", { exact: true })).toBeVisible();
  await expect(empty).toBeVisible();
  await captureScreenshot(page, testInfo, "vault-empty");

  await startNew("contact");
  await editor.getByLabel("Label", { exact: true }).fill("Home");
  await editor.getByLabel("Full name", { exact: true }).fill("Alex Rivera");
  await editor.getByLabel("Address", { exact: true }).fill("12 Elm St");
  await editor.getByLabel("City", { exact: true }).fill("Springfield");
  await editor.getByLabel("ZIP or postal code", { exact: true }).fill("12345");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);

  await startNew("card");
  await editor.getByLabel("Card number", { exact: true }).fill("4242424242424242");
  await expect(editor.getByTestId("vault-card-brand")).toHaveText("Visa");
  await editor.getByLabel("Expiry", { exact: true }).fill("0830");
  await editor.getByLabel("Security code", { exact: true }).fill("123");
  await editor.getByLabel("Billing address", { exact: true }).selectOption({ label: "Home" });
  await editor.getByRole("button", { name: "Add a note", exact: true }).click();
  await editor.getByLabel("When to use", { exact: true }).fill("For travel");
  await captureScreenshot(page, testInfo, "vault-new-card");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);

  await startNew("login");
  await editor.getByLabel("Site", { exact: true }).fill("https://www.example.test");
  const values = editor.getByTestId("login-field").locator("input:not([aria-label='Label'])");
  await values.nth(0).fill(`fake-user-${stamp}@example.test`);
  await values.nth(1).fill(`fake-password-${stamp}`);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);

  const rows = vault.getByTestId("vault-credential-row");
  await expect(rows).toHaveCount(3);
  await expect(vault.getByText("Visa ·· 4242", { exact: true })).toBeVisible();
  await expect(vault.getByText("Expires 08/30 · For travel", { exact: true })).toBeVisible();
  await expect(vault.getByText("Home", { exact: true })).toBeVisible();
  await expect(vault.getByTestId("vault-filter-card")).toBeVisible();
  await expect(empty).toHaveCount(0);
  await captureScreenshot(page, testInfo, "vault-list");

  // A bot's earlier checkout, as the audit log would hold it.
  const at = new Date(Date.now() - 2 * 3600_000).toISOString();
  await page.route("**/rpc/vault/activity", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            at,
            botName: "Research bot",
            site: "https://shop.example.test",
            chat: null,
          },
        ],
      },
    }),
  );
  await vault.getByText("Visa ·· 4242", { exact: true }).click();
  const detail = page.getByTestId("vault-item-detail");
  const activity = detail.getByRole("button", { name: "Used 2h ago by Research bot", exact: true });
  await expect(detail.getByText("•••• 4242", { exact: true })).toBeVisible();
  await expect(detail.getByText("Home", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "vault-card-detail");
  // Every use opens on its own page, and Back returns to the item.
  await activity.click();
  const uses = page.getByTestId("vault-item-uses");
  await expect(uses.getByTestId("vault-item-use")).toHaveText(
    "Research botshop.example.test2h ago",
  );
  await captureScreenshot(page, testInfo, "vault-item-uses");
  await page.getByTestId("vault-back").click();
  await expect(activity).toBeVisible();
  // The item opens in the Settings panel itself, and Back returns to the list.
  await page.getByTestId("vault-back").click();
  await expect(rows).toHaveCount(3);

  const listed = JSON.stringify(await rpc(page, "vault/list", { scope: "account" }));
  expect(listed).not.toContain("4242424242424242");
  expect(listed).not.toContain(`fake-password-${stamp}`);
  await expect(page.getByText("4242424242424242")).toHaveCount(0);

  // An API key no bot may use.
  await startNew("api_key");
  await editor.getByLabel("Site", { exact: true }).fill("https://api.example.test");
  await editor.getByLabel("Value", { exact: true }).fill(`fake-key-${stamp}`);
  const access = editor.getByTestId("vault-item-access");
  await access.getByRole("button", { name: "Block", exact: true }).click();
  await expect(access.getByRole("button", { name: "Block", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await captureScreenshot(page, testInfo, "vault-item-access");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await vault.getByText("api.example.test", { exact: true }).click();
  await expect(detail.getByTestId("vault-item-access-detail")).toHaveText("BotsBlock");
  await captureScreenshot(page, testInfo, "vault-item-access-detail");

  // A key every bot but one may use.
  await rpc(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await page.getByTestId("vault-back").click();
  await startNew("api_key");
  await editor.getByLabel("Site", { exact: true }).fill("https://scoped.example.test");
  await editor.getByLabel("Value", { exact: true }).fill(`fake-scoped-key-${stamp}`);
  await editor.getByTestId("agent-access").getByRole("button").click();
  await page.getByRole("menuitemcheckbox", { name: "Researcher" }).click();
  await page.keyboard.press("Escape");
  await captureScreenshot(page, testInfo, "vault-item-chosen-bots");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  // A new item's save returns to the list, as every new item's does.
  await vault.getByText("scoped.example.test", { exact: true }).click();
  const chosen = detail.getByTestId("vault-item-access-detail");
  await expect(chosen).toHaveText(/^Bots./);
  await expect(chosen).not.toContainText("Researcher");

  // A key no bot may use yet: every bot let go of.
  await page.getByTestId("vault-back").click();
  await startNew("api_key");
  await editor.getByLabel("Site", { exact: true }).fill("https://none.example.test");
  await editor.getByLabel("Value", { exact: true }).fill(`fake-none-key-${stamp}`);
  await editor.getByTestId("agent-access").getByRole("button").click();
  await page.getByRole("menuitemcheckbox", { name: "All bots" }).click();
  await page.keyboard.press("Escape");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await vault.getByText("none.example.test", { exact: true }).click();
  await expect(detail.getByTestId("vault-item-access-detail")).toHaveText("BotsNo bots");
  await captureScreenshot(page, testInfo, "vault-item-no-bots");

  // A login the user is asked about before each sign-in.
  await page.getByTestId("vault-back").click();
  await startNew("login");
  await editor.getByLabel("Site", { exact: true }).fill("https://ask.example.test");
  const loginValues = editor.getByTestId("login-field").locator('input:not([aria-label="Label"])');
  await loginValues.nth(0).fill("alex");
  await loginValues.nth(1).fill(`fake-ask-password-${stamp}`);
  const asking = editor.getByTestId("vault-item-access");
  await asking.getByRole("button", { name: "Ask first", exact: true }).click();
  await expect(asking.getByRole("button", { name: "Ask first", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await captureScreenshot(page, testInfo, "vault-item-ask-first");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await vault.getByText("ask.example.test", { exact: true }).click();
  await expect(detail.getByTestId("vault-item-access-detail")).toHaveText("BotsAsk first");

  // A server from before Block saves the item but drops the setting: the save finishes on the
  // item, which says so.
  await page.route("**/rpc/vault/put", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    delete body.json.policy;
    await route.fulfill({ response, json: body });
  });
  await page.getByTestId("vault-back").click();
  await startNew("api_key");
  await editor.getByLabel("Site", { exact: true }).fill("https://old.example.test");
  await editor.getByLabel("Value", { exact: true }).fill(`fake-old-key-${stamp}`);
  await editor.getByTestId("vault-item-access").getByRole("button", { name: "Block" }).click();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(detail.getByText("Saved, but this server can't block bots yet.")).toBeVisible();
  await captureScreenshot(page, testInfo, "vault-old-server-block");

  // A server from before chosen bots and Ask first saves the item and drops them.
  await page.unroute("**/rpc/vault/put");
  await page.route("**/rpc/vault/put", async (route) => {
    const sent = route.request().postDataJSON() as { json: { policy?: string } };
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    delete body.json.allBots;
    delete body.json.botIds;
    if (sent.json.policy === "ask") delete body.json.policy;
    await route.fulfill({ response, json: body });
  });
  await page.getByTestId("vault-back").click();
  await startNew("api_key");
  await editor.getByLabel("Site", { exact: true }).fill("https://old-scope.example.test");
  await editor.getByLabel("Value", { exact: true }).fill(`fake-old-scope-key-${stamp}`);
  await editor.getByTestId("agent-access").getByRole("button").click();
  await page.getByRole("menuitemcheckbox", { name: "Researcher" }).click();
  await page.keyboard.press("Escape");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    detail.getByText("Saved, but this server can't limit an item to chosen bots."),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "vault-old-server-chosen-bots");
  await page.getByTestId("vault-back").click();
  await startNew("login");
  await editor.getByLabel("Site", { exact: true }).fill("https://old-ask.example.test");
  await loginValues.nth(0).fill("alex");
  await loginValues.nth(1).fill(`fake-old-ask-password-${stamp}`);
  await editor.getByTestId("vault-item-access").getByRole("button", { name: "Ask first" }).click();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(detail.getByText("Saved, but this server can't ask you first.")).toBeVisible();
  await captureScreenshot(page, testInfo, "vault-old-server-ask-first");
  await page.unroute("**/rpc/vault/put");

  // With a second Space, a choice says it covers only this Space's bots.
  await rpc(page, "spaces/create", { name: "Work" });
  // The editor reads the Spaces and this Space's own vault when it opens, so both are loaded first.
  const spaceData = () =>
    Promise.all(
      ["spaces/list", "spaceSettings/overrides"].map((procedure) =>
        page.waitForResponse((response) => response.url().endsWith(`/rpc/${procedure}`)),
      ),
    );
  let loaded = spaceData();
  await page.reload();
  const again = (await openUserSettings(page, "vault")).getByTestId("vault");
  await loaded;
  await again.getByText("scoped.example.test", { exact: true }).click();
  await page.getByTestId("vault-item-edit").click();
  await expect(
    editor.getByText("This limits only this Space's bots. Your other Spaces choose for their own."),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "vault-item-other-spaces");

  // From a Space that keeps its own vault, an account item offers no bots, and says why.
  await rpc(page, "spaceSettings/setOverride", { setting: "credentials", enabled: true });
  loaded = spaceData();
  await page.reload();
  const own = (await openUserSettings(page, "vault")).getByTestId("vault");
  await loaded;
  await own.getByText("scoped.example.test", { exact: true }).click();
  await page.getByTestId("vault-item-edit").click();
  await expect(
    editor.getByText("This Space keeps its own vault, so its bots can't use account items."),
  ).toBeVisible();
  await expect(editor.getByTestId("agent-access")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "vault-item-own-vault-space");
});
