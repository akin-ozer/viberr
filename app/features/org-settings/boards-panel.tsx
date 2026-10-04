import { useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { BoardExportSummary } from "~/server/org/board-export.server";
import type { BoardImportPreview } from "~/server/org/board-import.server";
import type { ConnectionRecord } from "~/server/org/connections.server";
import { countLabel } from "~/shared/text/plural";
import { useFileDrop } from "~/ui/attach-files";
import { GlyphSwap } from "~/ui/copy-glyph";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { BoardImportDialog } from "./board-import-dialog";
import type { OrgActionData } from "./use-org-action";

/**
 * Ruling 653: Instance settings → Import & export. A board file is a board's
 * workflow without its work, every part of it a plain file in one zip; this
 * tab is where one is made (Export, per board) and where one becomes a new
 * project (Import, which reads the file, shows what it would bring, and
 * writes nothing until the person confirms in the dialog).
 *
 * Import lives here rather than in New project on purpose (owner, 2026-10-04):
 * it brings knowledge bases, skills, MCP servers and agent templates into the
 * instance, which only an org admin may do.
 */

/** "5 stages · 4 agents · 2 skills · 1 knowledge base · 1 MCP server". */
function boardContents(board: BoardExportSummary): string {
  const parts = [countLabel(board.stages, "stage"), countLabel(board.agents, "agent")];
  if (board.skills > 0) parts.push(countLabel(board.skills, "skill"));
  if (board.knowledgeBases > 0) parts.push(countLabel(board.knowledgeBases, "knowledge base"));
  if (board.mcpServers > 0) parts.push(countLabel(board.mcpServers, "MCP server"));
  return parts.join(" · ");
}

/** The file name a Content-Disposition header gives, or the fallback. */
function attachmentName(header: string | null, fallback: string): string {
  const match = header ? /filename="([^"]+)"/.exec(header) : null;
  return match?.[1] ?? fallback;
}

function ExportRow({ board }: { board: BoardExportSummary }) {
  const push = useToast();
  const [busy, setBusy] = useState(false);
  // A fetch rather than a link, so a refusal (a board too large to import
  // back, a project file the store cannot read) is a toast on this page
  // instead of an error page in its place.
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/org/settings/board-export?project=${encodeURIComponent(board.slug)}`);
      if (!res.ok) {
        const body: { error?: string } = await res.json().catch(() => ({}));
        push(body.error ?? `Export failed (HTTP ${res.status}).`, "error");
        return;
      }
      const name = attachmentName(res.headers.get("content-disposition"), `${board.slug}.viberr-board.zip`);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      push(`${name} downloaded`);
    } catch {
      push("Export failed: the server could not be reached.", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rsrc-row">
      <span className="pj-mark">{(board.name.trim()[0] || "•").toUpperCase()}</span>
      <span className="rsrc-main">
        <b>
          {board.name} <span className="mono board-key">{board.taskPrefix}</span>{" "}
          {board.archived && (
            <Pill kind="neutral" sm quiet>
              archived
            </Pill>
          )}
        </b>
        <span className="sub">{boardContents(board)}</span>
        {board.missing.length > 0 && (
          <span className="sub">
            Granted but not on this instance, so not in the file: {board.missing.join(", ")}
          </span>
        )}
      </span>
      <span className="rsrc-acts">
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          aria-busy={busy || undefined}
          aria-label={(busy ? "Exporting " : "Export ") + board.name}
          onClick={download}
        >
          <GlyphSwap rest="download" alt="loader" on={busy} spinAlt />
          {busy ? "Exporting…" : "Export"}
        </button>
      </span>
    </div>
  );
}

export function BoardsPanel({
  boards,
  connections,
}: {
  boards: BoardExportSummary[];
  connections: ConnectionRecord[];
}) {
  const fetcher = useFetcher<OrgActionData>();
  const csrf = useCsrfToken();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BoardImportPreview | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const reading = fetcher.state !== "idle";

  useFetcherResult(fetcher, (d) => {
    if (!d.ok) setReadError(d.error);
    else if (d.boardImport) setPreview(d.boardImport);
  });

  const read = (picked: File) => {
    setFile(picked);
    setPreview(null);
    setReadError(null);
    if (!/\.zip$/i.test(picked.name)) {
      setReadError(`${picked.name} is not a .zip. A board file is the zip an Export below downloads.`);
      return;
    }
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "board-import-preview");
    fd.set("file", picked);
    fetcher.submit(fd, { method: "post", action: "/org/settings", encType: "multipart/form-data" });
  };
  const { dropping, dropProps } = useFileDrop((files) => {
    const first = files[0];
    if (first) read(first);
  }, reading);

  // The New project dialog's connection list: one chip per owner, `valid`
  // winning when an owner has several (UI-09).
  const owners: string[] = [];
  const health: Record<string, "valid" | "unvalidated" | "failed"> = {};
  for (const c of connections) {
    if (!owners.includes(c.owner)) owners.push(c.owner);
    if (health[c.owner] !== "valid") health[c.owner] = c.validationState;
  }

  return (
    <div className="rsrc-grid" data-screen-label="Settings · Import & export">
      <section className="panel">
        <div className="panel-head">
          <Icon name="upload" />
          <h2>Import a board</h2>
        </div>
        <p className="fine board-lede">
          A board file brings a board&apos;s workflow without its work: its stages and the rules between
          them, its agents with the skills, knowledge bases and MCP servers they use, its guardrails,
          required reviewers and gates. It becomes a new project. Nothing is written until you have seen
          what it brings and confirmed.
        </p>
        <div className={"board-drop" + (dropping ? " on" : "")} {...dropProps}>
          <GlyphSwap rest="upload" alt="loader" on={reading} spinAlt />
          <span className="board-drop-text">
            {reading && file ? `Reading ${file.name}…` : "Drop a board file (.zip) here, or"}
          </span>
          {!reading && (
            <button type="button" className="btn sm" onClick={() => inputRef.current?.click()}>
              Choose a file
            </button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            aria-label="Board file"
            onChange={(e) => {
              const picked = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (picked) read(picked);
            }}
          />
        </div>
        {readError && (
          <div className="form-err" role="alert">
            <Icon name="alert" />
            <span>{readError}</span>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <Icon name="download" />
          <h2>Export a board</h2>
        </div>
        <p className="fine board-lede">
          Downloads one board as <code className="mono">&lt;board&gt;.viberr-board.zip</code>: a{" "}
          <code className="mono">board.md</code> with its stages, rules and agents, and a folder for each
          agent template, skill and knowledge base they use. Tasks, members, the repository and every
          credential stay on this instance.
        </p>
        <div className="rsrc-list">
          {boards.map((board) => (
            <ExportRow board={board} key={board.slug} />
          ))}
          {boards.length === 0 && (
            <div className="empty">
              No boards yet. Create a project on Home, or import a board file above, and it is listed
              here for export.
            </div>
          )}
        </div>
      </section>
      {file && preview && (
        <BoardImportDialog
          file={file}
          preview={preview}
          boards={boards}
          connections={owners}
          connectionHealth={health}
          onChooseAnother={() => {
            setPreview(null);
            inputRef.current?.click();
          }}
          onClose={() => {
            setPreview(null);
            setFile(null);
          }}
        />
      )}
    </div>
  );
}
