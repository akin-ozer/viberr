import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $createParagraphNode,
  $getRoot,
  $isParagraphNode,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type EditorState,
  type LexicalEditor,
} from "lexical";
import { mergeRegister } from "@lexical/utils";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { TaskRunPrincipalView } from "./run-principal-view";
import { MentionMenu } from "./mention-menu";
import {
  useMentionAutocomplete,
  type MentionAutocomplete,
} from "./use-mention-autocomplete";
import {
  $caretOffsetIn,
  $setParagraphPlainText,
  MentionTextNode,
  registerMentionHighlighting,
} from "./lexical-mention-plugin";

/**
 * The task-comment composer (Lexical, plain text only).
 *
 * The editor owns only the DRAFT UI: one paragraph of plain text with line
 * breaks, known @mentions highlighted live as character-editable text. The
 * posted value, storage, and rendering pipeline are untouched — the parent
 * reads the raw draft through `onChange` and submits exactly `raw.trim()`,
 * the same bytes the textarea composer produced. No rich text, Markdown,
 * HTML, or editor state ever persists.
 */

export interface CommentComposerHandle {
  focus(): void;
  /** Ask-operator prefill: only fills a draft whose trimmed text is empty. */
  prefillIfEmpty(text: string): void;
  /** Success reset: clears the draft AND the undo history, so ⌘Z cannot
   *  resurrect a posted comment. */
  clearAfterSuccess(): void;
}

interface CommentComposerProps {
  mentionables: Mentionables;
  /** Ruling 121: the task's run principal (the owner whose accounts an
   *  `@claude` / `@codex` mention would bill), so the menu rows can name a
   *  backend that would refuse. Absent on renders with no task behind them. */
  runPrincipal?: TaskRunPrincipalView | null;
  /** Fires with the raw (untrimmed) draft on every edit. */
  onChange: (raw: string) => void;
  /** ⌘/Ctrl+Enter — the parent decides whether a submit is possible. */
  onSubmit: () => void;
}

/** Captures the editor instance for the imperative handle. */
function EditorBridge({ editorRef }: { editorRef: React.MutableRefObject<LexicalEditor | null> }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editor, editorRef]);
  return null;
}

/** Keeps mention segmentation live against the (changeable) directory. */
function MentionHighlightPlugin({ names }: { names: string[] }) {
  const [editor] = useLexicalComposerContext();
  const namesRef = useRef(names);
  // Kept current in an effect, not during render (render must stay pure); read
  // lazily by the highlighter registered below.
  useEffect(() => {
    namesRef.current = names;
  });
  useEffect(
    () => registerMentionHighlighting(editor, () => namesRef.current),
    [editor],
  );
  return null;
}

/**
 * Keyboard model, as Lexical commands (composition-safe: Enter during IME is
 * never a send or a pick):
 *   - ⌘/Ctrl+Enter → send, always;
 *   - while the menu is open: ArrowUp/Down move, Enter/Tab insert, Escape
 *     closes;
 *   - otherwise every key keeps its plain-text default (Enter = line break).
 */
function ComposerKeysPlugin({
  menuRef,
  onSubmitRef,
}: {
  menuRef: React.MutableRefObject<MentionAutocomplete>;
  onSubmitRef: React.MutableRefObject<() => void>;
}) {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand<KeyboardEvent | null>(
          KEY_ENTER_COMMAND,
          (event) => {
            if (editor.isComposing()) return false;
            if (event && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              onSubmitRef.current();
              return true;
            }
            if (menuRef.current.open) {
              event?.preventDefault();
              return menuRef.current.pickActive();
            }
            return false;
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand<KeyboardEvent>(
          KEY_TAB_COMMAND,
          (event) => {
            if (!menuRef.current.open) return false;
            event.preventDefault();
            return menuRef.current.pickActive();
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand<KeyboardEvent>(
          KEY_ARROW_DOWN_COMMAND,
          (event) => {
            if (!menuRef.current.open) return false;
            event.preventDefault();
            menuRef.current.moveActive(1);
            return true;
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand<KeyboardEvent>(
          KEY_ARROW_UP_COMMAND,
          (event) => {
            if (!menuRef.current.open) return false;
            event.preventDefault();
            menuRef.current.moveActive(-1);
            return true;
          },
          COMMAND_PRIORITY_HIGH,
        ),
        editor.registerCommand<KeyboardEvent>(
          KEY_ESCAPE_COMMAND,
          (event) => {
            if (!menuRef.current.open) return false;
            event.preventDefault();
            menuRef.current.close();
            return true;
          },
          COMMAND_PRIORITY_HIGH,
        ),
      ),
    [editor, menuRef, onSubmitRef],
  );
  return null;
}

export const CommentComposer = forwardRef<CommentComposerHandle, CommentComposerProps>(
  function CommentComposer(
    { mentionables, runPrincipal, onChange, onSubmit },
    ref,
  ) {
    const editorRef = useRef<LexicalEditor | null>(null);
    const onChangeRef = useRef(onChange);
    const onSubmitRef = useRef(onSubmit);

    const menu = useMentionAutocomplete(
      mentionables,
      (result) => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.update(() => {
          const paragraph = $getRoot().getFirstChild();
          if ($isParagraphNode(paragraph)) {
            $setParagraphPlainText(paragraph, result.text, result.caret);
          }
        });
        editor.focus();
      },
      runPrincipal,
    );
    const menuRef = useRef(menu);
    // Kept current in an effect, not during render (render must stay pure); all
    // three are read only from deferred Lexical command / onChange handlers.
    useEffect(() => {
      onChangeRef.current = onChange;
      onSubmitRef.current = onSubmit;
      menuRef.current = menu;
    });

    useImperativeHandle(
      ref,
      () => ({
        focus() {
          editorRef.current?.focus();
        },
        prefillIfEmpty(text: string) {
          const editor = editorRef.current;
          if (!editor) return;
          editor.update(() => {
            const root = $getRoot();
            if (root.getTextContent().trim()) return;
            const first = root.getFirstChild();
            if ($isParagraphNode(first)) {
              $setParagraphPlainText(first, text);
              return;
            }
            root.clear();
            const paragraph = $createParagraphNode();
            root.append(paragraph);
            $setParagraphPlainText(paragraph, text);
          });
          editor.focus();
        },
        clearAfterSuccess() {
          const editor = editorRef.current;
          if (!editor) return;
          editor.update(() => {
            const root = $getRoot();
            root.clear();
            root.append($createParagraphNode());
          });
          editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
        },
      }),
      [],
    );

    const handleChange = (editorState: EditorState) => {
      editorState.read(() => {
        const root = $getRoot();
        const text = root.getTextContent();
        const paragraph = root.getFirstChild();
        const caret = $isParagraphNode(paragraph) ? $caretOffsetIn(paragraph) : null;
        onChangeRef.current(text);
        menuRef.current.refreshFrom(text, caret);
      });
    };

    return (
      <LexicalComposer
        initialConfig={{
          namespace: "task-comment",
          nodes: [MentionTextNode],
          onError(error: Error) {
            throw error;
          },
        }}
      >
        <EditorBridge editorRef={editorRef} />
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="composer-ce"
              role="combobox"
              aria-label="Add a comment"
              aria-expanded={menu.open}
              aria-controls={menu.open ? menu.listId : undefined}
              aria-activedescendant={menu.activeId}
              aria-autocomplete="list"
              onBlur={menu.close}
            />
          }
          placeholder={
            <div className="composer-placeholder" aria-hidden="true">
              Add a comment… type @ to tag the operator, an agent, or a teammate
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange={false} />
        <MentionHighlightPlugin names={mentionNamesFor(mentionables)} />
        <ComposerKeysPlugin menuRef={menuRef} onSubmitRef={onSubmitRef} />
        <MentionMenu
          id={menu.listId}
          items={menu.open ? menu.items : []}
          active={menu.active}
          query={menu.query}
          onPick={menu.pick}
          onHover={menu.setActive}
        />
      </LexicalComposer>
    );
  },
);

/**
 * Every string that ACTUALLY routes, for whole-name highlight matching —
 * must stay exactly what the server resolves (P13-LV-12).
 */
export function mentionNamesFor(m: Mentionables): string[] {
  return [
    ...m.agents.flatMap((a) => [a.name, a.handle]),
    ...m.users.flatMap((u) => [u.name, u.handle]),
    ...m.reserved.map((r) => r.handle),
  ];
}
