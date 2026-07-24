import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Link, useFetcher } from "react-router";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import type { SessionUser } from "~/server/auth/require-user.server";
import type { HomePrefs } from "~/server/prefs/user-prefs.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { Avatar } from "~/ui/avatar";
import { useRelativeTime } from "~/ui/use-relative-time";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { SkipLink } from "~/ui/skip-link";
import { useModifierHint } from "~/ui/use-shortcut-hint";
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
import {
  keyFromName,
  projectNameFromRepo,
  slugifyProjectName,
} from "./project-name";

/**
 * Multi-project home. Uses loader data,
 * per-user DB prefs instead of localStorage, real routes instead of hash
 * hops, per-project board links instead of the single WORKSPACE page.
 */

/* ---------- local icon (not in the shared set — mock keeps it local) ---- */
function StarIco({ on }: { on?: boolean }) {
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
  if (!total) {
    // Empty pipeline preview: a faint ghost of the project's OWN stages, so a
    // fresh (0-task) card previews the workflow it will run instead of a dead
    // block. NB: the modifier is `is-empty`, NOT the global `.empty` text
    // utility (which carries 2rem padding and would inflate this 6px bar — the
    // "weird task view" bug on freshly-created projects).
    return (
      <div className="pj-meter is-empty" title="No tasks yet — ready for its first">
        {stages.map((s) => (
          <span
            key={s.id}
            style={{
              flex: 1,
              background: `color-mix(in srgb, ${s.color}, transparent 82%)`,
            }}
          ></span>
        ))}
      </div>
    );
  }
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
              // UI-15: the completed band is dimmed because it is the
              // project's TERMINAL stage, not because its id is "done" —
              // stage ids are per-project and renameable
              // (shared/workflow/stage-roles.ts).
              opacity: isTerminalStage(s.id, stages) ? 0.45 : 1,
            }}
          ></span>
        );
      })}
    </div>
  );
}

/**
 * "updated 2m ago" on a project card. UI-02: a project with no tasks has no
 * change timestamp at all (the old `parsed_at` fallback made every task-less
 * card read "updated just now" after any projection rebuild), so it says so.
 */
function UpdatedLabel({ updatedAt }: { updatedAt: string | null }) {
  const relative = useRelativeTime(updatedAt);
  if (!updatedAt) return <span className="upd">no task activity yet</span>;
  return (
    <time className="upd" dateTime={updatedAt} suppressHydrationWarning>
      updated {relative}
    </time>
  );
}

function ProjectStats({ p }: { p: HomeProjectCard }) {
  const total = p.total;
  if (total === 0) {
    // Fresh project: an inviting hint instead of a bare "0 tasks", so the card
    // reads as ready-to-start rather than empty.
    return (
      <div className="pj-stats">
        <span className="pj-empty-hint">No tasks yet · ready for its first</span>
      </div>
    );
  }
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
      {/* UI-22: shown ALONGSIDE a personal count, not only when it is zero —
          an admin with 2 personal and 3 override-eligible decisions used to see
          no trace of the other 3. */}
      {p.overrideWaiting > 0 && (
        <span title="These need a decision your project role can't make — reachable through your org-admin override.">
          <Pill kind="neutral" sm>
            {p.overrideWaiting} override-available
          </Pill>
        </span>
      )}
    </div>
  );
}

function MemberStack({ members }: { members: HomeMember[] }) {
  return (
    <span className="stack" aria-label={members.map((m) => m.name).join(", ")}>
      {members.map((m) => (
        <Avatar key={m.name} person={m} />
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
          <UpdatedLabel updatedAt={p.updatedAt} />
        </div>
      </Link>
      <button
        type="button"
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
        type="button"
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

function NewProjectNameFields({
  nameRef,
  name,
  setName,
  effKey,
  setKey,
  setKeyTouched,
  keyStripped,
  setKeyStripped,
  submit,
}: {
  nameRef: RefObject<HTMLInputElement | null>;
  name: string;
  setName: (v: string) => void;
  effKey: string;
  setKey: (v: string) => void;
  setKeyTouched: (v: boolean) => void;
  keyStripped: boolean;
  setKeyStripped: (v: boolean) => void;
  submit: () => void;
}) {
  return (
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
      {/* LV-07: the input silently dropped every non-letter (typing "P13" left
          "P") and Create then sat disabled with no explanation. The accepted
          alphabet is stated up front, and a live note names what was stripped.
          Letters-only is the stored contract — `taskPrefix` is
          `/^[A-Za-z]+$/` in app/schemas/project-file.schema.ts. */}
      <div className="field">
        <label className="flabel" htmlFor="np-key">
          Task key{" "}
          <span className="fhint">2–4 letters · task ids look like {(effKey || "PAY") + "-1"}</span>
        </label>
        <input
          id="np-key"
          type="text"
          className="mono"
          value={effKey}
          placeholder="PAY"
          aria-describedby="np-key-note"
          onChange={(e) => {
            setKeyTouched(true);
            const raw = e.target.value;
            const cleaned = raw
              .toUpperCase()
              .replace(/[^A-Z]/g, "")
              .slice(0, 4);
            setKeyStripped(raw.toUpperCase().replace(/[A-Z]/g, "").trim().length > 0);
            setKey(cleaned);
          }}
        />
        <div className="fhint" id="np-key-note">
          {keyStripped
            ? "Only letters are kept — digits and symbols aren't allowed in a task key."
            : effKey.length > 0 && effKey.length < 2
              ? "At least 2 letters."
              : ""}
        </div>
      </div>
    </div>
  );
}

function NewProjectConnectionField({
  connections,
  connOwner,
  setConnOwner,
}: {
  connections: string[];
  connOwner: string;
  setConnOwner: (owner: string) => void;
}) {
  return (
    <div className="field">
      <span className="flabel">
        GitHub connection<span className="req">*</span>{" "}
        <span className="fhint">sets the repository root</span>
      </span>
      <div className="pick-chips">
        {connections.map((owner) => (
          <button
            type="button"
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
            No GitHub connections yet — every project needs a repository. Add
            a PAT in{" "}
            <Link to="/org/settings?tab=connections">
              <b>Viberr settings → GitHub connections</b>
            </Link>
            , then come back.
          </span>
        </div>
      )}
    </div>
  );
}

function NewProjectRepoField({
  repo,
  setRepo,
  effOwner,
  effRepo,
}: {
  repo: string;
  setRepo: (v: string) => void;
  effOwner: string;
  effRepo: string;
}) {
  return (
    <div className="field">
      <label className="flabel" htmlFor="np-repo">
        GitHub repository<span className="req">*</span>{" "}
        <span className="fhint">
          {effOwner
            ? "project default · task-level override later"
            : "requires a GitHub connection"}
        </span>
      </label>
      <div className="repo-input">
        <span className="pre">{(effOwner || "github") + "/"}</span>
        <input
          id="np-repo"
          type="text"
          value={repo}
          placeholder={effRepo || "repo-name"}
          disabled={!effOwner}
          onChange={(e) => setRepo(e.target.value)}
        />
      </div>
    </div>
  );
}

/**
 * P13-AP-04 / owner ruling 2: the "Lightweight · 3 stages" preset was DELETED —
 * it created a `todo`/`doing`/`done` board while the preinstalled roster's
 * eligible stages are the governed ids, so no specialist was ever assignable
 * (LV-01, live-proven). With one template left there is nothing to pick, so the
 * chip row is replaced by an honest statement of the board a project starts on
 * and where to change it.
 */
function NewProjectWorkflowField() {
  return (
    <div className="field">
      <span className="flabel">
        Workflow
        <span className="fhint">customize the stages in project settings</span>
      </span>
      <div className="pick-chips">
        <span className="pick-chip on" aria-disabled="true">
          <span className="sdot" style={{ background: "var(--blue)" }}></span>
          Standard · 5 stages
        </span>
      </div>
    </div>
  );
}

function NewProjectPolicyField({
  policy,
  setPolicy,
}: {
  policy: "strict" | "balanced" | "auto";
  setPolicy: (p: "strict" | "balanced" | "auto") => void;
}) {
  return (
    <div className="field">
      <span className="flabel">Agent policy preset</span>
      <div className="pick-chips">
        <button
          type="button"
          className={"pick-chip" + (policy === "strict" ? " on" : "")}
          onClick={() => setPolicy("strict")}
        >
          <Icon name="lock" />
          Strict human-gate
        </button>
        <button
          type="button"
          className={"pick-chip" + (policy === "balanced" ? " on" : "")}
          onClick={() => setPolicy("balanced")}
        >
          <Icon name="shield" />
          Balanced · recommended
        </button>
        <button
          type="button"
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
          Completion stays human-authorized — except an{" "}
          <b>Autonomous within policy</b> operator granted <b>direct</b>{" "}
          completion authority, which may accept work itself (disclosed on the
          Policy page). Stages, RBAC and the agent capability matrix can be
          refined in project settings.
        </span>
      </div>
    </div>
  );
}

function NewProjectFooter({
  storeRoot,
  slug,
  ok,
  blockedReason,
  busy,
  onClose,
  submit,
}: {
  storeRoot: string;
  slug: string;
  ok: boolean;
  /** LV-07: why Create is disabled — never a dead button with no explanation. */
  blockedReason: string | null;
  busy: boolean;
  onClose: () => void;
  submit: () => void;
}) {
  return (
    <div className="modal-foot">
      <span className="foot-hint mono">
        creates {storeRoot}/projects/{slug || "…"}/
      </span>
      <span className="foot-actions">
        {!ok && blockedReason && (
          <span className="foot-hint" role="status">
            {blockedReason}
          </span>
        )}
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!ok || busy}
          {...(!ok && blockedReason ? { title: blockedReason } : {})}
          style={!ok ? { opacity: 0.55, pointerEvents: "none" } : undefined}
          onClick={submit}
          aria-busy={busy}
        >
          <Icon name="plus" />
          Create project
        </button>
      </span>
    </div>
  );
}

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
  const [nameTouched, setNameTouched] = useState(false);
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [keyStripped, setKeyStripped] = useState(false);
  const [repo, setRepo] = useState("");
  const [repoTouched, setRepoTouched] = useState(false);
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
  const { ref: panelRef, close } = useDialog(onClose);
  const closedRef = useRef(false);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const effKey = keyTouched ? key : keyFromName(name);
  const effRepo = repo || slugifyProjectName(name);
  const slug = slugifyProjectName(name);
  // Name ↔ repo AUTOCOMPLETE (not a persistent two-way lock — pass-8 P1 ruling):
  // typing into an empty/untouched field fills the OTHER, but once a field has
  // been edited by hand it is `*Touched` and the other's derive no longer
  // overwrites it. This lets a project bind to an existing repo under a distinct
  // name (e.g. repo `viberr`, name "Viberr QA") without the two fighting.
  // `effRepo` still falls back to the derived slug for the grey placeholder.
  const editName = (v: string) => {
    setName(v);
    setNameTouched(true);
    if (!repoTouched) setRepo(slugifyProjectName(v));
  };
  const editRepo = (raw: string) => {
    const v = raw
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9._-]/g, "");
    setRepo(v);
    setRepoTouched(true);
    if (v && !nameTouched) setName(projectNameFromRepo(v));
  };
  const busy = fetcher.state !== "idle";
  // The effective repo owner: a picked connection. A repository (and therefore
  // a PAT connection) is REQUIRED — repo-less projects were cut (2026-07-17,
  // reverses F10): agents deliver through GitHub, so a project without a repo
  // dead-ends at execution.
  const effOwner = connOwner;
  const ok =
    name.trim().length > 1 &&
    effKey.length >= 2 &&
    effOwner.length > 0 &&
    effRepo.length > 0;
  // LV-07: name the FIRST unmet requirement so a disabled Create is never
  // unexplained (the previous modal offered no message anywhere).
  const blockedReason =
    name.trim().length <= 1
      ? "Enter a project name (2+ characters)."
      : effKey.length < 2
        ? "Task key needs at least 2 letters."
        : effOwner.length === 0
          ? "Pick a GitHub connection."
          : effRepo.length === 0
            ? "Enter a repository name."
            : null;
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
    fd.set("owner", effOwner);
    fd.set("repoName", effRepo);
    fd.set("policy", policy);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    // Native <dialog> via useDialog: Escape, backdrop-click close and the
    // ::backdrop scrim all come from showModal() + the hook.
    <dialog
      className="modal-card"
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
          <h2>New project</h2>
          <div className="mh-sub">
            One board, one repo, agents under policy from day one
          </div>
        </span>
        <button
          type="button"
          className="icon-btn modal-close"
          onClick={close}
          aria-label="Close"
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body">
        <NewProjectNameFields
          nameRef={nameRef}
          name={name}
          setName={editName}
          effKey={effKey}
          setKey={setKey}
          setKeyTouched={setKeyTouched}
          keyStripped={keyStripped}
          setKeyStripped={setKeyStripped}
          submit={submit}
        />
        <NewProjectConnectionField
          connections={connections}
          connOwner={connOwner}
          setConnOwner={setConnOwner}
        />
        <NewProjectRepoField
          repo={repo}
          setRepo={editRepo}
          effOwner={effOwner}
          effRepo={effRepo}
        />
        <NewProjectWorkflowField />
        <NewProjectPolicyField policy={policy} setPolicy={setPolicy} />
        {serverError && (
          <div className="form-err">
            <Icon name="alert" />
            <span>{serverError}</span>
          </div>
        )}
      </div>
      {/* Cancel routes through the animated close; the success unmount
          (fetcher effect above) keeps the raw onClose. */}
      <NewProjectFooter
        storeRoot={storeRoot}
        slug={slug}
        ok={ok}
        blockedReason={blockedReason}
        busy={busy}
        onClose={close}
        submit={submit}
      />
    </dialog>
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

/* Focused sections of HomePage — same-file extraction, state stays in
   HomePage and flows down via explicit props. Rendered DOM is unchanged. */

function HomeTopBar({
  searchRef,
  query,
  onQuery,
  notifications,
  unread,
  user,
  theme,
  livePaused = false,
  onReconnect,
}: {
  searchRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (q: string) => void;
  notifications: NotificationView[];
  unread: number;
  user: SessionUser;
  theme: ThemePreference;
  /** UI-03: the SSE stream is down — the cards are a stale snapshot. */
  livePaused?: boolean;
  onReconnect?: () => void;
}) {
  const modifierHint = useModifierHint();
  return (
    <header className="home-top">
      <div className="home-top-in">
        <button
          type="button"
          className="home-brand"
          onClick={() => window.scrollTo({ top: 0 })}
          title="Viberr"
        >
          <span className="mark">V</span>
          <b>Viberr</b>
        </button>
        {livePaused && (
          <button
            type="button"
            className="pill risk sm"
            role="status"
            style={{ marginLeft: "auto", cursor: "pointer" }}
            title="The live update stream dropped (often an expired session). These cards may be out of date."
            onClick={() => onReconnect?.()}
          >
            live updates paused — retry
          </button>
        )}
        <div
          className="top-search"
          style={livePaused ? undefined : { marginLeft: "auto" }}
        >
          <Icon name="search" />
          <input
            ref={searchRef}
            placeholder="Find a project…"
            aria-label="Find a project"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          {/* UI-55: platform-aware — the handler accepts Ctrl too. */}
          <span className="kbd" suppressHydrationWarning>
            {modifierHint}
          </span>
        </div>
        <TopBell notifications={notifications} unread={unread} />
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
  );
}

/**
 * UI-19: the loader computes the greeting from the SERVER's clock, so a user in
 * another timezone was told "Good evening" at 9am. The server value is kept as
 * the SSR text (no flash of empty heading) and corrected from the browser clock
 * on mount — the `<h1>` already carries `suppressHydrationWarning`.
 */
function useLocalGreeting(serverGreet: string): string {
  const [greet, setGreet] = useState(serverGreet);
  useEffect(() => {
    const hour = new Date().getHours();
    setGreet(
      hour < 12
        ? "Good morning"
        : hour < 18
          ? "Good afternoon"
          : "Good evening",
    );
  }, []);
  return greet;
}

function HomeHero({
  greet,
  firstName,
  projectCount,
  totalRunning,
  activeIn,
  totalWaiting,
  view,
  onView,
  onNew,
}: {
  greet: string;
  firstName: string;
  projectCount: number;
  totalRunning: number;
  activeIn: number;
  totalWaiting: number;
  view: "grid" | "list";
  onView: (v: "grid" | "list") => void;
  onNew: () => void;
}) {
  const localGreet = useLocalGreeting(greet);
  return (
    <div className="home-hero">
      <div>
        <h1 suppressHydrationWarning>
          {localGreet}, {firstName}
        </h1>
        {/* UI-10: the copy (and the animated `.working` pulse dot) asserted
            activity even at zero — "Your agents kept working — •0 runs active".
            The zero case now reads as the quiet state it is, and the pulse dot
            renders only when something is actually running. */}
        <p className="sub">
          {projectCount === 0 ? (
            "No projects yet — create your first project below."
          ) : totalRunning === 0 ? (
            <>
              All quiet — no agent runs right now.{" "}
              {totalWaiting > 0 ? (
                <>
                  <b>
                    {totalWaiting}{" "}
                    {totalWaiting === 1 ? "decision" : "decisions"}
                  </b>{" "}
                  waiting on you.
                </>
              ) : (
                "Nothing is waiting on you."
              )}
            </>
          ) : (
            <>
              Your agents kept working —{" "}
              <b>
                <span className="working"></span>
                {totalRunning} {totalRunning === 1 ? "run" : "runs"} active
              </b>{" "}
              across {activeIn} {activeIn === 1 ? "project" : "projects"},{" "}
              <b>
                {totalWaiting} {totalWaiting === 1 ? "decision" : "decisions"}
              </b>{" "}
              waiting on you.
            </>
          )}
        </p>
      </div>
      <div className="hero-actions">
        {/* UI-13: selection was conveyed by the `on` class alone — invisible to
            assistive tech. `aria-pressed` carries it now. */}
        <div className="seg" role="group" aria-label="View">
          <button
            type="button"
            className={view === "grid" ? "on" : ""}
            aria-pressed={view === "grid"}
            onClick={() => onView("grid")}
          >
            <Icon name="board" />
            Grid
          </button>
          <button
            type="button"
            className={view === "list" ? "on" : ""}
            aria-pressed={view === "list"}
            onClick={() => onView("list")}
          >
            <Icon name="review" />
            List
          </button>
        </div>
        <button type="button" className="btn primary" onClick={onNew}>
          <Icon name="plus" />
          New project
        </button>
      </div>
    </div>
  );
}

function EmptyHero({ onNew }: { onNew: () => void }) {
  return (
    <div className="empty-hero" data-screen-label="Empty state">
      <span className="plus">
        <Icon name="plus" />
      </span>
      <h2>Create your first project</h2>
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
      <button type="button" className="btn primary" onClick={onNew}>
        <Icon name="plus" />
        New project
      </button>
    </div>
  );
}

function ProjectSections({
  view,
  stars,
  onStar,
  pinned,
  rest,
  archivedList,
  query,
  onNew,
}: {
  view: "grid" | "list";
  stars: Record<string, boolean>;
  onStar: (slug: string) => void;
  pinned: HomeProjectCard[];
  rest: HomeProjectCard[];
  archivedList: HomeProjectCard[];
  query: string;
  onNew: () => void;
}) {
  const renderGroup = (list: HomeProjectCard[]) =>
    view === "grid" ? (
      <div className="pj-grid">
        {list.map((p) => (
          <ProjectCard
            key={p.slug}
            p={p}
            starred={!!stars[p.slug]}
            onStar={onStar}
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
            onStar={onStar}
          />
        ))}
      </div>
    );

  return (
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
        {/* UI-21: "no match" must account for the pinned group rendered above —
            it used to claim nothing matched while a matching pinned card was
            on screen. */}
        {rest.length === 0 && pinned.length === 0 && query ? (
          <div className="empty">No project matches “{query}”.</div>
        ) : rest.length === 0 && query ? (
          <div className="empty">
            Every match for “{query}” is pinned above.
          </div>
        ) : view === "grid" ? (
          <div className="pj-grid">
            {rest.map((p) => (
              <ProjectCard
                key={p.slug}
                p={p}
                starred={!!stars[p.slug]}
                onStar={onStar}
                showDesc
              />
            ))}
            {!query && (
              <button type="button" className="pj-new" onClick={onNew}>
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
                  onStar={onStar}
                />
              ))}
            </div>
            {!query && (
              <button
                type="button"
                className="pj-new"
                style={{ minHeight: 0, padding: ".7rem", marginTop: ".5rem" }}
                onClick={onNew}
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
      {archivedList.length > 0 && (
        <section data-screen-label="Archived projects">
          <div className="sec-h">
            <Icon name="board" />
            <h2>Archived</h2>
            <span className="ct">{archivedList.length}</span>
          </div>
          <p className="sub" style={{ margin: "0 0 .75rem" }}>
            Hidden from the active workspace. Open a project and use
            Settings → Danger zone to restore it.
          </p>
          <div className="pj-list">
            {archivedList.map((p) => (
              <ProjectRow
                key={p.slug}
                p={p}
                starred={!!stars[p.slug]}
                onStar={onStar}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function SettingsPanel({ org }: { org: HomeOrgSummary }) {
  return (
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
                {org.users.admins} admin{org.users.admins === 1 ? "" : "s"} ·{" "}
                {org.users.members} member{org.users.members === 1 ? "" : "s"}
                {org.users.disabled > 0
                  ? ` · ${org.users.disabled} disabled`
                  : ""}
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
              <span className="nm">
                {org.globalAgents} agent {org.globalAgents === 1 ? "profile" : "profiles"}
                <span className="muted"> · + operator</span>
              </span>
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
  );
}

function StoreStrip({
  scanning,
  onRescan,
  isAdmin,
  rebuilding,
  onRebuild,
}: {
  scanning: boolean;
  onRescan: () => void;
  isAdmin: boolean;
  rebuilding: boolean;
  onRebuild: () => void;
}) {
  // Both store-maintenance actions are org-admin only server-side; render them
  // only for an admin rather than a Re-scan button that silently 403s (MU-4).
  if (!isAdmin) return null;
  return (
    <footer className="store-strip" data-screen-label="Store strip">
      <button type="button" className="btn ghost sm" onClick={onRescan}>
        <Icon name="refresh" className={scanning ? "spin" : ""} />
        {scanning ? "Scanning…" : "Re-scan"}
      </button>
      <button
        type="button"
        className="btn ghost sm"
        onClick={onRebuild}
        title="Drop every projection row and re-project the whole store from files"
      >
        <Icon name="memory" className={rebuilding ? "spin" : ""} />
        {rebuilding ? "Rebuilding…" : "Rebuild projections"}
      </button>
    </footer>
  );
}

export function HomePage({
  data,
  theme,
  livePaused = false,
  onReconnect,
}: {
  data: HomePageData;
  theme: ThemePreference;
  /** UI-03: SSE stream state, surfaced in the header. */
  livePaused?: boolean;
  onReconnect?: () => void;
}) {
  const { user, projects, org } = data;
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const csrf = useCsrfToken();
  const push = useToast();
  const prefsFetcher = useFetcher<{
    ok: boolean;
    intent?: "pin" | "view";
    pinned?: boolean;
    error?: string;
  }>();
  const rescanFetcher = useFetcher<{
    ok: boolean;
    projects?: number;
    changed?: number;
    removed?: number;
    errors?: number;
    error?: string;
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
  };

  // UI-06: the pin/view toasts settle on the RESULT (the shared
  // `useFetcherResult` contract the bell/user-menu/profile already use). A
  // rejected submit now reports the failure instead of claiming success and
  // silently reverting on the next revalidation.
  useFetcherResult(prefsFetcher, (d) => {
    if (!d.ok) {
      push(d.error ?? "Couldn't save that preference — please try again", "error");
      return;
    }
    if (d.intent === "pin") {
      push(d.pinned ? "Pinned — it will stay at the top" : "Unpinned");
    }
  });

  const scanning = rescanFetcher.state !== "idle";
  // UI-07: a failed re-scan (403 for a non-admin, or an app error) used to
  // render NOTHING — the spinner just stopped and the page looked as if the
  // scan had succeeded. Both outcomes toast now, mirroring the rebuild handler.
  useFetcherResult(rescanFetcher, (d) => {
    if (!d.ok) {
      push(d.error ?? "Re-scan failed — check the server log", "error");
      return;
    }
    const drift = (d.changed ?? 0) + (d.removed ?? 0) + (d.errors ?? 0);
    push(
      "Store re-scanned — " +
        d.projects +
        " project dirs, " +
        (drift === 0 ? "no drift found" : drift + " changed"),
    );
  });
  const rescan = () => {
    if (scanning) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "rescan");
    rescanFetcher.submit(fd, { method: "post" });
  };

  // Full projection rebuild (Phase 10 recovery) — admin-only, confirmed.
  // ADDITION over the mock: the mock's store strip has only Re-scan; the
  // recovery hammer lives beside it per the Phase-10 plan.
  const rebuildFetcher = useFetcher<{
    ok: boolean;
    projects?: number;
    tasks?: number;
    error?: string;
  }>();
  const [rebuildConfirm, setRebuildConfirm] = useState(false);
  const rebuilding = rebuildFetcher.state !== "idle";
  const rebuildDone = useRef(false);
  useEffect(() => {
    if (rebuildFetcher.state === "submitting") rebuildDone.current = false;
    if (
      rebuildFetcher.state === "idle" &&
      rebuildFetcher.data &&
      !rebuildDone.current
    ) {
      rebuildDone.current = true;
      const d = rebuildFetcher.data;
      push(
        d.ok
          ? `Projections rebuilt from files — ${d.projects} project${d.projects === 1 ? "" : "s"}, ${d.tasks} task${d.tasks === 1 ? "" : "s"} re-projected`
          : (d.error ?? "Rebuild failed — check the server log"),
      );
    }
  }, [rebuildFetcher.state, rebuildFetcher.data, push]);
  const rebuild = () => {
    setRebuildConfirm(false);
    if (rebuilding) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "rebuild-projections");
    rebuildFetcher.submit(fd, { method: "post" });
  };

  const matchesQuery = (p: HomeProjectCard) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (p.name + " " + p.key + " " + (p.repo ?? "")).toLowerCase().includes(q);
  };
  // Archived projects are lifted out of the active grid into their own section.
  const active = projects.filter((p) => !p.archived);
  const archivedList = projects.filter((p) => p.archived && matchesQuery(p));
  const filtered = active.filter(matchesQuery);
  const pinned = filtered.filter((p) => stars[p.slug]);
  const rest = filtered.filter((p) => !stars[p.slug]);

  const totalRunning = active.reduce((a, p) => a + p.running, 0);
  const totalWaiting = active.reduce((a, p) => a + p.waiting, 0);
  const activeIn = active.filter((p) => p.running > 0).length;
  const firstName = user.name.split(" ")[0];

  return (
    <div
      className="home"
      data-density="comfortable"
      data-screen-label="Home — project selection"
    >
      {/* UI-12: bypass block ahead of the brand/search/bell/avatar header. */}
      <SkipLink />
      <HomeTopBar
        searchRef={searchRef}
        query={query}
        onQuery={setQuery}
        notifications={data.notifications}
        unread={data.unread}
        user={user}
        theme={theme}
        livePaused={livePaused}
        {...(onReconnect ? { onReconnect } : {})}
      />

      <main className="home-shell" id="main-content" tabIndex={-1}>
        <HomeHero
          greet={data.greet}
          firstName={firstName}
          projectCount={projects.length}
          totalRunning={totalRunning}
          activeIn={activeIn}
          totalWaiting={totalWaiting}
          view={view}
          onView={setView}
          onNew={() => setModal(true)}
        />

        {projects.length === 0 ? (
          <EmptyHero onNew={() => setModal(true)} />
        ) : (
          <ProjectSections
            view={view}
            stars={stars}
            onStar={toggleStar}
            pinned={pinned}
            rest={rest}
            archivedList={archivedList}
            query={query}
            onNew={() => setModal(true)}
          />
        )}

        <SettingsPanel org={org} />

        <StoreStrip
          scanning={scanning}
          onRescan={rescan}
          isAdmin={user.role === "admin"}
          rebuilding={rebuilding}
          onRebuild={() => setRebuildConfirm(true)}
        />
      </main>

      {rebuildConfirm && (
        <RebuildConfirm
          onCancel={() => setRebuildConfirm(false)}
          onConfirm={rebuild}
        />
      )}

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

/** Confirm dialog for the full projection rebuild (admin recovery action). */
function RebuildConfirm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { ref, close } = useDialog(onCancel);
  return (
    // Native <dialog>; role="alertdialog" kept for the stronger semantics.
    // Escape + backdrop-click close come from showModal() + useDialog.
    <dialog
      ref={ref}
      className="confirm-card"
      role="alertdialog"
      aria-labelledby="rebuild-confirm-title"
    >
      <div className="confirm-icon">
        <Icon name="alert" />
      </div>
      <h3 id="rebuild-confirm-title">Rebuild all projections?</h3>
      <p>
        Drops every derived board/task row and re-projects the whole store
        from the files on disk. Canonical task files are never touched.
        Day-to-day drift only needs Re-scan — rebuild when projections look
        wrong.
      </p>
      <div className="confirm-actions">
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={onConfirm}>
          Rebuild projections
        </button>
      </div>
    </dialog>
  );
}
