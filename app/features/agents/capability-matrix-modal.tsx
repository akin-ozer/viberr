import { Fragment } from "react";
import { Icon, storeIcon } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";
import type { MatrixProfile } from "./agent-types";
import { CAP_MODAL_CATALOG, MODE_LABEL } from "./capability-catalog";
import { capabilityByLabel, capabilityEnforcement } from "~/shared/capabilities";
import {
  CODEX_REPO_WRITE_ADVISORY_NOTE,
  codexRepoWriteAdvisory,
} from "~/server/tasks/specialist-tool-policy";

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

// D32-9: the one vocabulary (capability-catalog MODE_LABEL).
const MODE_TITLE = {
  off: MODE_LABEL.off,
  human: MODE_LABEL.human,
  recommend: MODE_LABEL.recommend,
  direct: MODE_LABEL.direct,
} satisfies Record<Mode, string>;

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
          <div className="mh-sub">
            Every profile's permissions for each action in {projectName}.
            Delivery (push · open/merge PR) is <b>server-owned</b> and gated
            server-side on the delivering profile's grant, enforced on both
            backends. Withholding <b>Execute code or write to the repo</b> binds on
            both too: Claude drops the write tools, Codex runs a read-only sandbox
            (ruling 101). The one exception is a Codex profile that withholds it
            while granting <b>Attach evidence references</b>: its runs keep a
            writable checkout, tagged "advisory on Codex" below. The scoped delivery
            commands bind only on Claude, and the <b>server-side delivery gate</b>
            is what constrains what ships on either backend. Web egress stays gated
            on both.
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
                    // Pass 32 (E32-3 fallback): the headline write family binds
                    // on both backends EXCEPT for the evidence carve-out — a
                    // Codex-first profile that withholds it while granting
                    // evidence keeps workspace-write. Name those profiles on
                    // the row so the matrix never reads "both" for a cell
                    // where the withholding is advisory.
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
                            Claude-enforced
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
          {/* P13-RT-14 / LV-15 / KM-04: the Claude↔Codex differences below are
              deliberate, but they were undisclosed — a reader could only learn
              them by running both backends and comparing. */}
          <div className="mx-notes">
            <h3>What differs between the two runtimes</h3>
            <ul>
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
                Org MCP credentials are sent on <b>Claude</b> runs only. Codex mounts a
                declared server unauthenticated, because its MCP config travels in argv.
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
                agent withholds <b>Execute code / write to the repo</b>, and from every
                operator run, on Claude and Codex. A server's unmarked tools keep the
                rule stated in the run's system prompt: an MCP tool may never merge,
                close a task, or change policy. Grant MCP servers as deliberately as
                you grant a capability.
              </li>
              <li>
                Both operators can reach the web (WebFetch/WebSearch) when
                <b> Search &amp; fetch from the web</b> is granted. The Codex
                operator's OS-sandbox network stays off, but its web search
                follows the grant the same way an agent's does; a withheld grant
                disables it on either backend.
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
        </div>
      </div>
    </dialog>
  );
}
