import { i18n } from "@lingui/core";
import { afterEach, expect, it } from "vitest";
import { secretAnswerErrorText, vaultImportText, vaultSaveNotice } from "./vault";

// The server's fixed refusals, as the contracts send them.
const BLOCKED = "This item is blocked for bots. Allow it in the Vault, or dismiss the request.";
const UNCHOSEN = "This bot can't use this item. Change it in the Vault, or dismiss the request.";

afterEach(() => {
  i18n.activate("en");
});

it("says why a secret answer was refused, and nothing an error could echo", () => {
  i18n.activate("en");
  expect(secretAnswerErrorText(new Error(BLOCKED), "Could not send answer")).toBe(BLOCKED);
  expect(secretAnswerErrorText(new Error(UNCHOSEN), "Could not send answer")).toBe(UNCHOSEN);
  expect(
    secretAnswerErrorText(new Error("Rejected saved-password-1"), "Could not send answer"),
  ).toBe("Could not send answer");
});

it("says what an older server dropped from a save, in one place for both apps", () => {
  i18n.activate("en");
  expect(vaultSaveNotice({ policy: "off", alsoOn: ["https://www.example.test"] }, {})).toBe(
    "Saved, but this server can't block bots yet. Saved, but this server fills logins only on their own site.",
  );
  expect(vaultSaveNotice({ allBots: false }, { allBots: false })).toBe("");
});

it("names import results and unusable files", () => {
  i18n.activate("en");
  const text = vaultImportText();
  expect(text.labels).toEqual({
    added: "Added",
    toAdd: "To add",
    duplicate: "Already saved",
    notHttps: "Not on an HTTPS site",
    noPassword: "No password",
    full: "Vault full",
    notSaved: "Not saved",
  });
  expect(text.reasons).toEqual({
    notHttps: "Not on an HTTPS site",
    noPassword: "No password",
    duplicate: "Already saved",
    invalid: "Not saved",
    limit: "Vault full",
  });
  expect(text.fileProblems).toEqual({
    too_large: "This file is too large to import.",
    unreadable: "This file can't be read as CSV.",
    no_logins: "No website and password columns found.",
  });
});

it("uses the active catalog", () => {
  i18n.load("de", {
    [BLOCKED]: "Dieser Eintrag ist für Bots gesperrt.",
    "Vault full": "Tresor voll",
    "Saved, but this server can't ask you first.": "Gespeichert, aber ohne Nachfrage.",
  });
  i18n.activate("de");
  expect(secretAnswerErrorText(new Error(BLOCKED), "x")).toBe(
    "Dieser Eintrag ist für Bots gesperrt.",
  );
  expect(vaultImportText().labels.full).toBe("Tresor voll");
  expect(vaultSaveNotice({ policy: "ask" }, { policy: "allow" })).toBe(
    "Gespeichert, aber ohne Nachfrage.",
  );
});
