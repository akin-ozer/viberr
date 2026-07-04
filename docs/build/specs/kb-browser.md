# Spec: Store-folder browser / KB browser (`app/features/org-admin/store-browser`)

Source of truth: `design/html-app/app/kb-browser.jsx` (390 lines, read in full).
Related: `design/html-app/app/org-settings.jsx` (the ONLY consumer — instantiates `StoreBrowser` twice and owns all the data), `design/html-app/app/ui.jsx` (`Icon`, toast `push`), `design/html-app/app/home.css` lines 412–450 (`.fm-*` class contract), `design/html-app/app/viberr.css` (modal/confirm/def-note contract).

Despite the filename, this file does **not** contain a KB-specific page. It is one generic, reusable **modal file manager for a folder in the file-native store** (`store://…`), used for both **knowledge bases** (`store://kb/<dir>/`) and **skills** (`store://skills/<name>/`). There is no content preview in the mock — clicking a file row does nothing (see §8 Open questions).

Mock exports (via `Object.assign(window, …)`): `StoreBrowser`, `countKbFiles`, `FolderIco`, `prettySize`.

---

## 1. Purpose & entry points

What it does (from the file header comment): "Visualizes a folder in the file-native store; upload files or whole folders (structure intact), drag & drop onto folders, import from a GitHub link, create nested folders, delete with approval."

**Entry points in the mock** — both inside org settings → Agent resources panel (`ResourcesPanel` in `org-settings.jsx`):

1. **Knowledge base browser.** Opened by clicking a KB's name (`.linkish` button) or its folder icon button (`title="Browse files"`, `aria-label="Browse files in {kb.name}"`). Instantiation (verbatim, org-settings.jsx:938):

```jsx
<StoreBrowser title={kb.name} root={"store://kb/" + dir}
  subMono={"store://kb/" + dir + "/ · re-index " + kb.refresh} metaTail={"indexed " + kb.last}
  tree={kb.tree || []} push={push}
  onChange={(tree) => patchOrg({ kbs: org.kbs.map((x) => (x.id === kb.id ? { ...x, tree, last: "just now" } : x)) })}
  onClose={() => setBrowsing(null)} />
```

where `dir = kb.dir || slugify(kb.name)`.

2. **Skill browser.** Same triggers on skill rows. Instantiation (verbatim, org-settings.jsx:948):

```jsx
<StoreBrowser title={sk.name} root={"store://skills/" + sk.name}
  subMono={"store://skills/" + sk.name + "/ · SKILL.md + supporting files"} metaTail={"updated " + sk.upd}
  tree={sk.tree || []} push={push} captureText="SKILL.md"
  onCaptureText={(text) => {
    patchOrg({ skills: org.skills.map((x) => (x.id === sk.id ? { ...x, body: text, upd: "just now" } : x)) });
    push("SKILL.md content captured — fully editable in the skill editor");
  }}
  onChange={(tree) => patchOrg({ skills: org.skills.map((x) => (x.id === sk.id ? { ...x, tree, upd: "just now" } : x)) })}
  onClose={() => setBrowsing(null)} />
```

**Real-app placement:** a shared component under `app/features/org-admin/` (or `app/ui/` if kept purely presentational with callbacks), rendered from the org-admin resources route. In the real app it should be backed by loader data (store scan projection) and actions (upload / mkdir / delete / import), not a client-held tree.

`StoreBrowser` props contract:

| Prop | Type | Meaning |
|---|---|---|
| `title` | string | Modal heading (KB display name or skill name) |
| `subMono` | string | Mono subtitle under heading (store path + policy blurb) |
| `root` | string | Store path prefix used in toast copy, e.g. `store://kb/api-contracts` (no trailing slash) |
| `metaTail` | string? | Appended to footer stats, e.g. `indexed Jul 1` / `updated Jun 12` |
| `tree` | Node[] | Current folder tree (see §3) |
| `onChange(tree)` | fn | Called with the **entire new tree** after any mutation |
| `onClose()` | fn | Dismiss the modal |
| `push(text)` | fn | Toast pusher from `useToasts()` (ui.jsx) |
| `captureText` | string? | Filename to watch for on root-level uploads/drops (`"SKILL.md"` for skills; unset for KBs) |
| `onCaptureText(text)` | fn? | Receives the text content of the captured file |

---

## 2. Component tree

- **`StoreBrowser(props)`** — the whole modal: scrim + wide modal card + toolbar + optional GitHub import bar + tree + footer + hidden file inputs + nested delete-confirm dialog.
- **`FolderIco({ open })`** — local folder SVG icon, two path variants (open/closed). Exported; also used by org-settings row buttons.
- **`UploadIco()`** — local up-arrow-over-line upload icon (toolbar + per-row upload).
- **`FolderUpIco()`** — local folder-with-up-arrow icon ("Upload folder" toolbar button).
- Pure helpers (all module-level, no React):
  - **`countKbFiles(nodes)`** — recursive file count (dirs contribute their descendants). Exported; org-settings uses it for "N docs"/"N files" row subtitles and re-index toast.
  - **`countKbDirs(nodes)`** — recursive dir count (footer stats only).
  - **`mapAt(nodes, path, fn)`** — immutably applies `fn` to the children array at `path` (array of dir names).
  - **`prettySize(bytes)`** — bytes → `"512 B" | "1.5 KB" | "2.0 MB"` display string. Exported; org-settings uses it to size a synthetic SKILL.md.
  - **`mergeNodes(existing, incoming)`** — merge by name: same-name dirs deep-merge, same-name anything-else is **replaced** by the incoming node.
  - **`buildFromPaths(files)`** — builds a Node tree from an `<input webkitdirectory>` FileList using `webkitRelativePath`; **skips any path with a dot-prefixed segment** (`.DS_Store`, `.git/…`).
  - **`entryToNode(entry)`** — async walk of a dropped `FileSystemEntry` (supports whole folders via `createReader().readEntries` batching); skips dot-entries; resolves `null` for unknown kinds.
  - **`flatten(nodes, path, depth, expanded, out)`** — produces visible rows: **dirs first, then files, both in insertion order (no alphabetical sort)**; recurses only into expanded dirs. Row shape: `{ node, path, depth, key, open? }` where `key` is the slash-joined path.

There is no virtualization, no context menu, no rename, no move, no file preview.

---

## 3. Data consumed

### 3.1 Tree node shape (the core contract)

```js
// dir
{ type: "dir", name: "decisions", children: [ …Node ] }
// file
{ type: "file", name: "adr-001-task-store.md", size: "4.2 KB", added: "Mar 30" }
```

Critical detail: **`size` and `added` are pre-formatted display strings in the mock**, not numbers/dates. `prettySize` is applied at upload time and the string is stored. `added` values seen: `"Mar 30"`, `"Jun 9"`, `"just now"`. In the real app the projection should carry `sizeBytes: number` and `addedAt/mtime: ISO string` and the component should format at render time (`prettySize(sizeBytes)` + relative/short date).

`children` may be missing/undefined on dirs in edge paths — every consumer guards with `n.children || []`. Files never have `children`.

### 3.2 Owner records (held by org-settings, NOT read by StoreBrowser directly)

Not in `data.js` — the mock's KB/skill data lives in `ORG_DEFAULTS` in `org-settings.jsx`, persisted to `localStorage["viberr:org:v10"]` via `loadOrg()`/`saveOrg()`.

```js
// KB (org-settings.jsx ORG_DEFAULTS.kbs[])
{ id: "kb-arch", name: "Architecture notes", dir: "architecture-notes",
  refresh: "on change" /* | "nightly" */, last: "Jul 1" /* display string */, tree: [ …Node ] }

// Skill (ORG_DEFAULTS.skills[])
{ id: "sk-2", name: "terraform-review", summary: "Module review checklist: …",
  upd: "Jun 12", body: "## Review checklist\n…" /* markdown, mirrors SKILL.md */, tree: [ …Node ] }
```

### 3.3 Where each piece must come from in the real app

| Mock source | Real source |
|---|---|
| `kb.tree` / `sk.tree` (localStorage org blob) | **Loader: store scan projection.** The store directory (`store://kb/<dir>/`, `store://skills/<name>/`) is scanned server-side (files are canonical truth per CONVENTIONS); loader returns the node tree with `sizeBytes` + `mtime`. Do not persist trees in SQLite as truth — project from the filesystem. |
| `kb.{id,name,dir,refresh,last}` / `sk.{id,name,summary,upd,body}` | SQLite org-resource tables (projections of resource definition files, per the file-native model), joined in the org-admin loader. |
| `root` / `subMono` strings | Derived server-side from resource record (`store://kb/${dir}`), passed as props. |
| `push` (toast) | Real toast system (`useToasts`/`ToastHost` port) fed by action results (fetcher data), not optimistic client math. |
| `window.VIBERR` globals | None consumed by this file — it is self-contained apart from `Icon` (ui.jsx) and `React` globals. |
| Session | Not read in the mock. Real app: org-admin authorization on the route + on every action. |
| Env | Store root path (server config) to resolve `store://` to disk. |

### 3.4 Icons consumed from `ui.jsx` `Icon`

`memory` (header), `x` (close, delete, confirm-cancel row act), `github`, `refresh` (importing spinner), `arrow` (Import), `alert` (GH error + confirm dialog), `chevron` (twisty, rotated via `.r90`), `file` (file rows + def-note), `plus` (new subfolder).

Local SVGs that must be ported with the component (verbatim, kb-browser.jsx:8–34):

```jsx
function FolderIco({ open }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open
        ? <path d="M3.5 8V6.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2V10M3.5 8h16.2l-1.6 9a2 2 0 0 1-2 1.6H6.6a2 2 0 0 1-2-1.6z" />
        : <path d="M3.5 7a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />}
    </svg>
  );
}
function UploadIco() {
  return (
    <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 16V5M7.5 9L12 4.5 16.5 9M5 19.5h14" />
    </svg>
  );
}
function FolderUpIco() {
  return (
    <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 7a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      <path d="M12 16v-5.5M9.5 12.5L12 10l2.5 2.5" />
    </svg>
  );
}
```

---

## 4. UI states & interactions

### 4.1 Modal shell

- Scrim: `<div className="confirm-scrim" onClick={onClose}>` — click outside closes.
- Card: `<div className="modal-card modal-wide" role="dialog" aria-modal="true" aria-label={"Files — " + title} data-screen-label={"Files — " + title}>`.
- Header: memory icon in a `conn-ico` chip with inline `style={{ width: 34, height: 34, borderRadius: 10 }}`; `<h2>{title}</h2>`; `<div className="mh-sub mono">{subMono}</div>`; close button `className="icon-btn modal-close"` `aria-label="Close"` with `Icon x`.
- Footer: left stats `<span className="foot-hint mono">` = `"{nDirs} folder(s) · {nFiles} file(s)"` + optional `" · {metaTail}"` (singular/plural handled: `1 folder`, `2 folders`); right: single `<button className="btn primary" onClick={onClose}>Done</button>`.
- Below the tree, a persistent note:

```jsx
<div className="def-note">
  <Icon name="file" />
  <span>This is the real folder on disk — files added outside Viberr appear after the next re-scan. Deleting here deletes from the store.</span>
</div>
```

- **Keyboard:** window-level `keydown` listener; `Escape` → `onClose()`. NOTE: this fires even while the delete-confirm sub-dialog is open — Escape closes the *whole browser*, not just the confirm (mock quirk; fix in port, see §7).

### 4.2 Toolbar

```jsx
<div className="fm-toolbar">
  <button className="btn sm" onClick={() => startUpload([])}><UploadIco />Upload files</button>
  <button className="btn sm" onClick={() => startDirUpload([])}><FolderUpIco />Upload folder</button>
  <button className="btn sm" onClick={() => { setGhOpen((v) => !v); setGhErr(null); }}><Icon name="github" />Add from GitHub</button>
  <button className="btn ghost sm" onClick={() => setNewIn([])}><FolderIco />New folder</button>
  <span className="fm-hint">drag files or folders onto a folder to upload there</span>
</div>
```

- **Upload files** / **Upload folder** trigger two hidden inputs at the end of the card (verbatim — note the non-standard folder attributes):

```jsx
<input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={onFiles} aria-hidden="true" tabIndex={-1} />
<input ref={dirRef} type="file" webkitdirectory="" directory="" multiple style={{ display: "none" }} onChange={onDirFiles} aria-hidden="true" tabIndex={-1} />
```

  A `uploadTarget` ref (path array) remembers which folder the picker was opened for; per-row upload buttons reuse the same inputs. Input `value` is reset to `""` after each change so the same file can be re-picked.
- **Add from GitHub** toggles an inline import bar (`ghOpen`), clearing any previous error.
- **New folder** at root sets `newIn = []` (see 4.5).

### 4.3 GitHub import bar (`ghOpen === true`)

```jsx
<div className="fm-gh">
  <input type="text" className="mono" value={ghUrl} placeholder="https://github.com/owner/repo/tree/main/docs"
    onChange={(e) => { setGhUrl(e.target.value); setGhErr(null); }}
    onKeyDown={(e) => { if (e.key === "Enter") ghImport(); }} autoFocus />
  <button className="btn sm" onClick={ghImport} style={importing ? { opacity: .6, pointerEvents: "none" } : null}>
    <Icon name={importing ? "refresh" : "arrow"} className={importing ? "spin" : ""} />{importing ? "Importing…" : "Import"}
  </button>
</div>
```

- URL validation regex: `/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/[\w.-]+\/?(.*))?/` → captures owner, repo, optional subpath after branch.
- Invalid → error rendered below bar: `<div className="cred-warn"><Icon name="alert" />{ghErr}</div>` with copy: **"Paste a GitHub link — a repo, or a folder like github.com/owner/repo/tree/main/docs."**
- Valid → `importing` state for a fake 1100 ms, then inserts a new root-level dir named after the last subpath segment (or repo name, `.git` suffix stripped), with name-collision suffixing `folder-2`, `folder-3`, …; the dir contains four canned files (`README.md 3.1 KB`, `getting-started.md 6.4 KB`, `architecture.md 9.8 KB`, `api-reference.md 14.2 KB`, all `added: "just now"`). Bar closes, URL clears, new dir key added to `expanded`.
- Toast: **"4 files imported from {owner}/{repo}[/{subpath}] — snapshot, not a live sync"**.
- Mock bug: after a name collision the `expanded` set gets the *original* folder name, so a renamed `docs-2` import lands collapsed.

### 4.4 Tree view

Container:

```jsx
<div className={"fm-tree" + (dropTgt === "" ? " droptgt" : "")}
  onDragOver={(e) => overDir(e, "")}
  onDrop={(e) => dropInto(e, [])}
  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropTgt(null); }}>
```

Row (verbatim — this is the trickiest markup in the file):

```jsx
<div className={"fm-row " + (r.node.type === "dir" ? "dir" : "file") + (dropTgt && dropTgt === (r.node.type === "dir" ? r.key : r.path.join("/")) ? " droptgt" : "")}
  style={{ paddingLeft: (0.6 + r.depth * 1.3) + "rem" }}
  onClick={r.node.type === "dir" ? () => toggle(r.key) : undefined}
  onDragOver={(e) => overDir(e, r.node.type === "dir" ? r.key : r.path.join("/"))}
  onDrop={(e) => dropInto(e, r.node.type === "dir" ? [...r.path, r.node.name] : r.path)}>
  <span className="twist">
    {r.node.type === "dir" && <Icon name="chevron" className={r.open ? "r90" : ""} />}
  </span>
  {r.node.type === "dir" ? <FolderIco open={r.open} /> : <Icon name="file" />}
  <span className="fm-name">{r.node.name}</span>
  {r.node.type === "dir"
    ? <span className="fm-meta">{countKbFiles(r.node.children) + " file" + (countKbFiles(r.node.children) === 1 ? "" : "s")}</span>
    : <span className="fm-meta">{r.node.size}{r.node.added ? " · " + r.node.added : ""}</span>}
  <span className="fm-acts" onClick={(e) => e.stopPropagation()}>
    {r.node.type === "dir" && (
      <React.Fragment>
        <button className="fm-act" title="Upload here" aria-label={"Upload into " + r.node.name}
          onClick={() => startUpload([...r.path, r.node.name])}><UploadIco /></button>
        <button className="fm-act" title="New subfolder" aria-label={"New folder in " + r.node.name}
          onClick={() => { expand([...r.path, r.node.name]); setNewIn([...r.path, r.node.name]); }}><Icon name="plus" /></button>
      </React.Fragment>
    )}
    <button className="fm-act del" title="Delete" aria-label={"Delete " + r.node.name}
      onClick={() => askRemove(r.path, r.node)}><Icon name="x" /></button>
  </span>
</div>
```

Behavioral notes:

- Row React key is `r.key + (r.node.type || "")` — path + type, so a file and dir with the same name at the same level don't collide.
- **Indent is an inline style**, not a class: `paddingLeft = 0.6 + depth * 1.3` rem.
- **Expand/collapse:** clicking anywhere on a dir row toggles it (`toggle(key)`); chevron rotates via `.r90`; folder icon switches open/closed variant. Files are not clickable. Initial `expanded` state = all **top-level** dirs expanded, nested collapsed: `new Set(tree.filter(n => n.type === "dir").map(n => n.name))`.
- **Hover actions:** `.fm-acts` is `opacity: 0` until row hover or `:focus-within` (keyboard reachable). Dir rows get Upload-here + New-subfolder + Delete; file rows only Delete. The acts span stops click propagation so buttons don't toggle the dir.
- **Meta column:** dirs show recursive file count ("3 files", "1 file"); files show `"{size} · {added}"` (added omitted if falsy).
- **Ordering:** dirs before files at each level, otherwise insertion order — the mock never sorts alphabetically.

### 4.5 Drag & drop

- Only reacts when `e.dataTransfer.types` includes `"Files"` (`hasFiles`); DOM-node drags are ignored.
- `overDir(e, key)` sets `dropEffect = "copy"` and `dropTgt = key`. Keys: `""` = root (highlights whole `.fm-tree` via `.fm-tree.droptgt`), `"a/b"` = dir key (highlights that `.fm-row.droptgt`). **Dragging over a file row targets its parent folder** (`r.path.join("/")` — which for root-level files is `""`, i.e. whole-tree highlight).
- Drop resolution: `dropInto(e, path)` — for dir rows `path = [...r.path, r.node.name]`, for file rows `path = r.path` (parent).
- Uses `item.webkitGetAsEntry()` to support whole-folder drops; entries walked by `entryToNode` (dot-entries skipped). On any Promise rejection, falls back to the flat `e.dataTransfer.files` list added to the target path.
- Global cleanup: window `dragend` + `drop` listeners clear `dropTgt`; the tree's own `dragLeave` clears it only when the pointer truly leaves the tree (`!currentTarget.contains(relatedTarget)`).
- After a successful drop of N files: toast **"{N} file(s) added to {root}/{path}/"** — e.g. `3 files added to store://kb/api-contracts/endpoints/` (`atPath` = `[root, ...path].join("/") + "/"`). If a drop yields 0 files (e.g. only empty folders), no toast, but the dirs are still merged into the tree.

### 4.6 Uploads

- `addFiles(path, files)` (file-picker path): wraps each `File` as `{ type: "file", name, size: prettySize(f.size), added: "just now" }`, merges via `mergeIn` (which also auto-expands the target path and any top-level incoming dirs), toasts **"{N} file(s) added to {atPath}"**.
- `onDirFiles` (folder-picker path): builds tree from `webkitRelativePath`s, merges, toasts **"Folder “{names}” uploaded as-is — {N} file(s)"** where `{names}` is the comma-joined top-level folder names.
- Merge semantics (`mergeNodes`): same-name dir + dir → recursive merge; same-name anything else → **incoming replaces existing** (silent overwrite, no confirmation). Note this can replace a dir with a file if names collide across types.
- **SKILL.md capture:** when `captureText` is set and the upload/drop targets the **root** (`path.length === 0`), if a file named exactly `captureText` is present its text is read client-side (`file.text()`) and passed to `onCaptureText(text)`. The skill consumer then updates `sk.body` and toasts **"SKILL.md content captured — fully editable in the skill editor"**. Errors are swallowed (`catch(() => {})`).

### 4.7 New folder (inline input row)

- `newIn` = path array where a folder is being named (`[]` = root; `["a","b"]` = inside a/b). Only one at a time.
- Root variant renders as first row of the tree; nested variant renders immediately **after** the matching dir row at `depth + 1`. Verbatim (nested variant):

```jsx
{newIn && r.node.type === "dir" && newIn.join("/") === r.key && (
  <div className="fm-row dir" style={{ paddingLeft: (0.6 + (r.depth + 1) * 1.3) + "rem" }}>
    <span className="twist"></span><FolderIco />
    <input ref={newRef} className="fm-newinp mono" placeholder="folder name" aria-label="New folder name"
      onKeyDown={(e) => { if (e.key === "Enter") createFolder(newIn, e.target.value); if (e.key === "Escape") setNewIn(null); }}
      onBlur={(e) => createFolder(newIn, e.target.value)} />
  </div>
)}
```

- Input auto-focuses (effect on `newIn`). Enter or blur commits; Escape cancels (but see §4.1 — the global Escape handler also fires and closes the modal; the mock effectively closes everything).
- `createFolder(path, name)`:
  - Splits input on `/` — **`"a/b/c"` creates the nested chain** (mkdir -p semantics). Segments trimmed; backslashes replaced with `-`; empty segments dropped. Empty result = silent cancel.
  - If a **file** with a segment's name exists at that level: aborts that level with toast **"A file named “{h}” already exists here"** (existing dirs are reused, not duplicated).
  - Success toast: **"Folder {path/segs joined with "/"}/ ready"** (note: path segments only, no `store://` prefix — inconsistent with upload toasts).
  - New chain is auto-expanded.

### 4.8 Delete with confirmation

- Row delete button → `setConfirm({ path, node })` → nested confirm dialog above the modal (scrim/card get inline `zIndex: 70/71` to beat the browser modal's own scrim). Verbatim:

```jsx
<div className="confirm-scrim" style={{ zIndex: 70 }} onClick={() => setConfirm(null)}></div>
<div className="confirm-card" style={{ zIndex: 71 }} role="alertdialog" aria-modal="true">
  <div className="confirm-icon"><Icon name="alert" /></div>
  <h3>Delete “{confirm.node.name}”{confirm.node.type === "dir" && countKbFiles(confirm.node.children) > 0 ? " and its contents" : ""}?</h3>
  <p>{confirm.node.type === "dir"
    ? (countKbFiles(confirm.node.children) > 0
        ? countKbFiles(confirm.node.children) + " file" + (countKbFiles(confirm.node.children) === 1 ? "" : "s") + " inside will be removed from the store. Agents lose them on their next context load."
        : "The empty folder is removed from the store.")
    : "The file is removed from the store. Agents lose it on their next context load."}</p>
  <div className="confirm-actions">
    <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
    <button className="btn danger" onClick={() => removeNode(confirm.path, confirm.node)}>{confirm.node.type === "dir" ? "Delete folder" : "Delete file"}</button>
  </div>
</div>
```

- `removeNode` filters the parent's children by **identity OR name** (`n !== node && n.name !== node.name`) — effectively delete-by-name at that level. Toast: **"Folder “{name}” deleted"** / **"“{name}” deleted"**.

### 4.9 Empty state

When `rows.length === 0 && !newIn`:

```jsx
<div className="fm-empty">Empty — drag files or folders here, upload, or import from GitHub.</div>
```

The empty tree is still a valid drop target (handlers are on `.fm-tree`).

---

## 5. Events/mutations produced

In the mock, every mutation is: recompute tree client-side → `onChange(newTree)` → org-settings `patchOrg` → `localStorage["viberr:org:v10"]`, plus a toast. The KB's `last` / skill's `upd` field is bumped to `"just now"` by the consumer on every tree change. In the real app each becomes a server action against the store directory, followed by re-scan → projection update → SSE:

| Mock interaction | Real action | Suggested typed event(s) |
|---|---|---|
| Upload files (picker or drop) into `path` | `POST` multipart to org-admin resource action `upload` with `{ resourceKind: "kb"\|"skill", resourceId, path, files[] }`; server writes files under store dir (reject `..`/absolute paths, skip dotfiles), re-scans | audit event `resource.files-added { resourceId, path, count }`; SSE `projection.rebuilt` (or a dedicated `resource.updated`) |
| Upload whole folder (`webkitdirectory` or folder drop) | Same action; client sends each file's relative path so structure survives (multipart field name carries the relative path) | same as above |
| Create folder `a/b/c` | Action `mkdir { resourceId, path, name }` with mkdir -p semantics; reject if a file occupies a segment (return the "A file named …" message as action error → toast) | `resource.folder-created { resourceId, path }` |
| Delete file/dir (confirmed) | Action `delete { resourceId, path }`, recursive for dirs; server deletes from store dir | `resource.file-deleted` / `resource.folder-deleted { resourceId, path, filesRemoved }`; audit entry (destructive, org-admin) |
| GitHub import | Action `import-github { resourceId, url }`; server validates URL (same regex is a fine first pass), fetches repo/subtree **snapshot** (tarball via GitHub API using the org connection), writes under a collision-suffixed root folder, returns `{ folder, fileCount }` | `resource.imported { resourceId, source: "github", repo, path, fileCount }` |
| SKILL.md capture (`onCaptureText`) | **Server-side, not client-side**: after any upload into a skill's root that includes `SKILL.md`, the server re-reads it and updates the skill's `body` projection; no client `file.text()` | folded into `resource.files-added`; skill projection refresh |
| Consumer-side `last`/`upd` bump | Set from the re-scan timestamp in the projection, not client fiat | — |

All toast copy in §4 should be produced from action responses (so it reflects what actually happened, e.g. real imported-file counts instead of the hardcoded "4 files imported…").

---

## 6. CSS classes used (the contract)

Component-specific (defined in `home.css:412–450` — note: NOT in `viberr.css`; both stylesheets must be in scope):

- `fm-toolbar`, `fm-hint` — toolbar row + right-aligned hint.
- `fm-gh` (+ `input.mono`) — GitHub import bar.
- `fm-tree`, `fm-tree.droptgt` — bordered rounded list container + whole-tree drop highlight.
- `fm-row`, `fm-row.dir`, `fm-row.file`, `fm-row.droptgt` — rows; `.dir` gets pointer cursor + display-font bold name; `.file` gets mono small name; `+`-sibling hairline dividers.
- `twist` — 16px chevron slot (also rendered empty for files/new-folder rows to keep alignment).
- `fm-name`, `fm-meta` — ellipsized name + mono meta column.
- `fm-acts`, `fm-act`, `fm-act.del` — hover-revealed action cluster (`opacity:0` → row `:hover` / `:focus-within`).
- `fm-newinp` — inline new-folder input.
- `fm-empty` — empty-state line.
- `r90` (chevron rotation), `linkish` (consumer's name-as-button), `spin` (see §7 quirk).

Shared shell (in `viberr.css`): `confirm-scrim`, `modal-card modal-wide` (1060px wide variant), `modal-head`, `conn-ico`, `mh-main`, `mh-sub mono`, `icon-btn modal-close`, `modal-body`, `modal-foot`, `foot-hint mono`, `foot-actions`, `btn` (+ `sm`, `ghost`, `primary`, `danger`), `cred-warn`, `def-note`, `confirm-card`, `confirm-icon`, `confirm-actions`, `ico`, `mono`.

---

## 7. Porting notes

- **Replace the client-owned tree with loader data + actions.** The mock's `tree`/`onChange` prop pair becomes: loader returns the scanned tree; each mutation is a fetcher action; the tree re-renders from revalidated loader data (or SSE-pushed projection update). Keep the component's row-rendering pure so it works with either.
- **`size`/`added` become numbers/dates.** Port `prettySize` as a shared formatter (`app/shared/format.ts`); add a short-date/relative formatter for `added`. The projection ships `sizeBytes` + `mtime`.
- **`window` exports → ES module exports.** `StoreBrowser`, `countKbFiles`, `prettySize`, `FolderIco` are imported by the org-admin resources feature (row subtitles use `countKbFiles` and `FolderIco`; the skill editor uses `prettySize`).
- **Escape handling must be layered.** Mock quirk: the browser's window-level Escape closes the whole modal even while the delete-confirm is open, and the new-folder input's own Escape handler races it. Port with proper dialog stacking: Escape closes the topmost layer only (confirm → input → modal). Same for the hardcoded `zIndex: 70/71` inline styles — fold into dialog-layer CSS.
- **Focus management:** the mock has none (no focus trap, no focus restore, close button not auto-focused). Real app should use a proper dialog primitive while keeping the exact class names/markup inside.
- **`webkitdirectory` folder picker + `webkitGetAsEntry` drops are Chromium/WebKit-specific.** Keep the flat-file fallback path (`e.dataTransfer.files`) as the mock does; feature-detect and hide "Upload folder" if unsupported, or accept flat uploads.
- **Dotfile skipping** happens in two places (`buildFromPaths`, `entryToNode`) client-side; enforce it server-side too (never trust the client), along with path traversal rejection.
- **`.spin` doesn't actually animate here** — the only rule is `.store-strip .spin` in `home.css:282`, scoped to the home screen. The GH-import spinner icon gets `class="ico spin"` but no animation applies inside the modal. Port: make `.spin { animation: spin 1s linear infinite }` a global utility (the keyframes already exist).
- **GitHub import is entirely fake** (regex + 1100 ms `setTimeout` + 4 canned files). Real implementation: server-side snapshot fetch via the org's GitHub connection (Phase 7 dependency — until then, the action can return "not yet available" or the button can be hidden). Preserve the "snapshot, not a live sync" messaging.
- **`mergeNodes` silent overwrite**: uploading `foo.md` where `foo.md` exists replaces it with no warning, and a same-name file can replace a dir (type-blind name match). Decide: keep silent-replace for files (matches "real folder on disk" semantics of `cp`) but the server should never let a file clobber a directory — return an error toast instead.
- **Delete is by name at parent path** (`n !== node && n.name !== node.name`). Real action should address by full path.
- **GH-import expand bug** (collision-renamed folder stays collapsed) — fix by expanding the actual created name returned by the action.
- **`data-screen-label`** attributes are mock screenshot-tooling hooks; the shell spec's convention applies (keep or drop consistently with other ported surfaces).
- **`captureText`/`onCaptureText` moves server-side** (§5). The prop pair can disappear entirely from the ported component; the skill body refresh becomes a side effect of the upload action + projection reload.
- **Empty/error states:** empty tree copy in §4.9; GH URL error in §4.3; "file exists" mkdir error in §4.7. Add real-app-only states the mock lacks: upload-in-progress (mock is instant), action failure toasts (network/permission), and a "re-scan pending" hint tying into the def-note's "appear after the next re-scan" promise.
- The modal's toasts render via the org-settings page's `ToastHost` — the browser itself never renders toasts. Keep that: actions toast at the page level.

---

## 8. Open questions

1. **File preview is missing.** The focus brief mentions preview rendering, but the mock has none — file rows are inert (no click handler, no viewer). Does the real app need a markdown/text preview pane or overlay (e.g. click a file → rendered preview via a `raw` file loader)? If yes, it's net-new design, not a port. (The skill's `body` shown in the skill editor is the closest thing to preview in the mock.)
2. **Should the browser be reachable outside org settings?** Mock-only entry is org admin → Agent resources. Project-level policy screens reference KBs but never open the browser. Confirm scope.
3. **Sort order:** mock preserves insertion order (dirs first). A real FS scan will naturally return sorted entries — is dirs-first + alphabetical the desired contract, or should mtime ordering be used?
4. **Upload size/type limits** and per-file quota for the store — nothing in the mock. Needs a product decision before the multipart action is built.
5. **Re-index semantics for KBs:** the consumer's "Re-index now" button (org-settings, outside this file) and `refresh: "on change" | "nightly"` policy imply an indexing pipeline. Does a tree mutation from this browser trigger re-index automatically (mock bumps `last: "just now"`, implying yes)?
6. **Concurrent edits:** two admins with the browser open — last-write-wins on the whole tree in the mock (whole-tree `onChange`). Real per-path actions mostly dissolve this, but the confirm dialog's file counts can go stale; acceptable?
7. **GitHub import auth/scope:** which connection is used when the org has several (`akin-ozer`, `hepapi` in defaults), and can public repos be imported without one?
