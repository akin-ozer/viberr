import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { DependencyCandidatesView } from "~/routes/task-dependency-candidates";
import { candidateRefusal, type DependencyCandidate } from "~/shared/dependency-candidates";
import type { DependencyRender } from "~/shared/dependencies";
// The parser from its home, not `shared/dependencies`: that module's hold
// sentences would follow it into a chunk of their own (ruling 457).
import { canonicalDependencyRef } from "~/shared/task-refs";
import { WaitChip } from "./wait-chip";

/**
 * Ruling 548: what a task waits on, edited the way the Current-state card's
 * Owner row releases its owner. Each entry is the chip the Blocked by row
 * draws (ruling 501(c)) with the owner's release cross after it, and the field
 * after the chips finds the project's tasks by key or title in the wait
 * editor's read (`/projects/:slug/tasks/:key/dependency-candidates`): every
 * task but this one and, once the person types, the ones the writer would
 * refuse as a new entry (archived, already waiting on this task, already
 * done), dimmed, the reason where the stage was.
 *
 * Its own chunk (ruling 457): the Details panel loads it when a person heads
 * for the Blocked by trigger, so a task page nobody edits the wait on pays
 * nothing for it. It can arrive after its editor opened, so it takes the
 * focus into its field as it mounts.
 *
 * The list stays under the field while the editor is open: a list that folded
 * away on the press that leaves the field moved Save out from under that same
 * press. The picker edits a draft, and the wait's form posts the whole list on
 * Save (ruling 131), so nothing reads as saved before the server answers.
 * Arrows walk the list; Enter adds the highlighted task, or with nothing
 * highlighted saves; Backspace in the empty field removes the last entry; a
 * key typed in full before a comma, or pasted as a list, goes in by itself.
 * When the list could not be loaded, a key typed in full still goes in, and
 * the writer checks it on Save.
 */

/** The rows drawn at once; typing narrows the rest. */
const ROW_LIMIT = 50;

/** An entry the picker adds is open: a task the writer takes as a new entry
 *  is neither done nor archived. */
const openEntry = (key: string): DependencyRender => ({ ref: key, label: key, state: "open", taskKey: key });

/** The tasks that match what is typed: every free task while nothing is;
 *  otherwise the task whose key it is, free or barred, so Enter never adds
 *  another in its place, then the free matches before the barred, a key it
 *  starts before a key or title it is in, each group in the server's order
 *  (newest first). */
function matching(candidates: readonly DependencyCandidate[], typed: string): DependencyCandidate[] {
  const q = typed.trim().toLowerCase();
  if (!q) return candidates.filter((c) => c.bar === null);
  const rank = (c: DependencyCandidate) => {
    const key = c.key.toLowerCase();
    if (key === q) return 0;
    if (key.startsWith(q)) return 1;
    return key.includes(q) || c.title.toLowerCase().includes(q) ? 2 : 3;
  };
  return candidates
    .map((c) => ({ c, rank: rank(c) }))
    .filter((r) => r.rank < 3)
    .sort(
      (a, b) =>
        Number(a.rank > 0) - Number(b.rank > 0) ||
        Number(a.c.bar !== null) - Number(b.c.bar !== null) ||
        a.rank - b.rank,
    )
    .map((r) => r.c);
}

/** What the field says when no row shows: why the read failed, that it is
 *  still loading, or that no task matches what is typed or is left to add. */
function noRowsText(
  view: DependencyCandidatesView | undefined,
  candidates: readonly DependencyCandidate[] | null,
  typed: string,
): string {
  return view && !view.ok
    ? `${view.reason} A key typed in full still goes in, and Save checks it.`
    : !candidates
      ? "Loading the project's tasks…"
      : typed
        ? `No task to add matches “${typed}”.`
        : "No other task to add.";
}

export function DependencyPicker({
  view,
  taskKey,
  initial,
  value,
  onChange,
}: {
  /** The editor's read of the project's tasks; undefined while it loads. */
  view: DependencyCandidatesView | undefined;
  taskKey: string;
  /** The wait the server holds: an entry taken out of the draft goes back in
   *  as it was, a done one included. */
  initial: readonly DependencyRender[];
  value: readonly DependencyRender[];
  onChange: (next: DependencyRender[]) => void;
}) {
  // A done task the wait already holds is free to go back in: the writer
  // refuses done work only among the entries a save adds.
  const candidates = view?.ok
    ? view.tasks.map((c) => (c.bar === "done" && initial.some((e) => e.ref === c.key) ? { ...c, bar: null } : c))
    : null;

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [status, setStatus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;

  // Into the field as it mounts: the editor may have opened before this chunk
  // arrived, and its first focusable was then Cancel.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const chosen = new Set(value.map((e) => e.ref));
  const found = candidates ? matching(candidates.filter((c) => !chosen.has(c.key)), query) : [];
  const rows = found.slice(0, ROW_LIMIT);
  // `active` can dangle when the rows shrink under it; out of range is none.
  const activeRow = active >= 0 && active < rows.length ? active : -1;

  useEffect(() => {
    if (activeRow < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeRow]);

  /** What a typed key names: the entry to add, or why it cannot go in. */
  const entryFor = (text: string): { ok: true; entry: DependencyRender } | { ok: false; why: string } => {
    const key = canonicalDependencyRef(text);
    if (!key) return { ok: false, why: `"${text}" is not a task key.` };
    if (key === taskKey) return { ok: false, why: `${key}: a task cannot wait on itself.` };
    const candidate = candidates?.find((c) => c.key === key);
    if (candidates && !candidate) return { ok: false, why: `${key} is not a task in this project.` };
    if (candidate?.bar) return { ok: false, why: candidateRefusal(candidate) };
    // An entry the wait holds goes back in as it was, with its state.
    return { ok: true, entry: initial.find((e) => e.ref === key) ?? openEntry(key) };
  };

  /** Adds, in ONE change, the keys that can go in, and returns the ones that
   *  cannot, for the field to keep. */
  const addKeys = (texts: readonly string[]): string[] => {
    const next = [...value];
    const kept: string[] = [];
    let said = "";
    for (const text of texts.map((t) => t.trim()).filter(Boolean)) {
      const named = entryFor(text);
      if (!named.ok) {
        kept.push(text);
        said = named.why;
      } else if (next.some((e) => e.ref === named.entry.ref)) {
        said = `${named.entry.label} is already on the list.`;
      } else {
        next.push(named.entry);
        said = `Added ${named.entry.label}`;
      }
    }
    if (next.length !== value.length) onChange(next);
    if (said) setStatus(said);
    return kept;
  };

  const pick = (candidate: DependencyCandidate) => {
    if (addKeys([candidate.key]).length === 0) {
      setQuery("");
      setActive(-1);
    }
    inputRef.current?.focus();
  };

  const remove = (entry: DependencyRender) => {
    onChange(value.filter((e) => e.ref !== entry.ref));
    setStatus(`Removed ${entry.label}`);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && rows.length > 0) {
      e.preventDefault();
      const down = e.key === "ArrowDown";
      setActive((a) => (down ? (a + 1) % rows.length : a <= 0 ? rows.length - 1 : a - 1));
    } else if (e.key === "Enter" && activeRow >= 0) {
      e.preventDefault();
      pick(rows[activeRow]!);
    } else if (e.key === "Enter" && query.trim() !== "") {
      e.preventDefault();
      setQuery(addKeys(query.split(",")).join(", "));
    } else if (e.key === "Backspace" && query === "" && value.length > 0) {
      e.preventDefault();
      remove(value[value.length - 1]!);
    }
  };

  const typed = query.trim();
  return (
    <div className="label-combo">
      <div
        className="label-input"
        onMouseDown={(e) => {
          // A press on the chrome (a chip, its cross, the gap) keeps the focus
          // in the field; the cross still clicks.
          if (e.target !== inputRef.current) {
            e.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {value.map((entry) => (
          <WaitChip key={entry.ref} entry={entry} onRemove={() => remove(entry)} />
        ))}
        <input
          ref={inputRef}
          type="text"
          className="label-input-field"
          role="combobox"
          aria-label="What this task waits on"
          aria-expanded={rows.length > 0}
          aria-controls={rows.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={activeRow >= 0 ? optionId(activeRow) : undefined}
          value={query}
          placeholder={value.length === 0 ? "Search by key or title" : ""}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            const text = e.currentTarget.value;
            // A comma completes the keys before it; the rest stays typed.
            const parts = text.split(",");
            const tail = parts.pop() ?? "";
            const next = parts.length > 0 ? [...addKeys(parts), tail.trimStart()].join(", ") : text;
            setQuery(next);
            // What is typed highlights its best match, for Enter to add; a key
            // already on the list highlights nothing, so Enter adds no other.
            const typedKey = canonicalDependencyRef(next);
            setActive(next.trim() && !(typedKey && chosen.has(typedKey)) ? 0 : -1);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {rows.length > 0 ? (
        <ul
          ref={listRef}
          className="label-select"
          id={listId}
          role="listbox"
          aria-label="Tasks in this project"
          // The pointer's highlight goes with it: an Enter meant to save must
          // not add the last row it crossed on the way to Save.
          onMouseLeave={() => setActive(-1)}
        >
          {rows.map((c, i) => (
            <li
              key={c.key}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeRow}
              aria-disabled={c.bar ? true : undefined}
              className="label-opt dep-opt"
              data-active={i === activeRow}
              title={c.bar ? candidateRefusal(c) : `${c.key} · ${c.title}`}
              // mousedown, before the field's blur, so the focus stays; stopped
              // so the press never reaches the editor's dismisser once the pick
              // has re-rendered the row away.
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                pick(c);
              }}
              // A move, not an enter: a row that scrolls under a resting
              // pointer as the editor opens is not one the person chose.
              onMouseMove={() => {
                if (i !== activeRow) setActive(i);
              }}
            >
              {/* The spaces are for the row's spoken name; a flex row draws
                  none of them. */}
              <span className="label-opt-name">{c.key}</span>{" "}
              <span className="dep-opt-title">{c.title}</span>{" "}
              <span className="dep-opt-hint">{c.bar === "cycle" ? `waits on ${taskKey}` : (c.bar ?? c.stage)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine">{noRowsText(view, candidates, typed)}</p>
      )}
      {found.length > rows.length && (
        <p className="fine">
          Showing {rows.length} of {found.length}. Type to narrow them.
        </p>
      )}
      <span className="vh" role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
