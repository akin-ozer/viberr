import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  filterMentions,
  splitHighlight,
  type MentionSuggestion,
} from "./mention-autocomplete";
import type { DeployedSpecialistView } from "./execution-profile";
import {
  backendRunMark,
  type TaskRunPrincipalView,
} from "./run-principal-view";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { AgentGlyph } from "~/ui/identity";

/**
 * The run-an-agent control's agent picker (dynamic-dispatch rework 2026-08-29):
 * a type-to-filter dropdown over the project's DEPLOYED agents, deliberately
 * the same interaction as the comment composer's @-mention menu (one product,
 * one way to pick an agent) — same filtering/ranking logic (`filterMentions`),
 * same listbox rows (`.rsel-menu`/`.rsel-item`), same match highlighting.
 *
 * Differences from the composer's menu, each deliberate:
 *   - it opens on FOCUS with the full roster (a dedicated selector needs no
 *     `@` sigil and no minimum query — the list IS the point);
 *   - rows carry capability subs ("no repo write", "gates acceptance",
 *     "model unavailable") because choosing an agent here commits a paid run,
 *     so what the run can actually do belongs on the row (UI-39's lesson);
 *   - picking fills the input with the agent's NAME and reports the selection
 *     up; editing the text clears the selection until a row is picked again.
 */

/** The selector's row model: a mention suggestion plus run-relevant marks. */
interface AgentOption extends MentionSuggestion {
  id: string;
  /** Cannot own delivery (no repo-write grant) — UI-39's dead-end warning. */
  noRepoWrite: boolean;
  /** Its verdict gates acceptance once engaged. */
  gatesAcceptance: boolean;
  /** F20-4: a real run marked this profile's model unavailable. */
  modelUnavailable: boolean;
  /** This profile has a live (queued/running) run on the task right now. */
  running: boolean;
  /** Ruling 127: the task OWNER has not connected this profile's backend (or
   *  the task has no owner), so dispatching it would refuse before it spent
   *  anything. Choosing an agent here commits a paid run, so the fact belongs
   *  on the row — the same reason the row already carries "model unavailable". */
  ownerCannotRun: string | null;
}

function toOptions(
  agents: readonly DeployedSpecialistView[],
  activeProfileIds: readonly string[],
  runPrincipal: TaskRunPrincipalView | null,
): AgentOption[] {
  return agents.map((a) => ({
    kind: "agent",
    handle: a.id,
    name: a.name,
    sub: `${a.role} · ${BACKEND_LABEL[a.backend]}`,
    backend: a.backend,
    id: a.id,
    noRepoWrite: a.capabilities?.delivery === false,
    gatesAcceptance: a.capabilities?.verdict === true,
    modelUnavailable: !!a.modelUnavailable,
    running: activeProfileIds.includes(a.id),
    ownerCannotRun: backendRunMark(runPrincipal, a.backend),
  }));
}

export function AgentSelect({
  agents,
  activeProfileIds,
  selectedId,
  runPrincipal = null,
  disabled,
  invalid = false,
  describedBy,
  inputRef,
  onSelect,
}: {
  agents: readonly DeployedSpecialistView[];
  /** Profiles with a live run — marked on their rows. */
  activeProfileIds: readonly string[];
  /** The currently selected profile id (null = nothing picked). */
  selectedId: string | null;
  /** Ruling 127: the task's run principal, so a row whose backend the OWNER
   *  cannot run says so before the run is picked. Defaults to null (unowned),
   *  which marks every row — a bare render with no principal is a task nobody
   *  owns, and that is the honest reading. */
  runPrincipal?: TaskRunPrincipalView | null;
  disabled?: boolean;
  /** Ruling 147: a run refused for an empty pick marks THIS control, because
   *  the picker is the unmet field. Off until a submit is actually refused —
   *  a pristine form is never accused. */
  invalid?: boolean;
  /** The id of the refusal alert that explains the mark. */
  describedBy?: string;
  /** So the refusing caller can move focus to the field it named. */
  inputRef?: RefObject<HTMLInputElement | null>;
  onSelect: (profileId: string | null) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Hunt 2026-08-29: the menu opens on bare FOCUS, and `active` used to start
  // at 0 — so a keyboard user who merely tabbed THROUGH the control had Tab
  // (or a reflexive Enter) silently commit roster row 0, and the very next
  // Enter in the prompt input dispatched a billable run nobody chose. A pick
  // is intentional only after the user TYPED or ARROWED: until then `active`
  // is -1 and Enter/Tab commit nothing.
  const [active, setActive] = useState(-1);

  const options = toOptions(agents, activeProfileIds, runPrincipal);
  const selected = options.find((o) => o.id === selectedId) ?? null;
  // While a selection stands the input shows its name; typing replaces it with
  // a live query. An empty query lists the whole roster (focus-open).
  const value = open ? query : (selected?.name ?? query);
  // A dedicated selector lists the WHOLE roster (the composer's 8-row cap is
  // for an inline popover over prose); the menu itself scrolls.
  const items = filterMentions(options, query, 50);
  const activeIndex = active < 0 ? -1 : Math.min(active, items.length - 1);
  const activeId =
    activeIndex >= 0 && items.length ? `${listId}-opt-${activeIndex}` : undefined;

  // The menu scrolls (max-height in app.css) but arrowing only moved an index —
  // on a roster taller than the box the highlight walked out of view.
  useEffect(() => {
    if (!activeId) return;
    // jsdom renders the tests and implements no scrollIntoView — the scroll is
    // a browser-only nicety, never load-bearing, so its absence is swallowed.
    try {
      document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
    } catch {
      /* jsdom */
    }
  }, [activeId]);

  const openWith = (q: string, armedActive: number) => {
    setQuery(q);
    setActive(armedActive);
    setOpen(true);
  };
  const pick = (option: AgentOption) => {
    onSelect(option.id);
    setQuery("");
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      // Reopen from a settled selection on any typing intent — arrowing IS
      // interaction, so the first row arms.
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openWith("", 0);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      if (activeIndex < 0) {
        // First arrow after a focus-open arms the list at its nearest end.
        setActive(event.key === "ArrowDown" ? 0 : items.length - 1);
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + delta + items.length) % items.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      // IME guard, same as the composer: an Enter that confirms a multibyte
      // candidate must not pick a row.
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        return;
      }
      // Only an ARMED row commits (typed query or arrow navigation set it) —
      // a bare Tab passing through the control must never select an agent.
      const item = activeIndex >= 0 ? items[activeIndex] : undefined;
      if (item) {
        if (event.key === "Enter") event.preventDefault();
        pick(item);
      } else if (event.key === "Enter") {
        event.preventDefault();
        setOpen(false);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      // Escape restores the settled selection's name (or empties).
      setQuery("");
    }
  };

  return (
    <div className="agent-select">
      <input
        ref={inputRef}
        type="text"
        className="op-steer agent-select-input"
        role="combobox"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-label="Choose an agent to run"
        placeholder="Choose an agent…"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={value}
        onFocus={() => openWith("", -1)}
        onBlur={() => {
          setOpen(false);
          setQuery("");
        }}
        onChange={(e) => {
          // Typing invalidates the settled pick — the selection is a row pick,
          // never free text (the id is what the dispatch submits). It also
          // ARMS the first match: Enter/Tab may now commit it.
          if (selectedId) onSelect(null);
          openWith(e.target.value, e.target.value ? 0 : -1);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div
          className="rsel-menu mention-menu agent-select-menu"
          id={listId}
          role="listbox"
          aria-label="Deployed agents"
        >
          {items.length === 0 ? (
            <div className="rsel-item" aria-disabled>
              <span className="ri-txt">
                <span className="ri-sub">No deployed agent matches.</span>
              </span>
            </div>
          ) : (
            items.map((o, i) => {
              const parts = splitHighlight(o.name, query);
              const marks = [
                ...(o.running ? ["running"] : []),
                ...(o.noRepoWrite ? ["no repo write"] : []),
                ...(o.gatesAcceptance ? ["gates acceptance"] : []),
                ...(o.modelUnavailable ? ["model unavailable"] : []),
                ...(o.ownerCannotRun ? [o.ownerCannotRun] : []),
              ];
              return (
                <button
                  type="button"
                  key={o.id}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={"rsel-item" + (i === activeIndex ? " on" : "")}
                  // Keep focus in the input so blur doesn't beat the click.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o)}
                >
                  <AgentGlyph
                    backend={o.backend === "codex" ? "codex" : "claude"}
                    decorative
                  />
                  <span className="ri-txt">
                    <span className="ri-nm">
                      {parts.match ? (
                        <>
                          {parts.before}
                          <mark className="mention-match">{parts.match}</mark>
                          {parts.after}
                        </>
                      ) : (
                        o.name
                      )}
                    </span>
                    <span className="ri-sub">
                      {o.sub}
                      {marks.length ? ` · ${marks.join(" · ")}` : ""}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
