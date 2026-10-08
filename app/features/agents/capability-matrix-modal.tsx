import { Fragment } from "react";
import { Icon, storeIcon } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";
import type { MatrixProfile } from "./agent-types";
import {
  CAP_MODAL_CATALOG,
  GOVERNED_CAP_LABELS,
  MODE_LABEL,
} from "./capability-catalog";
import {
  capabilityById,
  capabilityByLabel,
  capabilityEnforcement,
} from "~/shared/capabilities";
import { countLabel } from "~/shared/text/plural";
import {
  CODEX_REPO_WRITE_ADVISORY_NOTE,
  codexRepoWriteAdvisory,
} from "~/server/tasks/specialist-tool-policy";

/**
 * CapabilityMatrixModal (agents.jsx §4.6) — THE shared read-only
 * profiles × actions grid, rendered by both the Agents and Policy surfaces
 * (contracts §5). Presentation-only: takes `profiles` (the assembled
 * roster) + the project name for the subtitle. Rows: the curated modal
 * catalog groups, plus an "Operator actions" group for the operator's own
 * capabilities. Matching is by display label — labels are rendered from the
 * id-based store server-side, so this stays exact.
 *
 * Ruling 479(a): the grid holds only capabilities something enforces
 * (`GOVERNED_CAP_LABELS`, the set the Policy page's counts and the profile
 * panel's columns read). Advisory persona lines (`group: null` in the catalog,
 * the review-verdict outcomes among them, and bespoke extras) used to land in
 * an "Other actions" group with mode colours, so both required reviewers read
 * "Approve the review: Off", every builder "acts directly" to move a task to
 * Review, and the grid's counts disagreed with the Policy cards one click
 * away. They sit under the grid now, collapsed, the way the profile panel
 * shows them (R15-12): each line with the profiles that hold it and the mode
 * it is stored at, and no cell colour.
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

// D32-9: the one vocabulary (capability-catalog MODE_LABEL).
const MODE_TITLE = {
  off: MODE_LABEL.off,
  human: MODE_LABEL.human,
  recommend: MODE_LABEL.recommend,
  direct: MODE_LABEL.direct,
} satisfies Record<Mode, string>;

/**
 * What the matrix draws from the roster (ruling 696(e), the split of
 * `CapabilityMatrixModal`): the grid's groups, the curated catalog plus
 * "Operator actions", and the advisory lines that never reach a cell. A pure
 * function of the profiles; the modal calls it once per render.
 */
function matrixGroups(profiles: MatrixProfile[]) {
  const known = new Set(
    CAP_MODAL_CATALOG.flatMap((g) => g.caps.map((c) => c.label)),
  );
  const groups: { group: string; labels: string[] }[] = CAP_MODAL_CATALOG.map(
    (g) => ({ group: g.group, labels: g.caps.map((c) => c.label) }),
  );
  // Ruling 479(a): a label outside the agent catalog is either one of the
  // operator's own capabilities (enforced, so a grid row) or an advisory line
  // (no runtime consumer, so never a coloured cell).
  const operatorOnly = new Set<string>();
  const advisory = new Map<string, Map<Mode, string[]>>();
  for (const p of profiles) {
    const buckets: [readonly string[], Mode][] = [
      [p.actions.direct, "direct"],
      [p.actions.recommend, "recommend"],
      [p.actions.forbidden, "human"],
      [p.actions.off ?? [], "off"],
    ];
    for (const [bucket, mode] of buckets) {
      for (const label of bucket) {
        if (known.has(label)) continue;
        if (GOVERNED_CAP_LABELS.has(label)) {
          operatorOnly.add(label);
          continue;
        }
        // The profile panel lists the advisory lines a profile HOLDS; a
        // stored `off` holds nothing, so it is no line here either.
        if (mode === "off") continue;
        const byMode = advisory.get(label) ?? new Map<Mode, string[]>();
        byMode.set(mode, [...(byMode.get(mode) ?? []), p.name]);
        advisory.set(label, byMode);
      }
    }
  }
  if (operatorOnly.size) {
    groups.push({ group: "Operator actions", labels: [...operatorOnly] });
  }
  return { groups, advisory };
}

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
  const { groups, advisory } = matrixGroups(profiles);

  return (
    <dialog
      // Ruling 625: as wide as its grid (`.mx-modal`), so each row's label
      // sits beside its dots instead of 450-680px from them.
      className="modal-card mx-modal"
      aria-label="Capability matrix"
      // D33-2: `docs/ui/surfaces.md` §4 states the screen-label contract as
      // universal ("every top-level surface and dialog"), and this dialog was
      // one of two that carried none — so a sweep addressing surfaces by name
      // could not see it at all. Fixed here, not by relaxing the contract.
      data-screen-label="Capability matrix modal"
      ref={dialogRef}
    >
      <div className="modal-head">
        <span className="agent-glyph lg">
          <Icon name="shield" />
        </span>
        <div className="mh-main">
          <h2>Capability matrix</h2>
          {/* Interface review 2026-09-24 (layo-16): one sentence only. The
              head does not scroll, so the enforcement note that used to sit
              here left the matrix 0px tall at 320px; it is the first note
              below the table now. */}
          <div className="mh-sub">
            Every profile's permissions for each action in {projectName}.
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
          <span className="d direct" />
          {MODE_LABEL.direct}
        </span>
        <span className="lg">
          <span className="d recommend" />
          {MODE_LABEL.recommend}
        </span>
        <span className="lg">
          <span className="d human" />
          {MODE_LABEL.human}
        </span>
        <span className="lg">
          <span className="d off" />
          {MODE_LABEL.off}
        </span>
        {/* Ruling 625: the legend names the row mark once; the rows carry the
            mark, not the word repeated on every one. */}
        <span className="lg mx-scope-legend">
          <span className="mx-scope" aria-hidden="true">
            <Icon name="sparkle" />
          </span>
          Claude-enforced: binds tools on Claude runs · advisory on Codex
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
                        <Icon name={storeIcon(p.icon)} />
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
                    {/* The sticky must live on an INLINE child: the td spans
                        the full row (colSpan), so sticking the td itself had
                        zero travel and group names scrolled away while row
                        labels stayed pinned. */}
                    <td colSpan={profiles.length + 1}>
                      <span className="grp-label">{g.group}</span>
                    </td>
                  </tr>
                  {g.labels.map((label) => {
                    const capId = capabilityByLabel(label)?.id;
                    const claudeOnly =
                      capId && capabilityEnforcement(capId) === "claude-only";
                    // Ruling 185: with the Codex OS sandbox gone, a withheld
                    // write family has no OS channel on Codex — the prompt and
                    // the delivery gate carry it. Name the Codex-first
                    // profiles on the row so the matrix never reads "both" for
                    // a cell where the withholding is advisory.
                    const carveOut =
                      capId === "execute-code-or-write-repo"
                        ? profiles.filter(
                            (p) =>
                              p.backends[0] === "codex" &&
                              codexRepoWriteAdvisory(p.capabilities),
                          )
                        : [];
                    return (
                    <tr key={label}>
                      <td className="rowlabel">
                        {label}
                        {claudeOnly && (
                          <span
                            className="mx-scope"
                            title="Enforced on Claude runs (tool denylist). On Codex it is advisory only: the Codex SDK ignores tool allow/deny lists (S3)."
                          >
                            <Icon name="sparkle" />
                            <span className="vh">Claude-enforced</span>
                          </span>
                        )}
                        {carveOut.length > 0 && (
                          <span
                            className="mx-scope"
                            title={`For ${carveOut.map((p) => p.name).join(", ")}: ${CODEX_REPO_WRITE_ADVISORY_NOTE}.`}
                          >
                            advisory on Codex
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
                              {/* Interface review 2026-09-24 (acce-20): the
                                  title is only a description, so table
                                  navigation read every cell as blank. Same
                                  fix as ruling 148's RBAC cells. */}
                              <span className="vh">{MODE_TITLE[m]}</span>
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
          {advisory.size > 0 && (
            /* Ruling 479(a): the panel's R15-12 treatment, across profiles.
               Collapsed and outside the grid, so no cell colour and no count
               reads an advisory line as authority; the number stays visible. */
            <details className="cap-advisory">
              <summary>
                <Icon name="shield" />
                <span>
                  Advisory only · {countLabel(advisory.size, "line")} the runtime
                  does not read
                </span>
                <Icon name="chevron" className="disc-chev" />
              </summary>
              <div className="cap-advisory-body">
                <p>
                  These describe how a profile is meant to work. Nothing in the
                  runtime enforces them, so they never grant or refuse anything,
                  and the grid above leaves them out. Whether a profile&apos;s
                  review can approve or request changes is its{" "}
                  <b>{capabilityById("report-validation-verdict")?.label}</b> row.
                </p>
                <ul>
                  {[...advisory].map(([label, byMode]) => (
                    <li key={label}>
                      {label}{" "}
                      <span className="fhint">
                        (
                        {[...byMode]
                          .map(
                            ([mode, names]) =>
                              `${MODE_TITLE[mode].toLowerCase()}: ${names.join(", ")}`,
                          )
                          .join("; ")}
                        )
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )}
          <RuntimeDifferences />
        </div>
      </div>
    </dialog>
  );
}

/**
 * The runtime notes under the grid, hook-free (ruling 696(e) moved them
 * out of the modal's body unchanged).
 *
 * P13-RT-14 / LV-15 / KM-04: the Claude↔Codex differences below are
 * deliberate, but they were undisclosed — a reader could only learn
 * them by running both backends and comparing.
 */
function RuntimeDifferences() {
  return (
    <div className="mx-notes">
      <h3>What differs between the two runtimes</h3>
      <ul>
        <li>
          Delivery (push · open/merge PR) is <b>server-owned</b> and gated
          server-side on the delivering profile's grant, enforced on both
          backends. Withholding <b>Write to the repository</b> binds on
          Claude, which drops the write tools. Codex runs are not OS-confined
          (ruling 185), so there it is advisory: the prompt omits every delivery
          step, and the row is tagged "advisory on Codex" above. The scoped
          delivery commands bind only on Claude too, and the <b>server-side
          delivery gate</b> is what constrains what ships on either backend. Web
          egress stays gated on both.
        </li>
        <li>
          {/* U12 residual: "specialist" is retired vocabulary (C11/FR14) —
              the rows of this very matrix are agent PROFILES, engaged per
              task as the delivering or a supporting agent. The word
              survived here because nothing rendered this modal's prose in
              a test; `retired-vocabulary.test.tsx` now does. */}
          An agent profile running on <b>Claude</b> gets Claude Code's coding
          harness underneath its persona; the same profile on <b>Codex</b>{" "}
          gets the persona alone.
        </li>
        <li>
          {/* F19-16 / ruling 51 (R18-5): the asymmetry is meant to be
              DISCLOSED, not silent — "Codex keeps prompt-text injection —
              the asymmetry is disclosed, not silent". It was disclosed
              nowhere in the UI, so a reader granting a long skill could
              only discover the Codex clipping by comparing two runs.
              Numbers come from `SKILL_INJECTION_BUDGET` (24 000 chars,
              shared across every declared skill) and the native mount in
              `specialist-run.server.ts` (`skills: [...]` on the SDK). */}
          <b>Granted skills arrive differently.</b> On <b>Claude</b> they are
          installed into the run's workspace and handed to the SDK as real
          skills: the model sees each name and summary and loads the full
          text only when it invokes one, with no length cap. <b>Codex</b> has
          no such channel, so its skills are pasted into the prompt up front
          under one shared 24,000-character budget. A long skill can arrive
          clipped, and one that no longer fits is announced as omitted. A
          Claude run that cannot install them (no checkout, or another live
          run already holds this task's workspace) falls back to the same
          prompt text. Keep a skill short if agents on both backends must
          follow it.
        </li>
        <li>
          <b>Post mid-run comments</b> has no Codex channel: granting it does
          nothing there; a Codex agent's report always posts when the run ends.
        </li>
        <li>
          <b>Ask the human a question</b> pauses a Claude run mid-flight; on Codex
          the question arrives only when the run finishes.
        </li>
        <li>
          Org MCP credentials stay in Viberr on both backends: a run reaches a
          credentialed server through Viberr's gateway with a token that
          works only while it runs.
        </li>
        <li>
          {/* P14-LV-03: live, the same server answered `get-annotated-message`
              on Claude and `get_annotated_message` on Codex, and Claude
              listed one tool Codex never saw. The old copy covered only the
              SERVER segment, so a persona naming a tool still broke on one
              backend while this text implied it wouldn't. */}
          <b>MCP tool names differ per backend.</b> Codex renames hyphens to
          underscores in the whole tool id (server AND tool segment):{" "}
          <code>mcp__everything-http__get-annotated-message</code> on Claude
          is <code>mcp__everything_http__get_annotated_message</code> on
          Codex. The two clients can also expose different tool SETS from one
          server. Never name an MCP tool literally in a persona or skill, and
          read any tool count Viberr shows as what its OWN probe client saw,
          not as what a given run will get.
        </li>
        <li>
          {/* R16-5 (owner ruling, 2026-08-04): MCP stays outside the matrix
              BY DESIGN — the owner's call, not an oversight. The old copy
              named only the actions an MCP tool must not take, which read
              as if the matrix still bounded its powers. It does not, and
              the consequence belongs in the disclosure: a granted server
              is its own grant. Pinned by specialist-tool-policy.test.ts.
              Ruling 176 amends it: the tools an admin MARKS are the one
              exception, and the copy says which tools that covers. */}
          <b>MCP tools sit outside this matrix, with one exception.</b> Viberr
          can't know what a third-party tool does, so a granted server's tools are
          not restricted by any row here: granting a server IS the grant. The
          exception is the tools an admin marks as <b>write tools</b> on the
          server (Settings → MCP servers). Those are removed from every run whose
          agent withholds <b>Write to the repository</b>, and from every
          operator run, on Claude and Codex. A server's unmarked tools keep the
          rule stated in the run's system prompt: an MCP tool may never merge,
          close a task, or change policy. Grant MCP servers as deliberately as
          you grant a capability.
        </li>
        <li>
          Both operators can reach the web (WebFetch/WebSearch) when
          <b> Search &amp; fetch from the web</b> is granted. The Codex
          operator's web search follows the grant the same way an agent's
          does; a withheld grant disables it on either backend.
        </li>
        <li>
          A browser screenshot returns to the model as an image on Claude
          (the agent can see the page), but not on Codex. A Codex agent with
          <b> Drive a live web browser</b> can drive and read a page's text
          and accessibility tree, and its screenshots still save for humans
          on the task page, but it cannot visually see what it captured.
        </li>
      </ul>
    </div>
  );
}
