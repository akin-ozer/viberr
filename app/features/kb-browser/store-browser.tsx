import {
  Fragment,
  useEffect,
  useReducer,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import { useFetcher } from "react-router";
import { formatRelative } from "~/shared/dates/format";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { FolderIco, FolderUpIco, UploadIco } from "./icons";
import {
  entriesFromDataTransfer,
  entriesFromFileList,
  type UploadEntry,
} from "./local-files";
import {
  countKbDirs,
  countKbFiles,
  flatten,
  prettySize,
  type StoreNode,
} from "./tree";

/**
 * Store-folder file manager popup.
 *
 * - the tree comes from the loader (a real disk scan) and every mutation
 *   is a fetcher POST to the org-settings action → real fs write → the
 *   revalidated scan re-renders the tree; sizes/dates are formatted from
 *   sizeBytes/mtime at render time;
 * - GitHub import is the real snapshot action (default org connection);
 *   the honest "needs a connection" / failure states render in the
 *   `.cred-warn` under the import bar;
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

/** Toolbar row + the collapsible GitHub import bar and its error line. */
function BrowserToolbar({
  gh,
  dispatchGh,
  importing,
  onImport,
  onUploadFiles,
  onUploadFolder,
  onNewFolder,
  onNewDoc,
}: {
  gh: GhImportState;
  dispatchGh: (action: GhImportAction) => void;
  importing: boolean;
  onImport: () => void;
  onUploadFiles: () => void;
  onUploadFolder: () => void;
  onNewFolder: () => void;
  onNewDoc: () => void;
}) {
  return (
    <>
      <div className="fm-toolbar">
        <button type="button" className="btn sm" onClick={onUploadFiles}>
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
            style={importing ? { opacity: 0.6 } : undefined}
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
        <div className="cred-warn">
          <Icon name="alert" />
          {gh.err}
        </div>
      )}
    </>
  );
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
  onDelete: (path: string[], node: StoreNode) => void;
  onUploadEntries: (
    path: string[],
    entries: UploadEntry[],
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
    void entriesFromDataTransfer(dt).then((entries) => {
      const mode = entries.some((x) => x.relPath.includes("/"))
        ? "folder"
        : "files";
      onUploadEntries(path, entries, mode);
    });
  };

  const rows = flatten(nodes, [], 0, expanded, []);

  const newFolderRow = (path: string[], depth: number) => (
    <div className="fm-row dir" style={{ paddingLeft: `${0.6 + depth * 1.3}rem` }}>
      <span className="twist"></span>
      <FolderIco />
      <input
        ref={newRef}
        className="fm-newinp mono"
        placeholder="folder name"
        aria-label="New folder name"
        onKeyDown={(e) => {
          if (e.key === "Enter")
            onCreateFolder(path, (e.target as HTMLInputElement).value);
          if (e.key === "Escape") {
            // preventDefault aborts the dialog's native close request, so
            // Escape here dismisses only this row — not the whole modal.
            e.preventDefault();
            e.stopPropagation();
            onDismissNew();
          }
        }}
        onBlur={(e) => {
          if (newIn) onCreateFolder(path, e.target.value);
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
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDropTgt(null);
        }
      }}
    >
      {newIn && newIn.length === 0 && newFolderRow([], 0)}
      {rows.map((r) => (
        <Fragment key={r.key + (r.node.type || "")}>
          <div
            className={
              "fm-row " +
              (r.node.type === "dir" ? "dir" : "file") +
              (dropTgt &&
              dropTgt ===
                (r.node.type === "dir" ? r.key : r.path.join("/"))
                ? " droptgt"
                : "")
            }
            style={{ paddingLeft: `${0.6 + r.depth * 1.3}rem` }}
            role={r.node.type === "dir" ? "button" : undefined}
            tabIndex={r.node.type === "dir" ? 0 : undefined}
            aria-expanded={r.node.type === "dir" ? r.open : undefined}
            onClick={r.node.type === "dir" ? () => onToggle(r.key) : undefined}
            onKeyDown={
              r.node.type === "dir"
                ? (e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onToggle(r.key);
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
                {countKbFiles(r.node.children) +
                  " file" +
                  (countKbFiles(r.node.children) === 1 ? "" : "s")}
              </span>
            ) : (
              <span className="fm-meta">
                {prettySize(r.node.sizeBytes)}
                {r.node.mtime ? " · " + formatRelative(r.node.mtime) : ""}
              </span>
            )}
            <span className="fm-acts" onClick={(e) => e.stopPropagation()}>
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
      ))}
      {rows.length === 0 && !newIn && (
        <div className="fm-empty">
          Empty — drag files or folders here, upload, or import from GitHub.
        </div>
      )}
    </div>
  );
}

/** Nested delete confirm on its OWN native <dialog> — showModal stacking
 * makes it the topmost layer, so its Escape/backdrop land here (useDialog),
 * not on the browser card underneath. */
function DeleteConfirm({
  node,
  onCancel,
  onConfirm,
}: {
  node: StoreNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { ref, close } = useDialog(onCancel);
  return (
    <dialog
      ref={ref}
      className="confirm-card"
      style={{ zIndex: 71 }}
      role="alertdialog"
      aria-labelledby="store-confirm-title"
      aria-describedby="store-confirm-desc"
    >
      <div className="confirm-icon">
        <Icon name="alert" />
      </div>
      <h3 id="store-confirm-title">
        Delete “{node.name}”
        {node.type === "dir" && countKbFiles(node.children) > 0
          ? " and its contents"
          : ""}
        ?
      </h3>
      <p>
        {node.type === "dir"
          ? countKbFiles(node.children) > 0
            ? countKbFiles(node.children) +
              " file" +
              (countKbFiles(node.children) === 1 ? "" : "s") +
              " inside will be removed from the store. Agents lose them on their next context load."
            : "The empty folder is removed from the store."
          : "The file is removed from the store. Agents lose it on their next context load."}
      </p>
      <div className="confirm-actions">
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn danger" onClick={onConfirm}>
          {node.type === "dir" ? "Delete folder" : "Delete file"}
        </button>
      </div>
    </dialog>
  );
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
  const opsFetcher = useFetcher<Record<string, unknown>>();
  const ghFetcher = useFetcher<Record<string, unknown>>();
  const [gh, dispatchGh] = useReducer(ghImportReducer, ghImportInitial);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string[]>([]);

  const importing = ghFetcher.state !== "idle";

  // ---- action feedback (toasts ride the server response).
  const handledOps = useRef<unknown>(null);
  useEffect(() => {
    if (opsFetcher.state !== "idle" || !opsFetcher.data) return;
    if (handledOps.current === opsFetcher.data) return;
    handledOps.current = opsFetcher.data;
    const d = opsFetcher.data as {
      ok?: boolean;
      toast?: string;
      captureToast?: string;
      error?: string;
    };
    if (d.ok) {
      if (d.toast) push(d.toast);
      if (d.captureToast) push(d.captureToast);
    } else if (d.error) {
      push(d.error);
    }
  }, [opsFetcher.state, opsFetcher.data, push]);

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
    entries: UploadEntry[],
    mode: "files" | "folder",
  ) => {
    if (entries.length === 0) return;
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

  const ghImport = () => {
    if (importing) return;
    if (!gh.url.trim()) {
      dispatchGh({
        type: "err",
        err: "Paste a GitHub link — a repo, or a folder like github.com/owner/repo/tree/main/docs.",
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
      },
      { method: "post", action },
    );
  };

  return {
    gh,
    dispatchGh,
    importing,
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
  /** The in-app document editor (P13-LV-06): `null` = closed. */
  const [doc, setDoc] = useState<{ name: string; body: string } | null>(null);
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

  // ---- GitHub-import feedback: lives here (not in the hook) because a
  // successful import expands the tree state this component owns.
  const push = useToast();
  const handledGh = useRef<unknown>(null);
  const { ghFetcher, dispatchGh } = ops;
  useEffect(() => {
    if (ghFetcher.state !== "idle" || !ghFetcher.data) return;
    if (handledGh.current === ghFetcher.data) return;
    handledGh.current = ghFetcher.data;
    const d = ghFetcher.data as {
      ok?: boolean;
      toast?: string;
      folder?: string;
      error?: string;
    };
    if (d.ok) {
      if (d.toast) push(d.toast);
      if (d.folder) {
        setExpanded((s) => new Set([...s, d.folder!]));
      }
      dispatchGh({ type: "reset" });
    } else if (d.error) {
      dispatchGh({ type: "err", err: d.error });
    }
  }, [ghFetcher.state, ghFetcher.data, push, dispatchGh]);

  // ---- layered close on the native <dialog>: the nested DeleteConfirm is
  // topmost while open, so its own `cancel` handles that layer; here an
  // open new-folder input consumes the dismiss (onDismissRequest → true, no
  // exit animation) before the modal itself closes.
  const { ref: dialogRef, close } = useDialog(onClose, () => {
    if (!newIn) return false;
    setNewIn(null);
    return true;
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

  return (
    <>
      <dialog
        ref={dialogRef}
        className="modal-card modal-wide"
        aria-label={"Files — " + title}
        data-screen-label={"Files — " + title}
        inert={confirm !== null}
      >
        <div className="modal-head">
          <span className="conn-ico" style={{ width: 34, height: 34, borderRadius: 10 }}>
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
            onImport={ops.ghImport}
            onUploadFiles={() => ops.startUpload([])}
            onUploadFolder={() => ops.startDirUpload([])}
            onNewFolder={() => setNewIn([])}
            onNewDoc={() => setDoc({ name: "", body: "" })}
          />

          {doc && (
            <div className="fm-doc">
              <input
                type="text"
                className="mono"
                value={doc.name}
                placeholder="file-name.md"
                aria-label="Document file name"
                onChange={(e) => setDoc({ ...doc, name: e.target.value })}
              />
              <textarea
                className="ta mono"
                rows={10}
                value={doc.body}
                placeholder={"# Title\n\nWhat your agents must know."}
                aria-label="Document contents"
                onChange={(e) => setDoc({ ...doc, body: e.target.value })}
              />
              <div className="fm-doc-acts">
                <button type="button" className="btn ghost sm" onClick={() => setDoc(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={!doc.name.trim()}
                  onClick={() => {
                    ops.submitFields({
                      intent: "store-write-doc",
                      path: JSON.stringify([]),
                      name: doc.name.trim(),
                      body: doc.body,
                    });
                    setDoc(null);
                  }}
                >
                  Save document
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
              expand(path);
              setNewIn(path);
            }}
            onDismissNew={() => setNewIn(null)}
            onCreateFolder={createFolder}
            onStartUpload={ops.startUpload}
            onDelete={(path, node) => setConfirm({ path, node })}
            onUploadEntries={ops.submitUpload}
          />
          <div className="def-note">
            <Icon name="file" />
            <span>
              This is the real folder on disk — files added outside Viberr appear
              after the next re-scan. Deleting here deletes from the store.
            </span>
          </div>
        </div>
        <div className="modal-foot">
          <span className="foot-hint mono">
            {nDirs + " folder" + (nDirs === 1 ? "" : "s") + " · " + nFiles + " file" + (nFiles === 1 ? "" : "s")}
            {metaTail ? " · " + metaTail : ""}
          </span>
          <span className="foot-actions">
            <button type="button" className="btn primary" onClick={close}>
              Done
            </button>
          </span>
        </div>
        <input
          ref={ops.fileRef}
          type="file"
          multiple
          style={{ display: "none" }}
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
          style={{ display: "none" }}
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
    </>
  );
}
