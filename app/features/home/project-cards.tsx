import { Link } from "react-router";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { countLabel } from "~/shared/text/plural";
import { Avatar } from "~/ui/avatar";
import { useRelativeTime } from "~/ui/use-relative-time";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import type { HomeMember, HomeProjectCard } from "./home-query.server";

/**
 * One project, rendered: the card (grid) and row (list) forms plus the small
 * pieces they share — stage meter, stats line, member stack, pin star. Split
 * out of `home-page.tsx` (pass 16, pure structural refactor — no behaviour or
 * copy change).
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
      <span>{countLabel(total, "task")}</span>
      {p.running > 0 && (
        <>
          <span>·</span>
          <span className="running">
            <span className="working"></span>
            {countLabel(p.running, "agent") + " running"}
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

export function MemberStack({ members }: { members: HomeMember[] }) {
  return (
    <span className="stack" aria-label={members.map((m) => m.name).join(", ")}>
      {members.map((m) => (
        <Avatar key={m.name} person={m} />
      ))}
    </span>
  );
}

export function ProjectCard({
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

export function ProjectRow({
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
