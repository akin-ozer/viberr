import type { DatabaseSync } from "node:sqlite";
import { findUserById } from "~/server/auth/user-store.server";
import { isBackendAvailableFor } from "~/server/runtimes/backend-credentials.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { formatClockUTC, utcDayKey,
  formatCalendarDateUTC,
} from "~/shared/dates/format";
import { localNetworkFailureCode } from "~/shared/run-failure";
import type { RunFailure } from "./agent-reply.server";
import type { OperatorPacketOptionInput } from "./operator-actions.server";

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
 * connect a different account or an API key on Profile → Agent accounts.
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

const BACKEND_NAME = { claude: "Claude", codex: "Codex" } as const satisfies Record<RealBackend, string>;

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

/** A provider sentence ends exactly once, whatever the adapter wrote. */
function terminated(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
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

export function describeRunFailure(
  db: DatabaseSync,
  input: DescribeRunFailureInput,
): RunFailureDescription {
  const backend = BACKEND_NAME[input.backend];
  /** What an org-level restriction names: the product, not the model. */
  const product = input.backend === "claude" ? "Claude Code" : "Codex";
  const other: RealBackend = input.backend === "codex" ? "claude" : "codex";
  const kind = input.failure?.kind ?? "unknown";
  const facts = input.failure?.facts;
  const resetLabel = formatResetLabel(facts?.resetsAt);
  const ownerRecord = input.ownerUserId ? findUserById(db, input.ownerUserId) : null;
  const owner = ownerRecord ? { userId: ownerRecord.id, name: ownerRecord.name } : null;
  const ownerHasOther =
    input.ownerUserId !== null &&
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
        ? `${owner.name} can wait until the window reopens${resetLabel ? ` (${resetLabel})` : ""}, or connect a different ${backend} account or an API key on ${profile}.`
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
        ? `${owner.name} can connect a different ${backend} account or an API key on ${profile}${code === "oauth_org_not_allowed" ? ", or have the organization enable it" : ""}. Retrying with the same account fails the same way.`
        : `The task has no owner to bill; seat an owner whose ${backend} account the provider accepts.`;
      break;
    }
    case "unavailable":
      // Ruling 127: the run's own line already names the person and their
      // remedy; that sentence is the reason and the remedy.
      reason = input.failure?.text
        ? terminated(input.failure.text)
        : `${backend} could not run ${runWord}: no usable credential.`;
      remedy = owner
        ? `${owner.name} connects ${backend} on ${profile}${ownerHasOther ? `, or the run is retried on ${BACKEND_NAME[other]}` : ""}.`
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
        remedy = `Nothing about ${whose} account or the task is wrong; the fault is on this deployment's network path (TLS, DNS or a proxy). Retry in a few minutes${ownerHasOther ? `, or run it on ${BACKEND_NAME[other]} now` : ""}.`;
        break;
      }
      const status = facts?.apiErrorStatus ?? null;
      const code = facts?.apiError ?? null;
      const overloaded = status === 529 || code === "overloaded";
      reason = `${backend} could not serve ${runWord}: the provider ${overloaded ? "was overloaded" : "failed on its own side"}${status ? ` (HTTP ${status}${code && code !== "overloaded" ? `, ${code}` : ""})` : code ? ` (${code})` : ""}.`;
      remedy = `Nothing about ${whose} account or the task is wrong. Retry in a few minutes${ownerHasOther ? `, or run it on ${BACKEND_NAME[other]} now` : ""}.`;
      break;
    }
    case "max_turns":
      reason = `${runWord.charAt(0).toUpperCase()}${runWord.slice(1)} hit its turn cap before finishing.`;
      remedy = "Re-run it with a narrower directive, or split the work.";
      break;
    case "idle_timeout":
      reason = `${runWord.charAt(0).toUpperCase()}${runWord.slice(1)} produced nothing for the whole idle window and was stopped.`;
      remedy = "Re-run it; if it hangs again, inspect the session for what it was waiting on.";
      break;
    case "session_missing":
      reason = "The provider session this run tried to resume no longer exists.";
      remedy = "Re-run it: a fresh session re-anchors on task.md and continues.";
      break;
    default:
      reason = input.failure?.text
        ? `${runWord.charAt(0).toUpperCase()}${runWord.slice(1)} did not complete: ${terminated(input.failure.text)}`
        : `${runWord.charAt(0).toUpperCase()}${runWord.slice(1)} did not complete.`;
      remedy = "Re-run it; if it fails the same way, read the run's console for the cause.";
  }

  const options = input.role === "operator"
    ? operatorOptions(kind, backend, resetLabel)
    : specialistOptions(
        kind,
        backend,
        other,
        ownerHasOther,
        resetLabel,
        input.agentHandle,
        input.profileId,
        facts?.origin === "local",
      );

  return { reason, remedy, resetLabel, owner, options };
}

/** The operator's own recovery options. `block_on_policy` stays the kind
 *  (its resolution re-runs the operator, R20-1), but its label asserts only
 *  what the human says, and `ev` records exactly that. */
function operatorOptions(
  kind: RunFailure["kind"],
  backend: string,
  resetLabel: string | null,
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
    return [
      {
        kind: "block_on_policy",
        title: `The usage window has reset${resetLabel ? ` (${resetLabel})` : ""}, or I switched the ${backend} account: re-run`,
        detail: "Closes this decision and starts a fresh operator run on the owner's current account. If it fails again you get a new decision packet.",
        recommended: true,
        ev: "**Decision:** the usage window has reset or the account was switched; re-run the operator. No project policy was changed.",
      },
      redirect,
      hold,
    ];
  }
  if (kind === "auth") {
    return [
      {
        kind: "block_on_policy",
        title: `I connected a different ${backend} account or an API key on Profile → Agent accounts: re-run`,
        detail: "Closes this decision and starts a fresh operator run on the owner's current account.",
        recommended: true,
        ev: `**Decision:** a different ${backend} account or an API key was connected; re-run the operator. No project policy was changed.`,
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
  other: RealBackend,
  ownerHasOther: boolean,
  resetLabel: string | null,
  agentHandle: string | undefined,
  profileId: string | undefined,
  /** U35-11: the `overloaded` failure was this deployment's own network path. */
  localNetwork = false,
): OperatorPacketOptionInput[] {
  const handle = agentHandle ? `@${agentHandle}` : "the agent";
  const redirect: OperatorPacketOptionInput = {
    kind: "redirect",
    title: "Redirect with sharper guidance",
    detail: "Re-engage the operator to re-prompt the specialist with a corrected directive.",
  };
  const backendFailure =
    kind === "quota" || kind === "auth" || kind === "unavailable" || kind === "overloaded";
  if (backendFailure) {
    const options: OperatorPacketOptionInput[] = [];
    if (ownerHasOther) {
      const retry: OperatorPacketOptionInput = {
        kind: "retry_other_backend",
        title: `Retry ${handle} on ${BACKEND_NAME[other]} now`,
        detail: `The owner has ${BACKEND_NAME[other]} connected; re-run the same agent there and continue. The switch sticks: later prompts on this task follow it.`,
        recommended: true,
        backend: other,
      };
      if (profileId) retry.profileId = profileId;
      options.push(retry);
    }
    options.push({
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
      recommended: !ownerHasOther,
      ev:
        kind === "quota"
          ? "**Decision:** the usage window has reset or the account was switched; the agent continues. No project policy was changed."
          : kind === "overloaded"
            ? localNetwork
              ? `**Decision:** this deployment could not reach ${backend}; the agent is retried as it was. No account or project policy was changed.`
              : `**Decision:** ${backend} was overloaded; the agent is retried as it was. No account or project policy was changed.`
            : `**Decision:** the ${backend} credential was changed on the owner's profile; the agent continues.`,
    });
    options.push(redirect);
    return options;
  }
  return [{ ...redirect, recommended: true }];
}
