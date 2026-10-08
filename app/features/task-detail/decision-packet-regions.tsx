import type { ReactNode } from "react";
import { PACKET_NOTE_MAX } from "~/schemas/task-file.schema";
import type { PacketRender } from "~/shared/mapping/task.server";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { Markdown } from "~/ui/markdown";
import { Pill } from "~/ui/pill";
import type { PacketChoice } from "./decision-packet-actions";
import {
  answerBoxCopy,
  confirmName,
  gateFor,
  type PacketStanding,
  type PacketTierGrants,
} from "./decision-packet-derive";

/**
 * The decision packet card's regions (ruling 700(e), the split of
 * `decision-packet.tsx` along the task-page recipe): the body, the options
 * (live, and locked once an `edit_goal` decision is made), the two answer
 * boxes, the refusals and notes under them, and the action row. Each takes
 * the slot its markup held in the card, which still decides whether it shows,
 * and calls no hook: the card owns the choice (`usePacketChoice`) and hands it
 * in, so its markup, and every id React derives from its place in the tree,
 * are what they were.
 */

/** Ties the Confirm button to its visible refusal reason (E4). On the
 *  repository question that reason is the card's one note (ruling 673),
 *  which describes each answer a person cannot give as well. */
const BLOCK_REASON_ID = "pkt-block-reason";
/** Ruling 147: where a refused Confirm says the directive is still empty. */
const CUSTOM_ERR_ID = "pkt-custom-err";
/** Ruling 478(e): where a refused Confirm says no answer is chosen yet. */
const CHOICE_ERR_ID = "pkt-choice-err";
/** Ruling 478(e): where a refused Confirm says the chosen answer needs text. */
const REPLY_ERR_ID = "pkt-reply-err";

/** Render a string with `inline code` spans; everything else stays plain text. */
function renderInlineCode(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<code key={i++}>{m[1]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
/**
 * Ruling 472: the body is the asking agent's own text, and agents write it as
 * markdown — numbered dashboard steps, bold field names, a heading per part.
 * Rendered through the inline-code pass alone, a 3,500-character Connect guide
 * read as one paragraph with literal `**` and `##` (WEB-3, 2026-09-24). It goes
 * through the same GFM renderer as the timeline's comments; a <div>, because a
 * list cannot sit inside a <p>.
 *
 * Ruling 478(f) (F40-35): the body's headings are parts of the question, so
 * they nest under the packet's own h2 title rather than standing beside it.
 */
export function PacketBody({ text }: { text: string }): ReactNode {
  return (
    <div className="packet-lede md-body">
      <Markdown text={text} headingBase={3} />
    </div>
  );
}

/** Ruling 500: an option's key, the digit that selects it (the radiogroup's
 *  shortcut), where the radio circle stood; filled once chosen. Past nine an
 *  option has no digit, and the key stays for the column. */
function OptionKey({ index }: { index: number }) {
  return (
    <span className="opt-key" aria-hidden="true">
      {index < 9 ? index + 1 : ""}
    </span>
  );
}

/**
 * N20-15: not inert — drops `@operator` into the comment composer below and
 * focuses it; sending that comment starts a real operator run (the mention
 * path). The title says so, because a click that only scrolls to an
 * already-focused composer looked like a no-op. Open to everyone, resolver or
 * not (commenting is app-wide). One button for the open and the decided packet
 * (ruling 657).
 */
function AskOperatorButton({ onAsk }: { onAsk: () => void }) {
  return (
    <button
      type="button"
      className="btn ghost"
      onClick={onAsk}
      title="Starts a comment mentioning @operator below. Send it to pull the operator in"
    >
      <Icon name="message" />
      Ask operator
    </button>
  );
}

/**
 * Ruling 138: a decided `edit_goal` packet reads as decided after a reload —
 * the chosen option locked, no Confirm, and one control that opens the goal
 * editor exactly as the confirm did. The decided card's `.packet-body`.
 */
export function DecidedPacketContent({
  packet: p,
  decided,
  busy,
  canEditGoal,
  onAsk,
  onEditGoal,
}: {
  packet: PacketRender;
  decided: NonNullable<PacketRender["decided"]>;
  busy: boolean;
  canEditGoal: boolean;
  onAsk: () => void;
  onEditGoal: ((draft: string) => void) | undefined;
}) {
  const chosen = p.options[decided.optionIndex];
  // F35-6: the draft is the mapping's one `goalDraft` (composed by
  // `goalDraftForOption` on the chosen option, `mapPacket`), rendered here
  // so a person who reloads SEES the requested goal, and handed to the
  // editor unchanged so both doors open the same text.
  const draft = p.goalDraft;
  return (
    <>
      <h2>{p.title}</h2>
      <PacketBody text={p.body} />
      <div className="options" data-decided="">
        {p.options.map((o, i) => (
          <button
            key={i}
            type="button"
            disabled
            aria-disabled="true"
            className={"opt" + (i === decided.optionIndex ? " sel" : "")}
            data-chosen={i === decided.optionIndex ? "" : undefined}
          >
            <OptionKey index={i} />
            <span>
              {/* U39-21: an option is written like the body, with `code`. */}
              <div className="ot">{renderInlineCode(o.t)}</div>
              <div className="od">{renderInlineCode(o.d)}</div>
            </span>
            {i === decided.optionIndex && (
              <span className="rec-tag">
                <Pill kind="info" sm>
                  chosen
                </Pill>
              </span>
            )}
          </button>
        ))}
      </div>
      <p className="deny-note spaced" data-decided-note="">
        <Icon name="check" />
        Decision made · save the edited goal to clear this packet
      </p>
      {draft && (
        <figure className="goal-draft">
          <figcaption className="fine dim">
            Requested goal (opens in the editor)
          </figcaption>
          <pre className="goal-draft-text">{draft}</pre>
        </figure>
      )}
      <div className="packet-actions">
        <AskOperatorButton onAsk={onAsk} />
        {canEditGoal && chosen && draft && onEditGoal && (
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => onEditGoal(draft)}
          >
            Edit the goal
          </button>
        )}
      </div>
    </>
  );
}

/**
 * The radiogroup: the packet's options, then the questionnaire's composed
 * free-text choice for a viewer who can resolve. Port addition (sanctioned):
 * arrow-key roving and digit shortcuts (spec §7 accessibility inventory).
 */
export function PacketOptions({
  packet: p,
  choice,
  grants,
  standing,
}: {
  packet: PacketRender;
  choice: PacketChoice;
  grants: PacketTierGrants;
  standing: PacketStanding;
}) {
  const { sel, tabStop, optionRefs, selectOption, choiceInvalid, choiceCount, customIndex, customSelected } =
    choice;
  // N20-16: a packet raised by the operator recommends its own default; one
  // raised by a delivering/reviewing agent (an ask_human question) carries the
  // AGENT's recommendation. Attributing every rec to "operator pick" was a lie
  // on the developer's own question packet — read the real author off `from`.
  const authoredByOperator = p.from === "Operator";
  return (
    <div
      className="options"
      role="radiogroup"
      aria-label="Decision options"
      aria-invalid={choiceInvalid || undefined}
      aria-describedby={choiceInvalid ? CHOICE_ERR_ID : undefined}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          e.preventDefault();
          choice.move(1);
        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
          e.preventDefault();
          choice.move(-1);
        } else if (/^[1-9]$/.test(e.key)) {
          // Questionnaire shortcut: a digit jumps to that choice (the
          // chips on each row advertise the mapping). Fires only inside
          // the radiogroup — the directive textarea lives outside it. An
          // inert option's digit does nothing, as its click does (UI-42).
          const target = Number(e.key) - 1;
          if (target < choiceCount && !choice.blockedOptions[target]) {
            e.preventDefault();
            selectOption(target);
            requestAnimationFrame(() => optionRefs.current[target]?.focus());
          }
        }
      }}
    >
      {p.options.map((o, i) => {
        // Whether this option is inert is `blockedOptions`
        // (decision-packet-derive.ts), which the arrows and digits read too;
        // what it says about itself, its hover title and the clause in its
        // description, is its gate's `option`.
        const refusal = gateFor(o.kind, grants)?.option ?? null;
        const blocked = choice.blockedOptions[i];
        return (
          <button
            key={i}
            type="button"
            role="radio"
            ref={(el) => {
              optionRefs.current[i] = el;
            }}
            aria-checked={sel === i}
            // Ruling 459: `aria-disabled` alone dims a blocked option and
            // stills its hover and press (`.opt[aria-disabled="true"]`
            // in app.css); the inline .55 it wore is gone.
            aria-disabled={blocked || undefined}
            aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
            tabIndex={tabStop === i ? 0 : -1}
            className={
              "opt" + (sel === i ? " sel" : "") + (o.rec ? " recommend" : "")
            }
            title={refusal?.title}
            aria-describedby={refusal && standing.saidOnce ? BLOCK_REASON_ID : undefined}
            onClick={() => {
              if (blocked) return;
              selectOption(i);
            }}
          >
            <OptionKey index={i} />
            <span>
              {/* U39-21: an option is written like the body, with `code`,
                  and printed its backticks ("It answered this on
                  \`7920943\` in this streak"). */}
              <div className="ot">{renderInlineCode(o.t)}</div>
              {/* The refusal belongs in the DESCRIPTION, not only in the
                  `title`: a title needs a pointer, and a keyboard or touch
                  user reading a dimmed option has nothing else to go on. */}
              <div className="od">
                {renderInlineCode(o.d)}
                {refusal?.note ?? ""}
              </div>
              {/* Ruling 269: a create_task option writes a NEW task, and
                until it is confirmed that task exists only inside the
                option's payload. Show what is about to be created — the
                title and the goal it will be worked to — so the person is
                confirming the task rather than the sentence describing it.
                Selected only: unselected, four options each carrying a
                goal would bury the choice. */}
              {o.kind === "create_task" && o.newTask && sel === i && (
                <span className="od pkt-new-task">
                  <strong>Creates {o.newTask.title}</strong>
                  {/* A task goal is a contract, and a good one runs to
                      paragraphs — it scrolls in place rather than pushing
                      the other choices off the card. */}
                  <span className="fine pkt-new-task-goal">{o.newTask.goal}</span>
                  {o.newTask.blockedBy && o.newTask.blockedBy.length > 0 && (
                    <span className="fine dim">
                      waits on {o.newTask.blockedBy.join(", ")}
                    </span>
                  )}
                  {/* Ruling 287: confirming this option also edits tasks
                      that are NOT on this page — it adds the new key to
                      each of these tasks' own waits. That is the one part
                      of a create_task decision a person cannot see the
                      consequence of anywhere else, so it is shown before
                      the confirm rather than discovered on another board
                      card afterwards. */}
                  {o.newTask.blocks && o.newTask.blocks.length > 0 && (
                    <span className="fine dim">
                      {o.newTask.blocks.join(", ")} will wait on it
                    </span>
                  )}
                </span>
              )}
            </span>
            {/* The destructive half of archive_task is loud: this option
                doesn't just file the task away, it deletes the remote
                branch. */}
            {o.kind === "archive_task" && o.deleteBranch && (
              <span className="rec-tag">
                <Pill kind="blocked" sm>
                  deletes branch
                </Pill>
              </span>
            )}
            {o.rec && (
              <span className="rec-tag">
                {/* N20-16: attribute the recommendation to whoever RAISED
                    the packet — "operator pick" was printed on a developer's
                    own ask_human question, crediting the operator for a rec
                    the developer made. */}
                <Pill kind="info" sm>
                  {authoredByOperator ? "operator pick" : "recommended"}
                </Pill>
              </span>
            )}
          </button>
        );
      })}
      {choice.customOffered && (
        // The questionnaire's composed free-text choice: an answer in the
        // human's own words, resolved server-side as the un-gated `custom`
        // kind. Its input renders below the group when selected.
        <button
          type="button"
          role="radio"
          ref={(el) => {
            optionRefs.current[customIndex] = el;
          }}
          aria-checked={customSelected}
          aria-keyshortcuts={customIndex < 9 ? String(customIndex + 1) : undefined}
          tabIndex={tabStop === customIndex ? 0 : -1}
          className={"opt opt-custom" + (customSelected ? " sel" : "")}
          onClick={() => selectOption(customIndex)}
        >
          <OptionKey index={customIndex} />
          <span>
            {/* Ruling 478(e) (F40-31): on an agent's question the words go
                back to that agent (`resolvePacket`), not to the operator.
                The title stays: the controller's briefing names this
                choice by it. */}
            <div className="ot">Write your own directive</div>
            <div className="od">
              {p.answerTo
                ? `Answer in your own words. It goes back to ${p.answerTo}, which carries on from where it stopped.`
                : "Answer in your own words. The operator re-engages with exactly what you type."}
            </div>
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * Ruling 478(e) under ruling 147: a Confirm with nothing chosen is refused
 * here, a fresh alert per press, focus on the first choice the viewer can
 * make (the group's tab stop).
 */
export function ChoiceRefusal({ choice }: { choice: PacketChoice }) {
  return (
    <p
      key={`choice-${choice.refused}`}
      id={CHOICE_ERR_ID}
      className={"deny-note spaced" + (choice.refusalShake.shake ? " refused" : "")}
      onAnimationEnd={choice.refusalShake.onAnimationEnd}
      role="alert"
    >
      <Icon name="alert" />
      Choose an answer above first.
    </p>
  );
}

/** The directive's box, while the composed free-text choice is selected. */
export function DirectiveField({
  choice,
  answerTo,
}: {
  choice: PacketChoice;
  answerTo: string | undefined;
}) {
  const { customInvalid, refusalShake } = choice;
  return (
    <div className="field packet-note-field">
      <label className="flabel" htmlFor="pkt-custom">
        Your directive<span className="req">*</span>
        <span className="fhint">
          resolves this decision ·{" "}
          {answerTo ? `goes back to ${answerTo}` : "handed to the operator"}
        </span>
      </label>
      <textarea
        id="pkt-custom"
        ref={choice.customRef}
        className="packet-note"
        value={choice.customText}
        onChange={(e) => choice.setCustomText(e.target.value)}
        aria-invalid={customInvalid || undefined}
        aria-describedby={customInvalid ? CUSTOM_ERR_ID : undefined}
        // Ruling 646 (643's rule, on the box it missed): a required
        // answer has no example. Ruling 291's merge-and-rebase directive
        // sat under every agent's question on every board, a Free Tier
        // stance on the AWS estimates board included.
        rows={2}
        data-autofocus=""
      />
      {customInvalid && (
        <p
          key={`refused-${choice.refused}`}
          id={CUSTOM_ERR_ID}
          className={"deny-note spaced" + (refusalShake.shake ? " refused" : "")}
          onAnimationEnd={refusalShake.onAnimationEnd}
          role="alert"
        >
          <Icon name="alert" />
          Write the directive first.
        </p>
      )}
    </div>
  );
}

/**
 * The one input on the app's highest-stakes card wears the same form language
 * as every other input: `.field` + uppercase label + hint (owner feedback
 * 2026-07-26 — it was a bare textarea outside `.field`, so none of the
 * border/focus/typography tokens applied). When it stands is
 * `showsAnswerBox` (decision-packet-derive.ts).
 */
export function PacketNoteField({
  choice,
  answerTo,
}: {
  choice: PacketChoice;
  answerTo: string | undefined;
}) {
  const { connectsRepository, needsReply, replyInvalid, answer } = choice;
  const copy = answerBoxCopy(connectsRepository, answerTo, needsReply);
  return (
    <div className="field packet-note-field">
      <label className="flabel" htmlFor="pkt-note">
        {copy.label}
        {needsReply && <span className="req">*</span>}
        <span className="fhint">
          {/* Ruling 315: the length is stated BEFORE it matters. The route
              used to cut this to 2,000 characters with nothing on the box
              saying so, and the server now refuses instead — a refusal a
              person could not see coming is a worse trade than the cut it
              replaced unless the box says the number. */}
          {connectsRepository ? (
            // Ruling 672: what the box is, and that nothing changes
            // until GitHub answers for the repository.
            "required · owner/name · checked on GitHub before anything changes"
          ) : (
            <>
              {needsReply ? "required" : "optional"} ·{" "}
              {answerTo ? `goes back to ${answerTo} with your choice` : "recorded on the decision"} ·{" "}
              {PACKET_NOTE_MAX.toLocaleString("en-US")} characters max
            </>
          )}
        </span>
      </label>
      <textarea
        id="pkt-note"
        ref={choice.noteRef}
        className="packet-note"
        value={answer}
        onChange={(e) => choice.setAnswer(e.target.value)}
        aria-invalid={replyInvalid || undefined}
        aria-describedby={replyInvalid ? REPLY_ERR_ID : undefined}
        placeholder={copy.placeholder}
        rows={1}
        // The browser stops the paste at the cap rather than letting the
        // server refuse a confirm the person has already committed to.
        maxLength={PACKET_NOTE_MAX}
      />
      {replyInvalid && (
        <p
          key={`reply-${choice.refused}`}
          id={REPLY_ERR_ID}
          className={"deny-note spaced" + (choice.refusalShake.shake ? " refused" : "")}
          onAnimationEnd={choice.refusalShake.onAnimationEnd}
          role="alert"
        >
          <Icon name="alert" />
          {copy.refusal}
        </p>
      )}
      {answer.length > PACKET_NOTE_MAX - 200 && (
        <p className="fine dim">
          {answer.length.toLocaleString("en-US")} of{" "}
          {PACKET_NOTE_MAX.toLocaleString("en-US")} characters.
        </p>
      )}
    </div>
  );
}

/**
 * Ruling 324: the echoes of the SELECTED option, under the choice they are
 * about. Silent when the selection creates nothing, and silent when nothing on
 * the board resembles it — a disclosure a person learns to skip is worse than
 * no disclosure.
 */
export function CreateTaskEchoes({
  echoes,
  sel,
}: {
  /** The selected option's echoes; the card shows this only when there are some. */
  echoes: { key: string; title: string; stage: string }[];
  sel: number;
}) {
  return (
    <div className="deny-note spaced" data-create-task-echoes={sel}>
      <Icon name="board" />
      <span>
        This project already has{" "}
        {echoes.length === 1 ? "a task" : "tasks"} that look like
        this:{" "}
        {echoes.map((t, i, all) => (
          <span key={t.key}>
            <strong>{t.key}</strong> &ldquo;{t.title}&rdquo; ({t.stage})
            {i < all.length - 1 ? ", " : ""}
          </span>
        ))}
        . Confirming still creates a new one, so check it is not a second owner for
        work one of these already holds.
      </span>
    </div>
  );
}

/** The selected option's refusal beside Confirm (E4), unless the card says
 *  who answers once (ruling 673, `blockReasonShown`). */
export function BlockReasonNote({ blockReason }: { blockReason: string }) {
  return (
    <p className="deny-note spaced" id={BLOCK_REASON_ID}>
      <Icon name="lock" />
      {blockReason}
    </p>
  );
}

/**
 * F20-17: the viewer cannot resolve this packet at all — say who can, once,
 * instead of leaving a live-looking radiogroup with no Confirm.
 */
export function ResolveRefusalNote({ standing }: { standing: PacketStanding }) {
  return (
    <p className="deny-note spaced" id={standing.saidOnce ? BLOCK_REASON_ID : undefined}>
      <Icon name="lock" />
      {standing.boardDecision ? (
        // Ruling 672: neither a maintainer nor the task's owner can
        // answer the repository question, so the note names who does.
        <>
          You can&rsquo;t answer this decision: both answers decide the
          board, so a project admin gives one. You can still comment or
          ask the operator below.
        </>
      ) : (
        <>
          You can&rsquo;t resolve this decision: a maintainer, an admin, or
          this task&rsquo;s owner can. You can still comment or ask the
          operator below.
        </>
      )}
    </p>
  );
}

/**
 * F20-18: a contributor-OWNER may open this card (owner exception) but EVERY
 * option re-checks a higher tier, so there is nothing they can settle. Name
 * that, and hand the decision UP to a maintainer instead of leaving them
 * stranded (server: requestPacketMaintainerDecision).
 */
export function EscalationNote({
  standing,
  taskKey,
  busy,
  escalating,
  onRequestMaintainer,
}: {
  standing: PacketStanding;
  /** The task's key, when the page wired the archive disclosure. */
  taskKey: string | undefined;
  busy: boolean;
  escalating: boolean;
  onRequestMaintainer: (() => void) | undefined;
}) {
  const { boardDecision } = standing;
  return (
    <div className="deny-note spaced" id={standing.saidOnce ? BLOCK_REASON_ID : undefined}>
      <Icon name="lock" />
      <span>
        {boardDecision ? (
          <>
            Both answers decide the board, so a project admin gives one.
            You can still answer with your own directive above.
          </>
        ) : (
          <>
            Every listed option needs maintainer or admin authority. You own{" "}
            {taskKey ?? "this task"} and raised this
            decision, but settling it with one of them is above your role. You
            can still answer with your own directive above.
          </>
        )}
        {onRequestMaintainer && (
          <>
            {" "}
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy || escalating}
              aria-busy={escalating || undefined}
              onClick={onRequestMaintainer}
            >
              <GlyphSwap rest="message" alt="loader" on={escalating} spinAlt />
              {escalating
                ? "Sending…"
                : boardDecision
                  ? "Send to a project admin"
                  : "Send to a maintainer"}
            </button>
          </>
        )}
      </span>
    </div>
  );
}

/** The action row: "Ask operator", then the primary Confirm for a viewer who
 *  can resolve. */
export function PacketActions({
  choice,
  canResolve,
  busy,
  onAsk,
}: {
  choice: PacketChoice;
  canResolve: boolean;
  busy: boolean;
  onAsk: () => void;
}) {
  const { blockReason } = choice;
  return (
    <div className="packet-actions">
      {/* FIRST in the row: actions end on the primary commit (flex-end). */}
      <AskOperatorButton onAsk={onAsk} />
      {canResolve && (
        <button
          type="button"
          className="btn primary"
          // Ruling 147: only a request in flight is a real `disabled` here.
          // An empty directive is REFUSED below instead, in a sentence; a
          // ROLE refusal stays focusable so its reason is reachable. The
          // sheet dims it (`.btn[aria-disabled="true"]`, ruling 459) and
          // keeps it from hovering or pressing like a live button.
          disabled={busy}
          aria-disabled={blockReason !== null || undefined}
          aria-describedby={blockReason ? BLOCK_REASON_ID : undefined}
          aria-busy={busy}
          aria-label={confirmName(choice.selected, choice.customSelected)}
          onClick={choice.confirm}
        >
          <Icon name="check" />
          {/* A concise, stable label — echoing the full (often multi-line)
              option title here overflowed the flex button and rendered the
              text overlapping itself (F-UI1). The chosen option is already
              highlighted in the radiogroup above, and the accessible name
              (aria-label) states the selection for non-visual users. */}
          Confirm decision
        </button>
      )}
    </div>
  );
}
