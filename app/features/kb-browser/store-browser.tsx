import {
  Fragment,
  useEffect,
  useReducer,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import { useFetcher } from "react-router";
import { countLabel } from "~/shared/text/plural";
import { STORE_TEXT_EXTENSIONS } from "~/shared/text/store-extensions";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useRelativeTime } from "~/ui/use-relative-time";
import { FolderIco, FolderUpIco, UploadIco } from "./icons";
import {
  entriesFromDataTransfer,
  entriesFromFileList,
  type UploadSelection,
} from "./local-files";
import {
  countKbDirs,
  countKbFiles,
  flatten,
  prettySize,
  type StoreNode,
} from "./tree";
import { useRefusalShake } from "~/ui/use-refusal-shake";

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
          <UploadIco />
          Upload files
        </button>
        <button type="button" className="btn sm" onClick={onUploadFolder}>
          <FolderUpIco />
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
          <FolderIco />
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
            <Icon
              name={importing ? "refresh" : "arrow"}
              className={importing ? "spin" : ""}
            />
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
    // it carries no role, tabIndex or handler, so it must not offer a real
    // row's hand cursor and hover fill (`.editing` drops both, `.dir` keeps the
    // folder glyph's weight).
    <div
      className="fm-row dir editing"
      style={{ paddingLeft: `${0.6 + depth * 1.3}rem` }}
    >
      <span className="twist"></span>
      <FolderIco />
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
              role={activate ? "button" : undefined}
              tabIndex={activate ? 0 : undefined}
              aria-expanded={r.node.type === "dir" ? r.open : undefined}
              aria-label={openable ? "Open " + r.node.name : undefined}
              onClick={activate}
              onKeyDown={
                activate
                  ? (e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        activate();
                      }
                    }
                  : undefined
              }
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
              <span className="twist">
                {r.node.type === "dir" && (
                  <Icon name="chevron" className={r.open ? "r90" : ""} />
                )}
              </span>
              {r.node.type === "dir" ? (
                <FolderIco open={r.open} />
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
              {/* Row actions are ALWAYS drawn (pass 16). `.fm-acts` faded them
                  in on `:hover`/`:focus-within`, which is a mouse-only reveal —
                  and `opacity: 0` does not remove hit-testing, so on a touch
                  device these buttons were invisible but still tappable: a tap
                  near the right edge of a row could hit Delete with nothing on
                  screen to explain it. `.rsrc-acts` is the always-visible row-
                  action wrapper the org-settings resource rows already use, so
                  this is also the app's one row-action shape rather than a
                  third. (`.fm-acts` has since been deleted from app.css, P16-UI-25.) */}
              <span className="rsrc-acts" onClick={(e) => e.stopPropagation()}>
                {r.node.type === "dir" && (
                  <>
                    <button
                      type="button"
                      className="fm-act"
                      title="Upload here"
                      aria-label={"Upload into " + r.node.name}
                      onClick={() => onStartUpload([...r.path, r.node.name])}
                    >
                      <UploadIco />
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
 * ruling 455(f)) — showModal stacking makes it the topmost layer, so its
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
  /** `store-import-github`: the store-relative folder the snapshot landed in. */
  folder?: string;
  error?: string;
}

/**
 * All store mutations behind the modal: the two fetcher POSTs to the
 * org-settings action (file ops + GitHub import), the file-ops toast
 * effect, and the hidden-input upload plumbing. The GitHub-import
 * feedback effect stays with the caller — it expands tree state the
 * caller owns.
 */
function useStoreOps(
  resource: StoreBrowserResource,
  action: string,
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
      { method: "post", action },
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
      action,
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
      { method: "post", action },
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
  /** The on-disk file exceeded the read cap, so this body is a partial copy. */
  truncated: boolean;
  err: string | null;
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
  action: string,
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
          ? { ...prev, body: d.text ?? "", truncated: Boolean(d.truncated), err: null }
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
    setDoc({ dir, name: "", body: "", existing: false, truncated: false, err: null });

  const openExisting = (dir: string[], name: string) => {
    setDoc({ dir, name, body: "", existing: true, truncated: false, err: null });
    readFetcher.submit(
      {
        _csrf: csrf,
        intent: "store-read-doc",
        kind: resource.kind,
        id: resource.id,
        path: JSON.stringify([...dir, name]),
      },
      { method: "post", action },
    );
  };

  const save = (overwrite: boolean) => {
    if (!doc || saving) return;
    const fields = {
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
    saveFetcher.submit(overwrite ? { ...fields, overwrite: "1" } : fields, {
      method: "post",
      action,
    });
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
 *  shared `ConfirmDialog`, ruling 455(f)), so it stacks over the browser card
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

export function StoreBrowser({
  title,
  subMono,
  metaTail,
  tree,
  resource,
  onClose,
  action = "/org/settings",
}: {
  title: string;
  subMono: string;
  metaTail?: string;
  tree: StoreNode[];
  resource: StoreBrowserResource;
  onClose: () => void;
  action?: string;
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

  const ops = useStoreOps(resource, action, expand);
  const push = useToast();
  const editor = useDocEditor(resource, action, (toast) => {
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
    setConfirm(null);
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
    const wanted = draft.name.trim().includes(".")
      ? draft.name.trim()
      : `${draft.name.trim()}.md`;
    return childNames(nodes, draft.dir).includes(wanted);
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
            <div className="fm-doc">
              {doc.existing ? (
                <div className="fm-doc-path mono">
                  {[...doc.dir, doc.name].join("/")}
                  {editor.loading ? " · loading…" : ""}
                </div>
              ) : (
                /* Ruling 149: both typing controls used to sit bare inside
                   `.fm-doc`, so they painted in UA chrome inside a card whose
                   every other control wears the sheet's. `.field` is the one
                   place that chrome is declared, and it brings a visible label
                   with it. */
                <div className="field">
                  <label className="flabel" htmlFor="fm-doc-name">
                    File name
                  </label>
                  <input
                    ref={docNameRef}
                    id="fm-doc-name"
                    type="text"
                    className="mono"
                    value={doc.name}
                    placeholder="file-name.md"
                    aria-invalid={docNameInvalid || undefined}
                    aria-describedby={docNameInvalid ? "fm-doc-err" : undefined}
                    onChange={(e) =>
                      editor.setDoc({ ...doc, name: e.target.value, err: null })
                    }
                  />
                </div>
              )}
              <div className="field">
                <label className="flabel" htmlFor="fm-doc-body">
                  Document contents
                </label>
                <textarea
                  id="fm-doc-body"
                  className="ta mono"
                  rows={10}
                  value={doc.body}
                  placeholder={"# Title\n\nWhat your agents must know."}
                  onChange={(e) =>
                    editor.setDoc({ ...doc, body: e.target.value, err: null })
                  }
                />
              </div>
              {doc.truncated && (
                <div className="cred-warn">
                  <Icon name="alert" />
                  This document is larger than the editor can load, so only the
                  first part is shown. Saving would destroy the rest. Edit it on
                  disk instead.
                </div>
              )}
              {/* One box, never two: a refused save speaks in the same slot the
                  server's own sentence uses (ruling 147). */}
              {docNameInvalid ? (
                <div
                  key={`refused-${refusedDoc}`}
                  id="fm-doc-err"
                  className={"form-err" + (docShake.shake ? " refused" : "")}
                  onAnimationEnd={docShake.onAnimationEnd}
                  role="alert"
                >
                  <Icon name="alert" />
                  Give the document a file name.
                </div>
              ) : (
                doc.err && (
                  <div className="form-err">
                    <Icon name="alert" />
                    {doc.err}
                  </div>
                )
              )}
              <div className="fm-doc-acts">
                <span className="fm-hint mono">
                  {(doc.dir.length > 0 ? doc.dir.join("/") + "/" : "/") +
                    (doc.existing ? "" : " · new document")}
                </span>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    setRefusedDoc(0);
                    editor.setDoc(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  // Ruling 147: only the in-flight states and the truncated
                  // hard block (a data-safety refusal whose reason is rendered
                  // above) disable this; a nameless draft is refused below.
                  disabled={doc.truncated || editor.saving || editor.loading}
                  aria-busy={editor.saving}
                  onClick={() => {
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
                >
                  {editor.saving ? "Saving…" : "Save document"}
                </button>
              </div>
            </div>
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
            {metaTail ? " · " + metaTail : ""}
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
          onConfirm={() => {
            editor.setConfirmReplace(false);
            editor.save(true);
          }}
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

/** File names directly inside `dir` ([] = the store root). */
function childNames(nodes: StoreNode[], dir: string[]): string[] {
  let level = nodes;
  for (const segment of dir) {
    const next = level.find((n) => n.type === "dir" && n.name === segment);
    if (!next || next.type !== "dir") return [];
    level = next.children;
  }
  return level.flatMap((n) => (n.type === "file" ? [n.name] : []));
}
