import { Fragment, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { Avatar } from "~/ui/avatar";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon, type IconName } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { LocalDayDotTime } from "~/ui/local-time";
import { rovingRadioKeyDown } from "~/ui/roving-radio";
import { useToast } from "~/ui/toast";
import { useActionToast } from "~/ui/use-action-toast";
import {
  profileRoleLabel,
  type MatrixProfile,
} from "~/features/agents/agent-types";

/** The Agent-capability rows need the matrix shape plus the role sub-line. */
export type PcapProfile = MatrixProfile & { role: string };
import { CapabilityMatrixModal } from "~/features/agents/capability-matrix-modal";
import type { MembershipView } from "~/features/project-settings/membership.server";
import type { PolicyViewData, TransitionView } from "./policy-query.server";
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

/**
 * Policy view:
 * Human access (member roles + the read-only 9-row RBAC grant table),
 * Agent capability (per-profile direct/recommend/human counts + the
 * always-human invariant list), Workflow rules (stage flow + per-transition
 * boundaries, review→done locked human), and the shared
 * CapabilityMatrixModal. Non-admins see everything read-only (controls
 * disabled — spec §8.2 recommendation); the server enforces regardless.
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
  const counts: Record<ProjectRole, number> = {
    admin: 0,
    maintainer: 0,
    contributor: 0,
    viewer: 0,
  };
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
        `${projectName} needs at least one admin — promote someone else first`,
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
          Roles decide what each member may approve, accept, and configure —
          enforced on every project and task action.
        </span>
      </div>
      {/* P14-LV-08: the four role radios rendered live for a contributor and
          swallowed every click — they were `disabled`, but nothing in the sheet
          expressed that and `title` cannot open on a disabled control, so the
          only feedback was silence. The stylesheet now dims them; this states
          the reason where the reader can actually see it. */}
      {!canManage && (
        <div className="pol-note">
          <Icon name="lock" />
          <span>
            Read-only — changing a member's role needs the{" "}
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
                  ? "This account no longer exists — remove it in Settings → Members."
                  : m.email}
              </div>
            </span>
            {/* UXA-7: a radiogroup promises arrow-key traversal; this one
                declared the role and never wired the keys. */}
            <div
              className="mini-seg"
              role="radiogroup"
              aria-label={"Role for " + m.name}
              onKeyDown={rovingRadioKeyDown}
            >
              {ROLE_IDS.map((r) => (
                <button
                  type="button"
                  key={r}
                  role="radio"
                  aria-checked={m.role === r}
                  tabIndex={m.role === r ? 0 : -1}
                  className={m.role === r ? "on" : ""}
                  // A deleted account cannot hold a role: the control is dead,
                  // so it no longer pretends to be live (UI-29).
                  disabled={!canManage || busy || m.missing}
                  onClick={() => setRole(m, r)}
                >
                  {ROLE_LABEL[r]}
                </button>
              ))}
            </div>
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
                <td className="act">{row.action}</td>
                {ROLE_IDS.map((r) => (
                  <td key={r}>
                    {row.grant[r] ? (
                      <span className="rbac-yes">
                        <Icon name="check" />
                      </span>
                    ) : (
                      <span className="rbac-no">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pol-note after">
        <Icon name="message" />
        <span>
          Rules that reach beyond project roles:{" "}
          <strong>this project is members-only</strong> — the table above says
          what a member may do, and someone who is not a member is not merely
          refused: every page and every action, comments included, answers as if
          the project did not exist, so even its existence stays private;{" "}
          <strong>contributors and above</strong> may{" "}
          <strong>take or release their own task ownership</strong> (viewers are
          read + comment only; the owner is the task's human reviewer and
          acceptance authority, scoped to that task — a contributor who owns a
          task <strong>may accept its completion</strong>, and{" "}
          {/* N20-7: the owner exception covered acceptance but not the operator's
              other packet options — task-actions.server.ts lets an owner resolve
              the non-acceptance options too, an authority no surface stated. */}
          <strong>
            may resolve the non-acceptance options on a decision packet the
            operator raises on that task
          </strong>
          , even though the table reserves those columns for maintainers);{" "}
          <strong>admins may release any owner</strong> — recorded in the audit
          trail; and <strong>org admins hold emergency project-admin
          authority on every project</strong> — even without membership — with
          every override recorded in the audit trail as{" "}
          <em>org-admin override</em>.
        </span>
      </div>
    </div>
  );
}

// --------------------------------------------- Surface 2: agent capability

export function AgentCapability({
  profiles,
  onOpenProfile,
  onManageProfiles,
  onMatrix,
}: {
  profiles: PcapProfile[];
  onOpenProfile: (profileId: string) => void;
  onManageProfiles: () => void;
  onMatrix: () => void;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="agents" />
        <h2>Agent capability</h2>
        <span className="right sub fine">
          {profiles.length} profiles
        </span>
      </div>
      <div className="pol-note">
        <Icon name="shield" />
        <span>
          Agents never hold human roles. What an agent may do comes only from
          its profile's capability policy — act directly, recommend, or stay
          out.
        </span>
      </div>

      <div className="pcap-list">
        {profiles.map((p) => (
          <button
            type="button"
            className="pcap-row"
            key={p.id}
            onClick={() => onOpenProfile(p.id)}
            title={"Open " + p.name + " in Agents"}
          >
            <span className={"agent-glyph" + (p.kind === "operator" ? " op" : "")}>
              <Icon name={p.icon as IconName} />
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
              {p.actions.direct.length +
                p.actions.recommend.length +
                p.actions.forbidden.length ===
              0 ? (
                <span
                  className="cs pcap-readonly"
                  title="This profile holds no gated capabilities — it acts read-only (e.g. reviews the diff and reports a verdict)."
                >
                  read-only · no gated capabilities
                </span>
              ) : (
                <>
                  <span className="cs">
                    <span className="d direct"></span>
                    {p.actions.direct.length} direct
                  </span>
                  <span className="cs">
                    <span className="d recommend"></span>
                    {p.actions.recommend.length} recommend
                  </span>
                  <span className="cs">
                    <span className="d human"></span>
                    {p.actions.forbidden.length} human
                  </span>
                </>
              )}
            </span>
          </button>
        ))}
      </div>

      <div className="human-only">
        <div className="flabel danger">
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
            <Pill kind="risk" sm>
              {row.exception ? "agent profiles" : "all profiles"}
            </Pill>
          </div>
        ))}
      </div>

      <div className="pol-actions">
        <button type="button" className="btn ghost sm" onClick={onMatrix}>
          <Icon name="shield" />
          Capability matrix
        </button>
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
                <span className="sdot" style={{ background: s.color }}></span>
                {s.name}
              </span>
            </Fragment>
          );
        })}
        {offChain.map((id) => {
          const s = S(id);
          return (
            <span className="stage-chip" key={id} title="No transition rule reaches this stage">
              <span className="sdot" style={{ background: s.color }}></span>
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
            can move a task in or out — only an admin or maintainer can, by hand.
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
          Read-only — changing a transition&apos;s boundary needs the{" "}
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
                <span className="sdot" style={{ background: f.color }}></span>
                {f.name}
                <Icon name="arrow" />
                <span className="sdot" style={{ background: o.color }}></span>
                {o.name}
              </span>
              <span className="trans-by">{t.by}</span>
              <div
                className={"cap-seg" + (t.locked ? " locked" : "")}
                role="radiogroup"
                aria-label={`Boundary for ${f.name} → ${o.name}`}
                onKeyDown={rovingRadioKeyDown}
                title={
                  t.locked
                    ? "Completion is human-authorized in V1 — this boundary can't be delegated"
                    : undefined
                }
              >
                {BOUNDARIES.map((b) => (
                  <button
                    type="button"
                    key={b.id}
                    role="radio"
                    aria-checked={t.boundary === b.id}
                    tabIndex={t.boundary === b.id ? 0 : -1}
                    className={BCLS[b.id] + (t.boundary === b.id ? " on" : "")}
                    disabled={t.locked || !canManage || busy}
                    onClick={() => {
                      if (t.boundary !== b.id) onSetBoundary(t, b.id);
                    }}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
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
          <em>Direct</em> — an explicit, audited opt-in that lets that operator
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
                  <strong>active</strong> — it can close a passing task itself.{" "}
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
                  , so the exception is <strong>not active</strong> — every task
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
          The per-transition <strong>Human approval / Human only</strong>{" "}
          boundaries below apply to <strong>human</strong> actors; an operator
          granted <em>Direct</em> stage transitions crosses them itself, so treat
          those settings as the rule for people, not for a direct-capability
          operator.
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
  myRole: string | null;
}) {
  const navigate = useNavigate();
  const csrf = useCsrfToken();
  const roleFetcher = useFetcher<ActionResult>();
  const boundaryFetcher = useFetcher<ActionResult>();
  useActionToast(roleFetcher);
  useActionToast(boundaryFetcher);
  const [matrixOpen, setMatrixOpen] = useState(false);

  // P14-UI-58: ONE `canManage` gated both segs on `edit-policy`, but the two
  // actions behind them are different rows of the canonical matrix —
  // `set-role` enforces `manage-members`, `set-boundary` enforces
  // `edit-policy` (policy-actions.server.ts:101,185). They resolve to the same
  // role set today, so the bug was latent, and that is exactly the drift the
  // single-source matrix exists to prevent: each control asks for ITS action.
  const canSetRole = roleCan(myRole as ProjectRole | null, "manage-members");
  const canEditPolicy = roleCan(myRole as ProjectRole | null, "edit-policy");
  const busy =
    roleFetcher.state !== "idle" || boundaryFetcher.state !== "idle";

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

  return (
    <div className="board-wrap" data-screen-label="Policy">
      <div className="board-head">
        <div>
          <h1>Policy</h1>
          <div className="sub">
            Human access and agent capability — two surfaces, managed
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
          <AgentCapability
            profiles={data.profiles}
            onOpenProfile={(id) =>
              navigate(`/projects/${projectSlug}/agents?profile=${id}`)
            }
            onManageProfiles={() => navigate(`/projects/${projectSlug}/agents`)}
            onMatrix={() => setMatrixOpen(true)}
          />
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
