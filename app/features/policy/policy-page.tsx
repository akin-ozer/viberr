import { Fragment, useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate, type FetcherWithComponents } from "react-router";
import { Avatar } from "~/ui/avatar";
import { ArchivedBadge } from "~/ui/archived-badge";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon, type IconName } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import type { MatrixProfile } from "~/features/agents/agent-types";
import { formatDayBucket } from "~/shared/dates/format";
import { useViewerTimeZone } from "~/shared/dates/use-viewer-time-zone";
import { roleCan, type ProjectRole } from "~/shared/rbac";

/** The Agent-capability rows need the matrix shape plus the role sub-line. */
export type PcapProfile = MatrixProfile & { role: string };
import { CapabilityMatrixModal } from "~/features/agents/capability-matrix-modal";
import type { MembershipView } from "~/features/project-settings/membership.server";
import type { PolicyViewData, TransitionView } from "./policy-query.server";
import {
  ALWAYS_HUMAN_LABELS,
  BCLS,
  BOUNDARIES,
  RBAC_ROWS,
  ROLE_IDS,
  ROLE_LABEL,
  type RoleId,
} from "./policy-data";

/**
 * Policy view (design/html-app/app/policy.jsx → 1:1 port, policy spec):
 * Human access (member roles + the read-only 9-row RBAC grant table),
 * Agent capability (per-profile direct/recommend/human counts + the
 * always-human invariant list), Workflow rules (stage flow + per-transition
 * boundaries, review→done locked human), and the shared
 * CapabilityMatrixModal. Non-admins see everything read-only (controls
 * disabled — spec §8.2 recommendation); the server enforces regardless.
 */

type ActionResult = { ok: true; toast: string } | { ok: false; error: string };

function useActionToast(fetcher: FetcherWithComponents<ActionResult>) {
  const push = useToast();
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    const d = fetcher.data;
    if (d.ok) {
      if (d.toast) push(d.toast);
    } else if (d.error) {
      push({ kind: "error", text: d.error });
    }
  }, [fetcher.state, fetcher.data, push]);
}

const PANEL_COUNT_STYLE = { fontSize: ".76rem", color: "var(--faint)" } as const;

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
  onSetRole: (member: MembershipView, role: RoleId) => void;
}) {
  const push = useToast();
  const counts: Record<RoleId, number> = {
    admin: 0,
    maintainer: 0,
    contributor: 0,
    viewer: 0,
  };
  for (const m of members) counts[m.role] += 1;

  const setRole = (m: MembershipView, r: RoleId) => {
    if (m.role === r) return;
    if (m.role === "admin" && r !== "admin" && counts.admin <= 1) {
      // Client mirror of the server guard (UX sugar — the action re-checks).
      push(`${projectName} needs at least one admin — promote someone else first`);
      return;
    }
    onSetRole(m, r);
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="user" />
        <h2>Human access · RBAC</h2>
        <span className="right sub" style={PANEL_COUNT_STYLE}>
          {members.length} members
        </span>
      </div>
      <div className="pol-note">
        <Icon name="board" />
        <span>
          Roles decide what each member may approve, accept, and configure —
          enforced on every project and task action.
        </span>
      </div>

      <div className="member-list">
        {members.map((m) => (
          <div className="member-row" key={m.userId}>
            <Avatar person={{ initials: m.initials, tone: m.tone }} />
            <span className="member-main">
              <div className="nm">{m.name}</div>
              <div className="em">{m.email}</div>
            </span>
            <div className="mini-seg" role="radiogroup" aria-label={"Role for " + m.name}>
              {ROLE_IDS.map((r) => (
                <button
                  type="button"
                  key={r}
                  role="radio"
                  aria-checked={m.role === r}
                  className={m.role === r ? "on" : ""}
                  disabled={!canManage || busy}
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
      <div className="pol-note" style={{ marginTop: ".85rem" }}>
        <Icon name="message" />
        <span>
          Rules that reach beyond project roles:{" "}
          <strong>commenting is app-wide</strong> — every registered user may
          comment on any task; <strong>contributors and above</strong> may{" "}
          <strong>take or release their own task ownership</strong> (viewers are
          read + comment only; the owner is the task's human reviewer and
          acceptance authority, scoped to that task); and{" "}
          <strong>admins may release any owner</strong> — recorded in the audit
          trail. An <strong>organization admin</strong> may intervene with
          audited emergency project-admin authority even without membership;
          that override does not add every task to their personal queue.
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
        <span className="right sub" style={PANEL_COUNT_STYLE}>
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
              <span className="sub">{p.role}</span>
            </span>
            <span className="pcap-counts">
              <span className="cs">
                <span className="d" style={{ background: "var(--teal-dark)" }}></span>
                {p.actions.direct.length} direct
              </span>
              <span className="cs">
                <span className="d" style={{ background: "var(--blue)" }}></span>
                {p.actions.recommend.length} recommend
              </span>
              <span className="cs">
                <span className="d" style={{ background: "var(--coral-dark)" }}></span>
                {p.actions.forbidden.length} human
              </span>
              <span className="cs">
                <span className="d" style={{ background: "var(--ring)" }}></span>
                {p.actions.off?.length ?? 0} off
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="human-only">
        <div className="flabel" style={{ color: "var(--coral-dark)" }}>
          Always reserved for humans
        </div>
        {ALWAYS_HUMAN_LABELS.map((x) => (
          <div className="ho-row" key={x}>
            <Icon name="lock" />
            <span>{x}</span>
            <Pill kind="risk" sm>
              all profiles
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
}: {
  stages: { id: string; name: string; color: string }[];
  transitions: TransitionView[];
  canManage: boolean;
  busy: boolean;
  onSetBoundary: (t: TransitionView, boundary: "auto" | "approval" | "human") => void;
}) {
  // Defensive stage lookup (policy spec §4.4 — a renamed/removed stage id
  // must never crash the panel).
  const S = (id: string) => stages.find((s) => s.id === id) ?? { name: id, color: undefined };
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="board" />
        <h2>Workflow rules</h2>
        <span className="right sub" style={PANEL_COUNT_STYLE}>
          {stages.length} stages · {transitions.length} transition rules
        </span>
      </div>

      <div className="flow-map">
        {stages.map((s, i) => (
          <Fragment key={s.id}>
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
        ))}
      </div>

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
                title={
                  t.locked
                    ? "The human Review → Done path stays locked. Eligible full-autonomy operators use their separate completion capability for healthy repo-less work."
                    : undefined
                }
              >
                {BOUNDARIES.map((b) => (
                  <button
                    type="button"
                    key={b.id}
                    role="radio"
                    aria-checked={t.boundary === b.id}
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
                  human path locked · V1
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="pol-note" style={{ marginTop: ".85rem" }}>
        <Icon name="lock" />
        <span>
          By default a human accepts completion: operators request{" "}
          <strong>Review → Done</strong> and a human accepts it. The one
          exception is an operator running at <strong>full autonomy</strong> with{" "}
          <strong>Completion for human acceptance</strong> set to{" "}
          <em>Direct</em> — an explicit, audited opt-in that lets that operator
          finalize healthy <strong>repo-less</strong> work only after every
          assigned reviewer explicitly approves. Repository work still requires
          a real merged PR and remains on the human merge path. The
          per-transition <strong>Human approval / Human only</strong> boundaries
          below govern <strong>human</strong> actors; an operator granted{" "}
          <em>Direct</em> stage transitions crosses them itself, so treat those
          settings as the rule for people, not for a direct-capability operator.
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
  readOnly = false,
}: {
  data: PolicyViewData;
  projectSlug: string;
  myRole: ProjectRole | null;
  /** Archived projects retain policy inspection and navigation only. */
  readOnly?: boolean;
}) {
  const navigate = useNavigate();
  const timeZone = useViewerTimeZone();
  const csrf = useCsrfToken();
  const roleFetcher = useFetcher<ActionResult>();
  const boundaryFetcher = useFetcher<ActionResult>();
  useActionToast(roleFetcher);
  useActionToast(boundaryFetcher);
  const [matrixOpen, setMatrixOpen] = useState(false);

  const canManage = !readOnly && roleCan(myRole, "edit-policy");
  const busy =
    roleFetcher.state !== "idle" || boundaryFetcher.state !== "idle";

  const onSetRole = (member: MembershipView, role: RoleId) => {
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
          {readOnly && <ArchivedBadge />}
          {data.edited && (
            <span className="hero-file">
              <Icon name="clock" />
              last change · {data.edited.by} · {formatDayBucket(data.edited.at, new Date(), timeZone)}
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
            canManage={canManage}
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
          canManage={canManage}
          busy={busy}
          onSetBoundary={onSetBoundary}
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
