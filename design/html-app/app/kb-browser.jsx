/* Viberr — store-folder browser (popup). Used by knowledge bases and skills.
   Visualizes a folder in the file-native store; upload files or whole folders
   (structure intact), drag & drop onto folders, import from a GitHub link,
   create nested folders, delete with approval.
   Exports: StoreBrowser, countKbFiles, FolderIco, prettySize */
const { useState: useStateK, useRef: useRefK, useEffect: useEffectK } = React;

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

function countKbFiles(nodes) {
  return (nodes || []).reduce((a, n) => a + (n.type === "dir" ? countKbFiles(n.children) : 1), 0);
}
function countKbDirs(nodes) {
  return (nodes || []).reduce((a, n) => a + (n.type === "dir" ? 1 + countKbDirs(n.children) : 0), 0);
}
/* apply fn to the children array at path (array of dir names) */
function mapAt(nodes, path, fn) {
  if (path.length === 0) return fn(nodes);
  return nodes.map((n) =>
    n.type === "dir" && n.name === path[0]
      ? { ...n, children: mapAt(n.children || [], path.slice(1), fn) }
      : n
  );
}
const prettySize = (bytes) => {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
};

/* merge incoming nodes into existing: same-name dirs merge, files replace */
function mergeNodes(ns, add) {
  let out = [...ns];
  add.forEach((n) => {
    const i = out.findIndex((x) => x.name === n.name);
    if (i === -1) out.push(n);
    else if (out[i].type === "dir" && n.type === "dir") out[i] = { ...out[i], children: mergeNodes(out[i].children || [], n.children || []) };
    else out[i] = n;
  });
  return out;
}

/* build a node tree from an <input webkitdirectory> file list */
function buildFromPaths(files) {
  const root = [];
  files.forEach((f) => {
    const parts = (f.webkitRelativePath || f.name).split("/").filter(Boolean);
    if (parts.some((p) => p.startsWith("."))) return; // skip dotfiles/.DS_Store
    let level = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let d = level.find((n) => n.type === "dir" && n.name === parts[i]);
      if (!d) { d = { type: "dir", name: parts[i], children: [] }; level.push(d); }
      level = d.children;
    }
    level.push({ type: "file", name: parts[parts.length - 1], size: prettySize(f.size), added: "just now" });
  });
  return root;
}

/* walk a dropped FileSystemEntry (supports whole folders) */
function entryToNode(entry) {
  if (entry.name && entry.name.startsWith(".")) return Promise.resolve(null);
  if (entry.isFile) {
    return new Promise((res) => entry.file(
      (f) => res({ type: "file", name: entry.name, size: prettySize(f.size), added: "just now" }),
      () => res({ type: "file", name: entry.name, size: "", added: "just now" })
    ));
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const readAll = (acc) => new Promise((res) => reader.readEntries(
      (batch) => batch.length ? res(readAll([...acc, ...batch])) : res(acc),
      () => res(acc)
    ));
    return readAll([]).then((entries) => Promise.all(entries.map(entryToNode)))
      .then((children) => ({ type: "dir", name: entry.name, children: children.filter(Boolean) }));
  }
  return Promise.resolve(null);
}

/* flatten visible rows */
function flatten(nodes, path, depth, expanded, out) {
  const dirs = (nodes || []).filter((n) => n.type === "dir");
  const files = (nodes || []).filter((n) => n.type !== "dir");
  dirs.forEach((n) => {
    const p = [...path, n.name];
    const key = p.join("/");
    out.push({ node: n, path, depth, key, open: expanded.has(key) });
    if (expanded.has(key)) flatten(n.children, p, depth + 1, expanded, out);
  });
  files.forEach((n) => out.push({ node: n, path, depth, key: [...path, n.name].join("/") }));
  return out;
}

function StoreBrowser({ title, subMono, root, metaTail, tree, onChange, onClose, push, captureText, onCaptureText }) {
  const [expanded, setExpanded] = useStateK(() => new Set((tree || []).filter((n) => n.type === "dir").map((n) => n.name)));
  const [newIn, setNewIn] = useStateK(null);      // path array where a folder is being named
  const [ghOpen, setGhOpen] = useStateK(false);
  const [ghUrl, setGhUrl] = useStateK("");
  const [ghErr, setGhErr] = useStateK(null);
  const [importing, setImporting] = useStateK(false);
  const [confirm, setConfirm] = useStateK(null);  // { path, node }
  const [dropTgt, setDropTgt] = useStateK(null);  // "" = root, "a/b" = folder key
  const fileRef = useRefK(null);
  const dirRef = useRefK(null);
  const uploadTarget = useRefK([]);
  const newRef = useRefK(null);

  const nodes = tree || [];
  const commit = (next) => onChange(next);
  const atPath = (path) => [root, ...path].join("/") + "/";

  useEffectK(() => {
    const f = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);
  useEffectK(() => { if (newIn && newRef.current) newRef.current.focus(); }, [newIn]);
  useEffectK(() => {
    const clear = () => setDropTgt(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => { window.removeEventListener("dragend", clear); window.removeEventListener("drop", clear); };
  }, []);

  const toggle = (key) => setExpanded((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const expand = (path) => setExpanded((s) => { const n = new Set(s); for (let i = 1; i <= path.length; i++) n.add(path.slice(0, i).join("/")); return n; });

  /* ---- add content ---- */
  const mergeIn = (path, incoming) => {
    const clean = (incoming || []).filter(Boolean);
    if (!clean.length) return 0;
    commit(mapAt(nodes, path, (ns) => mergeNodes(ns, clean)));
    expand(path);
    clean.filter((n) => n.type === "dir").forEach((n) => expand([...path, n.name]));
    return clean.reduce((a, n) => a + (n.type === "dir" ? countKbFiles(n.children) : 1), 0);
  };
  const addFiles = (path, files) => {
    if (!files.length) return;
    const total = mergeIn(path, files.map((f) => ({ type: "file", name: f.name, size: prettySize(f.size), added: "just now" })));
    push(total + " file" + (total === 1 ? "" : "s") + " added to " + atPath(path));
    if (captureText && onCaptureText && path.length === 0) {
      const m = files.find((f) => f.name === captureText);
      if (m && m.text) m.text().then((t) => onCaptureText(t)).catch(() => {});
    }
  };
  const startUpload = (path) => { uploadTarget.current = path; fileRef.current && fileRef.current.click(); };
  const startDirUpload = (path) => { uploadTarget.current = path; dirRef.current && dirRef.current.click(); };
  const onFiles = (e) => { addFiles(uploadTarget.current, Array.from(e.target.files || [])); e.target.value = ""; };
  const onDirFiles = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const built = buildFromPaths(files);
    const total = mergeIn(uploadTarget.current, built);
    const names = built.map((n) => n.name).join(", ");
    push("Folder “" + names + "” uploaded as-is — " + total + " file" + (total === 1 ? "" : "s"));
  };

  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  const overDir = (e, key) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    if (dropTgt !== key) setDropTgt(key);
  };
  const dropInto = (e, path) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    setDropTgt(null);
    const items = Array.from(e.dataTransfer.items || []);
    const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (entries.length) {
      const flatFallback = Array.from(e.dataTransfer.files || []);
      Promise.all(entries.map(entryToNode)).then((ns) => {
        const total = mergeIn(path, ns);
        if (total > 0) push(total + " file" + (total === 1 ? "" : "s") + " added to " + atPath(path));
      }).catch(() => addFiles(path, flatFallback));
      if (captureText && onCaptureText && path.length === 0) {
        const fe = entries.find((en) => en.isFile && en.name === captureText);
        if (fe) fe.file((f) => { if (f.text) f.text().then((t) => onCaptureText(t)).catch(() => {}); }, () => {});
      }
    } else {
      addFiles(path, Array.from(e.dataTransfer.files || []));
    }
  };

  const createFolder = (path, name) => {
    const segs = (name || "").split("/").map((s) => s.trim().replace(/[\\]/g, "-")).filter(Boolean);
    if (!segs.length) { setNewIn(null); return; }
    const ensure = (ns, rest) => {
      if (!rest.length) return ns;
      const [h, ...tail] = rest;
      if (ns.some((n) => n.type !== "dir" && n.name === h)) { push("A file named “" + h + "” already exists here"); return ns; }
      const ex = ns.find((n) => n.type === "dir" && n.name === h);
      if (ex) return ns.map((n) => (n === ex ? { ...n, children: ensure(n.children || [], tail) } : n));
      return [...ns, { type: "dir", name: h, children: ensure([], tail) }];
    };
    commit(mapAt(nodes, path, (ns) => ensure(ns, segs)));
    expand([...path, ...segs]);
    push("Folder " + [...path, ...segs].join("/") + "/ ready");
    setNewIn(null);
  };

  const removeNode = (path, node) => {
    commit(mapAt(nodes, path, (ns) => ns.filter((n) => n !== node && n.name !== node.name)));
    push((node.type === "dir" ? "Folder “" : "“") + node.name + "” deleted");
    setConfirm(null);
  };
  const askRemove = (path, node) => setConfirm({ path, node });

  const ghImport = () => {
    const m = ghUrl.trim().match(/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/[\w.-]+\/?(.*))?/);
    if (!m) { setGhErr("Paste a GitHub link — a repo, or a folder like github.com/owner/repo/tree/main/docs."); return; }
    setGhErr(null);
    setImporting(true);
    const folder = (m[3] ? m[3].split("/").filter(Boolean).pop() : m[2]).replace(/\.git$/, "");
    setTimeout(() => {
      setImporting(false);
      const files = [
        { type: "file", name: "README.md", size: "3.1 KB", added: "just now" },
        { type: "file", name: "getting-started.md", size: "6.4 KB", added: "just now" },
        { type: "file", name: "architecture.md", size: "9.8 KB", added: "just now" },
        { type: "file", name: "api-reference.md", size: "14.2 KB", added: "just now" },
      ];
      commit(mapAt(nodes, [], (ns) => {
        let nm = folder, i = 2;
        while (ns.some((n) => n.name === nm)) nm = folder + "-" + i++;
        return [...ns, { type: "dir", name: nm, children: files }];
      }));
      setExpanded((s) => new Set([...s, folder]));
      setGhOpen(false); setGhUrl("");
      push("4 files imported from " + m[1] + "/" + m[2] + (m[3] ? "/" + m[3] : "") + " — snapshot, not a live sync");
    }, 1100);
  };

  const rows = flatten(nodes, [], 0, expanded, []);
  const nFiles = countKbFiles(nodes);
  const nDirs = countKbDirs(nodes);

  return (
    <React.Fragment>
      <div className="confirm-scrim" onClick={onClose}></div>
      <div className="modal-card modal-wide" role="dialog" aria-modal="true" aria-label={"Files — " + title} data-screen-label={"Files — " + title}>
        <div className="modal-head">
          <span className="conn-ico" style={{ width: 34, height: 34, borderRadius: 10 }}><Icon name="memory" /></span>
          <span className="mh-main">
            <h2>{title}</h2>
            <div className="mh-sub mono">{subMono}</div>
          </span>
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="modal-body">
          <div className="fm-toolbar">
            <button type="button" className="btn sm" onClick={() => startUpload([])}><UploadIco />Upload files</button>
            <button type="button" className="btn sm" onClick={() => startDirUpload([])}><FolderUpIco />Upload folder</button>
            <button type="button" className="btn sm" onClick={() => { setGhOpen((v) => !v); setGhErr(null); }}><Icon name="github" />Add from GitHub</button>
            <button type="button" className="btn ghost sm" onClick={() => setNewIn([])}><FolderIco />New folder</button>
            <span className="fm-hint">drag files or folders onto a folder to upload there</span>
          </div>
          {ghOpen && (
            <div className="fm-gh">
              <input type="text" className="mono" value={ghUrl} placeholder="https://github.com/owner/repo/tree/main/docs"
                onChange={(e) => { setGhUrl(e.target.value); setGhErr(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") ghImport(); }} autoFocus />
              <button type="button" className="btn sm" onClick={ghImport} style={importing ? { opacity: .6, pointerEvents: "none" } : null}>
                <Icon name={importing ? "refresh" : "arrow"} className={importing ? "spin" : ""} />{importing ? "Importing…" : "Import"}
              </button>
            </div>
          )}
          {ghErr && <div className="cred-warn"><Icon name="alert" />{ghErr}</div>}

          <div className={"fm-tree" + (dropTgt === "" ? " droptgt" : "")}
            onDragOver={(e) => overDir(e, "")}
            onDrop={(e) => dropInto(e, [])}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropTgt(null); }}>
            {newIn && newIn.length === 0 && (
              <div className="fm-row dir" style={{ paddingLeft: ".6rem" }}>
                <span className="twist"></span><FolderIco />
                <input ref={newRef} className="fm-newinp mono" placeholder="folder name" aria-label="New folder name"
                  onKeyDown={(e) => { if (e.key === "Enter") createFolder([], e.target.value); if (e.key === "Escape") setNewIn(null); }}
                  onBlur={(e) => createFolder([], e.target.value)} />
              </div>
            )}
            {rows.map((r) => (
              <React.Fragment key={r.key + (r.node.type || "")}>
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
                        <button type="button" className="fm-act" title="Upload here" aria-label={"Upload into " + r.node.name}
                          onClick={() => startUpload([...r.path, r.node.name])}><UploadIco /></button>
                        <button type="button" className="fm-act" title="New subfolder" aria-label={"New folder in " + r.node.name}
                          onClick={() => { expand([...r.path, r.node.name]); setNewIn([...r.path, r.node.name]); }}><Icon name="plus" /></button>
                      </React.Fragment>
                    )}
                    <button type="button" className="fm-act del" title="Delete" aria-label={"Delete " + r.node.name}
                      onClick={() => askRemove(r.path, r.node)}><Icon name="x" /></button>
                  </span>
                </div>
                {newIn && r.node.type === "dir" && newIn.join("/") === r.key && (
                  <div className="fm-row dir" style={{ paddingLeft: (0.6 + (r.depth + 1) * 1.3) + "rem" }}>
                    <span className="twist"></span><FolderIco />
                    <input ref={newRef} className="fm-newinp mono" placeholder="folder name" aria-label="New folder name"
                      onKeyDown={(e) => { if (e.key === "Enter") createFolder(newIn, e.target.value); if (e.key === "Escape") setNewIn(null); }}
                      onBlur={(e) => createFolder(newIn, e.target.value)} />
                  </div>
                )}
              </React.Fragment>
            ))}
            {rows.length === 0 && !newIn && (
              <div className="fm-empty">Empty — drag files or folders here, upload, or import from GitHub.</div>
            )}
          </div>
          <div className="def-note">
            <Icon name="file" />
            <span>This is the real folder on disk — files added outside Viberr appear after the next re-scan. Deleting here deletes from the store.</span>
          </div>
        </div>
        <div className="modal-foot">
          <span className="foot-hint mono">{nDirs + " folder" + (nDirs === 1 ? "" : "s") + " · " + nFiles + " file" + (nFiles === 1 ? "" : "s")}{metaTail ? " · " + metaTail : ""}</span>
          <span className="foot-actions">
            <button type="button" className="btn primary" onClick={onClose}>Done</button>
          </span>
        </div>
        <input ref={fileRef} type="file" multiple style={{ display: "none" }} onChange={onFiles} aria-hidden="true" tabIndex={-1} />
        <input ref={dirRef} type="file" webkitdirectory="" directory="" multiple style={{ display: "none" }} onChange={onDirFiles} aria-hidden="true" tabIndex={-1} />
      </div>
      {confirm && (
        <React.Fragment>
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
              <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="btn danger" onClick={() => removeNode(confirm.path, confirm.node)}>{confirm.node.type === "dir" ? "Delete folder" : "Delete file"}</button>
            </div>
          </div>
        </React.Fragment>
      )}
    </React.Fragment>
  );
}

Object.assign(window, { StoreBrowser, countKbFiles, FolderIco, prettySize });
