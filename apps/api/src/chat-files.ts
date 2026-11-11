import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { resolveBotUploadPath } from "@rakazo/adapters";
import type { ComputerMode } from "@rakazo/contracts";
import { CHAT_FILE_TEXT_BYTES } from "@rakazo/contracts";

const CHUNK_BYTES = 32 * 1024;

export class ChatFileError extends Error {
  constructor(
    message: string,
    readonly code: "not_text" | "too_large",
  ) {
    super(message);
  }
}

export type ChatTextPage = {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number | null;
  partial: boolean;
};

/**
 * A path the signed-in user may read or write for this bot: its own folder, or `shared/`
 * on a Team Computer. Other bots' folders and the rest of the machine are refused.
 * `/` and `.` are this bot's folder, not the Team Computer root.
 */
export function userWorkspacePath(scope: ComputerMode, botId: string, requested: string): string {
  if (hasControlCharacter(requested)) throw new Error("Path escapes the bot workspace");
  const path = requested === "/" || requested === "." ? "" : requested;
  return resolveBotUploadPath(scope, botId, path);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

export function isOversizedFileError(error: unknown): boolean {
  return error instanceof Error && /exceeds \d+ bytes|too large/i.test(error.message);
}

/** The line window `offset` (1-based) and `limit` select. A start past the end yields no lines. */
export function pageTextLines(
  text: string,
  offset: number,
  limit: number,
): Omit<ChatTextPage, "partial" | "totalLines"> & { totalLines: number } {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const start = Math.max(1, offset);
  if (start > totalLines) {
    return { content: "", startLine: start, endLine: start - 1, totalLines };
  }
  const end = Math.min(totalLines, start + limit - 1);
  return {
    content: lines.slice(start - 1, end).join("\n"),
    startLine: start,
    endLine: end,
    totalLines,
  };
}

/**
 * Reads a text page. Files that fit are sliced by line. Larger files are read from the start
 * in bounded chunks, and `partial` says the line count does not cover the rest of the file.
 */
export async function readChatTextPage(input: {
  offset: number;
  limit: number;
  readAll: (maxBytes: number) => Promise<Uint8Array>;
  readRange: (offset: number, length: number) => Promise<Uint8Array>;
}): Promise<ChatTextPage> {
  try {
    const bytes = await input.readAll(CHAT_FILE_TEXT_BYTES);
    return { ...pageTextLines(decodeText(bytes), input.offset, input.limit), partial: false };
  } catch (error) {
    if (error instanceof ChatFileError || !isOversizedFileError(error)) throw error;
  }
  const scanned = await scanTextPrefix(input.readRange, input.offset + input.limit - 1);
  const page = pageTextLines(scanned.text, input.offset, input.limit);
  return {
    ...page,
    totalLines: scanned.reachedEnd ? page.totalLines : null,
    partial: !scanned.reachedEnd,
  };
}

/** One byte window of a file on a running computer. `dd` is argv-only, so the path is not a shell. */
export async function readSandboxByteRange(
  sandbox: Pick<SandboxProvider, "execute">,
  computer: ComputerRef,
  filePath: string,
  offset: number,
  length: number,
  context: AdapterContext,
): Promise<Uint8Array> {
  const aligned = offset % CHUNK_BYTES === 0 && length === CHUNK_BYTES;
  const argv = aligned
    ? [
        "dd",
        `if=${filePath}`,
        `bs=${CHUNK_BYTES}`,
        `skip=${offset / CHUNK_BYTES}`,
        "count=1",
        "status=none",
      ]
    : ["dd", `if=${filePath}`, "bs=1", `skip=${offset}`, `count=${length}`, "status=none"];
  let stdout = "";
  let stderr = "";
  let code: number | undefined;
  for await (const event of sandbox.execute(computer, { argv, cwd: "." }, context)) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") code = event.code;
  }
  if (code !== 0) {
    throw new ChatFileError(stderr.trim() || "file is too large to preview", "too_large");
  }
  const bytes = new TextEncoder().encode(stdout);
  return bytes.byteLength > length ? bytes.subarray(0, length) : bytes;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ChatFileError("file is not a text file", "not_text");
  }
}

/** Decodes a prefix, dropping one split character at the cut. Invalid text in the middle is refused. */
function decodePrefix(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    for (let trim = 1; trim <= 3 && trim < bytes.length; trim++) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -trim));
      } catch {
        // A trailing partial character is the usual cut; anything else is not text.
      }
    }
    throw new ChatFileError("file is not a text file", "not_text");
  }
}

async function scanTextPrefix(
  readRange: (offset: number, length: number) => Promise<Uint8Array>,
  linesNeeded: number,
): Promise<{ text: string; reachedEnd: boolean }> {
  const parts: Uint8Array[] = [];
  let read = 0;
  let text = "";
  while (read < CHAT_FILE_TEXT_BYTES) {
    const want = Math.min(CHUNK_BYTES, CHAT_FILE_TEXT_BYTES - read);
    const chunk = await readRange(read, want);
    if (chunk.byteLength === 0) {
      if (read === 0) throw new ChatFileError("file is too large to preview", "too_large");
      return { text, reachedEnd: true };
    }
    parts.push(chunk);
    read += chunk.byteLength;
    text = decodePrefix(concatBytes(parts));
    if (chunk.byteLength < want) return { text, reachedEnd: true };
    if (text.split("\n").length >= linesNeeded) {
      const peek = await readRange(read, 1);
      return { text, reachedEnd: peek.byteLength === 0 };
    }
  }
  return { text, reachedEnd: false };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
