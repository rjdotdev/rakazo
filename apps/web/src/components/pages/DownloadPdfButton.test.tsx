// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DownloadPdfButton } from "./DownloadPdfButton";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(""),
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("is the shared button and prints the page", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const print = vi.fn();
  vi.stubGlobal("print", print);
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => root.render(<DownloadPdfButton className="rounded-full" />));
  const button = container.querySelector("button")!;
  expect(button.dataset.slot).toBe("button");
  expect(button.type).toBe("button");
  expect(button.textContent).toBe("Download PDF");
  await act(async () => button.click());
  expect(print).toHaveBeenCalledOnce();
  act(() => root.unmount());
});
