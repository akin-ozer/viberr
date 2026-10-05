import {
  Fragment,
  useEffect,
  useReducer,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useFetcher } from "react-router";
import { countLabel } from "~/shared/text/plural";
import { STORE_TEXT_EXTENSIONS } from "~/shared/text/store-extensions";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { useCsrfToken } from "~/ui/csrf-input";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { isMarkdownName } from "~/ui/code-language";
import { DocViewToggle, MarkdownDoc, type DocView } from "~/ui/markdown-doc";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useRelativeTime } from "~/ui/use-relative-time";
import {
  entriesFromDataTransfer,
  entriesFromFileList,
  type UploadSelection,
} from "./local-files";
import {
  countKbDirs,
  countKbFiles,
  flatten,
  type StoreNode,
} from "./tree";
import { prettySize } from "~/shared/text/byte-size";
import { useRefusalShake, type RefusalShake } from "~/ui/use-refusal-shake";

/**
 * Store-folder file manager popup.
 *
 * - the tree comes from the loader (a real disk scan) and every mutation
 *   is a fetcher POST to the org-settings action → real fs write → the
 *   revalidated scan re-renders the tree; sizes/dates are formatted from
 *   sizeBytes/mtime at render time;
 * - GitHub import is the real snapshot action. It runs ANONYMOUSLY when the
 *   org has no connection — a public repo needs no credential — and uses the
 *   default connection when there is one (private repos, higher rate limit).
 *   A refusal that having no credential explains, and any other failure,
 *   render in the `.form-err` under the import bar;
 * - SKILL.md capture happens server-side (the skill body is re-read from
 *   disk) — the capture toast rides the action response;
 * - both layers are native <dialog>s (showModal via useDialog): Escape's
 *   `cancel` hits the TOPMOST layer only (confirm → new-folder input →
 *   modal), and the card goes `inert` under the nested confirm.
 */

export interface StoreBrowserResource {
  kind: "kb" | "skill";
  id: string;
}

const hasFiles = (e: ReactDragEvent) =>
  Boolean(e.dataTransfer) &&
  Array.from(e.dataTransfer.types ?? []).includes("Files");

type GhImportState = { open: boolean; url: string; err: string | null };

type GhImportAction =
  | { type: "toggle" }
  | { type: "url"; url: string }
  | { type: "err"; err: string | null }
  | { type: "reset" };

const ghImportInitial: GhImportState = { open: false, url: "", err: null };

function ghImportReducer(
  state: GhImportState,
  action: GhImportAction,
): GhImportState {
  switch (action.type) {
    case "toggle":
      return { ...state, open: !state.open, err: null };
    case "url":
      return { ...state, url: action.url, err: null };
    case "err":
      return { ...state, err: action.err };
    case "reset":
      return ghImportInitial;
  }
}

/**
 * Which rows are clickable, so a PDF doesn't look editable (P14-KM-08). The
 * SERVER is still the authority — `readStoreDoc`/`writeStoreDoc` refuse
 * anything else — but this list no longer restates it from memory (C5-followup):
 * it reads the same set, from `~/shared/text/store-extensions` rather than the
 * injector, because this component runs in the browser and cannot import a
 * `.server` module.
 */
function isEditableDoc(name: string): boolean {
  // extname-equivalent without node:path: last dot in the last segment.
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return false;
  return STORE_TEXT_EXTENSIONS.has(lower.slice(dot));
}

/** Toolbar row + the collapsible GitHub import bar and its error line. */
function BrowserToolbar({
  gh,
  dispatchGh,
  importing,
  dest,
  folders,
  rootLabel,
  onDest,
  onImport,
  onUploadFiles,
  onUploadFolder,
  onNewFolder,
  onNewDoc,
}: {
  gh: GhImportState;
  dispatchGh: (action: GhImportAction) => void;
  importing: boolean;
  /** Store-relative folder every toolbar action writes into ([] = root). */
  dest: string[];
  /** Every folder in the tree, as store-relative paths (root excluded). */
  folders: string[][];
  /** The browsed resource's own name — what `[]` actually writes into. */
  rootLabel: string;
  onDest: (path: string[]) => void;
  onImport: () => void;
  onUploadFiles: () => void;
  onUploadFolder: () => void;
  onNewFolder: () => void;
  onNewDoc: () => void;
}) {
  return (
    <>
      <div className="fm-toolbar">
        {/* Pass 30: adding files is the dialog's job, so it carries the one
            primary; Done below is a plain exit. Five equal-weight secondaries
            gave the toolbar no ranking. */}
        <button type="button" className="btn primary sm" onClick={onUploadFiles}>
          <Icon name="upload" />
          Upload files
        </button>
        <button type="button" className="btn sm" onClick={onUploadFolder}>
          <Icon name="folderup" />
          Upload folder
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => dispatchGh({ type: "toggle" })}
        >
          <Icon name="github" />
          Add from GitHub
        </button>
        {/* P13-LV-06 (owner ruling 3): a knowledge base used to be fillable
            only by upload/import, so writing three facts by hand meant leaving
            the product — while skills had a full in-app editor. */}
        <button type="button" className="btn sm" onClick={onNewDoc}>
          <Icon name="file" />
          New document
        </button>
        <button type="button" className="btn ghost sm" onClick={onNewFolder}>
          <Icon name="folder" />
          New folder
        </button>
        {/* P14-KM-08 (owner ruling R14-4): every toolbar action wrote to the
            store ROOT no matter which folder you were looking at — "New
            document" hardcoded `path: []` and the GitHub import carried no path
            at all — so organising a KB into folders was impossible from the UI.
            One destination drives all of them; the per-row actions set it too. */}
        <label className="fm-hint" htmlFor="fm-dest">
          into
        </label>
        <select
          id="fm-dest"
          className="mono"
          value={dest.join("/")}
          aria-label="Destination folder"
          onChange={(e) =>
            onDest(e.target.value ? e.target.value.split("/") : [])
          }
        >
          {/* U33-3: this read "/ (store root)", which is a place no toolbar
              action here has ever written. A StoreBrowser is opened on ONE
              resource (resources-panel mounts it per knowledge base or per
              skill) and `resolveStoreTarget` resolves every path against that
              resource's own folder — the kb dir / skill folder — so `[]` is
              the RESOURCE root, not the store's. Copy only: the value stays
              empty and the destination stays `[]`. */}
          <option value="">{"/ (" + rootLabel + " root)"}</option>
          {folders.map((path) => (
            <option key={path.join("/")} value={path.join("/")}>
              {path.join("/")}/
            </option>
          ))}
        </select>
        <span className="fm-hint">drag files or folders onto a folder to upload there</span>
      </div>
      {gh.open && (
        <div className="fm-gh">
          <input
            type="text"
            className="mono"
            value={gh.url}
            placeholder="https://github.com/owner/repo/tree/main/docs"
            onChange={(e) => dispatchGh({ type: "url", url: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") onImport();
            }}
            autoFocus
          />
          <button
            type="button"
            className="btn sm"
            onClick={onImport}
            disabled={importing}
            aria-busy={importing || undefined}
          >
            <GlyphSwap rest="arrow" alt="loader" on={importing} spinAlt />
            {importing ? "Importing…" : "Import"}
          </button>
        </div>
      )}
      {gh.err && (
        <div className="form-err">
          <Icon name="alert" />
          {gh.err}
        </div>
      )}
    </>
  );
}

/**
 * P13-UI-20 residual: the file rows called `formatRelative` straight in render,
 * so the string was minted on the SERVER's clock and then never aged — a
 * browser left open kept claiming a file changed "2m ago" an hour later. The
 * shared hook re-renders on mount and every 30s; a component per row is what
 * lets a hook run inside the row map at all.
 */
function FileMtime({ iso }: { iso: string | null }) {
  const rel = useRelativeTime(iso);
  if (!rel) return null;
  return <span suppressHydrationWarning>{" · " + rel}</span>;
}

/** The file tree with drag-drop upload targets and the inline new-folder
 * row; owns the transient drop-target highlight. */
function StoreTree({
  nodes,
  expanded,
  newIn,
  onToggle,
  onStartNew,
  onDismissNew,
  onCreateFolder,
  onStartUpload,
  onOpenDoc,
  onDelete,
  onUploadEntries,
}: {
  nodes: StoreNode[];
  expanded: Set<string>;
  newIn: string[] | null;
  onToggle: (key: string) => void;
  /** Expand the dir and open the new-folder input inside it. */
  onStartNew: (path: string[]) => void;
  onDismissNew: () => void;
  onCreateFolder: (path: string[], name: string) => void;
  onStartUpload: (path: string[]) => void;
  /** Open an existing text doc in the in-place editor (dir path + file name). */
  onOpenDoc: (path: string[], name: string) => void;
  onDelete: (path: string[], node: StoreNode) => void;
  onUploadEntries: (
    path: string[],
    selection: UploadSelection,
    mode: "files" | "folder",
  ) => void;
}) {
  const [dropTgt, setDropTgt] = useState<string | null>(null);
  const newRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (newIn && newRef.current) newRef.current.focus();
  }, [newIn]);
  useEffect(() => {
    const clear = () => setDropTgt(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);

  const overDir = (e: ReactDragEvent, key: string) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    if (dropTgt !== key) setDropTgt(key);
  };
  const dropInto = (e: ReactDragEvent, path: string[]) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTgt(null);
    const dt = e.dataTransfer;
    void entriesFromDataTransfer(dt).then((selection) => {
      const mode = selection.entries.some((x) => x.relPath.includes("/"))
        ? "folder"
        : "files";
      onUploadEntries(path, selection, mode);
    });
  };

  const rows = flatten(nodes, [], 0, expanded, []);

  const newFolderRow = (path: string[], depth: number) => (
    // The row is a text field in a row shell, not an activatable directory row:
    // it carries no `.fm-open` button or handler, so it must not offer a real
    // row's hover fill (`.editing` drops it, and the hand lives on `.fm-open`;
    // `.dir` keeps the folder glyph's weight).
    <div
      className="fm-row dir editing"
      style={{ paddingLeft: `${0.6 + depth * 1.3}rem` }}
    >
      <span className="twist"></span>
      <Icon name="folder" />
      <input
        ref={newRef}
        className="fm-newinp mono"
        placeholder="folder name"
        aria-label="New folder name"
        onKeyDown={(e) => {
          if (e.key === "Enter") onCreateFolder(path, e.currentTarget.value);
          if (e.key === "Escape") {
            // preventDefault aborts the dialog's native close request, so
            // Escape here dismisses only this row — not the whole modal.
            e.preventDefault();
            e.stopPropagation();
            onDismissNew();
          }
        }}
        onBlur={() => {
          // P13-UI-23: committing on BLUR created a folder from a half-typed
          // name whenever focus moved (clicking another row, the toolbar, or
          // just tabbing away) — an accidental, real filesystem mutation with
          // no way to take it back except deleting it. Blur now dismisses;
          // Enter commits.
          onDismissNew();
        }}
      />
    </div>
  );

  return (
    <div
      className={"fm-tree" + (dropTgt === "" ? " droptgt" : "")}
      onDragOver={(e) => overDir(e, "")}
      onDrop={(e) => dropInto(e, [])}
      onDragLeave={(e) => {
        // Leaving for anything that is not a node inside the tree (including
        // leaving the window, where `relatedTarget` is null) clears the target.
        const entered = e.relatedTarget;
        if (!(entered instanceof Node) || !e.currentTarget.contains(entered)) {
          setDropTgt(null);
        }
      }}
    >
      {newIn && newIn.length === 0 && newFolderRow([], 0)}
      {rows.map((r) => {
        // P14-KM-08/UI-61: a text doc opens in the in-place editor. Binaries
        // stay inert rather than pretending to be editable — the server refuses
        // them either way, but a clickable PDF would be a lie.
        const openable = r.node.type === "file" && isEditableDoc(r.node.name);
        const activate =
          r.node.type === "dir"
            ? () => onToggle(r.key)
            : openable
              ? () => onOpenDoc(r.path, r.node.name)
              : undefined;
        const rowFace = (
          <>
            <span className="twist">
              {r.node.type === "dir" && (
                <Icon name="chevron" className={r.open ? "r90" : ""} />
              )}
            </span>
            {r.node.type === "dir" ? (
              <Icon name={r.open ? "folderopen" : "folder"} />
            ) : (
              <Icon name="file" />
            )}
            <span className="fm-name">{r.node.name}</span>
            {r.node.type === "dir" ? (
              <span className="fm-meta">
                {countLabel(countKbFiles(r.node.children), "file")}
              </span>
            ) : (
              <span className="fm-meta">
                {prettySize(r.node.sizeBytes)}
                <FileMtime iso={r.node.mtime} />
              </span>
            )}
          </>
        );
        return (
          <Fragment key={r.key + (r.node.type || "")}>
            <div
              className={
                "fm-row " +
                (r.node.type === "dir" ? "dir" : "file") +
                (openable ? " openable" : "") +
                (dropTgt &&
                dropTgt ===
                  (r.node.type === "dir" ? r.key : r.path.join("/"))
                  ? " droptgt"
                  : "")
              }
              style={{ paddingLeft: `${0.6 + r.depth * 1.3}rem` }}
              onDragOver={(e) =>
                overDir(e, r.node.type === "dir" ? r.key : r.path.join("/"))
              }
              onDrop={(e) =>
                dropInto(
                  e,
                  r.node.type === "dir" ? [...r.path, r.node.name] : r.path,
                )
              }
            >
              {activate ? (
                // Interface review 2026-09-24 (acce-32): the activation is a
                // native button BESIDE the row actions, not a role="button"
                // row around them — children of a button are presentational,
                // and the folder row was named "decisions 3 files Upload into
                // decisions New folder in decisions Delete decisions" while it
                // only expanded. Same fix as notifications-page's UI-54 row.
                <button
                  type="button"
                  className="fm-open"
                  aria-expanded={r.node.type === "dir" ? r.open : undefined}
                  aria-label={openable ? "Open " + r.node.name : undefined}
                  onClick={activate}
                >
                  {rowFace}
                </button>
              ) : (
                <span className="fm-open">{rowFace}</span>
              )}
              {/* Row actions are ALWAYS drawn (pass 16). `.fm-acts` faded them
                  in on `:hover`/`:focus-within`, which is a mouse-only reveal —
                  and `opacity: 0` does not remove hit-testing, so on a touch
                  device these buttons were invisible but still tappable: a tap
                  near the right edge of a row could hit Delete with nothing on
                  screen to explain it. `.rsrc-acts` is the always-visible row-
                  action wrapper the org-settings resource rows already use, so
                  this is also the app's one row-action shape rather than a
                  third. (`.fm-acts` has since been deleted from app.css, P16-UI-25.) */}
              <span className="rsrc-acts">
                {r.node.type === "dir" && (
                  <>
                    <button
                      type="button"
                      className="fm-act"
                      title="Upload here"
                      aria-label={"Upload into " + r.node.name}
                      onClick={() => onStartUpload([...r.path, r.node.name])}
                    >
                      <Icon name="upload" />
                    </button>
                    <button
                      type="button"
                      className="fm-act"
                      title="New subfolder"
                      aria-label={"New folder in " + r.node.name}
                      onClick={() => onStartNew([...r.path, r.node.name])}
                    >
                      <Icon name="plus" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="fm-act del"
                  title="Delete"
                  aria-label={"Delete " + r.node.name}
                  onClick={() => onDelete(r.path, r.node)}
                >
                  <Icon name="x" />
                </button>
              </span>
            </div>
            {newIn &&
              r.node.type === "dir" &&
              newIn.join("/") === r.key &&
              newFolderRow(newIn, r.depth + 1)}
          </Fragment>
        );
      })}
      {rows.length === 0 && !newIn && (
        <div className="fm-empty">
          Empty. Drag files or folders here, upload, or import from GitHub.
        </div>
      )}
    </div>
  );
}

/** Nested delete confirm on its OWN native <dialog> (the shared `ConfirmDialog`,
 * ruling 458(f)) — showModal stacking makes it the topmost layer, so its
 * Escape/backdrop land there (useDialog), not on the browser card underneath. */
function DeleteConfirm({
  node,
  onCancel,
  onConfirm,
}: {
  node: StoreNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const files = node.type === "dir" ? countKbFiles(node.children) : 0;
  return (
    <ConfirmDialog
      screenLabel="Store deletion dialog"
      className="over-modal"
      title={`Delete “${node.name}”${files > 0 ? " and its contents" : ""}?`}
      body={
        node.type === "dir"
          ? files > 0
            ? countLabel(files, "file") +
              " inside will be removed from the store. Agents lose them on their next context load."
            : "The empty folder is removed from the store."
          : "The file is removed from the store. Agents lose it on their next context load."
      }
      confirmLabel={node.type === "dir" ? "Delete folder" : "Delete file"}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/**
 * The org-settings action's reply, as this browser reads it — mirrors
 * `SettingsOk` and the `{ ok: false, error }` failure in routes/org.settings.tsx.
 * Every field beyond `ok` is per-intent and is OMITTED unless that intent
 * produced one, so each handler keys on the key being there.
 */
interface StoreActionReply {
  ok?: boolean;
  toast?: string;
  /** `store-upload`: a second toast when a SKILL.md body was captured. */
  captureToast?: string;
  /** `store-read-doc`: the document body and whether the read was cut short. */
  text?: string;
  truncated?: boolean;
  /** `store-read-doc` (ruling 663): the version read. */
  version?: string;
  /** `store-import-github`: the store-relative folder the snapshot landed in. */
  folder?: string;
  error?: string;
}

/** Where the browser's every read and write posts (ruling 657: no caller ever
 *  passed another). */
const STORE_ACTION = "/org/settings";

/**
 * All store mutations behind the modal: the two fetcher POSTs to the
 * org-settings action (file ops + GitHub import), the file-ops toast
 * effect, and the hidden-input upload plumbing. The GitHub-import
 * feedback effect stays with the caller — it expands tree state the
 * caller owns.
 */
function useStoreOps(
  resource: StoreBrowserResource,
  expand: (path: string[]) => void,
) {
  const push = useToast();
  const csrf = useCsrfToken();
  const opsFetcher = useFetcher<StoreActionReply>();
  const ghFetcher = useFetcher<StoreActionReply>();
  const [gh, dispatchGh] = useReducer(ghImportReducer, ghImportInitial);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string[]>([]);
  /** Files in the in-flight upload (P13-UI-08) — 0 when idle. */
  const [uploading, setUploading] = useState(0);

  const importing = ghFetcher.state !== "idle";
  const uploadBusy = uploading > 0 && opsFetcher.state !== "idle";

  // ---- action feedback (toasts ride the server response).
  useFetcherResult(opsFetcher, (d) => {
    setUploading(0);
    if (d.ok) {
      if (d.toast) push(d.toast);
      if (d.captureToast) push(d.captureToast);
    } else if (d.error) {
      // P13-D-10: `push` defaults to the "success" kind, so this failure
      // rendered under a green tick.
      push(d.error, "error");
    }
  });

  // ---- mutations (real fs writes via the org-settings action).
  const submitFields = (fields: Record<string, string>) => {
    opsFetcher.submit(
      {
        _csrf: csrf,
        kind: resource.kind,
        id: resource.id,
        ...fields,
      },
      { method: "post", action: STORE_ACTION },
    );
  };
  const submitUpload = (
    path: string[],
    selection: UploadSelection,
    mode: "files" | "folder",
  ) => {
    const { entries, skipped } = selection;
    if (entries.length === 0) {
      // P13-UI-08 residual: a drop of nothing but dot-files returned here with
      // no request, no toast and no error — the user saw exactly what a
      // successful upload looks like. Say which of the two nothings happened.
      if (skipped > 0) {
        push(
          `Nothing uploaded: ${countLabel(skipped, "hidden item")} skipped (names starting with “.” are never stored).`,
          "error",
        );
      }
      return;
    }
    const fd = new FormData();
    fd.set("intent", "store-upload");
    fd.set("mode", mode);
    fd.set("kind", resource.kind);
    fd.set("id", resource.id);
    fd.set("path", JSON.stringify(path));
    for (const e of entries) {
      fd.append("files", e.file);
      fd.append("filePaths", e.relPath);
    }
    fd.set("_csrf", csrf);
    opsFetcher.submit(fd, {
      method: "post",
      action: STORE_ACTION,
      encType: "multipart/form-data",
    });
    // P13-UI-08: an upload had no busy state at all, so a large drop looked
    // like nothing happened until the toast eventually arrived (or didn't).
    setUploading(entries.length);
    expand(path);
    for (const e of entries) {
      const top = e.relPath.split("/")[0];
      if (top && e.relPath.includes("/")) expand([...path, top]);
    }
  };

  const startUpload = (path: string[]) => {
    uploadTarget.current = path;
    fileRef.current?.click();
  };
  const startDirUpload = (path: string[]) => {
    uploadTarget.current = path;
    dirRef.current?.click();
  };
  const onFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    submitUpload(
      uploadTarget.current,
      entriesFromFileList(e.target.files ?? []),
      "files",
    );
    e.target.value = "";
  };
  const onDirFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    submitUpload(
      uploadTarget.current,
      entriesFromFileList(e.target.files ?? []),
      "folder",
    );
    e.target.value = "";
  };

  const ghImport = (dest: string[]) => {
    if (importing) return;
    if (!gh.url.trim()) {
      dispatchGh({
        type: "err",
        err: "Paste a GitHub link: a repo, or a folder like github.com/owner/repo/tree/main/docs.",
      });
      return;
    }
    dispatchGh({ type: "err", err: null });
    ghFetcher.submit(
      {
        _csrf: csrf,
        intent: "store-import-github",
        kind: resource.kind,
        id: resource.id,
        url: gh.url.trim(),
        // P14-KM-08: the import used to carry no path at all, so a snapshot
        // always landed at the store root regardless of the browsed folder.
        path: JSON.stringify(dest),
      },
      { method: "post", action: STORE_ACTION },
    );
  };

  return {
    gh,
    dispatchGh,
    importing,
    uploadBusy,
    uploading,
    ghFetcher,
    fileRef,
    dirRef,
    submitFields,
    submitUpload,
    startUpload,
    startDirUpload,
    onFiles,
    onDirFiles,
    ghImport,
  };
}

/** The in-place document editor's state (P14-KM-08 / UI-59 / UI-60 / UI-61). */
interface DocDraft {
  /** Store-relative folder holding the document. */
  dir: string[];
  /** File name — fixed once the document exists on disk. */
  name: string;
  body: string;
  existing: boolean;
  /** Ruling 614: the body as the read returned it, so the card knows whether
   *  anything changed. Null until the read answers (and after a read that
   *  failed); always null for a new document. */
  saved: string | null;
  /** The on-disk file exceeded the read cap, so this body is a partial copy. */
  truncated: boolean;
  /** Ruling 663: the version the read returned. The save sends it back, and
   *  the server refuses the save once the file is no longer that version, so
   *  a correction an agent merged meanwhile is not wiped. Null for a new
   *  document and until the read answers. */
  version: string | null;
  /** Ruling 614: rendered or raw. An existing markdown file opens rendered; a
   *  new document opens raw, since there is nothing to render yet. */
  view: DocView;
  err: string | null;
}

/** What a document save posts (`store-write-doc`). `overwrite` rides only a
 *  confirmed replace, and `version` only a document that was opened (ruling
 *  663); each is sent or absent, never blank. */
type DocSaveFields = {
  _csrf: string;
  intent: "store-write-doc";
  kind: string;
  id: string;
  path: string;
  name: string;
  body: string;
  overwrite?: "1";
  version?: string;
};

/** The name a new document is saved under: `writeStoreDoc` gives a name with
 *  no extension `.md`. */
function draftFileName(name: string): string {
  const trimmed = name.trim();
  return trimmed.includes(".") ? trimmed : `${trimmed}.md`;
}

/**
 * The in-app document editor (owner ruling R14-4).
 *
 * It used to be create-only, and it closed OPTIMISTICALLY on save — the draft
 * was thrown away before the server answered, so a rejected write destroyed
 * whatever had been typed (UI-60). Existing documents could not be opened at
 * all: `readStoreDoc` shipped with no production caller, so the only way to
 * change a doc in-app was to retype its name and blind-overwrite it (UI-61).
 *
 * It owns its OWN fetchers, separate from the file-op ones, so a read or a
 * rejected save never rides the generic store toast — the editor stays open and
 * says what went wrong.
 */
function useDocEditor(
  resource: StoreBrowserResource,
  onSaved: (path: string) => void,
) {
  const csrf = useCsrfToken();
  const readFetcher = useFetcher<StoreActionReply>();
  const saveFetcher = useFetcher<StoreActionReply>();
  const [doc, setDoc] = useState<DocDraft | null>(null);
  /** A save the user has confirmed will replace an existing file (UI-59). */
  const [confirmReplace, setConfirmReplace] = useState(false);

  const loading = readFetcher.state !== "idle";
  const saving = saveFetcher.state !== "idle";

  useFetcherResult(readFetcher, (d) => {
    setDoc((prev) =>
      prev
        ? d.ok
          ? {
              ...prev,
              body: d.text ?? "",
              saved: d.text ?? "",
              truncated: Boolean(d.truncated),
              version: d.version ?? null,
              err: null,
            }
          : { ...prev, err: d.error ?? "That document could not be read." }
        : prev,
    );
  });

  useFetcherResult(saveFetcher, (d) => {
    if (d.ok) {
      setConfirmReplace(false);
      setDoc(null);
      onSaved(d.toast ?? "Document saved");
      return;
    }
    // UI-60: keep the draft. The typed body is the only copy that exists.
    setConfirmReplace(false);
    setDoc((prev) =>
      prev ? { ...prev, err: d.error ?? "The document was not saved." } : prev,
    );
  });

  const openNew = (dir: string[]) =>
    setDoc({
      dir,
      name: "",
      body: "",
      existing: false,
      saved: null,
      truncated: false,
      version: null,
      view: "raw",
      err: null,
    });

  const openExisting = (dir: string[], name: string) => {
    setDoc({
      dir,
      name,
      body: "",
      existing: true,
      saved: null,
      truncated: false,
      version: null,
      view: isMarkdownName(name) ? "preview" : "raw",
      err: null,
    });
    readFetcher.submit(
      {
        _csrf: csrf,
        intent: "store-read-doc",
        kind: resource.kind,
        id: resource.id,
        path: JSON.stringify([...dir, name]),
      },
      { method: "post", action: STORE_ACTION },
    );
  };

  const save = (overwrite: boolean) => {
    if (!doc || saving) return;
    const fields: DocSaveFields = {
      _csrf: csrf,
      intent: "store-write-doc",
      kind: resource.kind,
      id: resource.id,
      path: JSON.stringify(doc.dir),
      name: doc.name.trim(),
      body: doc.body,
    };
    // Only a confirmed replace carries the field: the action reads it as
    // `overwrite === "1"`, so it is sent or absent, never blank.
    if (overwrite) fields.overwrite = "1";
    // Ruling 663: an opened document is saved against the version it read.
    if (doc.version) fields.version = doc.version;
    saveFetcher.submit(fields, { method: "post", action: STORE_ACTION });
  };

  return {
    doc,
    setDoc,
    loading,
    saving,
    confirmReplace,
    setConfirmReplace,
    openNew,
    openExisting,
    save,
  };
}

/** Nested "this file already exists" confirm — its own native <dialog> (the
 *  shared `ConfirmDialog`, ruling 458(f)), so it stacks over the browser card
 *  exactly like the delete confirm (UI-59). */
function ReplaceConfirm({
  path,
  onCancel,
  onConfirm,
}: {
  path: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      screenLabel="Replace document dialog"
      className="over-modal"
      title={`Replace “${path}”?`}
      body={
        <>
          A document with that name is already in the store. Saving overwrites its
          contents: the old text is gone, and agents load the new text on their
          next context load.
        </>
      }
      confirmLabel="Replace document"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** Lines as the attachment reader's gutter counts them (ruling 363): a
 *  trailing newline ends the last line rather than opening an empty one. */
function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split(/\r\n|\r|\n/);
  return lines.length > 1 && lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/**
 * Ruling 614: the open document is one card. The head names the file and, for
 * markdown, carries the Preview / Raw switch; the body is the rendered document
 * or its raw text; the foot says what state the text is in, beside Close (or
 * Cancel) and Save. It replaces a path line over a "Document contents" label, a
 * bare textarea with a resize grip, and a hint that printed "/".
 *
 * In Raw the card is the field, as the controller composer is (owner,
 * 2026-09-25: a square ring inside a rounded frame, and a resize grip, read as
 * unfinished): the textarea draws no frame of its own and the card takes the
 * focus ring.
 */
function DocumentCard({
  doc,
  sizeBytes,
  saving,
  nameRef,
  nameInvalid,
  refusal,
  onEdit,
  onCancel,
  onSave,
}: {
  doc: DocDraft;
  /** The file's size as the tree lists it; null for a new document. */
  sizeBytes: number | null;
  saving: boolean;
  nameRef: RefObject<HTMLInputElement | null>;
  /** Ruling 147: a refused save of a nameless draft marks the name field. */
  nameInvalid: boolean;
  /** The refusal counter the alert is keyed on, and its one shake (451(g)). */
  refusal: { count: number; shake: RefusalShake };
  onEdit: (next: DocDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  /** An existing document whose read has not answered, or failed. */
  const unread = doc.existing && doc.saved === null;
  /** Ruling 147(d): an opened document saves only once its text changed. */
  const changed = doc.existing && doc.saved !== null && doc.body !== doc.saved;
  const fileName = doc.existing ? doc.name : draftFileName(doc.name);
  // A nameless draft is markdown until it is named otherwise: the server
  // saves a bare name as `.md`.
  const markdown = doc.existing || doc.name.trim() ? isMarkdownName(fileName) : true;
  const view: DocView = markdown ? doc.view : "raw";
  const meta =
    doc.saved === null
      ? ""
      : [
          doc.truncated ? null : countLabel(lineCount(doc.saved), "line"),
          sizeBytes === null ? null : prettySize(sizeBytes),
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <section className="fm-doc" aria-label={doc.existing ? doc.name : "New document"}>
      <div className="doc-head">
        <span className="doc-glyph">
          <Icon name="file" />
        </span>
        <span
          className="doc-path"
          title={doc.existing ? [...doc.dir, doc.name].join("/") : undefined}
        >
          {doc.dir.map((segment, i) => (
            <Fragment key={i}>
              <span>{segment}</span>
              <span className="dp-sep">/</span>
            </Fragment>
          ))}
          {doc.existing ? (
            <span className="dp-name">{doc.name}</span>
          ) : (
            <span className="doc-title">New document</span>
          )}
        </span>
        {markdown && !(unread && doc.err) && (
          <DocViewToggle view={view} onChange={(next) => onEdit({ ...doc, view: next })} />
        )}
      </div>
      {!doc.existing && (
        /* Ruling 149: the name is a typing control in the sheet's own field
           chrome, with its visible label, laid out as the card's first row. */
        <div className="field doc-name">
          <label className="flabel" htmlFor="fm-doc-name">
            File name
          </label>
          <input
            ref={nameRef}
            id="fm-doc-name"
            type="text"
            className="mono"
            value={doc.name}
            placeholder="file-name.md"
            aria-invalid={nameInvalid || undefined}
            aria-describedby={nameInvalid ? "fm-doc-err" : undefined}
            onChange={(e) => onEdit({ ...doc, name: e.target.value, err: null })}
          />
        </div>
      )}
      {doc.truncated && (
        <div className="doc-notes">
          <div className="cred-warn">
            <Icon name="alert" />
            This document is larger than the editor can load, so only the
            first part is shown. Saving would destroy the rest. Edit it on
            disk instead.
          </div>
        </div>
      )}
      {unread ? (
        doc.err ? (
          <div className="doc-blank" role="alert">
            <Icon name="alert" />
            {doc.err}
          </div>
        ) : (
          <div className="doc-blank">
            <Icon name="loader" className="spin" />
            Loading document…
          </div>
        )
      ) : view === "preview" ? (
        doc.body.trim() ? (
          /* Scrolls on its own, so it takes focus and a name: a keyboard
             reaches all of a long document (WCAG 2.1.1). */
          <div
            className="doc-preview"
            tabIndex={0}
            role="region"
            aria-label={
              "Preview of " +
              (doc.existing || doc.name.trim() ? fileName : "the new document")
            }
          >
            <MarkdownDoc text={doc.body} />
          </div>
        ) : (
          <p className="doc-blank">
            {doc.existing ? "This document is empty." : "Nothing to preview yet."}
          </p>
        )
      ) : (
        <>
          <label className="vh" htmlFor="fm-doc-body">
            Document contents
          </label>
          <textarea
            id="fm-doc-body"
            className="doc-src"
            // Where `field-sizing` is unsupported the rows size it; the sheet
            // caps both at the preview's height.
            rows={Math.min(24, Math.max(8, lineCount(doc.body) + 1))}
            value={doc.body}
            placeholder={"# Title\n\nWhat your agents must know."}
            onChange={(e) => onEdit({ ...doc, body: e.target.value, err: null })}
          />
        </>
      )}
      {/* One box, never two: a refused save speaks in the same slot the
          server's own sentence uses (ruling 147). A read that failed says so
          in the body instead. */}
      {(nameInvalid || (doc.err && !unread)) && (
        <div className="doc-notes">
          {nameInvalid ? (
            <div
              key={`refused-${refusal.count}`}
              id="fm-doc-err"
              className={"form-err" + (refusal.shake.shake ? " refused" : "")}
              onAnimationEnd={refusal.shake.onAnimationEnd}
              role="alert"
            >
              <Icon name="alert" />
              Give the document a file name.
            </div>
          ) : (
            <div className="form-err">
              <Icon name="alert" />
              {doc.err}
            </div>
          )}
        </div>
      )}
      <div className="doc-foot">
        <span className="doc-state">
          {changed ? (
            <>
              <span className="doc-dot" />
              Unsaved changes
            </>
          ) : (
            meta
          )}
        </span>
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          {doc.existing && !changed ? "Close" : "Cancel"}
        </button>
        <button
          type="button"
          className="btn sm primary"
          // Ruling 147: the in-flight states, the truncated hard block (a
          // data-safety refusal whose reason is rendered above) and, for an
          // opened document, nothing changed (147(d)) disable this; a
          // nameless draft is refused instead.
          disabled={doc.truncated || saving || unread || (doc.existing && !changed)}
          aria-busy={saving}
          onClick={onSave}
        >
          {saving ? "Saving…" : "Save document"}
        </button>
      </div>
    </section>
  );
}

export function StoreBrowser({
  title,
  subMono,
  metaTail,
  tree,
  resource,
  onClose,
  initialDoc,
}: {
  title: string;
  subMono: string;
  /** Ruling 480: a node, so a "when" in it renders hydration-safe
   *  (`RelativeStamp`) rather than as a clock-read string. */
  metaTail?: ReactNode;
  tree: StoreNode[];
  resource: StoreBrowserResource;
  onClose: () => void;
  /** Ruling 483: a document to open on arrival (a store-relative path), for
   *  the link a knowledge-base proposal carries to the document it stands in. */
  initialDoc?: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () =>
      new Set(
        tree.flatMap((n) => (n.type === "dir" ? [n.name] : [])),
      ),
  );
  const [newIn, setNewIn] = useState<string[] | null>(null);
  /** Store-relative folder every toolbar action writes into (P14-KM-08). */
  const [dest, setDest] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{
    path: string[];
    node: StoreNode;
  } | null>(null);

  const nodes = tree;
  const toggle = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const expand = (path: string[]) =>
    setExpanded((s) => {
      const n = new Set(s);
      for (let i = 1; i <= path.length; i++) n.add(path.slice(0, i).join("/"));
      return n;
    });

  const ops = useStoreOps(resource, expand);
  const push = useToast();
  const editor = useDocEditor(resource, (toast) => {
    push(toast);
    expand(dest);
  });
  // Ruling 147: Save document stays enabled on a nameless draft and refuses the
  // click with the sentence `writeStoreDoc` would have thrown. Counted, so a
  // repeated press inserts a fresh alert; cleared wherever a draft opens or
  // closes, so a new document is never accused before it is submitted.
  const [refusedDoc, setRefusedDoc] = useState(0);
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const docShake = useRefusalShake(refusedDoc);
  const docNameRef = useRef<HTMLInputElement>(null);

  /** Pick the destination folder AND reveal it, so the two never disagree. */
  const target = (path: string[]) => {
    setDest(path);
    expand(path);
  };

  // Ruling 483: arriving from a proposal's "Open document", the document it
  // stands in opens once, the way a click on its row would open it. The ref
  // makes it once: a later render must not reopen a document a person closed.
  const openedInitial = useRef(false);
  useEffect(() => {
    if (!initialDoc || openedInitial.current) return;
    openedInitial.current = true;
    const parts = initialDoc.split("/").filter(Boolean);
    const name = parts.pop();
    if (!name) return;
    expand(parts);
    editor.openExisting(parts, name);
  }, [initialDoc, editor, expand]);

  // ---- GitHub-import feedback: lives here (not in the hook) because a
  // successful import expands the tree state this component owns.
  const { ghFetcher, dispatchGh } = ops;
  useFetcherResult(ghFetcher, (d) => {
    if (d.ok) {
      if (d.toast) push(d.toast);
      if (d.folder) {
        // The destination is store-relative now, so every ancestor of the
        // imported folder has to open for it to be visible (P14-KM-08).
        const parts = d.folder.split("/");
        setExpanded(
          (s) =>
            new Set([
              ...s,
              ...parts.map((_, i) => parts.slice(0, i + 1).join("/")),
            ]),
        );
      }
      dispatchGh({ type: "reset" });
    } else if (d.error) {
      dispatchGh({ type: "err", err: d.error });
    }
  });

  // ---- layered close on the native <dialog>: the nested DeleteConfirm is
  // topmost while open, so its own `cancel` handles that layer; here an
  // open new-folder input consumes the dismiss (onDismissRequest → true, no
  // exit animation) before the modal itself closes.
  const { ref: dialogRef, close } = useDialog(onClose, () => {
    if (newIn) {
      setNewIn(null);
      return true;
    }
    // An open editor holds unsaved text, so Escape closes the editor, not the
    // browser under it (P14-UI-60 — losing the draft to a stray Escape is the
    // same data loss as losing it to a rejected save).
    if (editor.doc) {
      editor.setDoc(null);
      return true;
    }
    return false;
  });

  const createFolder = (path: string[], name: string) => {
    const trimmed = (name || "").trim();
    setNewIn(null);
    if (!trimmed) return;
    ops.submitFields({ intent: "store-mkdir", path: JSON.stringify(path), name: trimmed });
    expand([
      ...path,
      ...trimmed.split("/").flatMap((s) => {
        const part = s.trim().replace(/\\/g, "-");
        return part ? [part] : [];
      }),
    ]);
  };

  const removeNode = (path: string[], node: StoreNode) => {
    ops.submitFields({
      intent: "store-delete",
      path: JSON.stringify([...path, node.name]),
    });
    // No setConfirm(null): the confirm plays its exit, then its onCancel
    // clears it (ruling 459).
  };

  const nFiles = countKbFiles(nodes);
  const nDirs = countKbDirs(nodes);
  const folders = folderPaths(nodes);
  const { doc } = editor;
  /** Ruling 147: set only after a refused save, and only while the draft is
   *  still nameless, so typing clears the mark. */
  const docNameInvalid =
    refusedDoc > 0 && doc !== null && !doc.existing && !doc.name.trim();
  /** Does a file with the draft's name already sit in the destination folder? */
  const draftCollides = (draft: DocDraft): boolean => {
    const wanted = draftFileName(draft.name);
    return childrenAt(nodes, draft.dir).some(
      (n) => n.type === "file" && n.name === wanted,
    );
  };

  return (
    <>
      <dialog
        ref={dialogRef}
        className="modal-card modal-wide"
        aria-label={"Files · " + title}
        data-screen-label={"Files · " + title}
        inert={confirm !== null || editor.confirmReplace}
      >
        <div className="modal-head">
          <span className="conn-ico">
            <Icon name="memory" />
          </span>
          <span className="mh-main">
            <h2>{title}</h2>
            <div className="mh-sub mono">{subMono}</div>
          </span>
          <button type="button" className="icon-btn modal-close" onClick={close} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          <BrowserToolbar
            gh={ops.gh}
            dispatchGh={ops.dispatchGh}
            importing={ops.importing}
            dest={dest}
            folders={folders}
            rootLabel={title}
            onDest={target}
            onImport={() => ops.ghImport(dest)}
            onUploadFiles={() => ops.startUpload(dest)}
            onUploadFolder={() => ops.startDirUpload(dest)}
            onNewFolder={() => setNewIn(dest)}
            onNewDoc={() => {
              setRefusedDoc(0);
              editor.openNew(dest);
            }}
          />

          {doc && (
            <DocumentCard
              doc={doc}
              sizeBytes={doc.existing ? fileSize(nodes, doc.dir, doc.name) : null}
              saving={editor.saving}
              nameRef={docNameRef}
              nameInvalid={docNameInvalid}
              refusal={{ count: refusedDoc, shake: docShake }}
              onEdit={editor.setDoc}
              onCancel={() => {
                setRefusedDoc(0);
                editor.setDoc(null);
              }}
              onSave={() => {
                if (editor.saving || editor.loading) return;
                if (!doc.existing && !doc.name.trim()) {
                  setRefusedDoc((n) => n + 1);
                  docNameRef.current?.focus();
                  return;
                }
                // UI-59: a new document that would land on an existing file
                // asks first. Saving an OPENED document is already an
                // explicit edit of that file, so it replaces directly.
                if (!doc.existing && draftCollides(doc)) {
                  editor.setConfirmReplace(true);
                  return;
                }
                editor.save(doc.existing);
              }}
            />
          )}

          <StoreTree
            nodes={nodes}
            expanded={expanded}
            newIn={newIn}
            onToggle={toggle}
            onStartNew={(path) => {
              target(path);
              setNewIn(path);
            }}
            onDismissNew={() => setNewIn(null)}
            onCreateFolder={createFolder}
            onStartUpload={(path) => {
              target(path);
              ops.startUpload(path);
            }}
            onOpenDoc={(dir, name) => {
              setRefusedDoc(0);
              editor.openExisting(dir, name);
            }}
            onDelete={(path, node) => setConfirm({ path, node })}
            onUploadEntries={ops.submitUpload}
          />
          {ops.uploadBusy && (
            <div className="def-note" aria-live="polite">
              <Icon name="refresh" />
              <span>
                Uploading {ops.uploading} file{ops.uploading === 1 ? "" : "s"}…
              </span>
            </div>
          )}
          <div className="def-note">
            <Icon name="file" />
            <span>
              This is the real folder on disk. Files added outside Viberr appear
              after the next re-scan. Deleting here deletes from the store.
            </span>
          </div>
        </div>
        <div className="modal-foot">
          <span className="foot-hint mono">
            {countLabel(nDirs, "folder") + " · " + countLabel(nFiles, "file")}
            {metaTail ? <> · {metaTail}</> : null}
          </span>
          <span className="foot-actions">
            <button type="button" className="btn" onClick={close}>
              Done
            </button>
          </span>
        </div>
        <input
          ref={ops.fileRef}
          type="file"
          multiple
          className="file-input"
          onChange={ops.onFiles}
          aria-hidden="true"
          tabIndex={-1}
        />
        <input
          ref={ops.dirRef}
          type="file"
          // @ts-expect-error non-standard folder-picker attributes (mock parity)
          webkitdirectory=""
          directory=""
          multiple
          className="file-input"
          onChange={ops.onDirFiles}
          aria-hidden="true"
          tabIndex={-1}
        />
      </dialog>
      {confirm && (
        <DeleteConfirm
          node={confirm.node}
          onCancel={() => setConfirm(null)}
          onConfirm={() => removeNode(confirm.path, confirm.node)}
        />
      )}
      {editor.confirmReplace && doc && (
        <ReplaceConfirm
          path={[...doc.dir, doc.name.trim()].join("/")}
          onCancel={() => editor.setConfirmReplace(false)}
          onConfirm={() => editor.save(true)}
        />
      )}
    </>
  );
}

/** Every folder in the tree as a store-relative path, depth-first (the
 *  destination picker's options). */
function folderPaths(nodes: StoreNode[], base: string[] = []): string[][] {
  const out: string[][] = [];
  for (const node of nodes) {
    if (node.type !== "dir") continue;
    const path = [...base, node.name];
    out.push(path);
    out.push(...folderPaths(node.children, path));
  }
  return out;
}

/** The entries directly inside `dir` ([] = the store root). */
function childrenAt(nodes: StoreNode[], dir: string[]): StoreNode[] {
  let level = nodes;
  for (const segment of dir) {
    const next = level.find((n) => n.type === "dir" && n.name === segment);
    if (!next || next.type !== "dir") return [];
    level = next.children;
  }
  return level;
}

/** A file's size as the scanned tree lists it; null when the tree does not. */
function fileSize(nodes: StoreNode[], dir: string[], name: string): number | null {
  const file = childrenAt(nodes, dir).find((n) => n.type === "file" && n.name === name);
  return file?.type === "file" ? file.sizeBytes : null;
}
