import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import type { SessionUser } from "~/server/auth/require-user.server";
import type { HomePrefs } from "~/server/prefs/user-prefs.server";
import { formatRelative } from "~/shared/dates/format";
import { Avatar } from "~/ui/avatar";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import type { NotificationView } from "~/features/notifications/notification-item";
import { TopBell } from "~/features/shell/top-bell";
import { UserMenu } from "~/features/shell/user-menu";
import type {
  HomeMember,
  HomeOrgSummary,
  HomeProjectCard,
} from "./home-query.server";
import { keyFromName, slugifyProjectName } from "./project-name";

/**
 * Home — multi-project landing, ported from design/html-app/app/home.jsx.
 * Prototype mechanics replaced: loader data instead of window.VIBERR,
 * per-user DB prefs instead of localStorage, real routes instead of hash
 * hops, per-project board links instead of the single WORKSPACE page.
 */

/* ---------- local icon (not in the shared set — mock keeps it local) ---- */
export function StarIco({ on }: { on?: boolean }) {
  return (
    <svg
      className="ico"
      viewBox="0 0 24 24"
      fill={on ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
    </svg>
  );
}

/* ---------- small pieces ---------- */

export function StageMeter({
  stages,
  dist,
}: {
  /** The project's OWN stage list (ruling 15). */
  stages: { id: string; name: string; color: string }[];
  dist: Record<string, number>;
}) {
  const total = stages.reduce((a, s) => a + (dist[s.id] || 0), 0);
  if (!total) return <div className="pj-meter empty" title="No tasks yet"></div>;
  const label = stages
    .map((s) => (dist[s.id] || 0) + " " + s.name.toLowerCase())
    .join(" · ");
  return (
    <div className="pj-meter" title={label}>
      {stages.map((s) => {
        const n = dist[s.id] || 0;
        if (!n) return null;
        return (
          <span
            key={s.id}
            style={{
              flex: n,
              background: s.color,
              opacity: s.id === "done" ? 0.45 : 1,
            }}
          ></span>
        );
      })}
    </div>
  );
}

function ProjectStats({ p }: { p: HomeProjectCard }) {
  const total = p.total;
  return (
    <div className="pj-stats">
      <span>{total + " task" + (total === 1 ? "" : "s")}</span>
      {p.running > 0 && (
        <>
          <span>·</span>
          <span className="running">
            <span className="working"></span>
            {p.running + " agent" + (p.running === 1 ? "" : "s") + " running"}
          </span>
        </>
      )}
      {p.running === 0 && total > 0 && (
        <>
          <span>·</span>
          <span>quiet</span>
        </>
      )}
      {p.waiting > 0 && (
        <Pill kind="input" sm>
          {p.waiting} waiting on you
        </Pill>
      )}
    </div>
  );
}

function MemberStack({ members }: { members: HomeMember[] }) {
  return (
    <span className="stack" aria-label={members.map((m) => m.name).join(", ")}>
      {members.map((m, i) => (
        <Avatar key={i} person={m} />
      ))}
    </span>
  );
}

function ProjectCard({
  p,
  starred,
  onStar,
  showDesc,
}: {
  p: HomeProjectCard;
  starred: boolean;
  onStar: (slug: string) => void;
  showDesc?: boolean;
}) {
  return (
    <article className="pj-card" data-screen-label={"Project card — " + p.name}>
      <Link
        className="pj-link"
        to={`/projects/${p.slug}/board`}
        aria-label={"Open " + p.name + " board"}
      >
        <div className="pj-top">
          <span
            className="pj-mark"
            style={{ boxShadow: "inset 0 -8px 0 " + p.accent }}
          >
            {p.name[0]}
          </span>
          <span className="pj-name">
            <span className="nm">
              {p.name}
              <span className="key">{p.key}</span>
            </span>
            <span className="repo">
              <Icon name="github" />
              {p.repo ?? "no repository"}
            </span>
          </span>
        </div>
        {showDesc && <p className="pj-desc">{p.desc}</p>}
        <StageMeter stages={p.stages} dist={p.dist} />
        <ProjectStats p={p} />
        <div className="pj-foot">
          <MemberStack members={p.members} />
          <span className="upd">
            updated {p.updatedAt ? formatRelative(p.updatedAt) : "—"}
          </span>
        </div>
      </Link>
      <button
        className={"pj-star" + (starred ? " on" : "")}
        onClick={() => onStar(p.slug)}
        aria-label={(starred ? "Unpin " : "Pin ") + p.name}
        title={starred ? "Unpin" : "Pin"}
      >
        <StarIco on={starred} />
      </button>
    </article>
  );
}

function ProjectRow({
  p,
  starred,
  onStar,
}: {
  p: HomeProjectCard;
  starred: boolean;
  onStar: (slug: string) => void;
}) {
  return (
    <article className="pj-row" data-screen-label={"Project row — " + p.name}>
      <Link
        className="pj-link"
        to={`/projects/${p.slug}/board`}
        aria-label={"Open " + p.name + " board"}
      >
        <span
          className="pj-mark"
          style={{ boxShadow: "inset 0 -7px 0 " + p.accent }}
        >
          {p.name[0]}
        </span>
        <span className="pj-name">
          <span className="nm">
            {p.name}
            <span className="key">{p.key}</span>
          </span>
          <span className="repo">
            <Icon name="github" />
            {p.repo ?? "no repository"}
          </span>
        </span>
        <StageMeter stages={p.stages} dist={p.dist} />
        <ProjectStats p={p} />
        <MemberStack members={p.members} />
        <span className="go">
          <Icon name="chevron" />
        </span>
      </Link>
      <button
        className={"pj-star" + (starred ? " on" : "")}
        onClick={() => onStar(p.slug)}
        aria-label={(starred ? "Unpin " : "Pin ") + p.name}
        title={starred ? "Unpin" : "Pin"}
      >
        <StarIco on={starred} />
      </button>
    </article>
  );
}

/* ---------- new project modal (home spec §4.9) ---------- */

function NewProjectModal({
  connections,
  storeRoot,
  onClose,
}: {
  /** Connection owners (Phase-4 stand-in — distinct repo owners in use). */
  connections: string[];
  storeRoot: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [repo, setRepo] = useState("");
  const [template, setTemplate] = useState<"governed" | "light">("governed");
  const [policy, setPolicy] = useState<"strict" | "balanced" | "auto">(
    "balanced",
  );
  const [connOwner, setConnOwner] = useState(() => connections[0] ?? "");
  const nameRef = useRef<HTMLInputElement>(null);
  const fetcher = useFetcher<{
    ok: boolean;
    key?: string;
    slug?: string;
    storePath?: string;
    error?: string;
  }>();
  const csrf = useCsrfToken();
  const push = useToast();
  const panelRef = useDialog(onClose);
  const closedRef = useRef(false);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const effKey = keyTouched ? key : keyFromName(name);
  const effRepo =
    repo || slugifyProjectName(name);
  const slug = slugifyProjectName(name);
  const busy = fetcher.state !== "idle";
  const ok =
    name.trim().length > 1 && effKey.length >= 2 && connections.length > 0;
  const serverError =
    fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  useEffect(() => {
    if (fetcher.data?.ok && !closedRef.current) {
      closedRef.current = true;
      push(
        fetcher.data.key +
          " initialized — task store created at " +
          fetcher.data.storePath,
      );
      onClose();
    }
  }, [fetcher.data, onClose, push]);

  const submit = () => {
    if (!ok || busy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "create-project");
    fd.set("name", name.trim());
    fd.set("key", effKey);
    fd.set("owner", connOwner);
    fd.set("repoName", effRepo || "new-project");
    fd.set("template", template);
    fd.set("policy", policy);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <>
      <div className="confirm-scrim" onClick={onClose}></div>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="New project"
        data-screen-label="New project modal"
        ref={panelRef}
      >
        <div className="modal-head">
          <span
            className="pj-mark"
            style={{
              boxShadow:
                "inset 0 -8px 0 color-mix(in srgb, var(--blue), transparent 55%)",
            }}
          >
            {(name.trim()[0] || "•").toUpperCase()}
          </span>
          <span className="mh-main">
            <h2>New governed project</h2>
            <div className="mh-sub">
              One board, one repo, agents under policy from day one
            </div>
          </span>
          <button
            className="icon-btn modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">
          <div className="key-row">
            <div className="field">
              <label className="flabel" htmlFor="np-name">
                Project name<span className="req">*</span>
              </label>
              <input
                id="np-name"
                type="text"
                ref={nameRef}
                value={name}
                placeholder="e.g. Payments Gateway"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
            </div>
            <div className="field">
              <label className="flabel" htmlFor="np-key">
                Task key
              </label>
              <input
                id="np-key"
                type="text"
                className="mono"
                value={effKey}
                placeholder="PAY"
                onChange={(e) => {
                  setKeyTouched(true);
                  setKey(
                    e.target.value
                      .toUpperCase()
                      .replace(/[^A-Z]/g, "")
                      .slice(0, 4),
                  );
                }}
              />
            </div>
          </div>
          <div className="field">
            <span className="flabel">
              GitHub connection{" "}
              <span className="fhint">sets the repository root</span>
            </span>
            <div className="pick-chips">
              {connections.map((owner) => (
                <button
                  key={owner}
                  className={"pick-chip" + (connOwner === owner ? " on" : "")}
                  onClick={() => setConnOwner(owner)}
                >
                  <Icon name="github" />
                  {owner}/
                </button>
              ))}
            </div>
            {connections.length === 0 && (
              <div className="def-note">
                <Icon name="alert" />
                <span>
                  No GitHub connections. Add one in{" "}
                  <b>Viberr settings → GitHub connections</b> first.
                </span>
              </div>
            )}
          </div>
          <div className="field">
            <label className="flabel" htmlFor="np-repo">
              GitHub repository{" "}
              <span className="fhint">
                project default · task-level override later
              </span>
            </label>
            <div className="repo-input">
              <span className="pre">{(connOwner || "github") + "/"}</span>
              <input
                id="np-repo"
                type="text"
                value={repo}
                placeholder={effRepo || "repo-name"}
                onChange={(e) => setRepo(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <span className="flabel">Workflow template</span>
            <div className="pick-chips">
              <button
                className={"pick-chip" + (template === "governed" ? " on" : "")}
                onClick={() => setTemplate("governed")}
              >
                <span className="sdot" style={{ background: "var(--blue)" }}></span>
                Governed default · 5 stages
              </button>
              <button
                className={"pick-chip" + (template === "light" ? " on" : "")}
                onClick={() => setTemplate("light")}
              >
                <span
                  className="sdot"
                  style={{ background: "var(--teal-dark)" }}
                ></span>
                Lightweight · 3 stages
              </button>
            </div>
          </div>
          <div className="field">
            <span className="flabel">Agent policy preset</span>
            <div className="pick-chips">
              <button
                className={"pick-chip" + (policy === "strict" ? " on" : "")}
                onClick={() => setPolicy("strict")}
              >
                <Icon name="lock" />
                Strict human-gate
              </button>
              <button
                className={"pick-chip" + (policy === "balanced" ? " on" : "")}
                onClick={() => setPolicy("balanced")}
              >
                <Icon name="shield" />
                Balanced · recommended
              </button>
              <button
                className={"pick-chip" + (policy === "auto" ? " on" : "")}
                onClick={() => setPolicy("auto")}
              >
                <Icon name="bolt" />
                Autonomous within policy
              </button>
            </div>
            <div className="def-note">
              <Icon name="shield" />
              <span>
                Completion stays human-authorized in every preset. Stages, RBAC
                and the agent capability matrix can be refined in project
                settings.
              </span>
            </div>
          </div>
          {serverError && (
            <div className="def-note">
              <Icon name="alert" />
              <span>{serverError}</span>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span className="foot-hint mono">
            creates {storeRoot}/projects/{slug || "…"}/
          </span>
          <span className="foot-actions">
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={!ok || busy}
              style={!ok ? { opacity: 0.55, pointerEvents: "none" } : undefined}
              onClick={submit}
              aria-busy={busy}
            >
              <Icon name="plus" />
              Create project
            </button>
          </span>
        </div>
      </div>
    </>
  );
}

/* ---------- page ---------- */

export interface HomePageData {
  user: SessionUser;
  greet: string;
  projects: HomeProjectCard[];
  prefs: HomePrefs;
  org: HomeOrgSummary;
  notifications: NotificationView[];
  unread: number;
  storeRoot: string;
}

export function HomePage({
  data,
  theme,
}: {
  data: HomePageData;
  theme: ThemePreference;
}) {
  const { user, projects, org } = data;
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const csrf = useCsrfToken();
  const push = useToast();
  const prefsFetcher = useFetcher();
  const rescanFetcher = useFetcher<{
    ok: boolean;
    projects?: number;
    changed?: number;
    removed?: number;
    errors?: number;
  }>();

  // ⌘K / Ctrl-K focuses the project search (mock behavior).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Optimistic prefs: reflect an in-flight pin/view submit immediately.
  const optimistic = prefsFetcher.formData;
  const view: "grid" | "list" =
    optimistic?.get("intent") === "view"
      ? (optimistic.get("view") as "grid" | "list")
      : data.prefs.view;
  const stars = useMemo(() => {
    const s = { ...data.prefs.stars };
    if (optimistic?.get("intent") === "pin") {
      s[String(optimistic.get("slug"))] = optimistic.get("pinned") === "1";
    }
    return s;
  }, [data.prefs.stars, optimistic]);

  const setView = (v: "grid" | "list") => {
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "view");
    fd.set("view", v);
    prefsFetcher.submit(fd, { method: "post" });
  };
  const toggleStar = (slug: string) => {
    const next = !stars[slug];
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "pin");
    fd.set("slug", slug);
    fd.set("pinned", next ? "1" : "0");
    prefsFetcher.submit(fd, { method: "post" });
    push(next ? "Pinned — it will stay at the top" : "Unpinned");
  };

  const scanning = rescanFetcher.state !== "idle";
  const rescanDone = useRef(false);
  useEffect(() => {
    if (rescanFetcher.state === "submitting") rescanDone.current = false;
    if (
      rescanFetcher.state === "idle" &&
      rescanFetcher.data?.ok &&
      !rescanDone.current
    ) {
      rescanDone.current = true;
      const d = rescanFetcher.data;
      const drift = (d.changed ?? 0) + (d.removed ?? 0) + (d.errors ?? 0);
      push(
        "Store re-scanned — " +
          d.projects +
          " project dirs, " +
          (drift === 0 ? "no drift found" : drift + " changed"),
      );
    }
  }, [rescanFetcher.state, rescanFetcher.data, push]);
  const rescan = () => {
    if (scanning) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "rescan");
    rescanFetcher.submit(fd, { method: "post" });
  };

  const filtered = projects.filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (p.name + " " + p.key + " " + (p.repo ?? "")).toLowerCase().includes(q);
  });
  const pinned = filtered.filter((p) => stars[p.slug]);
  const rest = filtered.filter((p) => !stars[p.slug]);

  const totalRunning = projects.reduce((a, p) => a + p.running, 0);
  const totalWaiting = projects.reduce((a, p) => a + p.waiting, 0);
  const activeIn = projects.filter((p) => p.running > 0).length;
  const firstName = user.name.split(" ")[0];

  const renderGroup = (list: HomeProjectCard[]) =>
    view === "grid" ? (
      <div className="pj-grid">
        {list.map((p) => (
          <ProjectCard
            key={p.slug}
            p={p}
            starred={!!stars[p.slug]}
            onStar={toggleStar}
            showDesc
          />
        ))}
      </div>
    ) : (
      <div className="pj-list">
        {list.map((p) => (
          <ProjectRow
            key={p.slug}
            p={p}
            starred={!!stars[p.slug]}
            onStar={toggleStar}
          />
        ))}
      </div>
    );

  return (
    <div
      className="home"
      data-density="comfortable"
      data-screen-label="Home — project selection"
    >
      <header className="home-top">
        <div className="home-top-in">
          <button
            className="home-brand"
            onClick={() => window.scrollTo({ top: 0 })}
            title="Viberr"
          >
            <span className="mark">V</span>
            <b>Viberr</b>
          </button>
          <div className="top-search" style={{ marginLeft: "auto" }}>
            <Icon name="search" />
            <input
              ref={searchRef}
              placeholder="Find a project…"
              aria-label="Find a project"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="kbd">⌘K</span>
          </div>
          <TopBell notifications={data.notifications} unread={data.unread} />
          <UserMenu
            user={{
              id: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
              avatarTone: user.avatarTone,
            }}
            theme={theme}
          />
        </div>
      </header>

      <main className="home-shell">
        <div className="home-hero">
          <div>
            <h1 suppressHydrationWarning>
              {data.greet}, {firstName}
            </h1>
            <p className="sub">
              {projects.length === 0 ? (
                "No projects yet — create your first governed project below."
              ) : (
                <>
                  Your agents kept working —{" "}
                  <b>
                    <span className="working"></span>
                    {totalRunning} runs active
                  </b>{" "}
                  across {activeIn} projects, <b>{totalWaiting} decisions</b>{" "}
                  waiting on you.
                </>
              )}
            </p>
          </div>
          <div className="hero-actions">
            <div className="seg" role="group" aria-label="View">
              <button
                className={view === "grid" ? "on" : ""}
                onClick={() => setView("grid")}
              >
                <Icon name="board" />
                Grid
              </button>
              <button
                className={view === "list" ? "on" : ""}
                onClick={() => setView("list")}
              >
                <Icon name="review" />
                List
              </button>
            </div>
            <button className="btn primary" onClick={() => setModal(true)}>
              <Icon name="plus" />
              New project
            </button>
          </div>
        </div>

        {projects.length === 0 ? (
          <div className="empty-hero" data-screen-label="Empty state">
            <span className="plus">
              <Icon name="plus" />
            </span>
            <h2>Create your first governed project</h2>
            <p>
              A project is one board, one repo, and a policy that decides what
              agents may do on their own — and what waits for you.
            </p>
            <div className="empty-steps">
              <span className="st">
                <span className="n">1</span>Connect a repository
              </span>
              <span className="st">
                <span className="n">2</span>Define workflow stages
              </span>
              <span className="st">
                <span className="n">3</span>Put agents under policy
              </span>
            </div>
            <button className="btn primary" onClick={() => setModal(true)}>
              <Icon name="plus" />
              New project
            </button>
          </div>
        ) : (
          <>
            {pinned.length > 0 && (
              <section data-screen-label="Pinned projects">
                <div className="sec-h">
                  <StarIco on />
                  <h2>Pinned</h2>
                  <span className="ct">{pinned.length}</span>
                </div>
                {renderGroup(pinned)}
              </section>
            )}
            <section data-screen-label="All projects">
              <div className="sec-h">
                <Icon name="board" />
                <h2>{pinned.length > 0 ? "Everything else" : "All projects"}</h2>
                <span className="ct">{rest.length}</span>
              </div>
              {rest.length === 0 && query ? (
                <div className="empty">No project matches “{query}”.</div>
              ) : view === "grid" ? (
                <div className="pj-grid">
                  {rest.map((p) => (
                    <ProjectCard
                      key={p.slug}
                      p={p}
                      starred={!!stars[p.slug]}
                      onStar={toggleStar}
                      showDesc
                    />
                  ))}
                  {!query && (
                    <button className="pj-new" onClick={() => setModal(true)}>
                      <span className="plus">
                        <Icon name="plus" />
                      </span>
                      New project
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="pj-list">
                    {rest.map((p) => (
                      <ProjectRow
                        key={p.slug}
                        p={p}
                        starred={!!stars[p.slug]}
                        onStar={toggleStar}
                      />
                    ))}
                  </div>
                  {!query && (
                    <button
                      className="pj-new"
                      style={{ minHeight: 0, padding: ".7rem", marginTop: ".5rem" }}
                      onClick={() => setModal(true)}
                    >
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: ".45rem",
                        }}
                      >
                        <Icon name="plus" />
                        New project
                      </span>
                    </button>
                  )}
                </>
              )}
            </section>
          </>
        )}

        <section className="panel" data-screen-label="Settings">
          <div className="panel-head">
            <Icon name="sliders" />
            <h2>Settings</h2>
          </div>
          <div className="org-tiles">
            <Link className="org-tile go" to="/org/settings?tab=connections">
              <span className="lbl">
                <Icon name="github" />
                GitHub connections
              </span>
              <span className="val">
                <span>
                  <span className="nm">
                    {org.connectionOwners.length} connection
                    {org.connectionOwners.length === 1 ? "" : "s"}
                  </span>
                  <div className="sub">
                    {org.connectionOwners.join(" · ") || "none connected"}
                  </div>
                </span>
              </span>
              <span className="foot go-hint">
                Manage
                <Icon name="arrow" />
              </span>
            </Link>
            <Link className="org-tile go" to="/org/settings?tab=users">
              <span className="lbl">
                <Icon name="user" />
                Users &amp; access
              </span>
              <span className="val">
                <MemberStack members={org.users.first} />
                <span>
                  <span className="nm">
                    {org.users.total} user{org.users.total === 1 ? "" : "s"}
                  </span>
                  <div className="sub">
                    {org.users.admins} admins · {org.users.members} members
                  </div>
                </span>
              </span>
              <span className="foot go-hint">
                Manage
                <Icon name="arrow" />
              </span>
            </Link>
            <Link className="org-tile go" to="/org/settings?tab=resources">
              <span className="lbl">
                <Icon name="memory" />
                Agent resources
              </span>
              <span className="val">
                <span className="glyphs">
                  <AgentGlyph backend="codex" />
                  <AgentGlyph backend="claude" />
                </span>
                <span>
                  <span className="nm">{org.globalAgents} global agents</span>
                  <div className="sub">
                    {org.knowledgeBases} knowledge bases · {org.mcpServers} MCP ·{" "}
                    {org.skills} skills
                  </div>
                </span>
              </span>
              <span className="foot go-hint">
                Manage
                <Icon name="arrow" />
              </span>
            </Link>
          </div>
        </section>

        <footer className="store-strip" data-screen-label="Store strip">
          <button className="btn ghost sm" onClick={rescan}>
            <Icon name="refresh" className={scanning ? "spin" : ""} />
            {scanning ? "Scanning…" : "Re-scan"}
          </button>
        </footer>
      </main>

      {modal && (
        <NewProjectModal
          connections={org.connectionOwners}
          storeRoot={data.storeRoot}
          onClose={() => setModal(false)}
        />
      )}
    </div>
  );
}
