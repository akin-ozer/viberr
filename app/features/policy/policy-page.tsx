import { Fragment, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { countLabel } from "~/shared/text/plural";
import { Avatar } from "~/ui/avatar";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon, storeIcon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { LocalDayDotTime } from "~/ui/local-time";
import { RadioSeg, RadioSegOption } from "~/ui/radio-seg";
import { useToast } from "~/ui/toast";
import { useActionToast } from "~/ui/use-action-toast";
import {
  profileRoleLabel,
  type MatrixProfile,
} from "~/features/agents/agent-types";

/** The Agent-capability rows need the matrix shape plus the role sub-line. */
export type PcapProfile = MatrixProfile & { role: string };
import { CapabilityMatrixModal } from "~/features/agents/capability-matrix-modal";
import { GOVERNED_CAP_LABELS, MODE_LABEL } from "~/features/agents/capability-catalog";
import type { MembershipView } from "~/features/project-settings/membership.server";
import type { GuardrailView, PolicyViewData, TransitionView } from "./policy-query.server";
import type { GuardrailOp } from "./policy-actions.server";
import type { RequiredReviewerView } from "~/server/tasks/required-reviewers.server";
import {
  ALWAYS_HUMAN_ROWS,
  BCLS,
  BOUNDARIES,
  operatorAutonomyState,
  RBAC_ROWS,
  ROLE_IDS,
  ROLE_LABEL,
  type OperatorAutonomyState,
} from "./policy-data";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import { stageFlowPath } from "~/shared/workflow/transitions";
import { isClaudeOnlyEnforcedLabel } from "~/shared/capabilities";
import { useRefusalShake } from "~/ui/use-refusal-shake";

/**
 * Policy view:
 * Human access (member roles + the read-only 9-row RBAC grant table),
 * Agent capability (per-profile direct/recommend/human counts + the
 * always-human invariant list), Workflow rules (stage flow + per-transition
 * boundaries, review→done locked human), and the shared
 * CapabilityMatrixModal. A role without the grant a control's action needs
 * reads the page rather than driving it: U33-4 (owner, 2026-09-03) turned the
 * member-role picker and the guardrail controls into plain values for that
 * reader, ruling 65's withdrawn-not-disabled precedent. The server enforces
 * regardless.
 */

type ActionResult = { ok: true; toast: string } | { ok: false; error: string };

/* F19-33: the three panel-head counts below used to be styled by a private
   `PANEL_COUNT_STYLE = { fontSize: ".76rem", color: "var(--faint)" }` const —
   a byte copy of the sheet's `.fine` utility (app.css:230) that github-view.tsx
   and settings-page.tsx each kept a copy of too. Hoisting the object out of the
   JSX also slipped it past app.css.test.ts's `style={{…}}` scan. Ruling 14:
   shared single implementations, never fork per surface — the count is
   `right sub fine`, the same three classes seven other panel heads use. */

// ------------------------------------------------- Surface 1: human access

export function HumanAccess({
  projectName,
  members,
  canManage,
  busy,
  onSetRole,
}: {
  projectName: string;
  members: MembershipView[];
  canManage: boolean;
  busy: boolean;
  onSetRole: (member: MembershipView, role: ProjectRole) => void;
}) {
  const push = useToast();
  const counts = {
    admin: 0,
    maintainer: 0,
    contributor: 0,
    viewer: 0,
  } satisfies Record<ProjectRole, number>;
  // LV-04/UI-29: a membership whose org account was deleted is NOT a member for
  // any counting purpose — the role headers describe who can actually perform
  // an action, and the ghost can perform none of them.
  const live = members.filter((m) => !m.missing);
  const stale = members.filter((m) => m.missing);
  for (const m of live) counts[m.role] += 1;

  const setRole = (m: MembershipView, r: ProjectRole) => {
    if (m.role === r) return;
    if (m.role === "admin" && r !== "admin" && counts.admin <= 1) {
      // Client mirror of the server guard (UX sugar — the action re-checks).
      // D5: a refusal must not render the success tick.
      push(
        `${projectName} needs at least one admin. Promote someone else first`,
        "error",
      );
      return;
    }
    onSetRole(m, r);
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="user" />
        <h2>Human access · RBAC</h2>
        <span className="right sub fine">
          {live.length} member{live.length === 1 ? "" : "s"}
          {stale.length > 0
            ? ` · ${stale.length} removed account${stale.length === 1 ? "" : "s"}`
            : ""}
        </span>
      </div>
      <div className="pol-note">
        <Icon name="board" />
        <span>
          Roles decide what each member may approve, accept, and configure,
          enforced on every project and task action.
        </span>
      </div>
      {/* P14-LV-08: the four role radios rendered live for a contributor and
          swallowed every click — they were `disabled`, but nothing in the sheet
          expressed that and `title` cannot open on a disabled control, so the
          only feedback was silence.
          U33-4 (owner, 2026-09-03): the dimmed radios are gone entirely. A
          reader without `manage-members` gets the member's role as a value
          instead (below) — ruling 65's precedent, that a withdrawn affordance
          is honest where a disabled one invites a support question. This note
          stays, and now explains the control's ABSENCE while naming the grant
          the reader would have to ask for. */}
      {!canManage && (
        <div className="pol-note">
          <Icon name="lock" />
          <span>
            Read-only: changing a member's role needs the{" "}
            <strong>Manage members &amp; roles</strong> grant (project admin).
          </span>
        </div>
      )}

      <div className="member-list">
        {members.map((m) => (
          <div className="member-row" key={m.userId}>
            <Avatar person={{ initials: m.initials, tone: m.tone }} />
            <span className="member-main">
              <div className="nm">
                {m.name}
                {m.missing && (
                  <>
                    {" "}
                    <Pill kind="blocked" sm>
                      removed account
                    </Pill>
                  </>
                )}
                {!m.missing && m.disabled && (
                  <>
                    {" "}
                    <Pill kind="neutral" sm>
                      disabled
                    </Pill>
                  </>
                )}
              </div>
              <div className="em">
                {/* LV-04: an unresolvable id used to render as the bare
                    `u_RT7-QeTWOwP4` string with an empty email, indistinguishable
                    from a real person. */}
                {m.missing
                  ? "This account no longer exists. Remove it in Settings → Members."
                  : m.email}
              </div>
            </span>
            {canManage ? (
              /* UXA-7: a radiogroup promises arrow-key traversal; this one
                 declared the role and never wired the keys. Ruling 166 moved
                 that wiring to Radix behind `RadioSeg` — same roles, same
                 classes, and Home/End and RTL for free. It is a toggle group
                 rather than a radio group ON PURPOSE: selection here commits a
                 role change, and Radix's RadioGroup selects as focus moves. */
              <RadioSeg
                className="mini-seg"
                label={"Role for " + m.name}
                value={m.role}
                // SAFETY: the options are ROLE_IDS, whose members are
                // ProjectRole, so Radix hands back one of them.
                onChange={(r) => setRole(m, r as ProjectRole)}
              >
                {ROLE_IDS.map((r) => (
                  <RadioSegOption
                    key={r}
                    value={r}
                    className={m.role === r ? "on" : ""}
                    // A deleted account cannot hold a role: the control is dead,
                    // so it no longer pretends to be live (UI-29). `canManage`
                    // is no longer part of this test — the branch above owns it.
                    disabled={busy || m.missing}
                  >
                    {ROLE_LABEL[r]}
                  </RadioSegOption>
                ))}
              </RadioSeg>
            ) : (
              /* U33-4: the reading seat. The same fact the picker encoded, in
                 words — rendered for a removed account too, so the reader and a
                 manager see the same stored role rather than a blank where the
                 ghost's row is. */
              <span className="fine sm">{ROLE_LABEL[m.role]}</span>
            )}
          </div>
        ))}
      </div>

      <div className="rbac-scroll">
        <table className="rbac-table">
          <thead>
            <tr>
              <th>Action</th>
              {ROLE_IDS.map((r) => (
                <th key={r}>
                  {ROLE_LABEL[r]} · {counts[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* E1: the first two rows (view / comment) used to render one merged
                cell reading "Any signed-in user · membership not required".
                Enforcement has answered a signed-in NON-member with the
                unknown-slug 404 on every page of this project since R15-4 —
                board, task, policy AND a comment POST — so the one place in the
                app where display contradicted enforcement was this table. They
                are ordinary rows: every ROLE holds them, and the note below says
                what holding them is worth to someone who is not a member. */}
            {RBAC_ROWS.map((row) => (
              <tr key={row.action}>
                <td className="act">
                  {row.action}
                  {/* Ruling 309(a): two grants gate more than their name says,
                      and the name stays short because sentences elsewhere on
                      this page read it inline. This table is where someone
                      comes to learn what a role can do, so the scope is here. */}
                  {row.covers ? <span className="act-covers">{row.covers}</span> : null}
                </td>
                {ROLE_IDS.map((r) => (
                  <td key={r}>
                    {/* Ruling 148: same words as the profile page's "Your
                        access" list — the check is aria-hidden, so a glyph-only
                        cell announced nothing at all. */}
                    {row.grant[r] ? (
                      <span className="rbac-yes">
                        <Icon name="check" />
                        <span className="vh">yes</span>
                      </span>
                    ) : (
                      <span className="rbac-no">no</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* D32-10 (pass 32): four rules, four items — this was one nine-line
          paragraph. Same facts, same emphasis; only the shape changed. */}
      <div className="pol-note after">
        <Icon name="message" />
        {/* A <div>, not the note's usual <span>: the list below is flow
            content, which a <span> may not contain (review F12, pass 32). */}
        <div>
          Rules that reach beyond project roles:
          <ul className="pol-rules">
            <li>
              <strong>This project is members-only</strong>. The table above
              says what a member may do; someone who is not a member is not
              merely refused: every page and every action, comments included,
              answers as if the project did not exist, so even its existence
              stays private.
            </li>
            <li>
              <strong>Contributors and above</strong> may{" "}
              <strong>take or release their own task ownership</strong>{" "}
              (viewers are read + comment only). The owner is the task&apos;s
              human reviewer and acceptance authority, scoped to that task: a
              contributor who owns a task{" "}
              <strong>may accept its completion</strong>, and{" "}
              {/* N20-7: the owner exception covered acceptance but not the
                  operator's other packet options — task-actions.server.ts lets
                  an owner resolve the non-acceptance options too, an authority
                  no surface stated. */}
              <strong>
                may resolve the non-acceptance options on a decision packet
                the operator raises on that task
              </strong>
              , even though the table reserves those columns for maintainers.
            </li>
            <li>
              <strong>Admins may release any owner</strong> (recorded in the
              audit trail).
            </li>
            <li>
              <strong>
                Org admins hold emergency project-admin authority on every
                project
              </strong>
              , even without membership, with every override recorded in the
              audit trail as <em>org-admin override</em>.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------- Surface 2: agent capability

export function AgentCapability({
  profiles,
  onOpenProfile,
  onManageProfiles,
}: {
  profiles: PcapProfile[];
  onOpenProfile: (profileId: string) => void;
  onManageProfiles: () => void;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="agents" />
        <h2>Agent capability</h2>
        <span className="right sub fine">
          {/* D6 (pass 23): the one un-pluralized count in a codebase that
              pluralizes fastidiously — a project with only its operator read
              "1 profiles". */}
          {countLabel(profiles.length, "profile")}
        </span>
      </div>
      <div className="pol-note">
        <Icon name="shield" />
        <span>
          Agents never hold human roles. What an agent may do comes only from
          its profile's capability policy: act directly, recommend, or stay
          out.
        </span>
      </div>

      <div className="pcap-list">
        {profiles.map((p) => {
          // D-2 (pass 24): the policy count must sum only GOVERNED caps. The
          // buckets also carry group-null advisory persona lines the runtime never
          // reads, which the profile-detail page (one click away) relegates to
          // "Advisory only · N lines". Counting them here made "N direct" disagree
          // with the detail's "acts directly" column (e.g. Reviewer 11 vs 5).
          const g = (labels: readonly string[]) =>
            labels.filter((l) => GOVERNED_CAP_LABELS.has(l));
          const direct = g(p.actions.direct);
          const recommend = g(p.actions.recommend);
          const human = g(p.actions.forbidden);
          // F-P2 (pass 25): a Codex-primary profile's direct/recommend counts
          // above can include grants that only bind advisorily on Codex (the
          // tool layer doesn't enforce them there — the same caveat the
          // capability matrix and profile detail already show per row). Flag
          // it here too, without splitting the counts.
          const codexPrimary = p.backends[0] === "codex";
          const advisoryOnCodex =
            codexPrimary &&
            [...direct, ...recommend].some((l) => isClaudeOnlyEnforcedLabel(l));
          return (
          <button
            type="button"
            className="pcap-row"
            key={p.id}
            onClick={() => onOpenProfile(p.id)}
            title={"Open " + p.name + " in Agents"}
          >
            <span className={"agent-glyph" + (p.kind === "operator" ? " op" : "")}>
              <Icon name={storeIcon(p.icon)} />
            </span>
            <span className="pcap-main">
              <span className="nm">{p.name}</span>
              {/* P14-WL-05: the deployed "Org Docs Writer" read
                  "Org Docs Writer · Org Docs Writer" here — the library deploy
                  copies the NAME into the role when the template declares none.
                  One shared label rule for every roster surface. */}
              <span className="sub">
                {profileRoleLabel(p.name, p.role, p.kind)}
              </span>
            </span>
            <span className="pcap-counts">
              {direct.length + recommend.length + human.length === 0 ? (
                <span
                  className="cs pcap-readonly"
                  title="This profile holds no gated capabilities. It acts read-only (e.g. reviews the diff and reports a verdict)."
                >
                  read-only · no gated capabilities
                </span>
              ) : (
                <>
                  {/* D32-9: the one vocabulary, lower-cased inline. D32-11: the
                      advisory note is a chip so the line wraps under the name
                      instead of squeezing the name column. */}
                  <span className="cs">
                    <span className="d direct"></span>
                    {direct.length} {MODE_LABEL.direct.toLowerCase()}
                  </span>
                  <span className="cs">
                    <span className="d recommend"></span>
                    {recommend.length} {MODE_LABEL.recommend.toLowerCase()}
                  </span>
                  <span className="cs">
                    <span className="d human"></span>
                    {human.length} {MODE_LABEL.human.toLowerCase()}
                  </span>
                  {advisoryOnCodex && (
                    <span
                      className="mx-scope"
                      title="Claude-enforced grants. On this profile's Codex runtime the tool layer does not bind them: the server-owned delivery gate is the real boundary."
                    >
                      advisory on Codex
                    </span>
                  )}
                </>
              )}
            </span>
          </button>
          );
        })}
      </div>

      {/* Design pass 2026-09-08: this block asks nothing of the reader, and it
          shouted three times — a danger-red eyebrow, a rose-filled pill on
          every row and a rule fencing it off. The eyebrow is the ordinary
          label, the pills describe (quiet), space does the fencing, and the
          coral locks stay as the one warm signal. */}
      <div className="human-only">
        <div className="flabel">
          Always reserved for humans
        </div>
        {ALWAYS_HUMAN_ROWS.map((row) => (
          <div className="ho-row" key={row.id}>
            <Icon name="lock" />
            <span>
              {row.label}
              {row.exception ? (
                <em className="ho-exc"> · {row.exception}</em>
              ) : null}
            </span>
            <Pill kind="risk" sm quiet>
              {row.exception ? "agent profiles" : "all profiles"}
            </Pill>
          </div>
        ))}
      </div>

      {/* One "Capability matrix" on this screen: the page header's. The copy
          that lived here opened the same modal from the same handler. */}
      <div className="pol-actions">
        <button type="button" className="btn sm" onClick={onManageProfiles}>
          <Icon name="agents" />
          Manage profiles
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- workflow rules

export function WorkflowRules({
  stages,
  transitions,
  canManage,
  busy,
  onSetBoundary,
  operator,
}: {
  stages: { id: string; name: string; color: string }[];
  transitions: TransitionView[];
  canManage: boolean;
  busy: boolean;
  onSetBoundary: (t: TransitionView, boundary: "auto" | "approval" | "human") => void;
  /** F20-19: the project's configured operator autonomy, so the human-accepts
   *  note below can be read as live or configured-off. Optional so the panel
   *  still renders the generic invariant when no roster is supplied. */
  operator?: OperatorAutonomyState;
}) {
  // Defensive stage lookup (policy spec §4.4 — a renamed/removed stage id
  // must never crash the panel).
  const S = (id: string) => stages.find((s) => s.id === id) ?? { name: id, color: undefined };
  // P13-D-1: the map is walked from the REAL transition rules. It used to draw
  // an arrow between every consecutive stage *position*, so a stage no rule
  // reached was still depicted mid-flow — the panel asserted a governed path
  // the project did not have, while the rule list under it stayed at four.
  const { chain, offChain } = stageFlowPath(stages, transitions);
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="board" />
        <h2>Workflow rules</h2>
        <span className="right sub fine">
          {stages.length} stages · {transitions.length} transition rules
        </span>
      </div>

      <div className="flow-map">
        {chain.map((id, i) => {
          const s = S(id);
          return (
            <Fragment key={id}>
              {i > 0 && (
                <span className="flow-arr">
                  <Icon name="arrow" />
                </span>
              )}
              <span className="stage-chip elig">
                <span className="sdot" data-stage-color={s.color}></span>
                {s.name}
              </span>
            </Fragment>
          );
        })}
        {offChain.map((id) => {
          const s = S(id);
          return (
            <span className="stage-chip" key={id} title="No transition rule reaches this stage">
              <span className="sdot" data-stage-color={s.color}></span>
              {s.name}
            </span>
          );
        })}
      </div>

      {offChain.length > 0 && (
        <div className="pol-note before">
          <Icon name="alert" />
          <span>
            {/* F18-14: the "govern/governance/governed" copy ban applies to
                rendered UI (design/CONVERSATION-SUMMARY line 81 calls it out for
                THIS page specifically) — say "workflow path". */}
            Off the workflow path:{" "}
            <strong>{offChain.map((id) => S(id).name).join(", ")}</strong>. No
            transition rule reaches{" "}
            {offChain.length === 1 ? "that stage" : "those stages"}, so no agent
            can move a task in or out. Only an admin or maintainer can, by hand.
          </span>
        </div>
      )}

      {/* E4: the boundary radios were `disabled` for a non-manager with no
          reason anywhere — the `locked` case gets its own chip on the row, but
          "you may not change this" was silent (a `title` on a disabled button
          never opens). Same `.deny-note` treatment the danger zone uses:
          the authority stated once, visibly, above the rows it governs. */}
      {!canManage && (
        <p className="deny-note before">
          <Icon name="lock" />
          Read-only: changing a transition&apos;s boundary needs the{" "}
          <strong>Edit workflow &amp; policy</strong> grant (project admin).
        </p>
      )}

      <div className="trans-list">
        {transitions.map((t) => {
          const k = t.from + ">" + t.to;
          const f = S(t.from);
          const o = S(t.to);
          return (
            <div className="trans-row" key={k}>
              <span className="trans-path">
                <span className="sdot" data-stage-color={f.color}></span>
                {f.name}
                <Icon name="arrow" />
                <span className="sdot" data-stage-color={o.color}></span>
                {o.name}
              </span>
              <span className="trans-by">{t.by}</span>
              <RadioSeg
                className={"cap-seg" + (t.locked ? " locked" : "")}
                label={`Boundary for ${f.name} → ${o.name}`}
                value={t.boundary}
                // A boundary is a governance decision (who may authorize this
                // transition), which is exactly why this group must commit on
                // activation and not on focus — see RadioSeg's note.
                onChange={(next) => {
                  if (t.boundary === next) return;
                  // SAFETY: the options are BOUNDARIES, whose ids are exactly
                  // these three, so Radix hands back one of them.
                  onSetBoundary(t, next as "auto" | "approval" | "human");
                }}
                title={
                  t.locked
                    ? "Completion is human-authorized in V1, so this boundary can't be delegated"
                    : undefined
                }
              >
                {BOUNDARIES.map((b) => (
                  <RadioSegOption
                    key={b.id}
                    value={b.id}
                    className={BCLS[b.id] + (t.boundary === b.id ? " on" : "")}
                    disabled={t.locked || !canManage || busy}
                  >
                    {b.label}
                  </RadioSegOption>
                ))}
              </RadioSeg>
              {t.locked && (
                <span className="trans-lock">
                  <Icon name="lock" />
                  locked · V1
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="pol-note after">
        <Icon name="lock" />
        <span>
          By default a human accepts completion: operators request{" "}
          <strong>Review → Done</strong> and a human accepts it. The one
          exception is an operator running at <strong>full autonomy</strong> with{" "}
          <strong>Accept completion into Done</strong> set to{" "}
          <em>Direct</em>, an explicit, audited opt-in that lets that operator
          close a task itself (it still refuses a failing-validation task).{" "}
          {/* F20-19: state whether that exception is actually live on THIS
              project, so the conditional above reads as configured or not — the
              autonomy value was previously visible only on the operator's
              Agents card, leaving this page identical either way. */}
          {operator && (
            <>
              <strong>On this project:</strong>{" "}
              {operator.directDoneLive ? (
                <>
                  the operator
                  {operator.operatorName ? ` (${operator.operatorName})` : ""} runs
                  at <strong>full autonomy</strong> with that grant set to{" "}
                  <em>Direct</em>, so the exception is{" "}
                  <strong>active</strong>: it can close a passing task itself.{" "}
                </>
              ) : operator.present ? (
                <>
                  the operator
                  {operator.operatorName ? ` (${operator.operatorName})` : ""} runs{" "}
                  <strong>
                    {operator.autonomy === "full"
                      ? "at full autonomy without the Direct accept grant"
                      : "supervised"}
                  </strong>
                  , so the exception is <strong>not active</strong>: every task
                  still needs a human to accept completion into Done.{" "}
                </>
              ) : (
                <>
                  no operator is deployed, so completion stays human-authorized
                  throughout.{" "}
                </>
              )}
            </>
          )}
          {/* Ruling 151 (pass 35, F35-2): the boundary below is the contract
              every actor answers to, the operator included. This sentence used
              to say the opposite (a Direct grant "crosses them itself"), which
              the engine now refuses outright. */}
          The per-transition <strong>Human approval / Human only</strong>{" "}
          boundaries below bind every actor, the operator included: a{" "}
          <em>Direct</em> stage-transitions grant crosses{" "}
          <strong>Auto-advance</strong> boundaries only, a{" "}
          <strong>Human approval</strong> boundary always files a recommendation
          for a person to apply, and a <strong>Human only</strong> boundary is
          refused to the operator.
        </span>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- guardrails

/** The set-guardrail form fields (project.policy.tsx action). A type alias,
 *  not an interface: the fetcher's SubmitTarget wants an index-signature-
 *  compatible object literal type. */
type GuardrailSubmit = {
  intent: "set-guardrail";
  _csrf: string;
  id: string;
  op: GuardrailOp;
  value?: string;
};

/**
 * E32-6 (pass 32, owner ruling): the anti-noise guardrails (project.md
 * `guardrails`, enforced live by comment-guardrails.server.ts and the
 * compaction pass) get their in-app surface here. One row per guardrail: a
 * toggle for the enforced set, a number field for the one carrying a unit
 * (compression-threshold), and inert rows for what this card does not own —
 * the branch-cleanup row (Settings → GitHub) and any retired/unknown id,
 * which is removable so a stale hand edit does not linger as a phantom rule.
 * U33-4: every one of those controls is withdrawn (not disabled) without
 * `edit-policy` — the row then reads as the state it reports.
 */
export function Guardrails({
  guardrails,
  canManage,
  busy,
  inFlight = null,
  onSet,
}: {
  guardrails: GuardrailView[];
  canManage: boolean;
  busy: boolean;
  /** Ruling 368: the guardrail and op whose request is in flight, so the
   *  button that sent it shows the work and every other control only waits. */
  inFlight?: { id: string; op: string } | null;
  onSet: (id: string, op: GuardrailOp, value?: number) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Ruling 147: Apply is kept disabled ONLY by the nothing-changed gate. The
  // old `valueChanged` folded validity into it, so a typed "0", "-3", "2.5" or
  // an emptied box was a changed draft that left Apply dead with no reason.
  // Counted per row, so a repeated press re-announces; cleared as soon as the
  // draft is edited, so a pristine row is never accused.
  const [refusedFor, setRefusedFor] = useState<Record<string, number>>({});
  // Ruling 451(g): the row refused last, as `id:count`. Its box shakes once
  // per refusal, and no other row's box shakes with it.
  const [lastRefused, setLastRefused] = useState<string | null>(null);
  const refusalShake = useRefusalShake(lastRefused);
  const valueRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const enforced = guardrails.filter((g) => g.kind === "default");
  const on = enforced.filter((g) => g.on).length;
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="shield" />
        <h2>Guardrails</h2>
        <span className="right sub fine">
          {on} of {enforced.length} enforced guardrails on
        </span>
      </div>
      <div className="pol-note">
        <Icon name="message" />
        <span>
          Anti-noise rules the timeline enforces on agent writes: a rejected
          comment never reaches the record, and compaction keeps every typed
          event. Changes apply from the next agent comment or compaction pass.
        </span>
      </div>
      {!canManage && (
        <p className="deny-note before">
          <Icon name="lock" />
          Read-only: changing a guardrail needs the{" "}
          <strong>Edit workflow &amp; policy</strong> grant (project admin).
        </p>
      )}
      <div className="guard-list">
        {guardrails.map((g) => {
          const inert = g.kind !== "default";
          const current = g.value === null ? "" : String(g.value);
          const draft = drafts[g.id] ?? current;
          const draftValue = Number(draft);
          const valid =
            draft.trim() !== "" && Number.isInteger(draftValue) && draftValue > 0;
          // A parseable draft still compares numerically, so a re-typed "040"
          // is not a change; anything unusable falls back to the raw string.
          const valueChanged = valid
            ? draftValue !== g.value
            : draft.trim() !== current;
          const refusedCount = refusedFor[g.id] ?? 0;
          const showRefusal = refusedCount > 0 && !valid;
          const errId = `guard-${g.id}-err`;
          const applyValue = () => {
            if (busy || !valueChanged) return;
            if (!valid) {
              setRefusedFor((r) => ({ ...r, [g.id]: (r[g.id] ?? 0) + 1 }));
              setLastRefused(`${g.id}:${refusedCount + 1}`);
              valueRefs.current[g.id]?.focus();
              return;
            }
            onSet(g.id, "value", draftValue);
          };
          return (
            <div className={"guard-row" + (inert ? " inert" : "")} key={g.id}>
              <div className="guard-main">
                <span className="guard-name">
                  {g.label}
                  {!g.present && (
                    <Pill kind="neutral" sm>
                      not in project.md
                    </Pill>
                  )}
                  {g.kind === "unknown" && (
                    <Pill kind="neutral" sm>
                      nothing reads this
                    </Pill>
                  )}
                </span>
                <span className="guard-desc">
                  {g.desc || (g.kind === "unknown" ? "A guardrail id the runtime does not know." : "")}
                </span>
              </div>
              {/* U33-4 (owner, 2026-09-03): without `edit-policy` this row is a
                  READING of the guardrail, never a dead control — ruling 65's
                  withdrawn-not-disabled precedent, the same shape the GitHub-
                  owned row below has always had. Nothing is hidden: the state
                  (and the threshold with its unit) still renders, as text. */}
              {g.kind === "default" &&
                (canManage ? (
                  <label className="guard-toggle">
                    <input
                      type="checkbox"
                      checked={g.on}
                      disabled={busy}
                      aria-label={`${g.label} guardrail`}
                      onChange={(e) => onSet(g.id, e.target.checked ? "on" : "off")}
                    />
                    {g.on ? "on" : "off"}
                  </label>
                ) : (
                  <span className="guard-ctl">{g.on ? "on" : "off"}</span>
                ))}
              {g.kind === "default" &&
                g.unit !== null &&
                (canManage ? (
                  <>
                  <span className="guard-ctl">
                    <input
                      ref={(el) => {
                        valueRefs.current[g.id] = el;
                      }}
                      id={`guard-${g.id}`}
                      type="number"
                      min={1}
                      step={1}
                      value={draft}
                      disabled={busy}
                      aria-label={`${g.label} value (${g.unit})`}
                      aria-invalid={showRefusal || undefined}
                      aria-describedby={showRefusal ? errId : undefined}
                      onChange={(e) => setDrafts((d) => ({ ...d, [g.id]: e.target.value }))}
                    />
                    {g.unit}
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy || !valueChanged}
                      aria-busy={(inFlight?.id === g.id && inFlight.op === "value") || undefined}
                      onClick={applyValue}
                    >
                      {inFlight?.id === g.id && inFlight.op === "value" ? (
                        <>
                          <Icon name="loader" className="spin" />
                          Applying…
                        </>
                      ) : (
                        "Apply"
                      )}
                    </button>
                  </span>
                  {showRefusal && (
                    <span
                      key={`refused-${refusedCount}`}
                      id={errId}
                      role="alert"
                      className={
                        "guard-ctl err" +
                        (refusalShake.shake && lastRefused === `${g.id}:${refusedCount}` ? " refused" : "")
                      }
                      onAnimationEnd={refusalShake.onAnimationEnd}
                    >
                      {g.label} needs a whole number above zero.
                    </span>
                  )}
                  </>
                ) : (
                  <span className="guard-ctl">
                    {/* A hand-edited project.md can carry the unit without the
                        number; the editable field shows that as an empty box,
                        so the reading says it in words — and drops the unit,
                        which measures nothing on its own. */}
                    {g.value === null ? "not set" : `${g.value} ${g.unit}`}
                  </span>
                ))}
              {g.kind === "github" && (
                <span className="guard-ctl">
                  {g.on ? "on" : "off"} · managed on Settings → GitHub
                </span>
              )}
              {g.kind === "unknown" && (
                <span className="guard-ctl">
                  {g.on ? "on" : "off"}
                  {/* U33-4: the stale row stays visible to everyone — only the
                      destructive control is reserved for who can act. */}
                  {canManage && (
                    <button
                      type="button"
                      className="btn ghost sm danger"
                      disabled={busy}
                      aria-busy={(inFlight?.id === g.id && inFlight.op === "remove") || undefined}
                      onClick={() => onSet(g.id, "remove")}
                    >
                      {inFlight?.id === g.id && inFlight.op === "remove" ? (
                        <>
                          <Icon name="loader" className="spin" />
                          Removing…
                        </>
                      ) : (
                        <>
                          <Icon name="x" />
                          Remove
                        </>
                      )}
                    </button>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------- required reviewers

/**
 * Ruling 178 (pass 36, G36-3): the reviewers the project REQUIRES per review
 * stage, read here beside the other acceptance rules. Before the rule, a
 * reviewer was required on a task only once the operator engaged it there, so
 * a task whose operator never ran the project's reviewer was acceptable on
 * another agent's verdict. The list is EDITED on Settings, where the stage and
 * agent pickers live (the same split Guardrails has with its GitHub-owned row):
 * this card states the rule and where to change it.
 */
export function RequiredReviewers({
  rules,
  canManage,
  onOpenSettings,
}: {
  rules: RequiredReviewerView[];
  canManage: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="check" />
        <h2>Required reviewers</h2>
        <span className="right sub fine">{countLabel(rules.length, "rule")}</span>
      </div>
      <div className="pol-note">
        <Icon name="message" />
        <span>
          A required reviewer must approve the delivered revision before a task
          can be accepted, whether or not the operator engaged it; the operator
          is told to run it at its stage. Without a rule, only the reviewers an
          operator engages on a task are required.
        </span>
      </div>
      {rules.length === 0 ? (
        <p className="empty sm">No required reviewers declared.</p>
      ) : (
        <div className="guard-list">
          {rules.map((r) => (
            <div className="guard-row" key={`${r.stageId} ${r.profileId}`}>
              <div className="guard-main">
                <span className="guard-name">{r.agentName}</span>
                <span className="guard-desc">Reviews at {r.stageName}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="pol-note after last">
        <Icon name={canManage ? "shield" : "lock"} />
        <span>
          {canManage ? (
            <>
              Add or remove a rule in{" "}
              <button type="button" className="keybtn" onClick={onOpenSettings}>
                Settings → Required reviewers
              </button>
            </>
          ) : (
            <>
              Read-only. Changing the rules needs the{" "}
              <strong>Edit workflow &amp; policy</strong> grant (project admin).
            </>
          )}
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- page

export function PolicyPage({
  data,
  projectSlug,
  myRole,
}: {
  data: PolicyViewData;
  projectSlug: string;
  myRole: ProjectRole | null;
}) {
  const navigate = useNavigate();
  const csrf = useCsrfToken();
  const roleFetcher = useFetcher<ActionResult>();
  const boundaryFetcher = useFetcher<ActionResult>();
  const guardFetcher = useFetcher<ActionResult>();
  useActionToast(roleFetcher);
  useActionToast(boundaryFetcher);
  useActionToast(guardFetcher);
  const [matrixOpen, setMatrixOpen] = useState(false);

  // P14-UI-58: ONE `canManage` gated both segs on `edit-policy`, but the two
  // actions behind them are different rows of the canonical matrix —
  // `set-role` enforces `manage-members`, `set-boundary` enforces
  // `edit-policy` (policy-actions.server.ts:101,185). They resolve to the same
  // role set today, so the bug was latent, and that is exactly the drift the
  // single-source matrix exists to prevent: each control asks for ITS action.
  const canSetRole = roleCan(myRole, "manage-members");
  const canEditPolicy = roleCan(myRole, "edit-policy");
  const busy =
    roleFetcher.state !== "idle" ||
    boundaryFetcher.state !== "idle" ||
    guardFetcher.state !== "idle";

  const onSetRole = (member: MembershipView, role: ProjectRole) => {
    roleFetcher.submit(
      { intent: "set-role", _csrf: csrf, userId: member.userId, role },
      { method: "post" },
    );
  };
  const onSetBoundary = (
    t: TransitionView,
    boundary: "auto" | "approval" | "human",
  ) => {
    boundaryFetcher.submit(
      { intent: "set-boundary", _csrf: csrf, from: t.from, to: t.to, boundary },
      { method: "post" },
    );
  };
  const onSetGuardrail = (id: string, op: GuardrailOp, value?: number) => {
    const fields: GuardrailSubmit = { intent: "set-guardrail", _csrf: csrf, id, op };
    if (value !== undefined) fields.value = String(value);
    guardFetcher.submit(fields, { method: "post" });
  };

  return (
    <div className="board-wrap" data-screen-label="Policy">
      <div className="board-head">
        <div>
          <h1>Policy</h1>
          <div className="sub">
            Human access and agent capability: two surfaces, managed
            separately
          </div>
        </div>
        <div className="board-tools">
          {data.edited && (
            <span className="hero-file">
              <Icon name="clock" />
              last change · {data.edited.by} ·{" "}
              <LocalDayDotTime iso={data.edited.at} />
            </span>
          )}
          <button type="button" className="btn ghost sm" onClick={() => setMatrixOpen(true)}>
            <Icon name="shield" />
            Capability matrix
          </button>
        </div>
      </div>

      <div className="policy-wrap">
        <div className="policy-cols">
          <HumanAccess
            projectName={data.projectName}
            members={data.members}
            canManage={canSetRole}
            busy={busy}
            onSetRole={onSetRole}
          />
          {/* Design pass 2026-09-08: the right cell used to hold Agent capability
              alone. `.policy-cols` is a stretching grid (ruling 148(a)), and
              Human access is far the taller of the two, so the right panel was
              drawn as a bordered, shadowed box around roughly 430px of nothing
              — the heaviest chrome on the page wrapped around its emptiest
              region. Guardrails moves up beside it rather than sitting
              full-width below, which fills the cell with the thing that was
              always going to follow it. `.profile-col` is the sheet's existing
              stack-of-panels-in-a-grid-cell class; its `> :last-child { flex: 1
              0 auto }` is what absorbs the remaining slack, so the bottom panel
              grows instead of the empty space. Reused rather than renamed: the
              class has two emitters now, and Profile is the other. */}
          <div className="profile-col">
            <AgentCapability
              profiles={data.profiles}
              onOpenProfile={(id) =>
                navigate(`/projects/${projectSlug}/agents?profile=${id}`)
              }
              onManageProfiles={() => navigate(`/projects/${projectSlug}/agents`)}
            />
            <Guardrails
              guardrails={data.guardrails}
              canManage={canEditPolicy}
              busy={busy}
              inFlight={
                guardFetcher.state !== "idle" && guardFetcher.formData
                  ? {
                      id: String(guardFetcher.formData.get("id") ?? ""),
                      op: String(guardFetcher.formData.get("op") ?? ""),
                    }
                  : null
              }
              onSet={onSetGuardrail}
            />
            {/* Ruling 178: the acceptance rule beside the other rules; the
                pickers that edit it live on Settings, next to the stages. */}
            <RequiredReviewers
              rules={data.requiredReviewers}
              canManage={canEditPolicy}
              onOpenSettings={() => navigate(`/projects/${projectSlug}/settings`)}
            />
          </div>
        </div>

        <WorkflowRules
          stages={data.stages}
          transitions={data.transitions}
          canManage={canEditPolicy}
          busy={busy}
          onSetBoundary={onSetBoundary}
          operator={operatorAutonomyState(data.profiles)}
        />
      </div>

      {matrixOpen && (
        <CapabilityMatrixModal
          profiles={data.profiles}
          projectName={data.projectName}
          onClose={() => setMatrixOpen(false)}
        />
      )}
    </div>
  );
}
