import { createHash } from "node:crypto";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { resolveBotUploadPath, teamBotWorkspaceDirectory } from "@rakazo/adapters";
import type { ComputerMode } from "@rakazo/contracts";
import { CHAT_FILE_TEXT_BYTES } from "@rakazo/contracts";
import {
  LIVE_APPEND_SCRIPT,
  LIVE_COMMIT_SCRIPT,
  LIVE_PATH_CONTAINMENT_SCRIPT,
  LIVE_STAGE_SCRIPT,
} from "./chat-file-shell.js";

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

/** Prefixes a live path may stay inside. `.` is the whole workspace, for a private computer. */
export function liveContainmentPrefixes(scope: ComputerMode, botId: string): string[] {
  if (scope !== "team") return ["."];
  return [teamBotWorkspaceDirectory(botId), "shared"];
}

/**
 * A stored path that is a folder boundary, not a file. On a private computer only the
 * workspace root is one: a file may be named `shared` or live under `bots/`.
 */
export function isStoredWorkspaceDirectory(
  scope: ComputerMode,
  botId: string,
  stored: string,
): boolean {
  if (stored === "") return true;
  if (scope !== "team") return false;
  return stored === "shared" || stored === teamBotWorkspaceDirectory(botId);
}

export function textContentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Hash of a page that is the whole file. A window or a capped read has no hash. */
export function chatTextContentHash(page: ChatTextPage): string | null {
  if (
    page.partial ||
    page.startLine !== 1 ||
    page.totalLines === null ||
    page.endLine !== page.totalLines
  ) {
    return null;
  }
  return textContentHash(page.content);
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
  if (!scanned.reachedEnd && scanned.text.length === 0) {
    return {
      content: "",
      startLine: input.offset,
      endLine: input.offset - 1,
      totalLines: null,
      partial: true,
    };
  }
  const page = pageTextLines(scanned.text, input.offset, input.limit);
  return {
    ...page,
    totalLines: scanned.reachedEnd ? page.totalLines : null,
    partial: !scanned.reachedEnd,
  };
}

/**
 * One byte window of a file on a running computer. The path is `$1`, and stdout is base64,
 * so a multibyte character on a chunk edge is not re-encoded as text.
 */
export async function readSandboxByteRange(
  sandbox: Pick<SandboxProvider, "execute">,
  computer: ComputerRef,
  filePath: string,
  offset: number,
  length: number,
  context: AdapterContext,
): Promise<Uint8Array> {
  const aligned = offset % CHUNK_BYTES === 0 && length === CHUNK_BYTES;
  const script = aligned
    ? `dd if="$1" bs=${CHUNK_BYTES} skip=${offset / CHUNK_BYTES} count=1 status=none | base64 | tr -d '\\n'`
    : `dd if="$1" bs=1 skip=${offset} count=${length} status=none | base64 | tr -d '\\n'`;
  const result = await runGuestShell(sandbox, computer, script, "rakazo-read", [filePath], context);
  if (result.code !== 0) {
    throw new ChatFileError(result.stderr.trim() || "file is too large to preview", "too_large");
  }
  const bytes = Buffer.from(result.stdout.replace(/\s/g, ""), "base64");
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
    // A full chunk can end in the middle of a line. Keep reading until that line is
    // terminated, or the file ends. Returning the cut as a finished line makes the
    // next page skip the rest of it.
    if (terminatedLineCount(text) >= linesNeeded) {
      const peek = await readRange(read, 1);
      if (peek.byteLength === 0) return { text, reachedEnd: true };
      return { text: completeLinePrefix(text), reachedEnd: false };
    }
  }
  const peek = await readRange(read, 1);
  if (peek.byteLength === 0) return { text, reachedEnd: true };
  return { text: completeLinePrefix(text), reachedEnd: false };
}

function terminatedLineCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) count += 1;
  }
  return count;
}

/** Drops a trailing line that has not seen its newline yet. */
function completeLinePrefix(text: string): string {
  const end = text.lastIndexOf("\n");
  if (end < 0) return "";
  return text.slice(0, end);
}

const STAGE_BYTES = 32 * 1024;
const STAGED_FILE = /^\/tmp\/rakazo-save\.[A-Za-z0-9]+$/;
const LIVE_CLEANUP_SCRIPT = 'rm -f -- "$1"';

type GuestShell = Pick<SandboxProvider, "execute">;

async function runGuestShell(
  sandbox: GuestShell,
  computer: ComputerRef,
  script: string,
  name: string,
  args: string[],
  context: AdapterContext,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  let code: number | undefined;
  for await (const event of sandbox.execute(
    computer,
    { argv: ["bash", "-c", script, name, ...args], cwd: "." },
    context,
  )) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") code = event.code;
  }
  return { code: code ?? 1, stdout, stderr };
}

/** Refuses a live path whose real parent leaves this bot's folder or shared/. */
export async function assertLivePathContained(
  sandbox: GuestShell,
  computer: ComputerRef,
  storedPath: string,
  prefixes: readonly string[],
  context: AdapterContext,
): Promise<void> {
  const result = await runGuestShell(
    sandbox,
    computer,
    LIVE_PATH_CONTAINMENT_SCRIPT,
    "rakazo-contain",
    [storedPath, ...prefixes],
    context,
  );
  if (result.code === 2) throw new Error("Path escapes the bot workspace");
  if (result.code !== 0) throw new Error("could not check the file path");
}

/**
 * Writes on a running computer without following a symlink into another bot's folder.
 * The bytes are staged under /tmp, then copied with an open that refuses a final symlink,
 * from a directory the script has already resolved.
 */
export async function writeContainedSandboxFile(
  sandbox: GuestShell,
  computer: ComputerRef,
  storedPath: string,
  content: Uint8Array,
  prefixes: readonly string[],
  context: AdapterContext,
): Promise<void> {
  const chunks: string[] = [];
  for (let offset = 0; offset < content.byteLength; offset += STAGE_BYTES) {
    chunks.push(Buffer.from(content.subarray(offset, offset + STAGE_BYTES)).toString("base64"));
  }
  if (chunks.length === 0) chunks.push("");
  const staged = await runGuestShell(
    sandbox,
    computer,
    LIVE_STAGE_SCRIPT,
    "rakazo-stage",
    [chunks[0] ?? ""],
    context,
  );
  const tmp = staged.stdout.trim();
  if (staged.code !== 0 || !STAGED_FILE.test(tmp)) throw new Error("could not save the file");
  try {
    for (const chunk of chunks.slice(1)) {
      const appended = await runGuestShell(
        sandbox,
        computer,
        LIVE_APPEND_SCRIPT,
        "rakazo-append",
        [tmp, chunk],
        context,
      );
      if (appended.code !== 0) throw new Error("could not save the file");
    }
    const committed = await runGuestShell(
      sandbox,
      computer,
      LIVE_COMMIT_SCRIPT,
      "rakazo-commit",
      [tmp, storedPath, ...prefixes],
      context,
    );
    if (committed.code === 2) throw new Error("Path escapes the bot workspace");
    if (committed.code !== 0) throw new Error("could not save the file");
  } catch (error) {
    await runGuestShell(
      sandbox,
      computer,
      LIVE_CLEANUP_SCRIPT,
      "rakazo-stage-cleanup",
      [tmp],
      context,
    ).catch(() => undefined);
    throw error;
  }
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
