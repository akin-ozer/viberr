import { useEffect, useRef, useState, type RefObject } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import {
  keyFromName,
  projectNameFromRepo,
  slugifyProjectName,
} from "./project-name";

/**
 * The new-project dialog (home spec §4.9) and its fields: name + task key,
 * GitHub connection, repository, workflow, policy preset, footer. Split out of
 * `home-page.tsx` (pass 16, pure structural refactor — no behaviour or copy
 * change); the name ↔ repo autocomplete and the create submit stay together
 * here in `NewProjectModal`, which owns all of the dialog's state.
 */

function NewProjectNameFields({
  nameRef,
  name,
  setName,
  effKey,
  setKey,
  keyTouched,
  setKeyTouched,
  keyStripped,
  setKeyStripped,
  submit,
}: {
  nameRef: RefObject<HTMLInputElement | null>;
  name: string;
  setName: (v: string) => void;
  effKey: string;
  setKey: (v: string) => void;
  keyTouched: boolean;
  setKeyTouched: (v: boolean) => void;
  keyStripped: boolean;
  setKeyStripped: (v: boolean) => void;
  submit: () => void;
}) {
  return (
    <div className="key-row">
      <div className="field">
        <label className="flabel" htmlFor="np-name">
          Project name<span className="req">*</span>
        </label>
        <input
          id="np-name"
          type="text"
          ref={nameRef}
          value={name}
          placeholder="e.g. Payments Gateway"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </div>
      {/* LV-07: the input silently dropped every non-letter (typing "P13" left
          "P") and Create then sat disabled with no explanation. The accepted
          alphabet is stated up front, and a live note names what was stripped.
          Letters-only is the stored contract — `taskPrefix` is
          `/^[A-Za-z]+$/` in app/schemas/project-file.schema.ts. */}
      <div className="field">
        <label className="flabel" htmlFor="np-key">
          Task key{" "}
          <span className="fhint">2–4 letters · task ids look like {(effKey || "PAY") + "-1"}</span>
        </label>
        <input
          id="np-key"
          type="text"
          className="mono"
          value={effKey}
          placeholder="PAY"
          aria-describedby="np-key-note"
          // Same derived-value trap as the repo field (F14): "VIB" is real text,
          // and appending to it silently truncated at the 4-letter cap.
          onFocus={selectDerivedOnFocus(!keyTouched)}
          onChange={(e) => {
            setKeyTouched(true);
            const raw = e.target.value;
            const cleaned = raw
              .toUpperCase()
              .replace(/[^A-Z]/g, "")
              .slice(0, 4);
            setKeyStripped(raw.toUpperCase().replace(/[A-Z]/g, "").trim().length > 0);
            setKey(cleaned);
          }}
        />
        <div className="fhint" id="np-key-note">
          {keyStripped
            ? "Only letters are kept — digits and symbols aren't allowed in a task key."
            : effKey.length > 0 && effKey.length < 2
              ? "At least 2 letters."
              : ""}
        </div>
      </div>
    </div>
  );
}

function NewProjectConnectionField({
  connections,
  health,
  connOwner,
  setConnOwner,
}: {
  connections: string[];
  /** UI-09: per-owner credential health, so an unhealthy connection is not
   *  offered as if it were fine. */
  health: Record<string, "valid" | "unvalidated" | "failed">;
  connOwner: string;
  setConnOwner: (owner: string) => void;
}) {
  const picked = health[connOwner];
  return (
    <div className="field">
      <span className="flabel">
        GitHub connection<span className="req">*</span>{" "}
        <span className="fhint">sets the repository root</span>
      </span>
      <div className="pick-chips">
        {connections.map((owner) => {
          const state = health[owner] ?? "unvalidated";
          return (
            <button
              type="button"
              key={owner}
              className={"pick-chip" + (connOwner === owner ? " on" : "")}
              aria-pressed={connOwner === owner}
              title={
                state === "failed"
                  ? "This connection's token failed validation — delivery will not be able to push."
                  : state === "unvalidated"
                    ? "This connection has not been validated yet."
                    : undefined
              }
              onClick={() => setConnOwner(owner)}
            >
              <Icon name="github" />
              {owner}/
              {state !== "valid" && (
                <span className="tally">
                  {" "}
                  · {state === "failed" ? "token failed" : "unvalidated"}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* UI-09: the store-import path requires `validationState === "valid"`;
          this chip list applied no filter at all, so a failed-token connection
          looked healthy and the failure only appeared at first delivery. */}
      {connections.length > 0 && picked && picked !== "valid" && (
        <div className="def-note">
          <Icon name="alert" />
          <span>
            {picked === "failed"
              ? "This connection's token failed validation. The project will be created, but agents won't be able to push until it's replaced in Instance settings → GitHub connections."
              : "This connection hasn't been validated yet — check it in Instance settings → GitHub connections if delivery fails."}
          </span>
        </div>
      )}
      {connections.length === 0 && (
        <div className="def-note">
          <Icon name="alert" />
          <span>
            No GitHub connections yet — every project needs a repository. Add
            a PAT in{" "}
            <Link to="/org/settings?tab=connections">
              <b>Instance settings → GitHub connections</b>
            </Link>
            , then come back.
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * F14/UI-D: typing a project name auto-fills this field, and the filled value
 * is REAL text, not a placeholder. Clicking in put the caret at the end, so the
 * next keystroke appended to the derived slug — live, "Viberr" then typing the
 * repo name produced `viberrviberr`, and the dialog looked like it was fighting
 * the typist. `selectDerivedOnFocus` selects the whole derived value on focus,
 * so the first keystroke REPLACES it; once the field is edited it holds the
 * user's value and is never selected out from under them again. (The derive
 * itself already stopped on first edit — the pass-8 P1 `*Touched` rule.)
 */
export function selectDerivedOnFocus(derived: boolean) {
  return (e: React.FocusEvent<HTMLInputElement>) => {
    if (derived) e.currentTarget.select();
  };
}

function NewProjectRepoField({
  repo,
  setRepo,
  derived,
  effOwner,
  effRepo,
}: {
  repo: string;
  setRepo: (v: string) => void;
  /** The value on screen came from the project name, not from the typist. */
  derived: boolean;
  effOwner: string;
  effRepo: string;
}) {
  return (
    <div className="field">
      <label className="flabel" htmlFor="np-repo">
        GitHub repository<span className="req">*</span>{" "}
        {/* P13-D-5: "task-level override later" promised a feature that was
            never built and is now deleted — one project, one repository. */}
        <span className="fhint">
          {!effOwner
            ? "requires a GitHub connection"
            : derived && repo
              ? "from the project name — type to replace"
              : "every task in this project uses it"}
        </span>
      </label>
      <div className="repo-input">
        <span className="pre">{(effOwner || "github") + "/"}</span>
        <input
          id="np-repo"
          type="text"
          value={repo}
          placeholder={effRepo || "repo-name"}
          disabled={!effOwner}
          onFocus={selectDerivedOnFocus(derived)}
          onChange={(e) => setRepo(e.target.value)}
        />
      </div>
    </div>
  );
}

/**
 * P13-AP-04 / owner ruling 2: the "Lightweight · 3 stages" preset was DELETED —
 * it created a `todo`/`doing`/`done` board while the preinstalled roster's
 * eligible stages are the governed ids, so no specialist was ever assignable
 * (LV-01, live-proven). With one template left there is nothing to pick, so the
 * chip row is replaced by an honest statement of the board a project starts on
 * and where to change it.
 */
function NewProjectWorkflowField() {
  return (
    <div className="field">
      <span className="flabel">
        Workflow
        <span className="fhint">customize the stages in project settings</span>
      </span>
      <div className="pick-chips">
        <span className="pick-chip on" aria-disabled="true">
          <span className="sdot brand"></span>
          Standard · 5 stages
        </span>
      </div>
    </div>
  );
}

function NewProjectPolicyField({
  policy,
  setPolicy,
}: {
  policy: "strict" | "balanced" | "auto";
  setPolicy: (p: "strict" | "balanced" | "auto") => void;
}) {
  return (
    <div className="field">
      <span className="flabel">Agent policy preset</span>
      <div className="pick-chips">
        <button
          type="button"
          className={"pick-chip" + (policy === "strict" ? " on" : "")}
          aria-pressed={policy === "strict"}
          onClick={() => setPolicy("strict")}
        >
          <Icon name="lock" />
          Strict human-gate
        </button>
        <button
          type="button"
          className={"pick-chip" + (policy === "balanced" ? " on" : "")}
          aria-pressed={policy === "balanced"}
          onClick={() => setPolicy("balanced")}
        >
          <Icon name="shield" />
          Balanced · recommended
        </button>
        <button
          type="button"
          className={"pick-chip" + (policy === "auto" ? " on" : "")}
          aria-pressed={policy === "auto"}
          onClick={() => setPolicy("auto")}
        >
          <Icon name="bolt" />
          Autonomous within policy
        </button>
      </div>
      <div className="def-note">
        <Icon name="shield" />
        <span>
          Completion stays human-authorized — except an{" "}
          <b>Autonomous within policy</b> operator granted <b>direct</b>{" "}
          completion authority, which may accept work itself (disclosed on the
          Policy page). Stages, RBAC and the agent capability matrix can be
          refined in project settings.
        </span>
      </div>
    </div>
  );
}

function NewProjectFooter({
  storeRoot,
  slug,
  ok,
  blockedReason,
  busy,
  onClose,
  submit,
}: {
  /** B-FD4: null for a non-admin — the host path is admin-only, the hint falls
   *  back to the store-relative form. */
  storeRoot: string | null;
  slug: string;
  ok: boolean;
  /** LV-07: why Create is disabled — never a dead button with no explanation. */
  blockedReason: string | null;
  busy: boolean;
  onClose: () => void;
  submit: () => void;
}) {
  return (
    <div className="modal-foot">
      <span className="foot-hint mono">
        creates {storeRoot ? storeRoot + "/" : ""}projects/{slug || "…"}/
      </span>
      <span className="foot-actions">
        {!ok && blockedReason && (
          <span className="foot-hint" role="status">
            {blockedReason}
          </span>
        )}
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={!ok || busy}
          {...(!ok && blockedReason ? { title: blockedReason } : {})}
          style={!ok ? { opacity: 0.55, pointerEvents: "none" } : undefined}
          onClick={submit}
          aria-busy={busy}
        >
          <Icon name="plus" />
          Create project
        </button>
      </span>
    </div>
  );
}

export function NewProjectModal({
  connections,
  connectionHealth,
  storeRoot,
  onClose,
}: {
  /** Connection owners (Phase-4 stand-in — distinct repo owners in use). */
  connections: string[];
  /** UI-09: per-owner credential health for the chip list. */
  connectionHealth: Record<string, "valid" | "unvalidated" | "failed">;
  storeRoot: string | null;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [keyStripped, setKeyStripped] = useState(false);
  const [repo, setRepo] = useState("");
  const [repoTouched, setRepoTouched] = useState(false);
  const [policy, setPolicy] = useState<"strict" | "balanced" | "auto">(
    "balanced",
  );
  const [connOwner, setConnOwner] = useState(() => connections[0] ?? "");
  const nameRef = useRef<HTMLInputElement>(null);
  const fetcher = useFetcher<{
    ok: boolean;
    key?: string;
    slug?: string;
    storePath?: string;
    repoWarning?: string | null;
    error?: string;
  }>();
  const csrf = useCsrfToken();
  const push = useToast();
  const navigate = useNavigate();
  const { ref: panelRef, close } = useDialog(onClose);
  const closedRef = useRef(false);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const effKey = keyTouched ? key : keyFromName(name);
  const effRepo = repo || slugifyProjectName(name);
  const slug = slugifyProjectName(name);
  // Name ↔ repo AUTOCOMPLETE (not a persistent two-way lock — pass-8 P1 ruling):
  // typing into an empty/untouched field fills the OTHER, but once a field has
  // been edited by hand it is `*Touched` and the other's derive no longer
  // overwrites it. This lets a project bind to an existing repo under a distinct
  // name (e.g. repo `viberr`, name "Viberr QA") without the two fighting.
  // `effRepo` still falls back to the derived slug for the grey placeholder.
  const editName = (v: string) => {
    setName(v);
    setNameTouched(true);
    if (!repoTouched) setRepo(slugifyProjectName(v));
  };
  const editRepo = (raw: string) => {
    const v = raw
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9._-]/g, "");
    setRepo(v);
    setRepoTouched(true);
    if (v && !nameTouched) setName(projectNameFromRepo(v));
  };
  const busy = fetcher.state !== "idle";
  // The effective repo owner: a picked connection. A repository (and therefore
  // a PAT connection) is REQUIRED — repo-less projects were cut (2026-07-17,
  // reverses F10): agents deliver through GitHub, so a project without a repo
  // dead-ends at execution.
  const effOwner = connOwner;
  const ok =
    name.trim().length > 1 &&
    effKey.length >= 2 &&
    effOwner.length > 0 &&
    effRepo.length > 0;
  // LV-07: name the FIRST unmet requirement so a disabled Create is never
  // unexplained (the previous modal offered no message anywhere).
  const blockedReason =
    name.trim().length <= 1
      ? "Enter a project name (2+ characters)."
      : effKey.length < 2
        ? "Task key needs at least 2 letters."
        : effOwner.length === 0
          ? "Pick a GitHub connection."
          : effRepo.length === 0
            ? "Enter a repository name."
            : null;
  const serverError =
    fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  useEffect(() => {
    if (fetcher.data?.ok && !closedRef.current) {
      closedRef.current = true;
      push(
        fetcher.data.key +
          " initialized — task store created at " +
          fetcher.data.storePath,
      );
      // UI-09: the repo probe's outcome, when it wasn't clean. Creation used to
      // report unqualified success even for a repo GitHub has never heard of.
      if (fetcher.data.repoWarning) push(fetcher.data.repoWarning, "error");
      onClose();
      // F15-04: land IN the project you just made. Creation used to drop the
      // modal and leave you on the home grid, hunting for the new card.
      if (fetcher.data.slug) navigate(`/projects/${fetcher.data.slug}/board`);
    }
  }, [fetcher.data, onClose, push, navigate]);

  const submit = () => {
    if (!ok || busy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "create-project");
    fd.set("name", name.trim());
    fd.set("key", effKey);
    fd.set("owner", effOwner);
    fd.set("repoName", effRepo);
    fd.set("policy", policy);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    // Native <dialog> via useDialog: Escape, backdrop-click close and the
    // ::backdrop scrim all come from showModal() + the hook.
    <dialog
      className="modal-card"
      aria-label="New project"
      data-screen-label="New project modal"
      ref={panelRef}
    >
      <div className="modal-head">
        <span className="pj-mark draft">
          {(name.trim()[0] || "•").toUpperCase()}
        </span>
        <span className="mh-main">
          <h2>New project</h2>
          <div className="mh-sub">
            One board, one repo, agents under policy from day one
          </div>
        </span>
        <button
          type="button"
          className="icon-btn modal-close"
          onClick={close}
          aria-label="Close"
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body">
        <NewProjectNameFields
          nameRef={nameRef}
          name={name}
          setName={editName}
          effKey={effKey}
          setKey={setKey}
          keyTouched={keyTouched}
          setKeyTouched={setKeyTouched}
          keyStripped={keyStripped}
          setKeyStripped={setKeyStripped}
          submit={submit}
        />
        <NewProjectConnectionField
          connections={connections}
          health={connectionHealth}
          connOwner={connOwner}
          setConnOwner={setConnOwner}
        />
        <NewProjectRepoField
          repo={repo}
          setRepo={editRepo}
          derived={!repoTouched}
          effOwner={effOwner}
          effRepo={effRepo}
        />
        <NewProjectWorkflowField />
        <NewProjectPolicyField policy={policy} setPolicy={setPolicy} />
        {serverError && (
          <div className="form-err">
            <Icon name="alert" />
            <span>{serverError}</span>
          </div>
        )}
      </div>
      {/* Cancel routes through the animated close; the success unmount
          (fetcher effect above) keeps the raw onClose. */}
      <NewProjectFooter
        storeRoot={storeRoot}
        slug={slug}
        ok={ok}
        blockedReason={blockedReason}
        busy={busy}
        onClose={close}
        submit={submit}
      />
    </dialog>
  );
}
