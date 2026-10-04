import { Link } from "react-router";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { countLabel } from "~/shared/text/plural";
import { AvatarGroup } from "~/ui/avatar";
import { useRelativeTime } from "~/ui/use-relative-time";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { RichText } from "~/ui/rich-text";
import { connectionPill } from "~/features/github/github-pills";
import type { RepoAccessResult } from "~/server/github/repo-access-check.server";
import type { HomeMember, HomeProjectCard } from "./home-query.server";

/**
 * One project, rendered: the card (grid) and row (list) forms plus the small
 * pieces they share — stage meter, stats line, member stack, pin star. Split
 * out of `home-page.tsx` (pass 16, pure structural refactor — no behaviour or
 * copy change).
 */

/* ---------- small pieces ---------- */

export function StageMeter({
  stages,
  dist,
}: {
  /** The project's OWN stage list (ruling 15); `color` is a preset NAME the
   *  sheet turns into paint (ruling 364). */
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
      <div
        className="pj-meter is-empty"
        role="img"
        aria-label="No tasks yet. Ready for its first"
        title="No tasks yet. Ready for its first"
      >
        {stages.map((s) => (
          <span
            key={s.id}
            data-stage-color={s.color}
          ></span>
        ))}
      </div>
    );
  }
  const label = stages
    .map((s) => (dist[s.id] || 0) + " " + s.name.toLowerCase())
    .join(" · ");
  return (
    // role=img + aria-label: the per-stage counts are otherwise conveyed by
    // color/width segments alone (WCAG 1.1.1); `title` is a weak SR name.
    <div className="pj-meter" role="img" aria-label={label} title={label}>
      {stages.map((s) => {
        const n = dist[s.id] || 0;
        if (!n) return null;
        return (
          <span
            key={s.id}
            data-stage-color={s.color}
            style={{
              flex: n,
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
      {/* Ruling 625: "quiet" is the stat a narrow row drops (app.css, 1100px
          tier), so the decision count beside it, the row's one demand, stays. */}
      {p.running === 0 && total > 0 && (
        <>
          <span className="pj-quiet">·</span>
          <span className="pj-quiet">quiet</span>
        </>
      )}
      {/* Ruling 625: a decision that waits on you is blue everywhere (amber is
          an agent's question), in the outline tier the board's chip wears. */}
      {p.waiting > 0 && (
        <Pill kind="info" sm quiet dot>
          {p.waiting} waiting on you
        </Pill>
      )}
      {/* UI-22: shown ALONGSIDE a personal count, not only when it is zero —
          an admin with 2 personal and 3 override-eligible decisions used to see
          no trace of the other 3. */}
      {p.overrideWaiting > 0 && (
        <span title="These need a decision your project role can't make. They're reachable through your org-admin override.">
          <Pill kind="neutral" sm>
            {p.overrideWaiting} override-available
          </Pill>
        </span>
      )}
    </div>
  );
}

/**
 * U33-2 — the repository line, and the one honest thing to say when GitHub
 * refuses the repository behind it.
 *
 * The card used to render `owner/name` with no more doubt than a working repo
 * gets, so a project pointing at a repository that does not exist (the
 * autocompleted `owner/sandbox` nobody ever created) read as healthy from Home
 * while every agent run in it failed its clone.
 *
 * The words are `connectionPill`'s — the same vocabulary the GitHub page's
 * Connection row speaks — and visibility is derived from that shared pill's
 * kind rather than a second list of statuses: `risk`/`blocked` are the arms
 * where a repository IS configured and GitHub will not serve it.
 * `no_repo_configured` stays quiet because the line beside it already says "no
 * repository", and `network_unavailable` stays quiet because a card that
 * flashes an alarm whenever GitHub blips teaches people to ignore it. The same
 * two lines live in `features/board/board-page.tsx`; their home is beside
 * `connectionPill`, which is another cluster's file this pass.
 *
 * The chip carries a `title` rather than a link: the whole card is already one
 * anchor to the board, and an anchor inside an anchor is invalid. The board
 * itself carries the linked version of this fact.
 */
function RepoLine({
  repo,
  access,
}: {
  repo: string | null;
  access: RepoAccessResult | null;
}) {
  const pill = access ? connectionPill(access) : null;
  const degraded = pill && (pill.kind === "risk" || pill.kind === "blocked");
  return (
    <span className="repo">
      <Icon name="github" />
      {repo ?? "no repository"}
      {degraded && (
        <span title="GitHub won't serve this repository, so agent runs here fail their clone. The project's GitHub page has the detail.">
          <Pill kind={pill.kind} sm>
            {pill.label}
          </Pill>
        </span>
      )}
    </span>
  );
}

/** Phase 1 (2026-09-08): the hand-rolled `.stack` is now `AvatarGroup`, which
 *  owns the overlap, the `role="img"` label idiom and the `+N` fold.
 *
 *  `max` closes a latent layout hole: this row was uncapped, so a project with
 *  twenty members drew twenty discs across a card footer. Five matches the cap
 *  the org tile already applies server-side (`users.slice(0, 5)` in
 *  home-query.server.ts), so the two member rows in the app now agree. Nobody
 *  is lost to the fold — AvatarGroup's label names every member, folded ones
 *  included. */
export function MemberStack({ members }: { members: HomeMember[] }) {
  return <AvatarGroup people={members} max={5} />;
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
    <article className="pj-card" data-screen-label={"Project card · " + p.name}>
      {/* Interface review 2026-09-24 (acce-8): no aria-label. "Open X board"
          replaced the content, so a screen reader never heard the repo, the
          stage counts, "N waiting on you" or the last update. The link is
          named by what it shows; only the decorative initial is hidden. */}
      <Link className="pj-link" to={`/projects/${p.slug}/board`}>
        <div className="pj-top">
          <span
            className="pj-mark"
            aria-hidden="true"
            style={{ boxShadow: "inset 0 -8px 0 " + p.accent }}
          >
            {p.name[0]}
          </span>
          <span className="pj-name">
            <span className="nm">
              {p.name}
              <span className="key">{p.key}</span>
            </span>
            <RepoLine repo={p.repo} access={p.repoAccess} />
          </span>
        </div>
        {/* U39-20: a description is written with `code` and **bold**, as the
            controller wrote ax-clone's ("Google's `ax`"), and the card
            printed the backticks. */}
        {showDesc && (
          <p className="pj-desc">
            <RichText text={p.desc} mentions={false} />
          </p>
        )}
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
        <Icon name={starred ? "starfilled" : "star"} />
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
    <article className="pj-row" data-screen-label={"Project row · " + p.name}>
      {/* acce-8: named by its content, as `ProjectCard` is. */}
      <Link className="pj-link" to={`/projects/${p.slug}/board`}>
        <span
          className="pj-mark"
          aria-hidden="true"
          style={{ boxShadow: "inset 0 -7px 0 " + p.accent }}
        >
          {p.name[0]}
        </span>
        <span className="pj-name">
          <span className="nm">
            {p.name}
            <span className="key">{p.key}</span>
          </span>
          <RepoLine repo={p.repo} access={p.repoAccess} />
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
        <Icon name={starred ? "starfilled" : "star"} />
      </button>
    </article>
  );
}
