import { useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AgentProfileView } from "./agent-types";
import type { ModalCapGroup, ResCatalogGroup, ResourceSelection } from "./capability-catalog";
import type { CapSelection, ProfileFormPayload } from "./create-profile-modal";
import {
  saveReadiness,
  seedCaps,
  type ProfileDraft,
  type SaveReadiness,
} from "./create-profile-modal-derive";

/**
 * The agent profile editor's form (ruling 695(e), the large-component split of
 * `create-profile-modal.tsx`, on the task page's recipe): the fields, the grant
 * pickers and the save gate, each a hook that `CreateProfileModal` calls in the
 * order its state always registered (the fields, the grants, then the model
 * catalog, then the save gate), so the modal's hooks and its `useId` stand where
 * they did. No component lives here, so the module is not a Fast Refresh
 * boundary.
 */

/** The editor's fields, each with the setter or the toggle its control calls. */
export interface ProfileFields extends ProfileDraft {
  setName: Dispatch<SetStateAction<string>>;
  setRole: Dispatch<SetStateAction<string>>;
  toggleStage: (id: string) => void;
  pickBackend: (next: "codex" | "claude") => void;
  autonomy: "supervised" | "full";
  setAutonomy: Dispatch<SetStateAction<"supervised" | "full">>;
  definition: string;
  setDefinition: Dispatch<SetStateAction<string>>;
  persona: string;
  setPersona: Dispatch<SetStateAction<string>>;
  setModel: Dispatch<SetStateAction<string>>;
  effort: string;
  setEffort: Dispatch<SetStateAction<string>>;
}

/** The fields, seeded from the profile in edit mode, blank in create mode. */
export function useProfileFields(initial: AgentProfileView | null): ProfileFields {
  const [name, setName] = useState(initial ? initial.name : "");
  const [role, setRole] = useState(initial ? initial.role : "");
  const [stg, setStg] = useState<string[]>(initial ? [...initial.stages] : []);
  const [backend, setBackend] = useState<"codex" | "claude" | "">(
    initial ? (initial.backends[0] ?? "") : "",
  );
  const [autonomy, setAutonomy] = useState<"supervised" | "full">(
    initial?.autonomy ?? "supervised",
  );
  const [definition, setDefinition] = useState(initial ? initial.desc : "");
  const [persona, setPersona] = useState(initial ? initial.definition : "");
  // Model + effort picks (seeded from the profile in edit mode). The catalog
  // (`useModelCatalog`, which the modal calls after the grant pickers) supplies
  // the option lists + defaults; a seeded value that is not in the catalog is
  // still preserved and rendered.
  const [model, setModel] = useState(initial ? initial.model : "");
  const [effort, setEffort] = useState(initial ? initial.effort : "");

  const toggleStage = (id: string) =>
    setStg((arr) =>
      arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id],
    );

  /**
   * F21-13 — switching the backend clears the model and effort ON THE CLICK.
   *
   * The catalog fetch (`useModelCatalog`) is async, and until it answers,
   * `catalog` still holds the PREVIOUS backend's payload and `model` its
   * previous id. Live, that window was long enough to save through: Developer
   * went Codex → Claude while the picker read "loading available models…", Save
   * was enabled, and the deployment landed with `backends: [claude]` next to
   * `model: gpt-5.6-terra` — a pair no run can honour (the runtime silently
   * substituted a Claude model, so the profile said one thing and the run did
   * another). Clearing here makes the incoherent pair unrepresentable rather
   * than merely unlikely: the model select has nothing to submit and
   * `saveReadiness` refuses the save until the new backend's catalog resolves.
   * Re-picking the SAME chip is a no-op (an edited profile keeps its stored
   * model through an idle click).
   */
  const pickBackend = (next: "codex" | "claude") => {
    if (next === backend) return;
    setBackend(next);
    setModel("");
    setEffort("");
  };

  return {
    name,
    setName,
    role,
    setRole,
    stg,
    toggleStage,
    backend,
    pickBackend,
    autonomy,
    setAutonomy,
    definition,
    setDefinition,
    persona,
    setPersona,
    model,
    setModel,
    effort,
    setEffort,
  };
}

/** The capability policy and context-resource pickers: the selections and
 *  which of their groups stand open. */
export interface GrantPickers {
  caps: CapSelection;
  setCaps: Dispatch<SetStateAction<CapSelection>>;
  openGroups: Record<string, boolean>;
  setOpenGroups: Dispatch<SetStateAction<Record<string, boolean>>>;
  res: ResourceSelection;
  toggleRes: (key: keyof ResourceSelection, item: string) => void;
  openRes: Record<string, boolean>;
  setOpenRes: Dispatch<SetStateAction<Record<string, boolean>>>;
}

/** The grants, seeded from the profile in edit mode (`seedCaps` for the
 *  capability policy), each picker opening on its first group. */
export function useGrantPickers(
  initial: AgentProfileView | null,
  capDefaults: Readonly<CapSelection>,
  capCatalog: readonly ModalCapGroup[],
  resCatalog: readonly ResCatalogGroup[],
): GrantPickers {
  const [caps, setCaps] = useState<CapSelection>(() =>
    seedCaps(initial, capDefaults),
  );
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    [capCatalog[0]!.group]: true,
  });
  const [res, setRes] = useState<ResourceSelection>(() =>
    initial
      ? {
          skills: [...initial.resources.skills],
          mcps: [...initial.resources.mcps],
          kb: [...initial.resources.kb],
        }
      : // A NEW profile starts with NOTHING pre-selected — the user grants real
        // resources from the live catalog. (Pre-checking mock ids like
        // `repo-write` / "Coding standards" seeded grants for resources that
        // don't exist — finding #5.)
        { skills: [], mcps: [], kb: [] },
  );
  const [openRes, setOpenRes] = useState<Record<string, boolean>>(() =>
    resCatalog[0] ? { [resCatalog[0].group]: true } : {},
  );

  const toggleRes = (key: keyof ResourceSelection, item: string) =>
    setRes((p) => ({
      ...p,
      [key]: p[key].includes(item)
        ? p[key].filter((x) => x !== item)
        : [...p[key], item],
    }));

  return { caps, setCaps, openGroups, setOpenGroups, res, toggleRes, openRes, setOpenRes };
}

/** What the save reads besides the fields and grants. */
export interface SaveGateInput {
  /** The profile being edited, null in create mode. */
  initial: AgentProfileView | null;
  isOperator: boolean;
  fields: ProfileFields;
  caps: CapSelection;
  res: ResourceSelection;
  /** The selected model takes an effort (`useModelCatalog`). */
  showEffort: boolean;
  busy: boolean;
  done: boolean;
  /** Server-side failure copy. */
  error: string | null;
  uid: string;
  dialogRef: RefObject<HTMLDialogElement | null>;
  onSubmit: (payload: ProfileFormPayload) => void;
}

export interface SaveGate {
  readiness: SaveReadiness;
  /** Refused saves so far. */
  attempted: number;
  /** Which of name and role a refused save named (ruling 147); null on a
   *  pristine form. */
  flaggedField: "name" | "role" | null;
  /** The requirements line reads as an error: the server refused, or a save
   *  was attempted on an invalid form. */
  showError: boolean;
  submit: () => void;
}

/** The save: the requirements it checks, the refusals it counts and the
 *  payload it hands back. */
export function useSaveGate(input: SaveGateInput): SaveGate {
  const { initial, isOperator, fields, caps, res, showEffort } = input;
  const { busy, done, error, uid, dialogRef, onSubmit } = input;
  const { name, role, stg, backend, autonomy, definition, persona, model, effort } = fields;
  const readiness = saveReadiness(fields, isOperator);
  const { valid, missing } = readiness;
  // The requirements line is neutral guidance until the person actually tries
  // to save an invalid form — a modal that opens with red error text is
  // scolding them for something they haven't had a chance to do yet. Counted:
  // every refusal re-inserts the alert (ModalFooter).
  const [attempted, setAttempted] = useState(0);
  const flaggedField = attempted && (missing === "name" || missing === "role") ? missing : null;

  const submit = () => {
    if (busy || done) return;
    // `valid` already requires a picked backend; naming it in the guard is what
    // rules out the picker's initial "" for the payload below.
    if (!valid || !backend) {
      setAttempted((n) => n + 1);
      // Ruling 147: the refusal puts the person on the first unmet requirement.
      const dlg = dialogRef.current;
      const target =
        missing === "name" || missing === "role"
          ? document.getElementById(`${uid}-${missing}`)
          : missing === "backend" || missing === "stages"
            ? dlg?.querySelector<HTMLElement>(`[data-field="${missing}"] .pick-chip`)
            : document.getElementById(`${uid}-model`);
      target?.focus();
      return;
    }
    const payload: ProfileFormPayload = {
      backend,
      stages: [...stg],
      definition,
      persona,
      model: model.trim(),
      effort: showEffort ? effort.trim() : "",
      caps,
      resources: res,
    };
    // Ruling 518: the operator has no name or role to send.
    if (!isOperator) {
      payload.name = name.trim();
      payload.role = role.trim();
    }
    // B5: an EDIT carries the record it was opened on; a create has none.
    if (initial?.fingerprint) payload.fingerprint = initial.fingerprint;
    // Autonomy is an OPERATOR field: a specialist payload must not carry the
    // key at all (the action's schema leaves it optional and the writer only
    // stores it for the operator).
    if (isOperator) payload.autonomy = autonomy;
    onSubmit(payload);
  };

  return {
    readiness,
    attempted,
    flaggedField,
    showError: Boolean(error) || (attempted > 0 && !valid),
    submit,
  };
}
