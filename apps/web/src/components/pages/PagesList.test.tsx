// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PagesList } from "./PagesList";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
const items = Array.from({ length: 8 }, (_, index) => ({
  id: `p${index}`,
  title: `Page ${index}`,
  pinned: false,
  visibility: "private",
  updatedAt: new Date(0).toISOString(),
}));
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    pages: {
      list: {
        infiniteOptions: (options: object) => ({
          ...options,
          queryKey: ["pages"],
          queryFn: async () => ({ items, nextCursor: null }),
        }),
      },
    },
  }),
}));
vi.mock("../../lib/page-actions", () => ({
  pageMutationOptions: () => ({ pin: {}, remove: {}, rename: {} }),
}));
vi.mock("../../lib/pages", () => ({ useOpenPage: () => () => {} }));
vi.mock("../../pages/shell/dialogs", () => ({ DeleteItemDialog: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("lists pages with the shared search field and row buttons", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <PagesList botId="bot-1" />
      </QueryClientProvider>,
    ),
  );
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
  const search = document.querySelector('[aria-label="Find a page"]');
  expect(search?.closest('[data-slot="input-group"]')).not.toBeNull();
  const row = [...document.querySelectorAll("li > *")].find((node) =>
    node.textContent?.includes("Page 0"),
  );
  expect(row?.getAttribute("data-slot")).toBe("button");
  act(() => root.unmount());
});
