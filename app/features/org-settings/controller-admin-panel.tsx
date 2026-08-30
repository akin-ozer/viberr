import { useState } from "react";
import { Link } from "react-router";
import { Icon } from "~/ui/icon";
import { useOrgAction } from "./use-org-action";

/**
 * Ruling 99: the org-admin surface that modifies the CONTROLLER ITSELF —
 * its model, its resource grants (skills, knowledge bases, MCP servers) and
 * its instructions. This page is admin-gated as a whole; talking TO the
 * controller is a different thing entirely and lives at /controller, open to
 * every signed-in user within their own permissions.
 */

export interface ControllerConfigView {
  name: string;
  model: string;
  skills: string[];
  kb: string[];
  mcps: string[];
  definition: string;
  profilePresent: boolean;
}

export function ControllerAdminPanel({
  config,
  kbs,
  skills,
  mcps,
}: {
  config: ControllerConfigView;
  /** The org resource catalogs the grant pickers offer (dir/slug names). */
  kbs: string[];
  skills: string[];
  mcps: string[];
}) {
  const action = useOrgAction();
  const [model, setModel] = useState(config.model);
  const [definition, setDefinition] = useState(config.definition);
  const [grantSkills, setGrantSkills] = useState(new Set(config.skills));
  const [grantKbs, setGrantKbs] = useState(new Set(config.kb));
  const [grantMcps, setGrantMcps] = useState(new Set(config.mcps));

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
      definition,
      skills: [...grantSkills].join("\n"),
      kb: [...grantKbs].join("\n"),
      mcps: [...grantMcps].join("\n"),
    });
  };

  const pickList = (
    label: string,
    options: string[],
    granted: Set<string>,
    apply: (next: Set<string>) => void,
    hint: string,
  ) => (
    <div className="ctladm-grants">
      <h3>{label}</h3>
      <p className="fine xs dim">{hint}</p>
      {options.length === 0 ? (
        <p className="fine xs dim">None exist yet (Agent resources tab).</p>
      ) : (
        <ul>
          {options.map((name) => (
            <li key={name}>
              <label>
                <input
                  type="checkbox"
                  checked={granted.has(name)}
                  onChange={() => toggle(granted, apply, name)}
                />
                <span className="mono">{name}</span>
              </label>
            </li>
          ))}
          {[...granted]
            .filter((name) => !options.includes(name))
            .map((name) => (
              <li key={name}>
                <label>
                  <input
                    type="checkbox"
                    checked
                    onChange={() => toggle(granted, apply, name)}
                  />
                  <span className="mono">{name}</span>{" "}
                  <span className="fine xs dim">not in the store</span>
                </label>
              </li>
            ))}
        </ul>
      )}
    </div>
  );

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
        <p className="fine ctladm-warn">
          The controller profile file is missing from the store; defaults
          apply. Restart the app to restore the shipped one.
        </p>
      )}
      <label className="ctladm-field">
        <span>Model</span>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Claude model id or alias (blank = default)"
        />
      </label>
      <div className="ctladm-grid">
        {pickList(
          "Skills",
          skills,
          grantSkills,
          setGrantSkills,
          "Injected as trusted operating context on every turn.",
        )}
        {pickList(
          "Knowledge bases",
          kbs,
          grantKbs,
          setGrantKbs,
          "The controller's own reference material (folder names).",
        )}
        {pickList(
          "MCP servers",
          mcps,
          grantMcps,
          setGrantMcps,
          "Extra tools mounted into its runs. They widen no authority.",
        )}
      </div>
      <label className="ctladm-field">
        <span>Instructions</span>
        <textarea
          rows={12}
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
          aria-label="Controller instructions"
        />
      </label>
      <div className="ctladm-foot">
        <span className="fine xs dim">
          Changes apply from the next controller turn.
        </span>
        <button
          type="button"
          className="btn primary sm"
          onClick={save}
          disabled={action.busy}
        >
          {action.busy ? "Saving…" : "Save controller"}
        </button>
      </div>
    </section>
  );
}
