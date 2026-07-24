import { Fragment } from "react";
import { Icon, type IconName } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";
import type { MatrixProfile } from "./agent-types";
import { CAP_MODAL_CATALOG } from "./capability-catalog";
import { capabilityByLabel, capabilityEnforcement } from "~/shared/capabilities";

/**
 * CapabilityMatrixModal (agents.jsx §4.6) — THE shared read-only
 * profiles × actions grid, rendered by both the Agents and Policy surfaces
 * (contracts §5). Presentation-only: takes `profiles` (the assembled
 * roster) + the project name for the subtitle. Rows: the curated modal
 * catalog groups, plus an "Other actions" group for any label a profile
 * declares outside the catalog (operator coordination actions, near-miss
 * extras). Matching is by display label — labels are rendered from the
 * id-based store server-side, so this stays exact.
 *
 * Ruling 16 additions over the mock: rendered as a native <dialog> via
 * useDialog, which provides Escape close, backdrop-click close, and focus
 * management (markup otherwise unchanged).
 */

type Mode = "direct" | "recommend" | "human" | "off";

function modeOf(profile: MatrixProfile, label: string): Mode {
  if (profile.actions.direct.includes(label)) return "direct";
  if (profile.actions.recommend.includes(label)) return "recommend";
  // `forbidden` = genuine always-human lock (coral); an explicitly WITHHELD ("off")
  // capability is just not granted (grey), same as an absent one (NEW-3).
  if (profile.actions.forbidden.includes(label)) return "human";
  return "off";
}

const MODE_TITLE: Record<Mode, string> = {
  off: "Not granted",
  human: "Reserved for humans",
  recommend: "Recommends",
  direct: "Acts directly",
};

export function CapabilityMatrixModal({
  profiles,
  projectName,
  onClose,
}: {
  profiles: MatrixProfile[];
  projectName: string;
  onClose: () => void;
}) {
  const { ref: dialogRef, close } = useDialog(onClose);

  const known = new Set(
    CAP_MODAL_CATALOG.flatMap((g) => g.caps.map((c) => c.label)),
  );
  const groups: { group: string; labels: string[] }[] = CAP_MODAL_CATALOG.map(
    (g) => ({ group: g.group, labels: g.caps.map((c) => c.label) }),
  );
  const extras = new Set<string>();
  for (const p of profiles) {
    for (const bucket of [
      p.actions.direct,
      p.actions.recommend,
      p.actions.forbidden,
      p.actions.off ?? [],
    ]) {
      for (const label of bucket) {
        if (!known.has(label)) extras.add(label);
      }
    }
  }
  if (extras.size) groups.push({ group: "Other actions", labels: [...extras] });

  return (
    <dialog
      className="modal-card modal-wide"
      aria-label="Capability matrix"
      ref={dialogRef}
    >
      <div className="modal-head">
        <span className="agent-glyph lg">
          <Icon name="shield" />
        </span>
        <div className="mh-main">
          <h2>Capability matrix</h2>
          <div className="mh-sub">
            Every profile's permissions for each action in {projectName}.
            Delivery (push · open/merge PR) is <b>server-owned</b> and gated
            server-side on the delivering profile's grant — enforced on both
            backends. Supporting (reviewing) agents run <b>read-only</b>. In-run
            tool limits bind on Claude; on Codex they are advisory, so a Codex
            run's own commands aren't blocked mid-run — the read-only sandbox and
            server-side delivery gate are what actually constrain it. Specialist
            processes share the host, not an OS sandbox.
          </div>
        </div>
        <button
          type="button"
          className="icon-btn modal-close"
          onClick={close}
          aria-label="Close"
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="mx-legend">
        <span className="lg">
          <span className="d" style={{ background: "var(--teal-dark)" }} />
          Acts directly
        </span>
        <span className="lg">
          <span className="d" style={{ background: "var(--blue)" }} />
          Recommends
        </span>
        <span className="lg">
          <span className="d" style={{ background: "var(--coral-dark)" }} />
          Reserved for humans
        </span>
        <span className="lg">
          <span className="d" style={{ background: "var(--ring)" }} />
          Not granted
        </span>
        <span className="lg mx-scope-legend">
          <span className="mx-scope">Claude-enforced</span>
          binds tools on Claude runs · advisory on Codex
        </span>
      </div>
      <div className="modal-body">
        <div className="mx-scroll">
          <table className="cap-matrix-table">
            <thead>
              <tr>
                <th className="corner">Action</th>
                {profiles.map((p) => (
                  <th key={p.id}>
                    <div className="mx-col">
                      <span
                        className={
                          "agent-glyph" + (p.kind === "operator" ? " op" : "")
                        }
                      >
                        <Icon name={p.icon as IconName} />
                      </span>
                      {p.name}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.group}>
                  <tr className="grp">
                    <td colSpan={profiles.length + 1}>{g.group}</td>
                  </tr>
                  {g.labels.map((label) => {
                    const capId = capabilityByLabel(label)?.id;
                    const claudeOnly =
                      capId && capabilityEnforcement(capId) === "claude-only";
                    return (
                    <tr key={label}>
                      <td className="rowlabel">
                        {label}
                        {claudeOnly && (
                          <span
                            className="mx-scope"
                            title="Enforced on Claude runs (tool denylist). On Codex it is advisory only — the Codex SDK ignores tool allow/deny lists (S3)."
                          >
                            Claude-enforced
                          </span>
                        )}
                      </td>
                      {profiles.map((p) => {
                        const m = modeOf(p, label);
                        return (
                          <td key={p.id}>
                            <span
                              className={"mx-cell " + m}
                              title={MODE_TITLE[m]}
                            >
                              <span className="d" />
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </dialog>
  );
}
