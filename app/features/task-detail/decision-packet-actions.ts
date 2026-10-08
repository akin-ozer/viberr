import {
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { PacketRender } from "~/shared/mapping/task.server";
import { useRefusalShake, type RefusalShake } from "~/ui/use-refusal-shake";
import {
  CONFIRM_FIRST_KINDS,
  initialChoice,
  initialRepository,
  packetChoiceView,
  type PacketChoiceView,
  type PacketTierGrants,
} from "./decision-packet-derive";

/**
 * The decision packet card's choice (ruling 700(e), the split of
 * `decision-packet.tsx` along the task-page recipe): what the person chose and
 * typed, the refusals a Confirm meets, the ask-first ceremony it opens, and
 * the re-seed when the packet is replaced. `DecisionPacket` calls the one hook
 * here where its state always lived, so every hook keeps its place, and hands
 * the result to its hook-free regions. No component lives here, so the module
 * is not a Fast Refresh boundary.
 */

type PacketOption = PacketRender["options"][number];

/** `usePacketChoice`'s result: the choice, what the card reads off it, and
 *  the handlers that change it. */
export interface PacketChoice extends PacketChoiceView {
  sel: number;
  /** Every choice goes through here, and a change drops a standing refusal:
   *  a pristine directive is never accused (ruling 147). The checked choice
   *  chosen again is no change, so its refusal stands. */
  selectOption: (i: number) => void;
  /** An arrow key's step through the choices, past an inert one (UI-44). */
  move: (delta: number) => void;
  optionRefs: RefObject<(HTMLButtonElement | null)[]>;
  noteRef: RefObject<HTMLTextAreaElement | null>;
  customRef: RefObject<HTMLTextAreaElement | null>;
  customText: string;
  setCustomText: Dispatch<SetStateAction<string>>;
  setAnswer: Dispatch<SetStateAction<string>>;
  refused: number;
  refusalShake: RefusalShake;
  /** The option whose ask-first ceremony is open, if any. */
  pendingOption: PacketOption | undefined;
  /** The Confirm button's press. */
  confirm: () => void;
  cancelConfirm: () => void;
  commitConfirm: () => void;
}

export function usePacketChoice(
  p: PacketRender,
  canResolve: boolean,
  grants: PacketTierGrants,
  onResolve: (optionIndex: number, note: string) => void,
  onResolveCustom: (text: string) => void,
): PacketChoice {
  const [sel, setSel] = useState(() => initialChoice(p));
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // P11-71: optional free-text so a human can supply the input an option asks
  // for (e.g. "specify the expected behavior") instead of resolving with an
  // unstated reading. Recorded on the decision event. Ruling 478(e): required
  // when the chosen option is one the asking agent marked `reply`.
  const [note, setNote] = useState("");
  // Ruling 672: the repository a `connect_repository` answer attaches is the
  // person's typed answer, kept apart from the note so choosing the other
  // answer does not carry a repository name into its record. It opens with
  // the repository the operator could name.
  const [repository, setRepository] = useState(() => initialRepository(p));
  const [customText, setCustomText] = useState("");
  // Ruling 147: Confirm stays enabled with the directive still empty, and the
  // click is refused here. Counted, so a repeated press inserts a fresh alert;
  // reset by every choice change, so returning to the directive is pristine.
  const [refused, setRefused] = useState(0);
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(refused);
  const customRef = useRef<HTMLTextAreaElement>(null);
  const selectOption = (i: number) => {
    if (i === sel) return;
    setSel(i);
    setRefused(0);
  };
  // UX19-9 / F20-6 / F31-6: the option index whose ask-first ceremony is open
  // (null = none). ONE slot, not one per kind: the open ceremony is chosen by
  // the pending option's own `kind`, so two can never stand at once.
  const [pendingConfirm, setPendingConfirm] = useState<number | null>(null);
  // F10-09: a packet can be replaced while its card is open, and the
  // revalidation hands the card the new one in place. Everything above that
  // the person chose or typed belongs to the packet it was seeded from, so a
  // new id re-seeds it all (the refusal's shake follows `refused` back to
  // none). In place, not by a key: a remount would take the `completion`
  // slot with it, the inline reader and its unsent notes (rulings 484(b),
  // 521(d)), and drop the person's focus to <body>. A packet written before
  // ids has none, so it is never re-seeded.
  const [seededFrom, setSeededFrom] = useState(p.id);
  if (p.id !== seededFrom) {
    setSeededFrom(p.id);
    setSel(initialChoice(p));
    setNote("");
    setRepository(initialRepository(p));
    setCustomText("");
    setRefused(0);
    setPendingConfirm(null);
  }
  const view = packetChoiceView(p, { sel, note, repository, customText, refused }, canResolve, grants);
  const { choiceCount, customSelected, selected, blockReason, noChoice, needsReply, answer, tabStop } =
    view;
  const setAnswer = view.connectsRepository ? setRepository : setNote;
  // F10-09: a re-seed can itself take away the control that held focus (the
  // directive box, an option past the replacement's last), and focus then
  // falls to <body>, where keys neither reach the card nor scroll `.detail`
  // (G7). Hand it to the replacement's tab stop before paint: only after a
  // re-seed, and only from <body>, so focus the re-seed kept stays put.
  const focusSeed = useRef(seededFrom);
  useLayoutEffect(() => {
    if (focusSeed.current === seededFrom) return;
    focusSeed.current = seededFrom;
    if (document.activeElement === document.body) {
      optionRefs.current[tabStop]?.focus({ preventScroll: true });
    }
  }, [seededFrom, tabStop]);

  // The open ask-first ceremony, chosen by the pending option's own `kind`. The
  // list is re-read every render rather than captured at click time, so a packet
  // that changes underneath an open dialog with no new id re-derives it (or
  // drops it) instead of leaving a ceremony describing an option that is gone.
  // A new id closes it (F10-09, above).
  const pendingOption =
    pendingConfirm === null ? undefined : p.options[pendingConfirm];
  const cancelConfirm = () => setPendingConfirm(null);
  const commitConfirm = () => {
    if (pendingConfirm === null) return;
    // No setPendingConfirm(null): the dialog plays its exit, then
    // cancelConfirm clears it (ruling 459).
    onResolve(pendingConfirm, answer);
  };

  // UI-44: roving tabindex + real focus movement. Every `role="radio"` used to
  // stay tabbable and the arrow handler only changed `sel`, so DOM focus stayed
  // on the previously focused radio while `aria-checked` moved elsewhere — a
  // screen-reader user got no feedback from the app's highest-stakes control,
  // and Tab walked every option.
  const move = (delta: number) => {
    if (choiceCount === 0) return;
    // Keep the focus side effect out of the state updater — updaters can run
    // more than once, which would schedule the frame twice. `sel` is current
    // here (this only runs from a keydown handler), matching the click path at
    // the option buttons (`PacketOptions`).
    // Ruling 478(e): with nothing chosen, an arrow moves from the choice that
    // has focus (the group's tab stop), or enters the list at its nearest end.
    const from =
      sel >= 0 ? sel : optionRefs.current.findIndex((el) => el === document.activeElement);
    // UI-42: an arrow passes an inert option by, as its click does nothing
    // (a disabled radio in the APG radio group), and with every choice inert
    // it does nothing at all. With none but the checked one reachable it
    // lands on that one again, which `selectOption` counts as no change, so
    // a standing refusal stays (ruling 147).
    const { blockedOptions } = view;
    let next = from < 0 ? (delta > 0 ? -1 : choiceCount) : from;
    for (let tried = 0; tried < choiceCount; tried++) {
      next = (next + delta + choiceCount) % choiceCount;
      if (!blockedOptions[next]) break;
    }
    if (blockedOptions[next]) return;
    selectOption(next);
    requestAnimationFrame(() => optionRefs.current[next]?.focus());
  };

  const confirm = () => {
    if (blockReason) return;
    // The custom choice resolves with the typed directive — it
    // never accepts, archives or merges, so no ceremony interposes.
    if (customSelected) {
      if (customText.trim()) {
        onResolveCustom(customText);
      } else {
        // Ruling 147: refuse in place, name the field, and never
        // let the attempt become a request.
        setRefused((n) => n + 1);
        customRef.current?.focus();
      }
      return;
    }
    // Ruling 478(e) under ruling 147: nothing chosen, or a choice
    // the asking agent marked as needing a typed answer with the
    // box still empty, is refused in place: the alert names it and
    // focus lands where the person must act. Never a request.
    if (noChoice) {
      setRefused((n) => n + 1);
      optionRefs.current[tabStop]?.focus();
      return;
    }
    if (needsReply && answer.trim() === "") {
      setRefused((n) => n + 1);
      noteRef.current?.focus();
      return;
    }
    // The packet's one-way halves ask first (rulings 20/53), each
    // through its own ceremony (decision-packet-ceremonies.tsx). They used
    // to commit from this generic "Confirm decision" while the *reversible*
    // Archive button beside them asked.
    if (selected && CONFIRM_FIRST_KINDS.has(selected.kind)) {
      setPendingConfirm(sel);
      return;
    }
    onResolve(sel, answer);
  };

  return {
    ...view,
    sel,
    selectOption,
    move,
    optionRefs,
    noteRef,
    customRef,
    customText,
    setCustomText,
    setAnswer,
    refused,
    refusalShake,
    pendingOption,
    confirm,
    cancelConfirm,
    commitConfirm,
  };
}
