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

const GROUP_LABEL: Record<CommandHitKind, string> = {
  project: "Projects",
  task: "Tasks",
  branch: "Branches",
  agent: "Agents",
};

const GROUP_ICON = {
  project: "board",
  task: "check",
  branch: "branch",
  agent: "agents",
} as const satisfies Record<CommandHitKind, IconName>;

/** Debounce: a palette query runs per keystroke otherwise. */
const QUERY_DEBOUNCE_MS = 140;

interface SearchPayload {
  data?: { q: string; hits: CommandHit[] };
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
    // jsdom has no scrollIntoView; keyboard navigation must not depend on it.
    if (row instanceof HTMLElement && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  const searching = fetcher.state !== "idle";
  const typed = query.trim().length > 0;

  return (
    <dialog
      ref={ref}
      className="cmdk-card"
      aria-label="Search Viberr"
      data-screen-label="Command palette"
    >
      <div className="cmdk-head">
        <Icon name="search" />
        <input
          data-autofocus
          className="cmdk-input"
          placeholder="Search tasks, branches, agents, projects…"
          aria-label="Search tasks, branches, agents, projects"
          aria-controls="cmdk-results"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="kbd">esc</span>
      </div>
      <div className="cmdk-list" id="cmdk-results" role="listbox" ref={listRef}>
        {!typed ? (
          <p className="cmdk-empty">
            Type to jump to a task, a branch, an agent or a project — across
            every project you can open.
          </p>
        ) : hits.length === 0 ? (
          <p className="cmdk-empty">
            {searching ? "Searching…" : `Nothing matches “${query.trim()}”.`}
          </p>
        ) : (
          hits.map((hit, i) => (
            <div key={hit.id}>
              {(i === 0 || hits[i - 1]!.kind !== hit.kind) && (
                <div className="cmdk-group">{GROUP_LABEL[hit.kind]}</div>
              )}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                data-active={i === active}
                className="cmdk-row"
                onMouseEnter={() => setActive(i)}
                onClick={() => go(hit)}
              >
                <Icon name={GROUP_ICON[hit.kind]} />
                <span className="cmdk-main">
                  <span className="cmdk-label">{hit.label}</span>
                  <span className="cmdk-sub">{hit.sub}</span>
                </span>
              </button>
            </div>
          ))
        )}
      </div>
    </dialog>
  );
}
