// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatFiles } from "./chat-files";

vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: string }) => <article>{children}</article>,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("../../lib/rpc", () => {
  const rpc = {
    computer: {
      files: vi.fn(),
      readFile: vi.fn(),
      saveFile: vi.fn(),
      changedFiles: vi.fn(),
      downloadFile: vi.fn(),
    },
  };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => null,
  };
});

import { rpc } from "../../lib/rpc";

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function render(computerMode: "team" | "dedicated" = "team") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ChatFiles botId="bot-1" computerMode={computerMode} />
      </QueryClientProvider>,
    );
  });
}

function button(path: string): HTMLButtonElement {
  const node = container.querySelector<HTMLButtonElement>(
    `[data-testid="chat-file"][data-path="${path}"]`,
  );
  if (!node) throw new Error(`missing ${path}`);
  return node;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc.computer.files).mockReset();
  vi.mocked(rpc.computer.readFile).mockReset();
  vi.mocked(rpc.computer.saveFile).mockReset();
  vi.mocked(rpc.computer.changedFiles).mockReset();
  vi.mocked(rpc.computer.downloadFile).mockReset();
  vi.mocked(rpc.computer.files).mockImplementation(async (input: { path?: string }) => {
    if (!input.path) {
      return [
        { path: "notes", kind: "dir", size: 0 },
        { path: "readme.txt", kind: "file", size: 5 },
      ];
    }
    if (input.path === "notes") return [{ path: "notes/weekly.md", kind: "file", size: 20 }];
    return [];
  });
  vi.mocked(rpc.computer.changedFiles).mockResolvedValue([
    { path: "notes/weekly.md", at: "2026-01-02T00:00:00.000Z" },
  ]);
  vi.mocked(rpc.computer.readFile).mockImplementation(async (input: { path: string }) => ({
    path: input.path,
    content: input.path.endsWith(".md") ? "# Weekly report\n\nEdited in chat." : "hello",
    startLine: 1,
    endLine: 2,
    totalLines: 2,
    partial: false,
    contentHash: "a".repeat(64),
  }));
  vi.mocked(rpc.computer.saveFile).mockImplementation(async (input: { path: string }) => ({
    ok: true as const,
    path: input.path,
    tracked: true,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
});

it("browses the bot home and shared, then edits a file from this chat", async () => {
  await render();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="chat-files-changed"]')).not.toBeNull(),
  );
  expect(container.querySelector('[data-testid="chat-files-changed"]')?.textContent).toContain(
    "Changed in this chat",
  );
  expect(button("notes/weekly.md").textContent).toContain("notes/weekly.md");
  expect(button("shared").dataset.kind).toBe("dir");
  expect(button("notes").dataset.kind).toBe("dir");
  expect(button("readme.txt")).not.toBeNull();

  await act(async () => button("notes").click());
  await vi.waitFor(() =>
    expect(container.querySelectorAll('[data-path="notes/weekly.md"]')).toHaveLength(2),
  );
  await act(async () => button("notes/weekly.md").click());
  await vi.waitFor(() => expect(container.textContent).toContain("# Weekly report"));
  expect(container.querySelector('[data-testid="chat-file-view"]')).not.toBeNull();

  const edit = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Edit",
  );
  await act(async () => edit?.click());
  const textarea = await vi.waitFor(() => {
    const field = container.querySelector("textarea");
    if (!field) throw new Error("waiting for the editor");
    return field;
  });
  expect(textarea.value).toContain("Weekly report");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      "Saved from chat.",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const save = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Save",
  );
  await act(async () => save?.click());
  await vi.waitFor(() =>
    expect(rpc.computer.saveFile).toHaveBeenCalledWith({
      botId: "bot-1",
      path: "notes/weekly.md",
      content: "Saved from chat.",
      expectedContentHash: "a".repeat(64),
    }),
  );
  expect(container.textContent).not.toContain("Saved. It is not on the changed list yet.");
});

it("says a saved file is missing from the changed list when tracking fails", async () => {
  vi.mocked(rpc.computer.files).mockResolvedValue([{ path: "notes.txt", kind: "file", size: 5 }]);
  vi.mocked(rpc.computer.changedFiles).mockResolvedValue([]);
  vi.mocked(rpc.computer.saveFile).mockResolvedValue({
    ok: true,
    path: "notes.txt",
    tracked: false,
  });
  await render();
  await vi.waitFor(() => expect(container.querySelector('[data-path="notes.txt"]')).not.toBeNull());
  await act(async () => button("notes.txt").click());
  await vi.waitFor(() => expect(container.textContent).toContain("hello"));
  const edit = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Edit",
  );
  await act(async () => edit?.click());
  const save = await vi.waitFor(() => {
    const node = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Save",
    );
    if (!node) throw new Error("waiting for save");
    return node;
  });
  await act(async () => save.click());
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Saved. It is not on the changed list yet."),
  );
  expect(container.textContent).not.toContain("Couldn't save.");
});

it("leaves a private computer without a shared folder", async () => {
  vi.mocked(rpc.computer.files).mockResolvedValue([]);
  vi.mocked(rpc.computer.changedFiles).mockResolvedValue([]);
  await render("dedicated");
  await vi.waitFor(() => expect(container.textContent).toContain("No files yet"));
  expect(container.textContent).not.toContain("Changed in this chat");
  expect(container.querySelector('[data-path="shared"]')).toBeNull();
});

it("offers another try when the home cannot be listed", async () => {
  vi.mocked(rpc.computer.files).mockRejectedValue(new Error("unavailable"));
  vi.mocked(rpc.computer.changedFiles).mockResolvedValue([]);
  await render();
  await vi.waitFor(() => expect(container.textContent).toContain("Couldn't load files."));
  const retry = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Try again",
  );
  await act(async () => retry?.click());
  await vi.waitFor(() => expect(rpc.computer.files).toHaveBeenCalledTimes(2));
});

it("pages a file that does not fit and keeps the editor closed", async () => {
  vi.mocked(rpc.computer.files).mockResolvedValue([{ path: "big.log", kind: "file", size: 9 }]);
  vi.mocked(rpc.computer.changedFiles).mockResolvedValue([]);
  vi.mocked(rpc.computer.readFile).mockImplementation(async (input: { offset?: number }) =>
    input.offset && input.offset > 1
      ? {
          path: "big.log",
          content: "",
          startLine: 2,
          endLine: 1,
          totalLines: null,
          partial: true,
          contentHash: null,
        }
      : {
          path: "big.log",
          content: "start",
          startLine: 1,
          endLine: 1,
          totalLines: null,
          partial: true,
          contentHash: null,
        },
  );
  await render();
  await vi.waitFor(() => expect(container.querySelector('[data-path="big.log"]')).not.toBeNull());
  await act(async () => button("big.log").click());
  await vi.waitFor(() => expect(container.textContent).toContain("Lines 1-1"));
  expect(
    [...container.querySelectorAll("button")].some((node) => node.textContent === "Edit"),
  ).toBe(false);
  const next = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === "Next",
  );
  await act(async () => next?.click());
  await vi.waitFor(() =>
    expect(container.textContent).toContain("The rest of this file is too large to open here."),
  );
});
