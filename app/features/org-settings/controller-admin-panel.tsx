import { useId, useState } from "react";
import { Link } from "react-router";
import {
  ModelEffortFields,
  useModelCatalog,
} from "~/features/agents/create-profile-modal";
import { Icon } from "~/ui/icon";
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

/** One grant chip-group (Skills / MCP servers / Knowledge bases): live catalog
 *  entries as toggle chips, then any granted id the store no longer holds as a
 *  removable red `missing` chip — never an unremovable ghost (P14-KM-10). */
function GrantChips({
  label,
  options,
  granted,
  onToggle,
  mono,
}: {
  label: string;
  options: { id: string; display: string; title?: string }[];
  granted: ReadonlySet<string>;
  onToggle: (id: string) => void;
  mono?: boolean;
}) {
  const missing = [...granted].filter(
    (id) => !options.some((o) => o.id === id),
  );
  return (
    <div className="ctx-group">
      <span className="ctx-lbl">{label}</span>
      <div className="pick-chips">
        {options.map((o) => (
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
        ))}
        {missing.map((id) => (
          <button
            type="button"
            key={id}
            className={"pick-chip missing on" + (mono ? " mono" : "")}
            aria-pressed={true}
            title="No longer in the store. Click to remove this grant"
            onClick={() => onToggle(id)}
          >
            {id}
          </button>
        ))}
        {options.length === 0 && missing.length === 0 && (
          <span className="ctx-none">none defined</span>
        )}
      </div>
    </div>
  );
}

export function ControllerAdminPanel({
  config,
  kbs,
  skills,
  mcps,
}: {
  config: ControllerConfigView;
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
  const [grantKbs, setGrantKbs] = useState(new Set(config.kb));
  const [grantMcps, setGrantMcps] = useState(new Set(config.mcps));

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
      definition,
      skills: [...grantSkills].join("\n"),
      kb: [...grantKbs].join("\n"),
      mcps: [...grantMcps].join("\n"),
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
          />
          <GrantChips
            label="MCP servers"
            options={mcps.map((m) => ({ id: m, display: m }))}
            granted={grantMcps}
            onToggle={(id) => toggle(grantMcps, setGrantMcps, id)}
            mono
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
          />
        </div>
      </div>
      <div className="field">
        <label className="flabel" htmlFor={`${uid}-instructions`}>
          Instructions
          <span className="fhint">
            the controller's working doctrine, injected as its system prompt on
            every turn; markdown ok
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
