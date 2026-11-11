import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { CHAT_FILE_TEXT_BYTES } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ChatFileError,
  pageTextLines,
  readChatTextPage,
  readSandboxByteRange,
  userWorkspacePath,
} from "./chat-files.js";

const context = {
  operationId: "files",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
} satisfies AdapterContext;

describe("userWorkspacePath", () => {
  it("keeps a team bot inside its own folder and shared/", () => {
    expect(userWorkspacePath("team", "bot-1", "")).toBe("bots/bot-1");
    expect(userWorkspacePath("team", "bot-1", "/")).toBe("bots/bot-1");
    expect(userWorkspacePath("team", "bot-1", ".")).toBe("bots/bot-1");
    expect(userWorkspacePath("team", "bot-1", "notes/weekly.md")).toBe(
      "bots/bot-1/notes/weekly.md",
    );
    expect(userWorkspacePath("team", "bot-1", "shared")).toBe("shared");
    expect(userWorkspacePath("team", "bot-1", "shared/plan.md")).toBe("shared/plan.md");
    expect(userWorkspacePath("team", "bot-1", "/shared/plan.md")).toBe("shared/plan.md");
    expect(userWorkspacePath("team", "bot-1", "bots/bot-1/notes.txt")).toBe("bots/bot-1/notes.txt");
  });

  it("refuses other bots, the team root, and paths that leave the workspace", () => {
    expect(() => userWorkspacePath("team", "bot-1", "bots")).toThrow(/escapes/);
    expect(() => userWorkspacePath("team", "bot-1", "bots/bot-2/secret.txt")).toThrow(/escapes/);
    expect(() => userWorkspacePath("team", "bot-1", "/bots/bot-2/secret.txt")).toThrow(/escapes/);
    expect(() => userWorkspacePath("team", "bot-1", "../secret")).toThrow(/escapes/);
    expect(() => userWorkspacePath("team", "bot-1", "shared/../../etc/passwd")).toThrow(/escapes/);
    expect(() => userWorkspacePath("team", "bot-1", "/etc/passwd")).toThrow(/escapes/);
    expect(() => userWorkspacePath("team", "bot-1", "notes\0.txt")).toThrow(/escapes/);
  });

  it("keeps a private computer inside its own home", () => {
    expect(userWorkspacePath("dedicated", "bot-1", "notes/weekly.md")).toBe("notes/weekly.md");
    expect(userWorkspacePath("dedicated", "bot-1", "/")).toBe("");
    expect(() => userWorkspacePath("dedicated", "bot-1", "../secret")).toThrow(/escapes/);
  });
});

describe("pageTextLines", () => {
  it("returns a 1-based window and the whole line count", () => {
    expect(pageTextLines("a\nb\nc", 2, 1)).toEqual({
      content: "b",
      startLine: 2,
      endLine: 2,
      totalLines: 3,
    });
    expect(pageTextLines("a\nb\nc", 2, 10)).toMatchObject({ content: "b\nc", endLine: 3 });
    expect(pageTextLines("a\nb\nc", 9, 1)).toMatchObject({ content: "", startLine: 9, endLine: 8 });
  });
});

describe("readChatTextPage", () => {
  it("pages a file that fits", async () => {
    const readRange = vi.fn();
    const page = await readChatTextPage({
      offset: 2,
      limit: 1,
      readAll: async () => new TextEncoder().encode("a\nb\nc"),
      readRange,
    });
    expect(page).toEqual({
      content: "b",
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      partial: false,
    });
    expect(readRange).not.toHaveBeenCalled();
  });

  it("refuses a binary file that fits", async () => {
    await expect(
      readChatTextPage({
        offset: 1,
        limit: 10,
        readAll: async () => new Uint8Array([0xff, 0xfe, 0x00]),
        readRange: async () => new Uint8Array(),
      }),
    ).rejects.toMatchObject({ code: "not_text" });
  });

  it("reads a line window from the start of a file past the byte cap", async () => {
    const body = `${"line\n".repeat(20)}tail`;
    const readRange = vi.fn(async (offset: number, length: number) => {
      const bytes = new TextEncoder().encode(body);
      return bytes.subarray(offset, offset + length);
    });
    const page = await readChatTextPage({
      offset: 2,
      limit: 2,
      readAll: async () => {
        throw new Error(`agent home file exceeds ${CHAT_FILE_TEXT_BYTES} bytes`);
      },
      readRange,
    });
    expect(page).toMatchObject({
      content: "line\nline",
      startLine: 2,
      endLine: 3,
      partial: false,
      totalLines: 21,
    });
  });

  it("marks a file partial when the cap ends before the file does", async () => {
    const readRange = vi.fn(async (_offset: number, length: number) => new Uint8Array(length));
    const page = await readChatTextPage({
      offset: 1,
      limit: 1,
      readAll: async () => {
        throw new Error("computer file exceeds 2097152 bytes");
      },
      readRange,
    });
    expect(page.partial).toBe(true);
    expect(page.totalLines).toBeNull();
    expect(page.startLine).toBe(1);
  });

  it("says a file is too large when a running computer returns none of it", async () => {
    await expect(
      readChatTextPage({
        offset: 1,
        limit: 10,
        readAll: async () => {
          throw new Error("computer file exceeds 2097152 bytes");
        },
        readRange: async () => new Uint8Array(),
      }),
    ).rejects.toBeInstanceOf(ChatFileError);
  });
});

describe("readSandboxByteRange", () => {
  const computer = {
    id: "sandbox-1",
    botId: "home-1",
    kind: "docker",
    providerRef: "sandbox-1",
  } as ComputerRef;

  it("reads an aligned chunk without a shell", async () => {
    const execute = vi.fn(async function* () {
      yield { type: "stdout" as const, data: "hello" };
      yield { type: "exit" as const, code: 0 };
    });
    const bytes = await readSandboxByteRange(
      { execute },
      computer,
      "bots/bot-1/notes.txt",
      0,
      32 * 1024,
      context,
    );
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(execute).toHaveBeenCalledWith(
      computer,
      {
        argv: ["dd", "if=bots/bot-1/notes.txt", "bs=32768", "skip=0", "count=1", "status=none"],
        cwd: ".",
      },
      context,
    );
  });

  it("refuses a failed read", async () => {
    const execute = vi.fn(async function* () {
      yield { type: "stderr" as const, data: "no such file" };
      yield { type: "exit" as const, code: 1 };
    });
    await expect(
      readSandboxByteRange({ execute }, computer, "bots/bot-1/missing.txt", 3, 4, context),
    ).rejects.toMatchObject({ code: "too_large" });
  });
});
