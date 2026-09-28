import type { DatabaseSync } from "node:sqlite";
import { findUserById } from "~/server/auth/user-store.server";
import { isBackendAvailableFor } from "~/server/runtimes/backend-credentials.server";
import { substituteRunModel } from "~/server/runtimes/model-catalog.server";
import {
  backendDispatchHold,
  latestBackendRateLimits,
} from "~/server/runtimes/backend-quota.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { formatClockUTC, utcDayKey,
  formatCalendarDateUTC,
} from "~/shared/dates/format";
import { formatUsd, localNetworkFailureCode } from "~/shared/run-failure";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { endSentence } from "~/shared/text/sentence";
import type { RunFailure } from "./agent-reply.server";
import type { OperatorPacketOptionInput } from "./operator-actions.server";
import { SESSION_STORE_UNREADABLE_MARK } from "~/server/runtimes/session-export.server";

/**
 * Ruling 130 (pass 34, F34-1 / F34-12 / Q34-7): the ONE home for
 * failure-to-words, for operator and specialist runs alike.
 *
 * Live: a five-hour session limit and a 403 `oauth_org_not_allowed` were both
 * `run·error·unknown`; the operator's recovery packet recommended "I've
 * updated the policy / credential"; the resolved decision was recorded as
 * "policy / credential updated"; and an operator acting on that record told a
 * specialist a GitHub-scope block had been lifted (JC-6), undoing the owner's
 * decision. Under ruling 127 the remedy for `quota` and `auth` belongs to the
 * credential principal (the task owner): wait until the reset instant, or
 * switch to or connect a different account (or an API key) on Profile → Agent accounts.
 * Generic advice ("fix the credential", "retry on the other backend", "review
 * the runtime configuration") is never written for a classified refusal, and
 * a recovery option's label states only what the human asserts.
 */
export interface DescribeRunFailureInput {
  failure: RunFailure | null;
  backend: RealBackend;
  taskKey: string;
  /** The task owner (ruling 127's credential principal); null when unowned. */
  ownerUserId: string | null;
  /** Whose run failed: the operator's own, or an engaged specialist's. */
  role: "operator" | "specialist";
  /** The specialist's @mention handle (specialist packets name it). */
  agentHandle?: string;
  /** The failed specialist's profile id, carried on the `retry_other_backend`
   *  option so the retry re-runs the same profile. */
  profileId?: string;
  /** F36-8: the profile's resolved model on ITS backend, so the
   *  `retry_other_backend` option can say which model the retry will run on
   *  (the other backend's default when this id is foreign there). Absent for
   *  a profile nobody can resolve; the option then names the default without
   *  claiming why. */
  profileModel?: string;
  dataRoot?: string;
  /** Test seam for the reset-label clock; defaults to now. */
  now?: Date;
}

export interface RunFailureDescription {
  /** One sentence: what happened (no remedy). */
  reason: string;
  /** One or two sentences: the person's own move, or the generic remedy. */
  remedy: string;
  /** The absolute UTC reset label ("Sep 3, 2026 · 11:50 UTC"), when known. */
  resetLabel: string | null;
  /** The owner's display name, when the task has one Viberr can resolve. */
  owner: { userId: string; name: string } | null;
  /** The recovery options, recommended one first. */
  options: OperatorPacketOptionInput[];
}

/** "Sep 3, 2026 · 11:50 UTC": absolute, never relative (a packet is read hours
 *  later; "today" would be a lie by then). */
export function formatResetLabel(resetsAt: string | null | undefined): string | null {
  if (!resetsAt || Number.isNaN(Date.parse(resetsAt))) return null;
  // Pass 34 review: the clock below is UTC, so the DAY must be too — pairing a
  // host-zone calendar date with a UTC clock and labelling the pair "UTC" is
  // wrong by up to a day on either side of midnight.
  const day = formatCalendarDateUTC(resetsAt) ?? utcDayKey(resetsAt);
  return `${day} · ${formatClockUTC(resetsAt)} UTC`;
}

function windowWord(window: string | null | undefined): string {
  switch (window) {
    case "five_hour":
      return "five-hour usage window";
    case "seven_day":
    case "weekly":
      return "weekly usage window";
    case "monthly":
      return "monthly usage window";
    default:
      return "usage window";
  }
}

/**
 * Ruling 224: the reset instant viberr actually knows, when the run's own
 * failure facts do not carry one.
 *
 * `RunFailureFacts.resetsAt` is set only from a machine `rate_limit_event` the
 * provider sent during the run. A Codex refusal at spawn time sends no such
 * event — but its SENTENCE names the date, the quota store parses it
 * (`parseQuotaResetAt`) and keeps it on the backend's exhaustion record. That
 * record is the same one Insights and the Profile page render, so reading it
 * here makes the packet agree with every other surface rather than inventing a
 * second source of truth. An expired record is already dropped by the reader.
 */
function storedQuotaResetIso(db: DatabaseSync, backend: RealBackend): string | null {
  try {
    const row = latestBackendRateLimits(db).find((r) => r.backend === backend);
    const seconds = row?.exhausted?.resetsAt ?? null;
    if (seconds === null || !Number.isFinite(seconds)) return null;
    return new Date(seconds * 1000).toISOString();
  } catch {
    // A reading that cannot be taken is not a reason to fail a failure
    // description — the packet simply loses the wait option.
    return null;
  }
}

export function describeRunFailure(
  db: DatabaseSync,
  input: DescribeRunFailureInput,
): RunFailureDescription {
  const backend = BACKEND_LABEL[input.backend];
  /** What an org-level restriction names: the product, not the model. */
  const product = input.backend === "claude" ? "Claude Code" : "Codex";
  const other: RealBackend = input.backend === "codex" ? "claude" : "codex";
  const kind = input.failure?.kind ?? "unknown";
  const facts = input.failure?.facts;
  // Ruling 224 (F37-44), second correction: the FACTS carry a reset instant
  // only when the provider sent a machine `rate_limit_event` this run —
  // Codex's spawn-time refusal sends none, so `facts.resetsAt` is null on
  // exactly the failure that stalls a board. Viberr does know the instant: the
  // quota store parsed it out of the provider's own sentence ("try again at
  // Sep 14th, 2026 2:27 AM") and holds it as `exhausted.resetsAt`. Read the
  // store when the facts are silent, or the wait this ruling added never
  // appears on the packet it was written for — which is what the first deploy
  // proved, live, on a board with four stalled tasks.
  const resetsAt = facts?.resetsAt ?? storedQuotaResetIso(db, input.backend);
  const resetLabel = formatResetLabel(resetsAt);
  const ownerRecord = input.ownerUserId ? findUserById(db, input.ownerUserId) : null;
  const owner = ownerRecord ? { userId: ownerRecord.id, name: ownerRecord.name } : null;
  /**
   * Ruling 326: CONNECTED is not the question. RUNNABLE NOW is.
   *
   * This used to ask only whether the owner has the other backend connected,
   * and every option and sentence built on it promises a retry that happens
   * NOW — "Retry @agent on Codex now", "or the run is retried on Codex". When
   * that backend is itself out of quota, the promise is false, and
   * `operatorOpenPacket` says so in its own words and REFUSES THE WHOLE PACKET:
   * "the dispatch would be HELD and re-scheduled rather than run, so the person
   * would spend a decision on a wait."
   *
   * Two parts of the same server disagreed, and the composer was the wrong one.
   * Measured on the shopify-clone board: Arda's Codex was recorded out of quota
   * from 2026-09-15 03:26 until 2026-09-19, and EVERY Claude failure inside
   * that window composed a packet the authoring guard then refused — eleven
   * times, in three bursts, each burst one account failure taking out several
   * tasks at once. Each of the eleven left a note saying only that "the
   * recovery packet could not be opened" (ruling 325) and no packet at all. For
   * four days this board could not escalate a stalled task.
   *
   * A held backend is a backend the owner has; it is not one the retry can use.
   */
  const otherHold =
    input.ownerUserId !== null
      ? backendDispatchHold(db, other, { credentialUserId: input.ownerUserId })
      : null;
  const ownerHasOther =
    input.ownerUserId !== null &&
    otherHold === null &&
    isBackendAvailableFor(db, input.ownerUserId, other, input.dataRoot ? { dataRoot: input.dataRoot } : {});
  const whose = owner ? `${owner.name}'s` : "the task owner's";
  const profile = "Profile → Agent accounts";
  const runWord = input.role === "operator" ? "the operator run" : "the agent run";

  let reason: string;
  let remedy: string;
  switch (kind) {
    case "quota": {
      const window = windowWord(facts?.window);
      reason = facts?.windowRejected
        ? `${backend} refused ${runWord}: ${whose} ${window} is spent${resetLabel ? ` and reopens at ${resetLabel}` : ""}.`
        : `${backend} refused ${runWord}: ${whose} account is over its usage limit${resetLabel ? ` until ${resetLabel}` : ""}.`;
      remedy = owner
        ? `${owner.name} can wait until the window reopens${resetLabel ? ` (${resetLabel})` : ""}, or switch to or connect a different ${backend} account (or an API key) on ${profile}.`
        : `The task has no owner to bill; seat an owner whose ${backend} account has room, or wait for the window to reopen${resetLabel ? ` (${resetLabel})` : ""}.`;
      break;
    }
    case "auth": {
      const code = facts?.apiError ?? null;
      const status = facts?.apiErrorStatus ?? null;
      const detail =
        code === "oauth_org_not_allowed"
          ? `the account's organization does not allow ${product}`
          : status === 403
            ? `the provider refused the account (HTTP 403${code ? `, ${code}` : ""})`
            : `the provider rejected the credential${status ? ` (HTTP ${status})` : ""}${code ? `, ${code}` : ""}`;
      reason = `${backend} refused ${runWord}: ${detail}.`;
      remedy = owner
        ? `${owner.name} can switch to or connect a different ${backend} account (or an API key) on ${profile}${code === "oauth_org_not_allowed" ? ", or have the organization enable it" : ""}. Retrying with the same account fails the same way.`
        : `The task has no owner to bill; seat an owner whose ${backend} account the provider accepts.`;
      break;
    }
    case "unavailable":
      // Ruling 127: the run's own line already names the person and their
      // remedy; that sentence is the reason and the remedy.
      reason = input.failure?.text
        ? endSentence(input.failure.text)
        : `${backend} could not run ${runWord}: no usable credential.`;
      remedy = owner
        ? `${owner.name} connects ${backend} on ${profile}${ownerHasOther ? `, or the run is retried on ${BACKEND_LABEL[other]}` : ""}.`
        : `Seat an owner who has ${backend} connected on ${profile}.`;
      break;
    case "overloaded": {
      // The provider's side, not the account's: nobody has a move to make on
      // Profile, so the remedy is the one thing that is true — retry, on the
      // same backend once the provider recovers or on the other one now.
      // U35-11 (pass 35): unless the request never reached the provider. A
      // connection that failed in this deployment's own environment (TLS,
      // DNS, a refused socket) keeps the retry but is attributed to where it
      // happened, never to "the provider's own side".
      if (facts?.origin === "local") {
        const networkCode = localNetworkFailureCode(input.failure?.providerText ?? input.failure?.text ?? "");
        reason = `${backend} could not be reached from this deployment: the connection failed before the provider answered${networkCode ? ` (${networkCode})` : ""}.`;
        remedy = `Nothing about ${whose} account or the task is wrong; the fault is on this deployment's network path (TLS, DNS or a proxy). Retry in a few minutes${ownerHasOther ? `, or run it on ${BACKEND_LABEL[other]} now` : ""}.`;
        break;
      }
      const status = facts?.apiErrorStatus ?? null;
      const code = facts?.apiError ?? null;
      const overloaded = status === 529 || code === "overloaded";
      reason = `${backend} could not serve ${runWord}: the provider ${overloaded ? "was overloaded" : "failed on its own side"}${status ? ` (HTTP ${status}${code && code !== "overloaded" ? `, ${code}` : ""})` : code ? ` (${code})` : ""}.`;
      remedy = `Nothing about ${whose} account or the task is wrong. Retry in a few minutes${ownerHasOther ? `, or run it on ${BACKEND_LABEL[other]} now` : ""}.`;
      break;
    }
    case "max_turns":
      reason = `${runWord.charAt(0).toUpperCase()}${runWord.slice(1)} hit its turn cap before finishing.`;
      remedy = "Re-run it with a narrower directive, or split the work.";
      break;
    case "max_budget": {
      // Ruling 175: the instance's spending cap, not the task, ended the run.
      // Both figures come from the adapter's typed record.
      const cap = facts?.spendCapUsd;
      const spent = facts?.spentUsd;
      reason =
        `${runWord.charAt(0).toUpperCase()}${runWord.slice(1)} was cut off by the instance's spending cap` +
        `${cap !== undefined ? ` of ${formatUsd(cap)}` : ""}${spent !== undefined ? ` after spending ${formatUsd(spent)}` : ""}.`;
      remedy =
        "Re-run it to continue from its session, or have an org admin raise the cap in Instance settings (Max spend per Claude run).";
      break;
    }
    case "idle_timeout":
      reason = `${runWord.charAt(0).toUpperCase()}${runWord.slice(1)} produced nothing for the whole idle window and was stopped.`;
      remedy = "Re-run it; if it hangs again, inspect the session for what it was waiting on.";
      break;
    case "session_missing":
      // Ruling 221 (F37-41): two roads to one class, and the difference is
      // what a human does next. A vanished session heals itself on the next
      // fresh run; a session STORE that cannot be opened keeps failing every
      // resume on this host until someone repairs or removes the file, so the
      // sentence has to say which one this was.
      if ((input.failure?.text ?? "").includes(SESSION_STORE_UNREADABLE_MARK)) {
        reason =
          "The provider's own session store on this host could not be opened, so this run could not resume its conversation.";
        remedy =
          "Re-run it: a fresh session re-anchors on task.md and continues. Every resume keeps failing until that store file is repaired or removed, so if this repeats, that file is the thing to fix.";
      } else {
        reason = "The provider session this run tried to resume no longer exists.";
        remedy = "Re-run it: a fresh session re-anchors on task.md and continues.";
      }
      break;
    default:
      reason = input.failure?.text
        ? `${runWord.charAt(0).toUpperCase()}${runWord.slice(1)} did not complete: ${endSentence(input.failure.text)}`
        : `${runWord.charAt(0).toUpperCase()}${runWord.slice(1)} did not complete.`;
      remedy = "Re-run it; if it fails the same way, read the run's console for the cause.";
  }

  const options = input.role === "operator"
    ? operatorOptions(kind, backend, input.backend, resetLabel, resetsAt)
    : specialistOptions(
        kind,
        backend,
        input.backend,
        other,
        ownerHasOther,
        resetLabel,
        input.agentHandle,
        input.profileId,
        input.profileModel,
        facts?.origin === "local",
        resetsAt,
      );

  return { reason, remedy, resetLabel, owner, options };
}

/** The operator's own recovery options. `block_on_policy` stays the kind
 *  (its resolution re-runs the operator, R20-1), but its label asserts only
 *  what the human says, and `ev` records exactly that. */
function operatorOptions(
  kind: RunFailure["kind"],
  backend: string,
  /** The backend that refused, as its id: an option asserting the window has
   *  reset or the account changed names it, and the resolution retires that
   *  backend's exhaustion record on the strength of the assertion. */
  failed: RealBackend,
  resetLabel: string | null,
  /** Ruling 224: the provider's own reset instant, when it gave one. */
  resetsAt: string | null = null,
): OperatorPacketOptionInput[] {
  const rerun: OperatorPacketOptionInput = {
    kind: "block_on_policy",
    title: "Re-run the operator now",
    detail: "Closes this decision and starts a fresh operator run. If it fails again you get a new decision packet.",
    ev: "**Decision:** re-run the operator. No policy or credential was changed.",
  };
  const redirect: OperatorPacketOptionInput = {
    kind: "redirect",
    title: "Redirect the work with new guidance",
    detail: "Closes this decision and re-runs the operator with your note as its steer.",
  };
  const hold: OperatorPacketOptionInput = {
    kind: "hold_runtime_debug",
    title: "Hold: pause coordination while I inspect the session",
    detail: "Closes this decision and starts NO run. The task stays blocked and waiting on you; use Run operator when you are ready.",
  };
  if (kind === "quota") {
    // Ruling 224 (F37-44): the operator's packet had the same defect as the
    // specialist's — its recommended option asks a human to ASSERT the window
    // has reset, which at the moment it is offered is the one statement on the
    // packet that is false. When the provider dated the reopening, waiting for
    // it is the answer, and it takes the recommendation.
    const waitUntil =
      resetsAt && Date.parse(resetsAt) > Date.now() ? resetsAt : null;
    const assertReset: OperatorPacketOptionInput = {
      kind: "block_on_policy",
      title: `The usage window has reset${resetLabel ? ` (${resetLabel})` : ""}, or I switched the ${backend} account: re-run`,
      detail:
        "Closes this decision and starts a fresh operator run on the owner's current account. If it fails again you get a new decision packet.",
      backend: failed,
      ev: "**Decision:** the usage window has reset or the account was switched; re-run the operator. No project policy was changed.",
    };
    if (!waitUntil) assertReset.recommended = true;
    const options: OperatorPacketOptionInput[] = [];
    if (waitUntil) {
      options.push({
        kind: "wait_for_window",
        title: `Wait for the window and pick the task back up automatically${resetLabel ? ` (${resetLabel})` : ""}`,
        detail:
          `Closes this decision and schedules an operator run for just after ${resetLabel ?? "the window reopens"}, ` +
          `on the same account and the same model. Nothing runs until then and the board says so. ` +
          `No account, model or project policy changes.`,
        recommended: true,
        dueAt: waitUntil,
        ev:
          `**Decision:** wait for the ${backend} window to reopen${resetLabel ? ` (${resetLabel})` : ""}. ` +
          `An operator run is scheduled to pick the task back up on the same account. No account or project policy was changed.`,
      });
    }
    options.push(assertReset, redirect, hold);
    return options;
  }
  if (kind === "auth") {
    return [
      {
        kind: "block_on_policy",
        title: `I switched to or connected a different ${backend} account or an API key on Profile → Agent accounts: re-run`,
        detail: "Closes this decision and starts a fresh operator run on the owner's current account.",
        recommended: true,
        backend: failed,
        ev: `**Decision:** a different ${backend} account or an API key was switched to or connected; re-run the operator. No project policy was changed.`,
      },
      redirect,
      hold,
    ];
  }
  return [{ ...rerun, recommended: true }, redirect, hold];
}

/** A specialist's recovery options: the other backend first when the owner
 *  has it (rule unchanged), else "send the agent back to continue"; `redirect`
 *  present and NOT recommended for a backend failure (the agent did nothing
 *  wrong). */
function specialistOptions(
  kind: RunFailure["kind"],
  backend: string,
  /** The backend that refused (see `operatorOptions`). */
  failed: RealBackend,
  other: RealBackend,
  ownerHasOther: boolean,
  resetLabel: string | null,
  agentHandle: string | undefined,
  profileId: string | undefined,
  /** F36-8: the profile's model on its own backend (see the input). */
  profileModel: string | undefined,
  /** U35-11: the `overloaded` failure was this deployment's own network path. */
  localNetwork = false,
  /** Ruling 224: the provider's own reset instant, when it gave one. A spent
   *  window with a KNOWN reopening has a remedy that is neither a model change
   *  nor a false assertion: wait for it, and come back by itself. */
  resetsAt: string | null = null,
): OperatorPacketOptionInput[] {
  const handle = agentHandle ? `@${agentHandle}` : "the agent";
  // F36-8 (pass 36): the option says which MODEL the retry runs on. A profile
  // whose id belongs to the failed backend gets the other backend's default
  // (`startRun` substitutes and discloses it, F21-13); one the other backend
  // knows keeps its own. Live, the option read "re-run the same agent there and
  // continue", the retry ran on `sonnet`, and nothing on the task named it.
  // Ruling 254 (pass 37, F37-83): and it says WHEN it was true. This sentence
  // is frozen into the packet when the option is authored, and a packet can sit
  // open for hours — live, the owner moved eight profiles from `gpt-5.6-luna`
  // to `opus` while four of these packets waited, and every one of them went on
  // offering "on `sonnet` (Claude's default: the profile's `gpt-5.6-luna` is a
  // Codex model)", a sentence with two now-false claims, to a person choosing
  // between them. The runs resolved the live deployment and correctly used
  // `opus`; the promise was the only thing that was wrong. The option pins a
  // BACKEND, never a model, so the honest sentence names today's model and says
  // what happens if the deployment moves first.
  const retryModel = profileModel
    ? (() => {
        const swap = substituteRunModel(other, profileModel);
        return swap.foreignBackend
          ? `on \`${swap.model}\` as deployed right now (${BACKEND_LABEL[other]}'s default: the profile's \`${profileModel}\` is a ${BACKEND_LABEL[swap.foreignBackend]} model)`
          : `on its own \`${profileModel}\` as deployed right now`;
      })()
    : `on ${BACKEND_LABEL[other]}'s default model as deployed right now`;
  /** Ruling 254: the option carries a backend, not a model, so a deployment
   *  edit between authoring and answering moves the run and not the text. */
  const retryModelCaveat =
    " This option pins the backend, not the model: if the deployment changes " +
    "before you answer, the run follows the deployment rather than the model named here.";
  const redirect: OperatorPacketOptionInput = {
    kind: "redirect",
    title: "Redirect with sharper guidance",
    detail: "Re-engage the operator to re-prompt the specialist with a corrected directive.",
  };
  const backendFailure =
    kind === "quota" || kind === "auth" || kind === "unavailable" || kind === "overloaded";
  if (backendFailure) {
    const options: OperatorPacketOptionInput[] = [];
    // Ruling 224 (F37-44): a spent window the provider dated. Every other
    // option on this packet is wrong at the moment it is offered — the
    // cross-backend retry permanently moves the task off the model its profile
    // declares, and the send-back asks a human to ASSERT a window has reset
    // that the provider just said will not for hours. Waiting is the real
    // remedy and viberr already has the runner for it, so it is offered first
    // and it takes the recommendation.
    const waitUntil =
      kind === "quota" && resetsAt && Date.parse(resetsAt) > Date.now()
        ? resetsAt
        : null;
    if (waitUntil) {
      const wait: OperatorPacketOptionInput = {
        kind: "wait_for_window",
        title: `Wait for the window and pick ${handle} back up automatically${resetLabel ? ` (${resetLabel})` : ""}`,
        detail:
          `Closes this decision and schedules an operator run for just after ${resetLabel ?? "the window reopens"}, ` +
          `on the same account and the same model. The operator re-reads the task then and continues it, which is ` +
          `what a gap of hours needs, because the board may have moved while it waited. Nothing runs until then and ` +
          `the board says so. No account, model or project policy changes.`,
        recommended: true,
        dueAt: waitUntil,
        ev:
          `**Decision:** wait for the ${backend} window to reopen${resetLabel ? ` (${resetLabel})` : ""}. ` +
          `An operator run is scheduled to pick the task back up on the same account. No account or project policy was changed.`,
      };
      options.push(wait);
    }
    if (ownerHasOther) {
      const retry: OperatorPacketOptionInput = {
        kind: "retry_other_backend",
        title: `Retry ${handle} on ${BACKEND_LABEL[other]} now`,
        detail:
          `The owner has ${BACKEND_LABEL[other]} connected; re-run the same agent there ${retryModel} and continue. ` +
          `Later runs on this task stay on ${BACKEND_LABEL[other]} until another retry moves them.` +
          retryModelCaveat +
          // Ruling 212: when the fault is THIS deployment's network path, the
          // other provider is reached over the same path, so switching is not a
          // remedy — and it permanently moves the task off the model its
          // profile declares. Offered, never recommended, and the reason is on
          // the option rather than left for the reader to work out.
          (localNetwork
            ? ` This failure was on this deployment's own network path, which the other provider is reached over too, so this is a change of model rather than a fix.`
            : ""),
        backend: other,
      };
      // Ruling 212: not recommended when the fault is this deployment's own
      // network path. Ruling 224: nor when waiting for a dated window is on the
      // table — exactly one option is recommended, and a permanent model change
      // is not it.
      if (!localNetwork && !waitUntil) retry.recommended = true;
      if (profileId) retry.profileId = profileId;
      options.push(retry);
    }
    const sendBack: OperatorPacketOptionInput = {
      kind: "request_edit",
      title:
        kind === "quota"
          ? `The window has reset${resetLabel ? ` (${resetLabel})` : ""}, or the ${backend} account changed: send ${handle} back to continue`
          : kind === "auth"
            ? `A different ${backend} account or an API key is connected: send ${handle} back to continue`
            : kind === "overloaded"
              ? localNetwork
                ? `Retry ${handle} on ${backend} now: this deployment could not reach the provider, nothing was changed`
                : `Retry ${handle} on ${backend} now: the provider was overloaded, nothing was changed`
              : `${backend} is connected now: send ${handle} back to continue`,
      detail:
        kind === "overloaded"
          ? localNetwork
            ? "Closes this decision and re-runs the agent on the same account with the same directive. If the deployment still cannot reach the provider you get a new decision packet."
            : "Closes this decision and re-runs the agent on the same account with the same directive. If the provider is still overloaded you get a new decision packet."
          : "Closes this decision and re-runs the agent on the owner's current account with the same directive.",
      // Ruling 212: the same-backend retry is the recommendation whenever the
      // other backend is not a real alternative — either the owner does not
      // have it, or the fault was local and switching would only change the
      // model.
      // Ruling 224: and never when the wait is offered — asking a human to
      // assert the window has reset, minutes after the provider said it has
      // hours to run, is the one thing on this packet that is simply false.
      recommended: (!ownerHasOther || localNetwork) && !waitUntil,
      ev:
        kind === "quota"
          ? "**Decision:** the usage window has reset or the account was switched; the agent continues. No project policy was changed."
          : kind === "overloaded"
            ? localNetwork
              ? `**Decision:** this deployment could not reach ${backend}; the agent is retried as it was. No account or project policy was changed.`
              : `**Decision:** ${backend} was overloaded; the agent is retried as it was. No account or project policy was changed.`
            : `**Decision:** the ${backend} credential was changed on the owner's profile; the agent continues.`,
    };
    // The two titles that assert the SPENT WINDOW is over (or that a different
    // account now answers for it) name the backend they assert about, so the
    // resolution can retire that backend's exhaustion record. Without it the
    // record outlives the person's statement: only a run that COMPLETES clears
    // it, the dispatch hold (ruling 152(c)) stops any run from starting until
    // the recorded instant passes, and the option's own promise — "send the
    // agent back to continue" — cannot be kept (ruling 164). The overloaded and
    // unavailable titles assert nothing about quota and name nothing.
    if (kind === "quota" || kind === "auth") sendBack.backend = failed;
    options.push(sendBack);
    options.push(redirect);
    return options;
  }
  return [{ ...redirect, recommended: true }];
}
