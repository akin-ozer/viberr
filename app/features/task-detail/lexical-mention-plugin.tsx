import {
  $createLineBreakNode,
  $createTextNode,
  $getSelection,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  TextNode,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type ParagraphNode,
  type SerializedTextNode,
} from "lexical";
import { findMentionSpans } from "~/ui/mention-spans";

/**
 * Known-@mention highlighting for the Lexical comment composer.
 *
 * A `MentionTextNode` is a NORMAL text node with the `.mention` class — fully
 * character-editable, exports/copies exactly its `@Name` text, and never
 * persists as anything but plain text. A paragraph-level transform keeps the
 * segmentation honest against the SAME matcher the rendered comments use
 * (`findMentionSpans`, P13-LV-12): text that becomes an exact known mention
 * is wrapped, a mention edited away from one is unwrapped.
 */

export class MentionTextNode extends TextNode {
  static getType(): string {
    return "viberr-mention";
  }

  static clone(node: MentionTextNode): MentionTextNode {
    return new MentionTextNode(node.__text, node.__key);
  }

  static importJSON(serialized: SerializedTextNode): MentionTextNode {
    return $createMentionTextNode(serialized.text).updateFromJSON(serialized);
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.classList.add("mention");
    return dom;
  }
}

export function $createMentionTextNode(text = ""): MentionTextNode {
  return new MentionTextNode(text);
}

export function $isMentionTextNode(
  node: LexicalNode | null | undefined,
): node is MentionTextNode {
  return node instanceof MentionTextNode;
}

/** The paragraph's plain text with line breaks as `\n`. Returns null when the
 *  paragraph holds anything but text and line-break nodes. */
function paragraphText(paragraph: ParagraphNode): string | null {
  let text = "";
  for (const child of paragraph.getChildren()) {
    if ($isLineBreakNode(child)) text += "\n";
    else if ($isTextNode(child)) text += child.getTextContent();
    else return null;
  }
  return text;
}

/** Collapsed-caret offset within `paragraph` as an absolute character offset
 *  into its plain text (line breaks count 1), or null. */
export function $caretOffsetIn(paragraph: ParagraphNode): number | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchor = selection.anchor;
  const anchorNode = anchor.getNode();
  if (anchor.type === "element") {
    if (anchorNode !== paragraph) return null;
    let offset = 0;
    const children = paragraph.getChildren();
    for (let i = 0; i < anchor.offset && i < children.length; i += 1) {
      const child = children[i]!;
      offset += $isLineBreakNode(child) ? 1 : child.getTextContent().length;
    }
    return offset;
  }
  let offset = 0;
  for (const child of paragraph.getChildren()) {
    if (child.getKey() === anchorNode.getKey()) return offset + anchor.offset;
    offset += $isLineBreakNode(child) ? 1 : child.getTextContent().length;
  }
  return null;
}

/** Place a collapsed caret at absolute offset `target` within `paragraph`. */
export function $setCaretOffsetIn(paragraph: ParagraphNode, target: number): void {
  let offset = 0;
  const children = paragraph.getChildren();
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]!;
    if ($isLineBreakNode(child)) {
      offset += 1;
      continue;
    }
    const length = child.getTextContent().length;
    if (target <= offset + length && $isTextNode(child)) {
      const inner = Math.max(0, target - offset);
      child.select(inner, inner);
      return;
    }
    offset += length;
  }
  paragraph.selectEnd();
}

/** Replace the paragraph's content with `text` (\n → line breaks), leaving
 *  mention wrapping to the transform. Restores the caret at `caret`. */
export function $setParagraphPlainText(
  paragraph: ParagraphNode,
  text: string,
  caret?: number,
): void {
  const nodes: LexicalNode[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      if (start < text.length) nodes.push($createTextNode(text.slice(start)));
      break;
    }
    if (nl > start) nodes.push($createTextNode(text.slice(start, nl)));
    nodes.push($createLineBreakNode());
    start = nl + 1;
  }
  paragraph.splice(0, paragraph.getChildrenSize(), nodes);
  if (caret !== undefined) $setCaretOffsetIn(paragraph, caret);
  else paragraph.selectEnd();
}

/** Current [start, end) ranges of mention nodes within the paragraph. */
function mentionRanges(paragraph: ParagraphNode): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let offset = 0;
  for (const child of paragraph.getChildren()) {
    const length = $isLineBreakNode(child) ? 1 : child.getTextContent().length;
    if ($isMentionTextNode(child)) {
      ranges.push({ start: offset, end: offset + length });
    }
    offset += length;
  }
  return ranges;
}

function resegment(paragraph: ParagraphNode, names: string[]): void {
  const text = paragraphText(paragraph);
  if (text === null) return;
  const spans = findMentionSpans(text, names)
    .filter((span) => span.known)
    .map(({ start, end }) => ({ start, end }));

  const current = mentionRanges(paragraph);
  const inSync =
    current.length === spans.length &&
    current.every((r, i) => r.start === spans[i]!.start && r.end === spans[i]!.end);
  if (inSync) return;

  const caret = $caretOffsetIn(paragraph);
  const nodes: LexicalNode[] = [];
  const pushPlain = (slice: string) => {
    let start = 0;
    for (;;) {
      const nl = slice.indexOf("\n", start);
      if (nl === -1) {
        if (start < slice.length) nodes.push($createTextNode(slice.slice(start)));
        break;
      }
      if (nl > start) nodes.push($createTextNode(slice.slice(start, nl)));
      nodes.push($createLineBreakNode());
      start = nl + 1;
    }
  };
  let pos = 0;
  for (const span of spans) {
    if (span.start > pos) pushPlain(text.slice(pos, span.start));
    nodes.push($createMentionTextNode(text.slice(span.start, span.end)));
    pos = span.end;
  }
  if (pos < text.length) pushPlain(text.slice(pos));

  paragraph.splice(0, paragraph.getChildrenSize(), nodes);
  if (caret !== null) $setCaretOffsetIn(paragraph, caret);
}

/**
 * Register the mention segmentation transform. `getNames` is read on every
 * run so the directory can change without re-registering. Transforms are
 * skipped mid-IME-composition (Lexical re-runs them on the settling update).
 */
export function registerMentionHighlighting(
  editor: LexicalEditor,
  getNames: () => string[],
): () => void {
  const apply = (node: TextNode) => {
    if (editor.isComposing()) return;
    const paragraph = node.getParent();
    if (!$isParagraphNode(paragraph)) return;
    resegment(paragraph, getNames());
  };
  const unregisterText = editor.registerNodeTransform(TextNode, apply);
  const unregisterMention = editor.registerNodeTransform(MentionTextNode, apply);
  return () => {
    unregisterText();
    unregisterMention();
  };
}
