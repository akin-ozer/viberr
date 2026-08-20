import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import type { CommandHit, CommandHitKind } from "./command-search.server";
import { Icon, type IconName } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";

/**
 * R15-5 — the global ⌘K palette.
 *
 * Replaces the topbar input that claimed to "Search tasks, branches, agents…"
 * and in fact filtered whichever board was open. Everything it lists is
 * reachable: the server query (`command-search.server.ts`) scopes hits to the
 * viewer's visible projects, and Enter navigates to the hit's own surface.
 *
 * The board keeps its own filter — that is a different question ("hide cards on
 * THIS board"), and it now says so.
 */

const GROUP_LABEL = {
  project: "Projects",
  task: "Tasks",
  branch: "Branches",
  agent: "Agents",
} as const satisfies Record<CommandHitKind, string>;

const GROUP_ICON = {
  project: "board",
  task: "check",
  branch: "branch",
  agent: "agents",
} as const satisfies Record<CommandHitKind, IconName>;

/** Debounce: a palette query runs per keystroke otherwise. */
const QUERY_DEBOUNCE_MS = 140;

/** The listbox the combobox input controls (`aria-controls`). */
const LISTBOX_ID = "cmdk-results";
/** Per-option id, referenced by `aria-activedescendant`. */
const optionId = (index: number) => `cmdk-opt-${index}`;

interface SearchPayload {
  data?: { q: string; hits: CommandHit[] };
}

/** One heading + its options, carrying each row's index into the flat hit list
 *  so keyboard state stays a single number. */
interface HitGroup {
  kind: CommandHitKind;
  rows: { hit: CommandHit; index: number }[];
}

/** Runs of same-kind hits, in server order (projects → tasks → branches →
 *  agents). Grouping by RUN rather than by kind keeps the rendered order and
 *  the flat `active` index in lockstep. */
function groupHits(hits: CommandHit[]): HitGroup[] {
  const groups: HitGroup[] = [];
  hits.forEach((hit, index) => {
    const last = groups[groups.length - 1];
    if (last && last.kind === hit.kind) last.rows.push({ hit, index });
    else groups.push({ kind: hit.kind, rows: [{ hit, index }] });
  });
  return groups;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { ref, close } = useDialog(onClose);
  const navigate = useNavigate();
  const fetcher = useFetcher<SearchPayload>();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // The fetcher keeps the PREVIOUS payload while a new one is in flight; only
  // trust hits that answer the query on screen, or the list flashes stale rows
  // as the viewer types.
  const hits = useMemo(() => {
    const payload = fetcher.data?.data;
    if (!payload) return [];
    return payload.q === query.trim().slice(0, 120) ? payload.hits : [];
  }, [fetcher.data, query]);

  const load = fetcher.load;
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const id = setTimeout(
      () => load(`/resources/search?q=${encodeURIComponent(q)}`),
      QUERY_DEBOUNCE_MS,
    );
    return () => clearTimeout(id);
  }, [query, load]);

  // A new result set always starts at the first row — keeping an index from the
  // previous query would leave the highlight on an unrelated hit.
  useEffect(() => setActive(0), [hits]);

  const go = (hit: CommandHit | undefined) => {
    if (!hit) return;
    // Navigate FIRST, then unmount through the dialog's own close so focus
    // restore and the exit transition still run.
    navigate(hit.href);
    close();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (hits.length ? (i + 1) % hits.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(hits[active]);
    }
  };

  useEffect(() => {
    const row = listRef.current?.querySelector('[data-active="true"]');
    // jsdom's Element carries no `scrollIntoView` at all; keyboard navigation
    // must not depend on the host providing it.
    if (row instanceof HTMLElement && "scrollIntoView" in row) {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  const searching = fetcher.state !== "idle";
  const typed = query.trim().length > 0;
  const groups = useMemo(() => groupHits(hits), [hits]);
  const expanded = hits.length > 0;

  return (
    <dialog
      ref={ref}
      className="cmdk-card"
      aria-label="Search Viberr"
      data-screen-label="Command palette"
    >
      <div className="cmdk-head">
        <Icon name="search" />
        {/* UI-C: a real combobox. The input keeps focus and POINTS at the
            highlighted row (`aria-activedescendant`) — before this the
            highlight was a `data-active` attribute nothing announced, so a
            screen-reader user arrowing through the list heard silence. Modelled
            on the mention composer next door (`comment-composer.tsx:259-268`),
            which already had the contract right. */}
        <input
          data-autofocus
          className="cmdk-input"
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={expanded}
          aria-controls={expanded ? LISTBOX_ID : undefined}
          aria-activedescendant={expanded ? optionId(active) : undefined}
          aria-autocomplete="list"
          placeholder="Search tasks, branches, agents, projects…"
          aria-label="Search tasks, branches, agents, projects"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="kbd">esc</span>
      </div>
      <div className="cmdk-list" ref={listRef}>
        {!typed ? (
          <p className="cmdk-empty">
            Type to jump to a task, a branch, an agent or a project, across
            every project you can open.
          </p>
        ) : hits.length === 0 ? (
          // The one thing a combobox cannot say through aria-activedescendant
          // is "there is nothing to point at". APG's own pattern gives the
          // status text its own polite region; without it, typing a query that
          // matches nothing is completely silent.
          <p className="cmdk-empty" role="status">
            {searching ? "Searching…" : `Nothing matches “${query.trim()}”.`}
          </p>
        ) : (
          // Options are DIRECT children of the listbox, through `role="group"` —
          // the only other role a listbox may own. They used to sit in an
          // anonymous <div> alongside their heading, and the heading was styled
          // text with no role at all, so the grouping existed only for sighted
          // readers. (axe never flagged this: `aria-required-children` descends
          // through role-less wrappers. It is the unit test next door, not the
          // sweep, that holds this shape in place.)
          <div id={LISTBOX_ID} role="listbox" aria-label="Search results">
            {groups.map((group) => (
              <div
                key={group.kind + ":" + group.rows[0]!.index}
                role="group"
                aria-label={GROUP_LABEL[group.kind]}
              >
                {/* The group carries the heading as its accessible name, so
                    the visible text would otherwise be announced twice. */}
                <div className="cmdk-group" aria-hidden="true">
                  {GROUP_LABEL[group.kind]}
                </div>
                {group.rows.map(({ hit, index }) => (
                  <button
                    key={hit.id}
                    type="button"
                    id={optionId(index)}
                    role="option"
                    // Focus never leaves the input in this pattern, so the rows
                    // are out of the tab sequence (APG combobox/listbox). They
                    // stay <button>s purely so the pointer affordances and
                    // `.cmdk-row` styling are unchanged.
                    tabIndex={-1}
                    aria-selected={index === active}
                    data-active={index === active}
                    className="cmdk-row"
                    // Keep the combobox focused: without this the mousedown
                    // blurs the input and aria-activedescendant goes stale
                    // mid-click (same guard as the mention menu).
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => go(hit)}
                  >
                    <Icon name={GROUP_ICON[hit.kind]} />
                    <span className="cmdk-main">
                      <span className="cmdk-label">{hit.label}</span>
                      <span className="cmdk-sub">{hit.sub}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </dialog>
  );
}
