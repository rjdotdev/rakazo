import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { CHAT_FILE_TEXT_BYTES } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  assertLivePathContained,
  ChatFileError,
  isStoredWorkspaceDirectory,
  liveContainmentPrefixes,
  pageTextLines,
  readChatTextPage,
  readSandboxByteRange,
  userWorkspacePath,
  writeContainedSandboxFile,
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

  it("keeps a line that crosses a chunk boundary on the same page", async () => {
    const first = `${"A".repeat(32 * 1024)}END`;
    const body = `${first}\nNEXT\n`;
    const bytes = new TextEncoder().encode(body);
    const readRange = vi.fn(async (offset: number, length: number) =>
      bytes.subarray(offset, offset + length),
    );
    const page = await readChatTextPage({
      offset: 1,
      limit: 1,
      readAll: async () => {
        throw new Error(`computer file exceeds ${CHAT_FILE_TEXT_BYTES} bytes`);
      },
      readRange,
    });
    expect(page.content).toBe(first);
    expect(page.endLine).toBe(1);
    const next = await readChatTextPage({
      offset: 2,
      limit: 1,
      readAll: async () => {
        throw new Error(`computer file exceeds ${CHAT_FILE_TEXT_BYTES} bytes`);
      },
      readRange,
    });
    expect(next.content).toBe("NEXT");
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

  it("reads an aligned chunk as base64 so a multibyte character survives", async () => {
    const text = `héllo${"é".repeat(20)}`;
    const execute = vi.fn(async function* (_computer: ComputerRef, _request: { argv: string[] }) {
      yield { type: "stdout" as const, data: Buffer.from(text).toString("base64") };
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
    expect(new TextDecoder().decode(bytes)).toBe(text);
    const request = execute.mock.calls[0]?.[1] as { argv?: string[] } | undefined;
    const argv = request?.argv ?? [];
    expect(argv[0]).toBe("bash");
    expect(argv[3]).toBe("rakazo-read");
    expect(argv[4]).toBe("bots/bot-1/notes.txt");
    expect(argv[2]).toContain("base64");
    expect(argv[2]).not.toContain("notes.txt");
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

describe("isStoredWorkspaceDirectory", () => {
  it("treats only this bot's folder and shared/ as directories on a team computer", () => {
    expect(isStoredWorkspaceDirectory("team", "bot-1", "")).toBe(true);
    expect(isStoredWorkspaceDirectory("team", "bot-1", "shared")).toBe(true);
    expect(isStoredWorkspaceDirectory("team", "bot-1", "bots/bot-1")).toBe(true);
    expect(isStoredWorkspaceDirectory("team", "bot-1", "bots/bot-1/notes.txt")).toBe(false);
    expect(isStoredWorkspaceDirectory("team", "bot-1", "shared/plan.md")).toBe(false);
  });

  it("lets a private computer open a file named shared or bots/notes.md", () => {
    expect(isStoredWorkspaceDirectory("dedicated", "bot-1", "")).toBe(true);
    expect(isStoredWorkspaceDirectory("dedicated", "bot-1", "shared")).toBe(false);
    expect(isStoredWorkspaceDirectory("dedicated", "bot-1", "bots/notes.md")).toBe(false);
    expect(liveContainmentPrefixes("dedicated", "bot-1")).toEqual(["."]);
  });
});

describe("live path containment", () => {
  const computer = {
    id: "sandbox-1",
    botId: "bot-1",
    kind: "docker",
    providerRef: "sandbox-1",
  } as ComputerRef;

  async function workspace() {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-contain-"));
    await mkdir(path.join(root, "bots", "bot-1"), { recursive: true });
    await mkdir(path.join(root, "bots", "bot-2"), { recursive: true });
    await mkdir(path.join(root, "shared"), { recursive: true });
    await writeFile(path.join(root, "bots", "bot-2", "secret.txt"), "old");
    await symlink("../bot-2", path.join(root, "bots", "bot-1", "link"));
    const execute = async function* (_computer: ComputerRef, request: { argv: string[] }) {
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve) => {
          execFile(
            request.argv[0] ?? "bash",
            request.argv.slice(1),
            { cwd: root, maxBuffer: 8 * 1024 * 1024 },
            (error, stdout, stderr) => {
              const code =
                error && typeof (error as { code?: unknown }).code === "number"
                  ? (error as { code: number }).code
                  : error
                    ? 1
                    : 0;
              resolve({ code, stdout: String(stdout), stderr: String(stderr) });
            },
          );
        },
      );
      if (result.stdout) yield { type: "stdout" as const, data: result.stdout };
      if (result.stderr) yield { type: "stderr" as const, data: result.stderr };
      yield { type: "exit" as const, code: result.code };
    };
    return { root, execute };
  }

  it("writes inside this bot and shared, and refuses a symlink into another bot", async () => {
    const { root, execute } = await workspace();
    const prefixes = liveContainmentPrefixes("team", "bot-1");
    try {
      await writeContainedSandboxFile(
        { execute },
        computer,
        "bots/bot-1/notes/weekly.md",
        new TextEncoder().encode("weekly"),
        prefixes,
        context,
      );
      await expect(
        readFile(path.join(root, "bots", "bot-1", "notes", "weekly.md"), "utf8"),
      ).resolves.toBe("weekly");

      const bulky = new Uint8Array(40 * 1024).fill(0x61);
      await writeContainedSandboxFile(
        { execute },
        computer,
        "bots/bot-1/big.txt",
        bulky,
        prefixes,
        context,
      );
      await expect(readFile(path.join(root, "bots", "bot-1", "big.txt"))).resolves.toEqual(
        Buffer.from(bulky),
      );

      await expect(
        writeContainedSandboxFile(
          { execute },
          computer,
          "bots/bot-1/link/secret.txt",
          new TextEncoder().encode("pwned"),
          prefixes,
          context,
        ),
      ).rejects.toThrow(/escapes/);
      await expect(readFile(path.join(root, "bots", "bot-2", "secret.txt"), "utf8")).resolves.toBe(
        "old",
      );
      await expect(
        assertLivePathContained(
          { execute },
          computer,
          "bots/bot-1/link/secret.txt",
          prefixes,
          context,
        ),
      ).rejects.toThrow(/escapes/);
      await expect(
        assertLivePathContained(
          { execute },
          computer,
          "bots/bot-1/notes/weekly.md",
          prefixes,
          context,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
