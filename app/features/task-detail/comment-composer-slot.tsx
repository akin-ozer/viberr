import {
  forwardRef,
  lazy,
  memo,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { TaskRunPrincipalView } from "./run-principal-view";

/**
 * The task-comment composer as the timeline mounts it. Ruling 454 (owner,
 * 2026-09-24): the editor behind it (Lexical, `comment-composer.tsx`) was
 * most of the task route's chunk, fetched and compiled before the first task
 * page of a session could render, so it is loaded lazily. Until it arrives
 * this renders a STAND-IN with the editor's own outer structure and classes
 * (a `.composer-ce` contenteditable and the same `.composer-placeholder`
 * hint), so nothing moves when the editor replaces it; the markup is pinned
 * against drift by `comment-composer-slot.test.tsx`.
 *
 * The editor loads when the browser is idle after mount, and at once when
 * the stand-in is focused or pressed. Whatever was typed into the stand-in
 * is carried into the editor, with the focus and the caret at the end; an
 * editor that arrives during an IME or dead-key composition waits for its
 * end. The stand-in already sends: its text reaches the parent through `onChange`
 * and ⌘/Ctrl+Enter submits, so only the @-mention menu and the live mention
 * highlighting wait for the editor.
 */

export interface CommentComposerHandle {
  focus(): void;
  /** Ask-operator prefill: only fills a draft whose trimmed text is empty. */
  prefillIfEmpty(text: string): void;
  /** Success reset: clears the draft AND the undo history, so ⌘Z cannot
   *  resurrect a posted comment. */
  clearAfterSuccess(): void;
}

export interface CommentComposerProps {
  mentionables: Mentionables;
  /** Ruling 127: the task's run principal (the owner whose accounts an
   *  `@claude` / `@codex` mention would bill), so the menu rows can name a
   *  backend that would refuse. Absent on renders with no task behind them. */
  runPrincipal?: TaskRunPrincipalView | null;
  /** Fires with the raw (untrimmed) draft on every edit. */
  onChange: (raw: string) => void;
  /** ⌘/Ctrl+Enter — the parent decides whether a submit is possible. */
  onSubmit: () => void;
}

/** What the stand-in hands the editor when the editor replaces it. */
export interface ComposerCarry {
  text: string;
  focused: boolean;
}

/** The composer's accessible name, shared by the stand-in and the editor. */
export const COMPOSER_LABEL = "Add a comment";

/** The empty-draft hint, shared by the stand-in and the editor. */
export function ComposerHint() {
  return (
    <div className="composer-placeholder" aria-hidden="true">
      Add a comment… type @ to tag the operator, an agent, or a teammate
    </div>
  );
}

let editorModule: Promise<typeof import("./comment-composer")> | null = null;
let editorLoaded = false;

/** Starts (once) fetching the editor's chunk. A failed fetch is forgotten, so
 *  the next focus retries, and the stand-in keeps working meanwhile. */
function loadEditor(): Promise<typeof import("./comment-composer")> {
  if (!editorModule) {
    const pending = import("./comment-composer");
    editorModule = pending;
    pending.then(
      () => {
        editorLoaded = true;
      },
      () => {
        editorModule = null;
      },
    );
  }
  return editorModule;
}

const LazyCommentEditor = lazy(() =>
  loadEditor().then((module) => ({ default: module.CommentEditor })),
);

/** The stand-in's draft as plain text. `innerText` keeps the line breaks a
 *  contenteditable draws as `<br>`; jsdom has no layout and leaves it
 *  undefined, so tests read `textContent`. */
function standInText(el: HTMLElement): string {
  return el.innerText ?? el.textContent ?? "";
}

const StandIn = forwardRef<
  CommentComposerHandle,
  Pick<CommentComposerProps, "onChange" | "onSubmit"> & {
    carry: RefObject<ComposerCarry | null>;
    onWant: () => void;
    /** An IME or dead-key composition started (true) or ended (false). */
    onComposing: (active: boolean) => void;
  }
>(function StandIn({ onChange, onSubmit, carry, onWant, onComposing }, ref) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const [empty, setEmpty] = useState(true);

  // Runs when the editor replaces the stand-in, in the same commit and before
  // the editor's own layout effects read it: nothing typed in between is lost.
  const capture = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current = el;
      if (!el) return;
      return () => {
        carry.current = {
          text: standInText(el),
          focused: el.ownerDocument.activeElement === el,
        };
      };
    },
    [carry],
  );

  useImperativeHandle(ref, () => {
    const write = (text: string) => {
      const el = elRef.current;
      if (!el) return;
      el.textContent = text;
      setEmpty(text === "");
    };
    const focus = () => {
      const el = elRef.current;
      if (!el) return;
      el.focus();
      // Caret at the end, where the editor puts it.
      const selection = el.ownerDocument.getSelection();
      selection?.selectAllChildren(el);
      selection?.collapseToEnd();
    };
    return {
      focus,
      prefillIfEmpty(text: string) {
        const el = elRef.current;
        if (!el || standInText(el).trim()) return;
        write(text);
        onChange(text);
        focus();
      },
      clearAfterSuccess() {
        write("");
      },
    };
  }, [onChange]);

  return (
    <>
      <div
        ref={capture}
        className="composer-ce"
        contentEditable="plaintext-only"
        role="combobox"
        aria-label={COMPOSER_LABEL}
        aria-expanded={false}
        aria-autocomplete="list"
        spellCheck
        onInput={(e) => {
          setEmpty(e.currentTarget.textContent === "");
          onChange(standInText(e.currentTarget));
        }}
        onFocus={onWant}
        onPointerDown={onWant}
        onCompositionStart={() => onComposing(true)}
        onCompositionEnd={() => onComposing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {empty && <ComposerHint />}
    </>
  );
});

/**
 * Ruling 454 (CS-7): memoised. The timeline hands it stable callbacks and
 * directories, so a revalidation or a send's fetcher states re-render the
 * timeline without re-rendering the editor under it.
 */
export const CommentComposer = memo(
  forwardRef<CommentComposerHandle, CommentComposerProps>(function CommentComposer(props, ref) {
    // Every mount renders the stand-in first: the server has no editor to
    // render, so hydration must see the stand-in too.
    const [wanted, setWanted] = useState(false);
    const carry = useRef<ComposerCarry | null>(null);
    const editorRef = useRef<CommentComposerHandle>(null);
    const standInRef = useRef<CommentComposerHandle>(null);

    // A transition keeps the stand-in on screen (and typeable) until the
    // editor can render in its place in one commit.
    const swap = useCallback(() => startTransition(() => setWanted(true)), []);
    // Review finding COMPOSER-IME-SWAP (ruling 454): while an IME or a dead
    // key composes, the stand-in's node holds the uncommitted text, and
    // removing it ends the composition: the conversion in progress is lost
    // and the marked text is carried as if typed. A swap that comes due then
    // waits for the composition's end.
    const composing = useRef(false);
    const swapOwed = useRef(false);
    const onComposing = useCallback(
      (active: boolean) => {
        composing.current = active;
        if (active || !swapOwed.current) return;
        swapOwed.current = false;
        swap();
      },
      [swap],
    );

    const want = useCallback(() => {
      loadEditor().then(
        () => {
          if (composing.current) swapOwed.current = true;
          else swap();
        },
        // Offline or a stale deploy: the stand-in stays and still sends.
        () => {},
      );
    }, [swap]);

    useEffect(() => {
      if (wanted) return;
      // A later task page in the same session already has the chunk: swap at
      // once (the stand-in and the editor draw the same pixels).
      if (editorLoaded) {
        want();
        return;
      }
      if ("requestIdleCallback" in window) {
        const id = window.requestIdleCallback(want, { timeout: 2000 });
        return () => window.cancelIdleCallback(id);
      }
      // Safari has no idle callback: a short delay keeps the fetch off the
      // hydration's critical path all the same.
      const id = setTimeout(want, 200);
      return () => clearTimeout(id);
    }, [wanted, want]);

    useImperativeHandle(
      ref,
      () => {
        const live = () => editorRef.current ?? standInRef.current;
        return {
          focus: () => live()?.focus(),
          prefillIfEmpty: (text: string) => live()?.prefillIfEmpty(text),
          clearAfterSuccess: () => live()?.clearAfterSuccess(),
        };
      },
      [],
    );

    const standIn = (
      <StandIn
        ref={standInRef}
        carry={carry}
        onChange={props.onChange}
        onSubmit={props.onSubmit}
        onWant={want}
        onComposing={onComposing}
      />
    );
    // The boundary stays mounted and its child changes inside a transition, so
    // React keeps the stand-in instead of showing the fallback while the lazy
    // module settles. The fallback is only a guard.
    return (
      <Suspense fallback={standIn}>
        {wanted ? <LazyCommentEditor ref={editorRef} {...props} carry={carry} /> : standIn}
      </Suspense>
    );
  }),
);
