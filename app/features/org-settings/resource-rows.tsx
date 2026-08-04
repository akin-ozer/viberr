import { FolderIco } from "~/features/kb-browser/icons";
import type { GagentView } from "~/server/org/gagents.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import type { StageDef } from "~/schemas/project-file.schema";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { EditIco } from "./mini-modal";
import { isStaleCheck, rel, updatedLabel } from "./resource-helpers";

/**
 * The four resource list panels (knowledge bases, MCP servers, skills, global
 * agent profiles) for the Agent-resources tab. Presentational: every mutation
 * is a callback the owning `ResourcesPanel` supplies. Split out of
 * `resources-panel.tsx` (pass 16, pure structural refactor — no behaviour or
 * copy change).
 */

export function KbPanel({
  kbs,
  usedBy,
  reindexing,
  onNew,
  onBrowse,
  onReindex,
  onEdit,
  onDelete,
}: {
  kbs: KbView[];
  usedBy: (slug: string) => number;
  reindexing: string | null;
  onNew: () => void;
  onBrowse: (kb: KbView) => void;
  onReindex: (kb: KbView) => void;
  onEdit: (kb: KbView) => void;
  onDelete: (kb: KbView) => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <Icon name="memory" />
        <h2>Knowledge bases</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={onNew}>
            <Icon name="plus" />
            New
          </button>
        </span>
      </div>
      <div className="rsrc-list">
        {kbs.map((kb) => (
          <div className="rsrc-row" key={kb.id}>
            <span className="rsrc-main">
              <b>
                <button type="button" className="linkish" onClick={() => onBrowse(kb)}>
                  {kb.name}
                </button>
              </b>
              {/* P14-KM-13: "N docs" counted EVERY file while injection reads
                  six text extensions, so a KB of PDFs advertised a healthy count
                  and injected nothing. Count what a run reads, and name the rest
                  rather than folding it in. */}
              {/* The two lines read as one sentence split across them —
                  "…docs agents read" / "read live" — which said "read" twice
                  and left the live-folder promise dangling. One clause each. */}
              <span className="sub mono">
                store://kb/{kb.dir}/ · {kb.injectableCount} doc
                {kb.injectableCount === 1 ? "" : "s"} · agents read the live
                folder
                {kb.fileCount > kb.injectableCount
                  ? " · " +
                    (kb.fileCount - kb.injectableCount) +
                    " non-text file" +
                    (kb.fileCount - kb.injectableCount === 1 ? "" : "s") +
                    " skipped"
                  : ""}
              </span>
              <span className="sub">
                re-scanned {rel(kb.lastIndexedAt)}
                {usedBy(kb.dir) > 0
                  ? " · " + usedBy(kb.dir) + " template" + (usedBy(kb.dir) === 1 ? "" : "s")
                  : ""}
              </span>
            </span>
            <span className="rsrc-acts">
              <button
                type="button"
                className="stg-x"
                title="Browse files"
                aria-label={"Browse files in " + kb.name}
                onClick={() => onBrowse(kb)}
              >
                <FolderIco />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Re-scan folder — refresh the doc count"
                aria-label={"Re-scan " + kb.name}
                onClick={() => onReindex(kb)}
              >
                <Icon name="refresh" className={reindexing === kb.id ? "spin" : ""} />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Edit"
                aria-label={"Edit " + kb.name}
                onClick={() => onEdit(kb)}
              >
                <EditIco />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Delete"
                aria-label={"Delete " + kb.name}
                onClick={() => onDelete(kb)}
              >
                <Icon name="x" />
              </button>
            </span>
          </div>
        ))}
        {kbs.length === 0 && <div className="empty">No knowledge bases yet.</div>}
      </div>
    </section>
  );
}

export function McpPanel({
  mcps,
  usedBy,
  testing,
  onNew,
  onTest,
  onEdit,
  onDelete,
}: {
  mcps: McpView[];
  usedBy: (slug: string) => number;
  testing: string | null;
  onNew: () => void;
  onTest: (m: McpView) => void;
  onEdit: (m: McpView) => void;
  onDelete: (m: McpView) => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <Icon name="cpu" />
        <h2>MCP servers</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={onNew}>
            <Icon name="plus" />
            Add
          </button>
        </span>
      </div>
      <div className="rsrc-list">
        {mcps.map((m) => (
          <div className="rsrc-row" key={m.id}>
            {(() => {
              const stale = m.up === true && isStaleCheck(m.lastCheckedAt);
              return (
                <span
                  className={
                    "stat-dot" +
                    (stale ? " stale" : m.up === true ? " up" : m.up === false ? " down" : "")
                  }
                  title={
                    stale
                      ? "last check passed but is stale — retest to confirm"
                      : m.up === true
                        ? "connected"
                        : m.up === false
                          ? "unreachable"
                          : "not health-checked"
                  }
                ></span>
              );
            })()}
            <span className="rsrc-main">
              <b className="mono-b">{m.name}</b>
              <span className="sub mono">
                {m.transport} · {m.target}
              </span>
              <span className="sub">
                {m.up === true
                  ? (m.tools !== null ? m.tools + " tools · " : "reachable · ") +
                    "checked " + rel(m.lastCheckedAt) +
                    (isStaleCheck(m.lastCheckedAt) ? " · stale, retest" : "")
                  : m.up === false
                    ? "unreachable · checked " + rel(m.lastCheckedAt)
                    : /* P13-UI-16: defensive — every save/test writes `up`, so a
                         null only appears for a row written outside Viberr. */
                      "not health-checked yet"}
                {/* A9 (F17 hygiene): a stored credential that no longer decrypts
                    (e.g. the encryption key was rotated without the PREVIOUS key)
                    used to still read "auth: configured" while the server mounted
                    anonymously. `credUnreadable` was computed for exactly this and
                    never surfaced — say it plainly so an admin knows to rotate or
                    re-enter it. */}
                {m.hasCred
                  ? m.credUnreadable
                    ? " · auth: unreadable — rotate the encryption key or re-enter the credential"
                    : " · auth: configured"
                  : ""}
                {/* P14-KM-09: KB and skill rows have counted their templates
                    since P13-KM-08; MCP rows showed nothing, so an admin about
                    to rename or remove a server had no idea what depended on
                    it. Same count, same honest "templates" label. */}
                {usedBy(m.name) > 0
                  ? " · " +
                    usedBy(m.name) +
                    " template" +
                    (usedBy(m.name) === 1 ? "" : "s")
                  : ""}
              </span>
            </span>
            <span className="rsrc-acts">
              <button
                type="button"
                className="stg-x"
                title="Test connection"
                aria-label={"Test " + m.name}
                onClick={() => onTest(m)}
              >
                <Icon name="refresh" className={testing === m.id ? "spin" : ""} />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Edit"
                aria-label={"Edit " + m.name}
                onClick={() => onEdit(m)}
              >
                <EditIco />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Remove"
                aria-label={"Remove " + m.name}
                onClick={() => onDelete(m)}
              >
                <Icon name="x" />
              </button>
            </span>
          </div>
        ))}
        {mcps.length === 0 && <div className="empty">No MCP servers yet.</div>}
      </div>
    </section>
  );
}

export function SkillPanel({
  skills,
  usedBy,
  onNew,
  onBrowse,
  onEdit,
  onDelete,
}: {
  skills: SkillView[];
  usedBy: (slug: string) => number;
  onNew: () => void;
  onBrowse: (s: SkillView) => void;
  onEdit: (s: SkillView) => void;
  onDelete: (s: SkillView) => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <Icon name="bolt" />
        <h2>Skills</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={onNew}>
            <Icon name="plus" />
            New
          </button>
        </span>
      </div>
      <div className="rsrc-list">
        {skills.map((s) => (
          <div className="rsrc-row" key={s.id}>
            <span className="rsrc-main">
              <b className="mono-b">
                <button
                  type="button"
                  className="linkish"
                  onClick={() => onBrowse(s)}
                >
                  {s.name}
                </button>
              </b>
              <span className="sub">{s.summary}</span>
              <span className="sub mono">
                store://skills/{s.name}/ · {s.fileCount} file
                {s.fileCount === 1 ? "" : "s"} · {updatedLabel(s.updatedAt)}
                {usedBy(s.name) > 0
                  ? " · " + usedBy(s.name) + " template" + (usedBy(s.name) === 1 ? "" : "s")
                  : ""}
              </span>
            </span>
            <span className="rsrc-acts">
              <button
                type="button"
                className="stg-x"
                title="Browse files"
                aria-label={"Browse files in " + s.name}
                onClick={() => onBrowse(s)}
              >
                <FolderIco />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Edit"
                aria-label={"Edit " + s.name}
                onClick={() => onEdit(s)}
              >
                <EditIco />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Delete"
                aria-label={"Delete " + s.name}
                onClick={() => onDelete(s)}
              >
                <Icon name="x" />
              </button>
            </span>
          </div>
        ))}
        {skills.length === 0 && <div className="empty">No skills yet.</div>}
      </div>
    </section>
  );
}

export function AgentPanel({
  gagents,
  stages,
  onNew,
  onEdit,
  onDelete,
}: {
  gagents: GagentView[];
  stages: StageDef[];
  onNew: () => void;
  onEdit: (a: GagentView) => void;
  onDelete: (a: GagentView) => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <Icon name="agents" />
        <h2>Global agent profiles</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={onNew}>
            <Icon name="plus" />
            New
          </button>
        </span>
      </div>
      <div className="rsrc-list">
        {gagents.map((a) => {
          const res = a.skills.length + a.mcps.length + a.kbs.length;
          const stageNames = a.stages
            .map((id) => stages.find((s) => s.id === id)?.name || id)
            .join(" · ");
          return (
            <div className="rsrc-row" key={a.id}>
              <AgentGlyph backend={a.backend} />
              <span className="rsrc-main">
                <b>{a.name}</b>
                {/* P13-AP-09: the row subtitle is the SHORT blurb. It used to
                    render the markdown body — i.e. the agent's entire persona —
                    so a seeded profile printed a 600-word system prompt here. */}
                <span className="sub">{a.summary}</span>
                <span className="sub mono">
                  {a.backend === "claude" ? "Claude Code" : "Codex"} ·{" "}
                  {/* P14-WL-06: the row right below already pluralizes
                      ("project"/"projects"); this one always said "resources". */}
                  {stageNames || "no stages"} · {res} context resource
                  {res === 1 ? "" : "s"} ·{" "}
                  {a.used > 0
                    ? "used in " + a.used + " project" + (a.used === 1 ? "" : "s")
                    : "not deployed"}
                </span>
              </span>
              <span className="rsrc-acts">
                <button
                  type="button"
                  className="stg-x"
                  title="Edit"
                  aria-label={"Edit " + a.name}
                  onClick={() => onEdit(a)}
                >
                  <EditIco />
                </button>
                <button
                  type="button"
                  className="stg-x"
                  title="Delete"
                  aria-label={"Delete " + a.name}
                  onClick={() => onDelete(a)}
                >
                  <Icon name="x" />
                </button>
              </span>
            </div>
          );
        })}
        {gagents.length === 0 && <div className="empty">No global agent profiles yet.</div>}
      </div>
    </section>
  );
}
