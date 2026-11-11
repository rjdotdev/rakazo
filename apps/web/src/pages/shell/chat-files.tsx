import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ComputerMode } from "@rakazo/contracts";
import { CHAT_FILE_READ_MAX_LINES } from "@rakazo/contracts";
import { Button, SectionHeading, Spinner, Textarea } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, File, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { CodeView, codeLanguage } from "./code-view";

const PREVIEW_LINES = 400;
const TREE_DEPTH = 40;

const IMAGE_MIME: Record<string, string> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

type ChatFileEntry = { path: string; kind: "file" | "dir"; size: number };

export function ChatFiles({ botId, computerMode }: { botId: string; computerMode: ComputerMode }) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  if (openPath) {
    return <FileView botId={botId} path={openPath} onBack={() => setOpenPath(null)} />;
  }
  return (
    <div data-testid="chat-files" className="space-y-4">
      <ChangedFiles botId={botId} onOpen={setOpenPath} />
      <FileTree botId={botId} computerMode={computerMode} path="" depth={0} onOpen={setOpenPath} />
    </div>
  );
}

function ChangedFiles({ botId, onOpen }: { botId: string; onOpen: (path: string) => void }) {
  const queries = useSpaceQueries();
  const changed = useQuery(queries.computer.changedFiles.queryOptions({ input: { botId } }));
  if (!changed.data?.length) return null;
  return (
    <section data-testid="chat-files-changed" className="space-y-1">
      <SectionHeading variant="label">
        <Trans>Changed in this chat</Trans>
      </SectionHeading>
      {changed.data.map((file) => (
        <FileButton
          key={file.path}
          path={file.path}
          kind="file"
          depth={0}
          showPath
          onClick={() => onOpen(file.path)}
        />
      ))}
    </section>
  );
}

function FileTree({
  botId,
  computerMode,
  path,
  depth,
  onOpen,
}: {
  botId: string;
  computerMode: ComputerMode;
  path: string;
  depth: number;
  onOpen: (path: string) => void;
}) {
  const queries = useSpaceQueries();
  const listing = useQuery(queries.computer.files.queryOptions({ input: { botId, path } }));
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(new Set());
  if (listing.isPending) {
    return (
      <div className="py-2">
        <Spinner />
      </div>
    );
  }
  if (listing.isError) {
    return (
      <div className="space-y-2">
        <p className="text-body text-muted-foreground">
          <Trans>Couldn't load files.</Trans>
        </p>
        <Button variant="outline" size="sm" onClick={() => void listing.refetch()}>
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }
  const entries = withSharedRoot(listing.data ?? [], computerMode, path);
  if (entries.length === 0) {
    return path === "" ? (
      <p className="text-body text-muted-foreground">
        <Trans>No files yet</Trans>
      </p>
    ) : null;
  }
  return (
    <div className="space-y-0.5">
      {entries.map((entry) => {
        const open = openDirs.has(entry.path);
        return (
          <div key={entry.path}>
            <FileButton
              path={entry.path}
              kind={entry.kind}
              depth={depth}
              expanded={open}
              onClick={() => {
                if (entry.kind === "file") {
                  onOpen(entry.path);
                  return;
                }
                setOpenDirs((current) => {
                  const next = new Set(current);
                  if (next.has(entry.path)) next.delete(entry.path);
                  else next.add(entry.path);
                  return next;
                });
              }}
            />
            {entry.kind === "dir" && open && depth < TREE_DEPTH ? (
              <FileTree
                botId={botId}
                computerMode={computerMode}
                path={entry.path}
                depth={depth + 1}
                onOpen={onOpen}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function FileButton({
  path,
  kind,
  depth,
  expanded,
  showPath = false,
  onClick,
}: {
  path: string;
  kind: "file" | "dir";
  depth: number;
  expanded?: boolean;
  showPath?: boolean;
  onClick: () => void;
}) {
  const Icon = kind === "dir" ? Folder : File;
  return (
    <button
      type="button"
      data-testid="chat-file"
      data-path={path}
      data-kind={kind}
      aria-expanded={kind === "dir" ? expanded : undefined}
      title={path}
      className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-body hover:bg-accent"
      style={{ paddingInlineStart: 6 + depth * 12 }}
      onClick={onClick}
    >
      {kind === "dir" ? (
        <ChevronRight
          size={14}
          strokeWidth={1.8}
          className={`shrink-0 text-muted-foreground ${expanded ? "rotate-90" : ""}`}
        />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <Icon size={14} strokeWidth={1.8} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{showPath ? path : baseName(path)}</span>
    </button>
  );
}

function FileView({ botId, path, onBack }: { botId: string; path: string; onBack: () => void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const imageType = IMAGE_MIME[extension(path)];
  const [offset, setOffset] = useState(1);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [baseline, setBaseline] = useState<string | null>(null);
  const [editNote, setEditNote] = useState<"large" | "failed" | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<"busy" | "changed" | "failed" | null>(null);
  const text = useQuery({
    ...queries.computer.readFile.queryOptions({
      input: { botId, path, offset, limit: PREVIEW_LINES },
    }),
    enabled: !imageType,
  });
  const image = useQuery({
    ...queries.computer.downloadFile.queryOptions({ input: { botId, path } }),
    enabled: Boolean(imageType),
  });
  const previewUrl = useObjectUrl(image.data?.contentBase64, imageType);
  const page = text.data;
  const editable = Boolean(
    page && !page.partial && (page.totalLines ?? 0) <= CHAT_FILE_READ_MAX_LINES,
  );

  async function startEdit() {
    setSaveNote(null);
    setEditNote(null);
    try {
      const loaded = await rpc.computer.readFile({
        botId,
        path,
        offset: 1,
        limit: CHAT_FILE_READ_MAX_LINES,
      });
      if (
        loaded.partial ||
        loaded.contentHash === null ||
        loaded.endLine < (loaded.totalLines ?? loaded.endLine)
      ) {
        setEditNote("large");
        return;
      }
      setBaseline(loaded.contentHash);
      setDraft(loaded.content);
      setEditing(true);
    } catch {
      setEditNote("failed");
    }
  }

  async function save() {
    setSaving(true);
    setSaveNote(null);
    try {
      await rpc.computer.saveFile({
        botId,
        path,
        content: draft,
        ...(baseline ? { expectedContentHash: baseline } : {}),
      });
      setEditing(false);
      setOffset(1);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queries.computer.files.key() }),
        queryClient.invalidateQueries({ queryKey: queries.computer.readFile.key() }),
        queryClient.invalidateQueries({ queryKey: queries.computer.changedFiles.key() }),
      ]);
    } catch (error) {
      if (error instanceof ORPCError && error.code === "CONFLICT") {
        if (error.message === "This file changed. Open it again.") setSaveNote("changed");
        else if (error.message === "The computer is busy. Try again.") setSaveNote("busy");
        else setSaveNote("failed");
      } else {
        setSaveNote("failed");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="chat-file-view" className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <Trans>Back</Trans>
        </Button>
        <span className="min-w-0 flex-1 truncate text-body font-medium" title={path}>
          {baseName(path)}
        </span>
        {editing ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
              <Trans>Cancel</Trans>
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              <Trans>Save</Trans>
            </Button>
          </>
        ) : editable ? (
          <Button variant="outline" size="sm" onClick={() => void startEdit()}>
            <Trans>Edit</Trans>
          </Button>
        ) : null}
      </div>
      {saveNote === "changed" ? (
        <p className="text-body text-destructive">
          <Trans>This file changed. Open it again.</Trans>
        </p>
      ) : null}
      {saveNote === "busy" ? (
        <p className="text-body text-destructive">
          <Trans>The computer is busy. Try again.</Trans>
        </p>
      ) : null}
      {saveNote === "failed" ? (
        <p className="text-body text-destructive">
          <Trans>Couldn't save.</Trans>
        </p>
      ) : null}
      {imageType ? (
        image.isPending ? (
          <Spinner />
        ) : previewUrl ? (
          <img src={previewUrl} alt={baseName(path)} className="max-w-full rounded-lg" />
        ) : (
          <p className="text-body text-muted-foreground">
            <Trans>Couldn't open this file.</Trans>
          </p>
        )
      ) : text.isPending ? (
        <Spinner />
      ) : text.isError ? (
        <OpenFailure error={text.error} />
      ) : page && page.endLine < page.startLine ? (
        <p className="text-body text-muted-foreground">
          <Trans>The rest of this file is too large to open here.</Trans>
        </p>
      ) : page ? (
        <>
          {!editing &&
          (page.startLine > 1 ||
            page.partial ||
            (page.totalLines !== null && page.endLine < page.totalLines)) ? (
            <div className="flex items-center gap-2 text-label text-muted-foreground">
              <span>
                {page.totalLines === null
                  ? t`Lines ${page.startLine}-${page.endLine}`
                  : t`Lines ${page.startLine}-${page.endLine} of ${page.totalLines}`}
              </span>
              {page.startLine > 1 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOffset(Math.max(1, page.startLine - PREVIEW_LINES))}
                >
                  <Trans>Previous</Trans>
                </Button>
              ) : null}
              {page.partial || (page.totalLines !== null && page.endLine < page.totalLines) ? (
                <Button variant="ghost" size="sm" onClick={() => setOffset(page.endLine + 1)}>
                  <Trans>Next</Trans>
                </Button>
              ) : null}
            </div>
          ) : null}
          {editNote === "large" ? (
            <p className="text-body text-muted-foreground">
              <Trans>The rest of this file is too large to open here.</Trans>
            </p>
          ) : null}
          {editNote === "failed" ? (
            <p className="text-body text-muted-foreground">
              <Trans>Couldn't open this file.</Trans>
            </p>
          ) : null}
          {editing ? (
            <Textarea
              aria-label={t`File contents`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-64 font-mono text-body-sm"
            />
          ) : isMarkdown(path) ? (
            <div className="text-body leading-6">
              <ChatMarkdown>{page.content}</ChatMarkdown>
            </div>
          ) : (
            <CodeView
              code={page.content}
              language={codeLanguage(path)}
              startLine={page.startLine}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

function OpenFailure({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "";
  if (/not a text file/i.test(message)) {
    return (
      <p className="text-body text-muted-foreground">
        <Trans>Can't preview this file.</Trans>
      </p>
    );
  }
  if (/too large/i.test(message)) {
    return (
      <p className="text-body text-muted-foreground">
        <Trans>The rest of this file is too large to open here.</Trans>
      </p>
    );
  }
  return (
    <p className="text-body text-muted-foreground">
      <Trans>Couldn't open this file.</Trans>
    </p>
  );
}

function withSharedRoot(
  entries: ChatFileEntry[],
  computerMode: ComputerMode,
  path: string,
): ChatFileEntry[] {
  const listed = [...entries];
  if (computerMode === "team" && path === "" && !listed.some((entry) => entry.path === "shared")) {
    listed.push({ path: "shared", kind: "dir", size: 0 });
  }
  return listed.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

function baseName(path: string): string {
  return path.split("/").pop() || path;
}

function extension(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function isMarkdown(path: string): boolean {
  const ext = extension(path);
  return ext === "md" || ext === "markdown";
}

function useObjectUrl(base64: string | undefined, mime: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!base64 || !mime) return;
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const next = URL.createObjectURL(new Blob([bytes], { type: mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [base64, mime]);
  return url;
}
