import { useState } from "react";
import { useSearchParams } from "react-router";
import type { ConnectionRecord } from "~/server/org/connections.server";
import {
  REACH_CAP,
  reachSummary,
  type ConnectionReach,
} from "~/shared/connection-reach";
import { slugify } from "~/shared/ids/slugify";
import { utcDayKey } from "~/shared/dates/format";
import { countLabel } from "~/shared/text/plural";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { LocalCalendarDate } from "~/ui/local-time";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { ConfirmDelete } from "./confirm-delete";
import { MiniModal } from "./mini-modal";
import { useBusyRow, useModalAction } from "./resource-helpers";
import { useOrgAction } from "./use-org-action";

/**
 * GitHub connections tab (org-settings spec §4.1). Row markup is the
 * mock's `.conn-row`; the honest-state deltas from the prototype:
 * masked token in the sub line, scope-chip checks only after a PASSING
 * validation, and a "not validated" / "validation failed" pill for
 * placeholder or broken tokens (seed's akin-ozer connection ships
 * unvalidated on purpose). Add/replace run the REAL phase-7 validator —
 * failure copy renders in the modal's `.form-err` and nothing is saved.
 */

// Owner ruling 2026-07-25: the required set is what Viberr's own writes use —
// branch push + PR open/merge. The mock-era `workflow` (unprovable on
// fine-grained tokens, over-demanding on classic ones) is gone.
const SCOPES = ["repo", "pull_request:write"] as const;

function ConnectionModal({
  initial,
  existing,
  onClose,
}: {
  initial: ConnectionRecord | null;
  existing: ConnectionRecord[];
  onClose: () => void;
}) {
  const [owner, setOwner] = useState(initial ? initial.owner : "");
  const [token, setToken] = useState("");
  // Ruling 459: a save plays the modal's exit, then onClose unmounts it.
  const [done, setDone] = useState(false);
  const { action, err, setErr } = useModalAction(() => setDone(true));
  const checking = action.busy;
  const canSave =
    (!!initial || owner.trim().length > 1) &&
    token.trim().length > 0;

  const apply = () => {
    // Enter in a field reaches this directly, so the busy guard lives here
    // too, and so does the one for a save that landed and is leaving.
    if (!canSave || checking || done) return;
    const o = owner.trim();
    if (!initial && existing.some((c) => c.id === slugify(o))) {
      setErr("That connection already exists.");
      return;
    }
    setErr(null);
    action.submit(
      initial
        ? { intent: "connection-replace", connectionId: initial.id, token: token.trim() }
        : { intent: "connection-add", owner: o, token: token.trim() },
    );
  };
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") apply();
  };

  return (
    <MiniModal
      icon={<Icon name="github" />}
      title={initial ? "Update token for " + initial.owner : "New GitHub connection"}
      busy={checking}
      done={done}
      sub={
        initial
          ? "The current token is never shown. Paste a replacement"
          : "A PAT authenticates every repo action for this owner"
      }
      onClose={onClose}
      canSave={canSave}
      saveLabel={
        checking
          ? "Verifying scopes…"
          : initial
            ? "Validate & replace"
            : "Validate & connect"
      }
      footHint={
        initial
          ? "the old token stays active unless validation passes"
          : "nothing is saved unless validation passes"
      }
      onSave={apply}
    >
      <div className="field">
        <label className="flabel" htmlFor="cn-owner">
          Organization or user<span className="req">*</span>
        </label>
        <div className="repo-input">
          <span className="pre">github.com/</span>
          <input
            id="cn-owner"
            type="text"
            value={owner}
            disabled={!!initial}
            placeholder="owner"
            // Owner report 2026-08-20: a text input followed by a password input
            // reads as a LOGIN form, and browsers filled a saved email here.
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            onChange={(e) => {
              setOwner(e.target.value);
              setErr(null);
            }}
            onKeyDown={enter}
            autoFocus={!initial}
          />
        </div>
        {/* UXA-11: on the update path this field is `disabled` and nothing said
            why — the title says "Update token" and the sub says the token is
            never shown, but neither states that the OWNER is fixed. A disabled
            input cannot explain itself; say it where the reader is looking. */}
        {initial && (
          <div className="fhint">
            The owner can&apos;t be changed. Add a separate connection for a
            different account or organisation.
          </div>
        )}
      </div>
      <div className="field">
        <label className="flabel" htmlFor="cn-token">
          Personal access token<span className="req">*</span>{" "}
          <span className="fhint">stored encrypted · never displayed</span>
        </label>
        {/* F11/UI-D: the label promises the token is never displayed while the
            field displayed it in clear text as you pasted it — over a shoulder,
            in a screen share, and to every password manager and spell-checker
            that scrapes text inputs. A secret field is `type="password"`; the
            autofill/spellcheck opt-outs keep the value out of the same stores.
            Nothing else changes: the value is still submitted verbatim, and the
            server still never sends one back. */}
        <input
          id="cn-token"
          type="password"
          className="mono"
          value={token}
          // `off` is ignored by browsers on login-shaped pairs (owner report
          // 2026-08-20: a saved password landed in this field) — `new-password`
          // is the value password managers actually honor for "never fill".
          autoComplete="new-password"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          placeholder="ghp_…"
          onChange={(e) => {
            setToken(e.target.value);
            setErr(null);
          }}
          onKeyDown={enter}
          autoFocus={!!initial}
        />
      </div>
      <div className="field">
        <span className="flabel">Required scopes</span>
        <span className="scope-chips flush">
          {SCOPES.map((s) => (
            <span className="scope-chip" key={s}>
              {s}
            </span>
          ))}
        </span>
        <div className="def-note">
          <Icon name="shield" />
          {/* Ruling 480 (F40-43): the old copy promised "write dry-runs",
              which run only when VIBERR_GITHUB_WRITE_PROBE is set, and a
              proof on attach that a connection Re-check then erased. */}
          <span>
            Verified when you apply: a classic PAT publishes its scopes, so a
            missing one refuses the token and nothing is saved. A{" "}
            <strong>fine-grained</strong> PAT publishes none, so each
            repository proves it: GitHub reports its write access when a project
            attaches it, and the first branch, push or pull request Viberr makes
            there proves the rest.
          </span>
        </div>
      </div>
      {err && (
        <div className="form-err">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}

/**
 * Ruling 463 (F40-6): what the TOKEN reaches, from `GET /user/repos`. The row
 * used to say "3 public repos", the account's public count, which says
 * nothing about a fine-grained token granted a private repository. The list
 * is one disclosure away; a read that failed says why, and a connection saved
 * before the read existed says Re-check reads it.
 */
function ReachLine({ reach }: { reach: ConnectionReach | null }) {
  if (!reach) {
    return (
      <span className="sub" data-reach="unread">
        Which repositories this token reaches has not been read yet. Re-check
        reads it.
      </span>
    );
  }
  if (reach.status === "unknown") {
    return (
      <span className="sub" data-reach="unknown">
        Which repositories this token reaches could not be read: {reach.reason}
      </span>
    );
  }
  if (reach.total === 0) {
    return (
      <span className="sub" data-reach="read">
        GitHub lists no repository this token reaches.
      </span>
    );
  }
  return (
    <details className="conn-reach" data-reach="read">
      <summary>
        <span>Reaches {reachSummary(reach)}</span>
        <Icon name="chevron" className="disc-chev" />
      </summary>
      <ul className="conn-reach-list">
        {reach.repos.map((r) => (
          <li key={r.fullName}>
            <span className="mono">{r.fullName}</span>
            {r.private && (
              <Pill sm quiet>
                private
              </Pill>
            )}
            {r.canPush === false && <span className="conn-reach-ro">read only</span>}
          </li>
        ))}
      </ul>
      {reach.capped && (
        <p className="conn-reach-note">
          The read stops at {REACH_CAP} repositories, so this token may reach
          more.
        </p>
      )}
    </details>
  );
}

export function ConnectionsPanel({
  connections,
}: {
  connections: ConnectionRecord[];
}) {
  // Ruling 480 (F40-45): a project's credential card sends an instance admin
  // here with `?update=<connection id>`, since Update token is the one place a
  // token is actually replaced, and the link lands on that connection's modal.
  // Ruling 532: Home's setup checklist sends one with `?add`, which lands on
  // the new connection's.
  const [searchParams] = useSearchParams();
  const [modal, setModal] = useState<{ item: ConnectionRecord | null } | null>(
    () => {
      if (searchParams.has("add")) return { item: null };
      const asked = searchParams.get("update");
      const item = asked ? connections.find((c) => c.id === asked) : undefined;
      return item ? { item } : null;
    },
  );
  const [confirm, setConfirm] = useState<ConnectionRecord | null>(null);
  const push = useToast();
  const rowAction = useOrgAction();
  // Ruling 463: Re-check validates the stored token again and re-reads what
  // it reaches; its own fetcher so the row that asked shows it in flight.
  const recheckAction = useOrgAction();
  const [rechecking, setRechecking] = useBusyRow(recheckAction);

  const setDefault = (id: string) =>
    rowAction.submit({ intent: "connection-default", connectionId: id });
  const remove = (c: ConnectionRecord) => {
    if (c.def) {
      // D5: a refusal must not render the success tick.
      push("Set another connection as default first", "error");
      return;
    }
    setConfirm(c);
  };

  return (
    <section className="panel" data-screen-label="Settings · GitHub connections">
      <div className="panel-head">
        <Icon name="github" />
        <h2>GitHub connections</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={() => setModal({ item: null })}>
            <Icon name="plus" />
            Add connection
          </button>
        </span>
      </div>
      {/* Design pass 2026-09-08: with nothing connected the note degraded to
          "0 connections." above an empty block that says the same thing, so
          the zero state renders one thing, and that thing offers the action. */}
      {connections.length > 0 && (
        <div className="pol-note">
          <Icon name="shield" />
          <span>
            <strong>{countLabel(connections.length, "connection")}.</strong>{" "}
            Every project picks one at creation. It sets the repository root. Each
            authenticates with a <strong>PAT</strong>, validated against the minimum
            scopes before anything is saved.
          </span>
        </div>
      )}
      <div className="conn-list">
        {connections.map((c) => {
          // An expiry the store cannot read renders "no expiry date", never a
          // dangling "expires ". The date itself goes through the hydration-safe
          // primitive: UTC day first, the viewer's calendar date after
          // hydration (pass 34, C6).
          const expiresAt =
            c.expiresAt && utcDayKey(c.expiresAt) ? c.expiresAt : null;
          const verified = c.validationState === "valid";
          return (
            <div className="conn-row" key={c.id}>
              <span className="conn-ico">
                <Icon name="github" />
              </span>
              <span className="conn-main">
                <b>
                  {c.owner}
                  <span className="mono pre">/</span>
                </b>
                <span className="sub mono">
                  PAT {c.masked} ·{" "}
                  {expiresAt ? (
                    <>
                      expires <LocalCalendarDate iso={expiresAt} />
                    </>
                  ) : (
                    "no expiry date"
                  )}
                </span>
                <ReachLine reach={c.reach} />
                <span className="scope-chips">
                  {/* P13-UI-01 + owner ruling 2026-07-25: chips are PROVEN
                      verdicts only — a scope header (classic) or a real probe
                      (fine-grained; writes via the empty-payload dry-run). An
                      `assumed` entry is not evidence, so it renders no chip:
                      unproven scopes collapse into the single honest line
                      below instead of a pseudo-check next to real ones. */}
                  {(() => {
                    const evidence = verified ? (c.scopes ?? []) : [];
                    const proven = evidence.filter((s) => s.source !== "assumed");
                    const unproven = evidence.filter((s) => s.source === "assumed");
                    return (
                      <>
                        {proven.map((s) => (
                          <span
                            className={"scope-chip" + (s.ok ? "" : " miss")}
                            key={s.id}
                            title={
                              (s.source === "header"
                                ? "Confirmed against the token's published scopes."
                                : "Proven by a live probe against the repository.") +
                              (s.note ? ` (${s.note})` : "")
                            }
                          >
                            <Icon name={s.ok ? "check" : "alert"} />
                            {s.id}
                          </span>
                        ))}
                        {(c.advisories ?? []).map((a) => (
                          <span className="sub" key={a.id} data-advisory={a.id}>
                            {a.text}
                          </span>
                        ))}
                        {/* Ruling 480 (F40-43): a fine-grained token is
                            proven per repository, so the line says where it
                            stands instead of promising a verification the
                            card then never showed. */}
                        {unproven.length > 0 && (
                          <span
                            className="sub"
                            title={unproven.map((s) => s.note ?? s.id).join(" · ")}
                          >
                            {proven.length > 0 ? " · " : ""}
                            {unproven.map((s) => s.id).join(", ")} unproven for
                            the token as a whole: each repository proves them.
                            {c.repoProofs.length === 0 &&
                              " No repository has proven them yet: attaching the token to a project does, and so does Viberr's first write there."}
                          </span>
                        )}
                      </>
                    );
                  })()}
                </span>
                {c.repoProofs.map((p) => (
                  <span className="sub" key={p.repo} data-repo-proof={p.repo}>
                    <span className="mono">{p.repo}</span>:{" "}
                    {[
                      p.proven.length > 0 ? `${p.proven.join(", ")} proven` : "",
                      p.refused.length > 0 ? `${p.refused.join(", ")} refused` : "",
                    ]
                      .filter(Boolean)
                      .join("; ")}
                  </span>
                ))}
              </span>
              {c.validationState === "unvalidated" && (
                <Pill kind="input" sm>
                  not validated
                </Pill>
              )}
              {c.validationState === "failed" && (
                <Pill kind="risk" sm>
                  validation failed
                </Pill>
              )}
              {c.daysLeft !== null && c.daysLeft <= 30 && (
                <Pill kind="input" sm>
                  expires in {c.daysLeft} days
                </Pill>
              )}
              {c.def && (
                <Pill kind="info" sm quiet>
                  default
                </Pill>
              )}
              <button type="button" className="btn ghost sm" onClick={() => setModal({ item: c })}>
                Update token
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={rechecking === c.id}
                aria-busy={rechecking === c.id || undefined}
                onClick={() => {
                  setRechecking(c.id);
                  recheckAction.submit({ intent: "connection-recheck", connectionId: c.id });
                }}
              >
                <GlyphSwap rest="refresh" alt="loader" on={rechecking === c.id} spinAlt />
                {rechecking === c.id ? "Checking…" : "Re-check"}
              </button>
              {!c.def && (
                <button type="button" className="btn ghost sm" onClick={() => setDefault(c.id)}>
                  Set default
                </button>
              )}
              <button
                type="button"
                className="stg-x"
                aria-label={"Remove " + c.owner}
                onClick={() => remove(c)}
              >
                <Icon name="x" />
              </button>
            </div>
          );
        })}
        {connections.length === 0 && (
          <div className="empty">
            No connections yet. Add one first: every project binds to a GitHub
            repo through a connection.
            <button
              type="button"
              className="btn primary empty-cta"
              onClick={() => setModal({ item: null })}
            >
              <Icon name="plus" />
              Add connection
            </button>
          </div>
        )}
      </div>
      {modal && (
        <ConnectionModal
          key={modal.item ? modal.item.id : "new"}
          initial={modal.item}
          existing={connections}
          onClose={() => setModal(null)}
        />
      )}
      {confirm && (
        <ConfirmDelete
          what={confirm.owner}
          // C6: the outcome, not a bare "Remove".
          confirmLabel="Remove connection"
          detail={
            // A4 (pass 23): removing the connection deletes its PAT, and the
            // binding cascade takes branch/PR sync offline for every project
            // bound to it. The old copy named only the harmless half.
            confirm.boundProjects > 0
              ? `This deletes the credential. ${countLabel(confirm.boundProjects, "project")} bound to it ${confirm.boundProjects === 1 ? "loses" : "lose"} branch and PR sync until a new credential is bound. Projects keep their repo setting; new projects can no longer select ${confirm.owner}.`
              : `Projects already created from ${confirm.owner} keep their repos; new projects can no longer select it.`
          }
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            rowAction.submit({
              intent: "connection-remove",
              connectionId: confirm.id,
            });
          }}
        />
      )}
    </section>
  );
}
