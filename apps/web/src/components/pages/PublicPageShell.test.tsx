// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PublicPageShell } from "./PublicPageShell";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("builds Copy link from the shared kit, like Download PDF beside it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<PublicPageShell title="Plan" document={null} />));
  const copy = [...document.querySelectorAll("nav button")].find(
    (button) => button.textContent === "Copy link",
  );
  expect(copy?.getAttribute("data-slot")).toBe("button");
  await act(async () => root.unmount());
});
