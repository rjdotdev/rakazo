import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  rpc,
  signup,
} from "./helpers";

test("browses a bot home, shared files, and edits without the computer screen", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `files-${stamp}@rakazo.test`, "password12", "Files");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);

  await rpc(page, "computer/saveFile", {
    botId,
    path: "notes/weekly.md",
    content: "# Weekly report\n\nEdited in chat.",
  });
  await rpc(page, "computer/saveFile", {
    botId,
    path: "src/app.ts",
    content: "export const ready = true;\n",
  });

  await openBotPanelTab(page, "Files");
  const files = page.getByTestId("chat-files");
  await expect(files.getByTestId("chat-files-changed")).toBeVisible();
  await expect(files.locator('[data-testid="chat-file"][data-path="shared"]')).toBeVisible();
  await expect(files.locator('[data-testid="chat-file"][data-path="notes"]')).toBeVisible();
  await expect(files.locator('[data-testid="chat-file"][data-path="src"]')).toBeVisible();
  await expect(files.getByRole("button", { name: "notes/weekly.md" })).toBeVisible();
  await captureScreenshot(page, testInfo, "chat-files-tree");

  await files.locator('[data-testid="chat-file"][data-path="notes"]').click();
  await files.locator('[data-testid="chat-file"][data-path="notes/weekly.md"]').click();
  await expect(page.getByRole("heading", { name: "Weekly report" })).toBeVisible();
  await captureScreenshot(page, testInfo, "chat-files-markdown");

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("textbox", { name: "File contents" })
    .fill("# Weekly report\n\nSaved from chat.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved from chat.")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(files.getByRole("button", { name: "notes/weekly.md" })).toBeVisible();
});
