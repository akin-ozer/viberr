import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
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
  $setSelection,
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
import { mentionNamesFor } from "./mention-autocomplete";
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
import {
  COMPOSER_LABEL,
  ComposerHint,
  type CommentComposerHandle,
  type CommentComposerProps,
  type ComposerCarry,
} from "./comment-composer-slot";

/**
 * The task-comment editor (Lexical, plain text only).
 *
 * The editor owns only the DRAFT UI: one paragraph of plain text with line
 * breaks, known @mentions highlighted live as character-editable text. The
 * posted value, storage, and rendering pipeline are untouched — the parent
 * reads the raw draft through `onChange` and submits exactly `raw.trim()`,
 * the same bytes the textarea composer produced. No rich text, Markdown,
 * HTML, or editor state ever persists.
 *
 * Ruling 454: nothing imports this module statically. `comment-composer-slot`
 * loads it on idle or on the first focus, shows a same-size stand-in until
 * then, and hands over what was typed there through `carry`.
 */

/** Replaces the whole draft with `text`, caret at the end. */
function $replaceDraft(text: string): void {
  const root = $getRoot();
  const first = root.getFirstChild();
  if ($isParagraphNode(first)) {
    $setParagraphPlainText(first, text);
    return;
  }
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);
  $setParagraphPlainText(paragraph, text);
}

/** Takes over the stand-in's draft and focus, once, as the editor mounts. A
 *  layout effect: the stand-in hands them over in the same commit, and the
 *  first paint must already show the text in the editor. */
function CarryInPlugin({ carry }: { carry: RefObject<ComposerCarry | null> }) {
  const [editor] = useLexicalComposerContext();
  useLayoutEffect(() => {
    const draft = carry.current;
    carry.current = null;
    if (!draft) return;
    if (draft.text) {
      editor.update(() => {
        $replaceDraft(draft.text);
        // A selection would move the page's caret into the editor, taking
        // the focus from wherever the person went after typing here.
        if (!draft.focused) $setSelection(null);
      });
    }
    // The caret lands at the end of the carried text.
    if (draft.focused) editor.focus();
  }, [editor, carry]);
  return null;
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

export const CommentEditor = forwardRef<
  CommentComposerHandle,
  CommentComposerProps & { carry: RefObject<ComposerCarry | null> }
>(
  function CommentEditor(
    { mentionables, runPrincipal, onChange, onSubmit, carry },
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
            if ($getRoot().getTextContent().trim()) return;
            $replaceDraft(text);
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

    // Ruling 454 (CS-7): stable, since it reads only refs. OnChangePlugin
    // registers its update listener in an effect keyed on this function, so a
    // new one on each render (every keystroke inside an @token, every render
    // the page made) tore the listener down and registered it again.
    const handleChange = useCallback((editorState: EditorState) => {
      editorState.read(() => {
        const root = $getRoot();
        const text = root.getTextContent();
        const paragraph = root.getFirstChild();
        const caret = $isParagraphNode(paragraph) ? $caretOffsetIn(paragraph) : null;
        onChangeRef.current(text);
        menuRef.current.refreshFrom(text, caret);
      });
    }, []);
    const mentionNames = useMemo(() => mentionNamesFor(mentionables), [mentionables]);

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
              aria-label={COMPOSER_LABEL}
              aria-expanded={menu.open}
              aria-controls={menu.open ? menu.listId : undefined}
              aria-activedescendant={menu.activeId}
              aria-autocomplete="list"
              onBlur={menu.close}
            />
          }
          placeholder={<ComposerHint />}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin onChange={handleChange} ignoreSelectionChange={false} />
        <MentionHighlightPlugin names={mentionNames} />
        <ComposerKeysPlugin menuRef={menuRef} onSubmitRef={onSubmitRef} />
        {/* After OnChangePlugin, whose listener (a layout effect too) must
            exist before the carried draft lands. The mention transform needs
            no ordering: registering it re-runs it over the existing text. */}
        <CarryInPlugin carry={carry} />
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
