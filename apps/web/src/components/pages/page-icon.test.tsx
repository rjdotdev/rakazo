import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PageTileIcon } from "./page-icon";

it("draws the page tile in theme tokens only, so the app stays monochrome", () => {
  const fills = [...renderToStaticMarkup(<PageTileIcon />).matchAll(/fill="([^"]*)"/g)].map(
    (match) => match[1],
  );
  expect(fills.length).toBeGreaterThan(4);
  for (const fill of fills) expect(fill).toMatch(/^var\(--page-tile/);
});
