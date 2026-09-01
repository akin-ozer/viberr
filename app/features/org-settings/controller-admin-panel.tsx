import { useId, useState } from "react";
import { Link } from "react-router";
import {
  ModelEffortFields,
  useModelCatalog,
} from "~/features/agents/create-profile-modal";
import { Icon } from "~/ui/icon";
import { kbDirsOf, kbLegacyOf, MissingChips } from "./agent-template-modal";
import { useOrgAction } from "./use-org-action";

/**
 * Ruling 99: the org-admin surface that modifies the CONTROLLER ITSELF —
 * its model, its resource grants (skills, knowledge bases, MCP servers) and
 * its instructions. This page is admin-gated as a whole; talking TO the
 * controller is a different thing entirely and lives at /controller, open to
 * every signed-in user within their own permissions.
 *
 * Ruling 106: this panel speaks the agent-editor language, not its own — the
 * same model/effort catalog pickers as the profile modal (ModelEffortFields +
 * useModelCatalog, so an admin picks a real model instead of free-typing one
 * the runtime would silently substitute), the same pick-chip resource grants
 * as the global-profile editor (dangling grants render as removable red
 * `missing` chips), and the same flabel/fhint field furniture. The controller
 * has no backend choice (its runs resolve Claude) and no capability matrix
 * (its authority is the asking user's own permission level), so those editor
 * sections rightly have no counterpart here.
 *
 * Ruling 108: the grant sections and the instructions are LOCKED by default,
 * org admins included — a deployment decision, unlocked per section by an
 * environment variable and a restart. A locked section renders read-only
 * here and `saveControllerConfig` refuses a change to it server-side, so the
 * panel and any other caller are bound by the same rule. Model and effort
 * stay editable either way.
 */

export interface ControllerConfigView {
  name: string;
  model: string;
  /** Reasoning effort ("" = the backend default). */
  effort: string;
  skills: string[];
  kb: string[];
  mcps: string[];
  definition: string;
  profilePresent: boolean;
}

/** A knowledge base the grant picker offers: granted/stored by store DIR (how
 *  runs resolve it), displayed by NAME — the global-profile editor's exact
 *  treatment (P13-KM-01). */
export interface ControllerKbOption {
  dir: string;
  name: string;
  uri: string;
}

/** Ruling 108: which sections this deployment allows editing (true = locked).
 *  A client mirror of the server's `ControllerSectionLocks` — the loader
 *  derives it from the environment; nothing in the app can change it. */
export interface ControllerSectionLocks {
  skills: boolean;
  kb: boolean;
  mcps: boolean;
  instructions: boolean;
}

/** The unlock variable each locked section names in the note below. Mirrors
 *  the server's `CONTROLLER_UNLOCK_ENV` (a test pins the two together — the
 *  server module cannot be imported from client code). */
export const CONTROLLER_UNLOCK_ENV_VIEW = {
  skills: "VIBERR_UNLOCK_CONTROLLER_SKILLS",
  kb: "VIBERR_UNLOCK_CONTROLLER_KB",
  mcps: "VIBERR_UNLOCK_CONTROLLER_MCPS",
  instructions: "VIBERR_UNLOCK_CONTROLLER_INSTRUCTIONS",
} as const;

/** The value that unlocks a section, mirrored for the note (pinned to the
 *  server's `CONTROLLER_UNLOCK_VALUE` by the same drift test). */
export const CONTROLLER_UNLOCK_VALUE_VIEW = "enabled";

/** Section names for the lock note — mirrors the server's
 *  CONTROLLER_SECTION_LABEL (pinned together by test). */
const SECTION_LABEL = {
  skills: "skill grants",
  kb: "knowledge base grants",
  mcps: "MCP server grants",
  instructions: "instructions",
} as const;

/** A resource the controller mounts by construction, shown so an admin can see
 *  what is attached. Ruling 107: it is NOT a control, because there is no
 *  grant row behind it and nothing to toggle. */
export interface PinnedChip {
  display: string;
  /** Why it is there and why it cannot be taken away. */
  title: string;
}

/** One grant chip-group (Skills / MCP servers / Knowledge bases): a pinned
 *  built-in first when the group has one, then live catalog entries as toggle
 *  chips, then any granted id the store no longer holds as a removable red
 *  `missing` chip — never an unremovable ghost (P14-KM-10). */
function GrantChips({
  label,
  options,
  granted,
  onToggle,
  mono,
  pinned,
  locked,
}: {
  label: string;
  options: { id: string; display: string; title?: string }[];
  granted: ReadonlySet<string>;
  onToggle: (id: string) => void;
  mono?: boolean;
  pinned?: PinnedChip;
  /** Ruling 108: the section is deployment-locked — every chip renders as a
   *  non-interactive span (the ruling-107 pinned treatment: a disabled button
   *  would be a toggle that does nothing and its title would never open), and
   *  the lock note above the groups says how to unlock. */
  locked?: boolean;
}) {
  const missing = [...granted].filter(
    (id) => !options.some((o) => o.id === id),
  );
  // A locked section is a read-only DISCLOSURE, not a picker: it lists only
  // what is granted (an ungranted option under a lock is noise you cannot act
  // on), so there is no granted/ungranted distinction for a screen reader to
  // lose — the F19-5 `aria-pressed` need is specific to a toggle. Each granted
  // resource keeps its display name; a dangling grant still shows, flagged.
  const grantedOptions = locked
    ? options.filter((o) => granted.has(o.id))
    : options;
  return (
    <div className="ctx-group">
      <span className="ctx-lbl">
        {label}
        {locked && <Icon name="lock" className="lbl-lock" />}
      </span>
      <div className="pick-chips">
        {pinned && (
          // A span, not a disabled button: a disabled control is a toggle that
          // does nothing, and its `title` never opens (no pointer events reach
          // it), so the one sentence explaining the chip would be unreadable.
          <span
            className={"pick-chip on" + (mono ? " mono" : "")}
            title={pinned.title}
          >
            <Icon name="lock" />
            {pinned.display}
          </span>
        )}
        {grantedOptions.map((o) =>
          locked ? (
            <span
              key={o.id}
              className={"pick-chip on" + (mono ? " mono" : "")}
              {...(o.title ? { title: o.title } : {})}
            >
              <Icon name="check" />
              {o.display}
            </span>
          ) : (
            <button
              type="button"
              key={o.id}
              className={
                "pick-chip" + (mono ? " mono" : "") + (granted.has(o.id) ? " on" : "")
              }
              aria-pressed={granted.has(o.id)}
              {...(o.title ? { title: o.title } : {})}
              onClick={() => onToggle(o.id)}
            >
              {granted.has(o.id) && <Icon name="check" />}
              {o.display}
            </button>
          ),
        )}
        {locked ? (
          // A dangling grant under a lock is still DISCLOSED (it reaches no
          // run), it just cannot be removed here — the note says what unlocks.
          missing.map((id) => (
            <span
              key={id}
              className={"pick-chip missing on" + (mono ? " mono" : "")}
              title="No longer in the store, so this grant reaches no run. The section is locked on this deployment."
            >
              {id}
            </span>
          ))
        ) : (
          <MissingChips ids={missing} {...(mono ? { mono } : {})} onDrop={onToggle} />
        )}
        {locked && grantedOptions.length === 0 && missing.length === 0 && !pinned && (
          <span className="ctx-none">none granted</span>
        )}
        {!locked && options.length === 0 && missing.length === 0 && !pinned && (
          <span className="ctx-none">none defined</span>
        )}
      </div>
    </div>
  );
}

export function ControllerAdminPanel({
  config,
  locks,
  kbs,
  skills,
  mcps,
}: {
  config: ControllerConfigView;
  /** Ruling 108: which sections this deployment allows editing. */
  locks: ControllerSectionLocks;
  /** The org resource catalogs the grant pickers offer. */
  kbs: ControllerKbOption[];
  skills: string[];
  mcps: string[];
}) {
  const action = useOrgAction();
  const uid = useId();
  const [model, setModel] = useState(config.model);
  const [effort, setEffort] = useState(config.effort);
  const [definition, setDefinition] = useState(config.definition);
  const [grantSkills, setGrantSkills] = useState(new Set(config.skills));
  // P13-KM-01, same repair as the global-profile editor: a KB grant stored
  // under the display NAME is rewritten to its dir on open (so it renders
  // granted and the next save repairs the file); only an entry matching
  // neither dir nor name stays raw and renders as a missing chip. Done even
  // under a lock — it is DISPLAY only now, because a locked save posts blank
  // for this section rather than this repaired set (so the server keeps the
  // stored grants byte-for-byte), so the repair can no longer become a write.
  const [grantKbs, setGrantKbs] = useState(
    () => new Set([...kbDirsOf(config.kb, kbs), ...kbLegacyOf(config.kb, kbs)]),
  );
  const [grantMcps, setGrantMcps] = useState(new Set(config.mcps));

  const lockedSections = (
    [
      ["skills", locks.skills],
      ["mcps", locks.mcps],
      ["kb", locks.kb],
      ["instructions", locks.instructions],
    ] as const
  ).filter(([, locked]) => locked);

  // The controller always runs on Claude (controller-run resolves
  // `resolveRunModel("claude", …)`), so the catalog backend is fixed — no
  // backend picker, no cross-backend model incoherence to guard against.
  const {
    catalog,
    catalogLoading,
    catalogFailed,
    loadCatalog,
    selectedModel,
    showEffort,
    effortOptions,
  } = useModelCatalog("claude", model, setModel, effort, setEffort);

  const toggle = (
    set: Set<string>,
    apply: (next: Set<string>) => void,
    name: string,
  ) => {
    const next = new Set(set);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    apply(next);
  };

  const save = () => {
    action.submit({
      intent: "controller-save",
      model,
      // A model without effort tiers submits none — the same rule the profile
      // editor's payload applies.
      effort: showEffort ? effort : "",
      // Ruling 108: a locked section posts BLANK, which the server reads as
      // "keep the stored value". This is what makes a model/effort-only save
      // succeed under a lock, and it means a stale grant/doctrine copy the
      // panel is still holding can never be posted back as a change.
      definition: locks.instructions ? "" : definition,
      skills: locks.skills ? "" : [...grantSkills].join("\n"),
      kb: locks.kb ? "" : [...grantKbs].join("\n"),
      mcps: locks.mcps ? "" : [...grantMcps].join("\n"),
    });
  };

  return (
    <section className="panel ctladm" data-screen-label="Controller settings">
      <div className="panel-head">
        <Icon name="cpu" />
        <h2>{config.name}</h2>
        <div className="right">
          <Link className="btn sm ghost" to="/controller">
            Open the controller
          </Link>
        </div>
      </div>
      <p className="fine dim">
        One controller manages this instance. Anyone can talk to it; every
        action it takes runs under the asking person's own permissions. This
        tab configures the controller itself, which only org admins can do.
      </p>
      {!config.profilePresent && (
        <p className="deny-note">
          <Icon name="alert" />
          <span>
            <strong>
              The controller profile file is missing from the store; defaults
              apply.
            </strong>{" "}
            Restart the app to restore the shipped one.
          </span>
        </p>
      )}
      {lockedSections.length > 0 && (
        <p className="pol-note">
          <Icon name="lock" />
          <span>
            Locked here on this deployment:{" "}
            <strong>
              {lockedSections
                .map(([section]) => SECTION_LABEL[section])
                .join(", ")}
            </strong>
            . Model and effort stay editable. To unlock a section, set its
            variable in the app environment and restart:{" "}
            {lockedSections
              .map(
                ([section]) =>
                  CONTROLLER_UNLOCK_ENV_VIEW[section] +
                  "=" +
                  CONTROLLER_UNLOCK_VALUE_VIEW,
              )
              .join(" · ")}
            . This locks the grant lists and the doctrine file edited on this
            tab; a granted skill or knowledge base can still be edited from
            Agent resources, which changes what the controller loads.
          </span>
        </p>
      )}
      <ModelEffortFields
        uid={uid}
        backend="claude"
        model={model}
        setModel={setModel}
        effort={effort}
        setEffort={setEffort}
        catalog={catalog}
        catalogLoading={catalogLoading}
        catalogFailed={catalogFailed}
        onRetryCatalog={loadCatalog}
        selectedModel={selectedModel}
        showEffort={showEffort}
        effortOptions={effortOptions}
      />
      <div className="field">
        <span className="flabel">
          Loadable context
          <span className="fhint">
            skills, MCP servers, knowledge bases the controller loads on every
            turn · extra tools widen no authority
          </span>
        </span>
        <div className="ctx-groups">
          <GrantChips
            label="Skills"
            options={skills.map((s) => ({ id: s, display: s }))}
            granted={grantSkills}
            onToggle={(id) => toggle(grantSkills, setGrantSkills, id)}
            mono
            locked={locks.skills}
          />
          <GrantChips
            label="MCP servers"
            options={mcps.map((m) => ({ id: m, display: m }))}
            granted={grantMcps}
            onToggle={(id) => toggle(grantMcps, setGrantMcps, id)}
            mono
            // Ruling 107: the controller's own diagnostics server. It is part
            // of the controller, mounted with no config read, so it is
            // disclosed here rather than offered as a grant nobody can change.
            pinned={{
              display: "viberr_ops",
              title:
                "Built-in diagnostics (instance health, run logs, store documents). Part of the controller: mounted on every run and not removable.",
            }}
            locked={locks.mcps}
          />
          <GrantChips
            label="Knowledge bases"
            options={kbs.map((k) => ({
              id: k.dir,
              display: k.name,
              title: k.uri + "/",
            }))}
            granted={grantKbs}
            onToggle={(id) => toggle(grantKbs, setGrantKbs, id)}
            locked={locks.kb}
          />
        </div>
      </div>
      <div className="field">
        <label className="flabel" htmlFor={`${uid}-instructions`}>
          Instructions
          {locks.instructions && <Icon name="lock" className="lbl-lock" />}
          <span className="fhint">
            {locks.instructions
              ? "the controller's working doctrine · read-only, locked on this deployment"
              : "the controller's working doctrine, injected as its system prompt on every turn; markdown ok"}
          </span>
        </label>
        <textarea
          id={`${uid}-instructions`}
          className="ta-long"
          // The doctrine is the tab's main body and this is a page, not a
          // modal — keep the old panel's editing area (ta-long only floors
          // the height).
          rows={12}
          value={definition}
          readOnly={locks.instructions}
          onChange={(e) => setDefinition(e.target.value)}
        />
      </div>
      <div className="ctladm-foot">
        <span className="fine xs dim">
          Changes apply from the next controller turn.
        </span>
        <button
          type="button"
          className="btn primary sm"
          onClick={save}
          disabled={action.busy}
          aria-busy={action.busy}
        >
          <Icon name="check" />
          {action.busy ? "Saving…" : "Save controller"}
        </button>
      </div>
    </section>
  );
}
