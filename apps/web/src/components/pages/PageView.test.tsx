// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PageView } from "./PageView";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("renames the page from its title with the shared button and field", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <PageView
        open
        onOpenChange={() => {}}
        title="Plan"
        document={null}
        onRename={() => {}}
        share={null}
      />,
    ),
  );
  const title = document.querySelector<HTMLElement>('[title="Rename"]');
  // The title keeps its dialog-title slot; the shared Button shows in its classes.
  expect(title?.classList.contains("group/button")).toBe(true);
  await act(async () => title?.click());
  expect(document.querySelector('[aria-label="Page title"]')?.getAttribute("data-slot")).toBe(
    "input",
  );
  act(() => root.unmount());
});
