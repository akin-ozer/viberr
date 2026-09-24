import { useEffect, useRef, useState, type RefObject } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import { useCsrfToken } from "~/ui/csrf-input";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import { slugify } from "~/shared/ids/slugify";
import { keyFromName, projectNameFromRepo } from "./project-name";
import { useRefusalShake } from "~/ui/use-refusal-shake";

/**
 * The new-project dialog (home spec §4.9) and its fields: name + task key,
 * GitHub connection, repository, workflow, policy preset, footer. Split out of
 * `home-page.tsx` (pass 16, pure structural refactor — no behaviour or copy
 * change); the name ↔ repo autocomplete and the create submit stay together
 * here in `NewProjectModal`, which owns all of the dialog's state.
 */

/** The footer's blocker line; the field a refused submit flags points at it. */
const BLOCK_REASON_ID = "np-block-reason";
/** Which field the FIRST unmet requirement belongs to (`conn` has no input). */
type BlockedField = "name" | "key" | "conn" | "repo";

function NewProjectNameFields({
  nameRef,
  keyRef,
  invalidField,
  name,
  setName,
  effKey,
  setKey,
  keyTouched,
  setKeyTouched,
  keyStripped,
  setKeyStripped,
  keyInUse,
  submit,
}: {
  nameRef: RefObject<HTMLInputElement | null>;
  keyRef: RefObject<HTMLInputElement | null>;
  /** Set only after a refused submit: the dialog must not open red. */
  invalidField: BlockedField | null;
  name: string;
  setName: (v: string) => void;
  effKey: string;
  setKey: (v: string) => void;
  keyTouched: boolean;
  setKeyTouched: (v: boolean) => void;
  keyStripped: boolean;
  setKeyStripped: (v: boolean) => void;
  /** Q26-3: the resolved key already belongs to another project (allowed, noted). */
  keyInUse: boolean;
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
          aria-invalid={invalidField === "name" || undefined}
          aria-describedby={invalidField === "name" ? BLOCK_REASON_ID : undefined}
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
        {/* The hint lives BELOW the input (np-key-note), not on the label: in
            the 130px column a label-line hint wraps to two lines, pushing this
            input out of alignment with the project-name input beside it. */}
        <label className="flabel" htmlFor="np-key">
          Task key
        </label>
        <input
          id="np-key"
          type="text"
          className="mono"
          ref={keyRef}
          value={effKey}
          placeholder="PAY"
          aria-invalid={invalidField === "key" || undefined}
          // The strip note stays described; a refused submit APPENDS the reason.
          aria-describedby={
            invalidField === "key" ? "np-key-note " + BLOCK_REASON_ID : "np-key-note"
          }
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
        <div
          className={"fhint" + (keyInUse ? " warn" : "")}
          id="np-key-note"
        >
          {keyStripped
            ? "Only letters are kept; digits and symbols aren't allowed in a task key."
            : effKey.length > 0 && effKey.length < 2
              ? "At least 2 letters."
              : keyInUse
                ? // Q26-3: allowed (keys are project-scoped) but worth flagging so
                  // the admin knows the ids will share a prefix across two projects.
                  `Another project already uses ${effKey}. Both projects' ids read ${effKey}-1; they stay separate. Pick another key to tell them apart.`
                : `2-4 letters · ids look like ${(effKey || "PAY") + "-1"}`}
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
  isAdmin,
}: {
  connections: string[];
  /** UI-09: per-owner credential health, so an unhealthy connection is not
   *  offered as if it were fine. */
  health: Record<string, "valid" | "unvalidated" | "failed">;
  connOwner: string;
  setConnOwner: (owner: string) => void;
  /** Pass-19 UX audit #14: whether THIS reader can reach /org/settings. */
  isAdmin: boolean;
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
                  ? "This connection's token failed validation. Delivery will not be able to push."
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
              : "This connection hasn't been validated yet. Check it in Instance settings → GitHub connections if delivery fails."}
          </span>
        </div>
      )}
      {/* Pass-19 UX coherence audit, finding #14: creating a project is
          deliberately self-serve for ANY org member (routes/_index.tsx —
          "Org role is intentionally NOT consulted here"), but a repository, and
          therefore a PAT connection, is required. On a connectionless instance
          this note was the member's only instruction — and it was a live link
          into /org/settings, which `requireRole(request, "admin")` answers with
          a bare "Error 403 / Forbidden" splash. The same class was already
          ruled on one file away: OrgTile (home-sections.tsx) and the user menu
          both stop offering the link and name the authority instead (B-FD4).
          This was the last surface handing a member a door that refuses. */}
      {connections.length === 0 && (
        <div className="def-note">
          <Icon name="alert" />
          {isAdmin ? (
            <span>
              No GitHub connections yet. Every project needs a repository. Add
              a PAT in{" "}
              <Link to="/org/settings?tab=connections">
                <b>Instance settings → GitHub connections</b>
              </Link>
              , then come back.
            </span>
          ) : (
            <span>
              No GitHub connections yet. Every project needs a repository, and
              an org admin adds the PAT under{" "}
              <b>Instance settings → GitHub connections</b>. Ask an admin to add
              one, then come back.
            </span>
          )}
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
function selectDerivedOnFocus(derived: boolean) {
  return (e: React.FocusEvent<HTMLInputElement>) => {
    if (derived) e.currentTarget.select();
  };
}

function NewProjectRepoField({
  repoRef,
  invalidField,
  repo,
  setRepo,
  derived,
  effOwner,
  effRepo,
}: {
  repoRef: RefObject<HTMLInputElement | null>;
  invalidField: BlockedField | null;
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
              ? "from the project name (type to replace)"
              : "every task in this project uses it"}
        </span>
      </label>
      <div className="repo-input">
        <span className="pre">{(effOwner || "github") + "/"}</span>
        <input
          id="np-repo"
          type="text"
          ref={repoRef}
          value={repo}
          placeholder={effRepo || "repo-name"}
          disabled={!effOwner}
          aria-invalid={invalidField === "repo" || undefined}
          aria-describedby={invalidField === "repo" ? BLOCK_REASON_ID : undefined}
          onFocus={selectDerivedOnFocus(derived)}
          onChange={(e) => setRepo(e.target.value)}
        />
      </div>
      {/* N20-11: the owner is fixed by the selected connection and the field is a
          single segment — an owner-qualified entry like `octocat/Hello-World`
          silently slugifies to a wrong repo under the fixed owner. Say so. */}
      {effOwner && (
        <span className="fhint">
          Owner is fixed by the <b>{effOwner}</b> connection. Enter just the
          repository name.
        </span>
      )}
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
      <span className="flabel">Workflow</span>
      {/* The statement, at last: `.pick-chip` is the option BUTTON class in
          every other field of this dialog and `.on` is its selected fill, so a
          one-option picker whose only chip was pre-selected read as a control
          nobody could change (and `aria-disabled` on a role-less span told
          assistive tech nothing). */}
      <span className="fhint flush">
        Starts on the {GOVERNED_TEMPLATE.label} board · customize the stages in
        project settings
      </span>
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
          Completion stays human-authorized. The exception is an{" "}
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
  blockedReason,
  attempted,
  busy,
  onClose,
  submit,
}: {
  /** B-FD4: null for a non-admin — the host path is admin-only, the hint falls
   *  back to the store-relative form. */
  storeRoot: string | null;
  slug: string;
  /** LV-07: why Create will refuse — never a dead button with no explanation. */
  blockedReason: string | null;
  /** How many submits were refused: 0 keeps the blocker a status line; each
   *  refusal remounts it as a fresh alert, because readers announce an alert's
   *  insertion, not a role flip on a node whose text did not change. */
  attempted: number;
  busy: boolean;
  onClose: () => void;
  submit: () => void;
}) {
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(attempted);
  return (
    <div className="modal-foot">
      <span className="foot-hint mono">
        creates {storeRoot ? storeRoot + "/" : ""}projects/{slug || "…"}/
      </span>
      <span className="foot-actions">
        {blockedReason && (
          <span
            key={attempted ? "alert-" + attempted : "status"}
            className={"foot-hint" + (attempted ? " err" : "") + (attempted && refusalShake.shake ? " refused" : "")}
            onAnimationEnd={attempted ? refusalShake.onAnimationEnd : undefined}
            role={attempted ? "alert" : "status"}
            id={BLOCK_REASON_ID}
          >
            {blockedReason}
          </span>
        )}
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        {/* Enabled until the request starts: an invalid submit is refused
            with the blocker beside it, the field marked and focused
            (submit()). Only `busy` disables; the aria-busy sheet rule paints it,
            and the button itself shows the request in flight the way the app's
            other busy buttons do: the loader glyph spinning where the plus was,
            the label naming the work under way. */}
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={submit}
          aria-busy={busy}
        >
          <GlyphSwap rest="plus" alt="loader" on={busy} spinAlt />
          {busy ? "Creating project…" : "Create project"}
        </button>
      </span>
    </div>
  );
}

export function NewProjectModal({
  connections,
  connectionHealth,
  storeRoot,
  isAdmin,
  existingKeys,
  onClose,
}: {
  /** Connection owners (Phase-4 stand-in — distinct repo owners in use). */
  connections: string[];
  /** UI-09: per-owner credential health for the chip list. */
  connectionHealth: Record<string, "valid" | "unvalidated" | "failed">;
  storeRoot: string | null;
  /**
   * Pass-19 UX audit #14: does this reader hold the ORG admin role — i.e. can
   * they follow a pointer into /org/settings at all? Optional only so the one
   * caller can adopt it without a lockstep edit; until it is passed we fall
   * back to the admin fact the loader ALREADY encoded in `storeRoot`
   * (`user.role === "admin" ? VIBERR_DATA_ROOT : null`, routes/_index.tsx), so
   * the gate is honest either way and never guesses "admin" for a member.
   */
  isAdmin?: boolean;
  /** Q26-3: task keys already in use by other projects. Task keys are project-
   *  scoped (the slug disambiguates), so a collision is allowed, not blocked —
   *  but the auto-derived key can silently match another project's, so we NOTE
   *  it so the creating admin is aware their task ids will read the same prefix. */
  existingKeys?: string[];
  onClose: () => void;
}) {
  const admin = isAdmin ?? storeRoot !== null;
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
  // Which field is flagged: only after a submit was refused (the dialog must
  // not open with a red field, the same rule as the new-task title). Counted,
  // so every refusal re-inserts the alert (see NewProjectFooter).
  const [attempted, setAttempted] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const repoRef = useRef<HTMLInputElement>(null);
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
  const busy = fetcher.state !== "idle";
  // The collision note is a PRE-submit aid, so it reads the project list as it
  // was when Create was pressed. `existingKeys` is the home loader's list, and
  // `/` revalidates it on the all-projects live scope, which fires the moment
  // the new project is projected, still mid-request (createProject writes and
  // re-projects before it proves the credential and returns). Read live, the
  // list then carried the very key being created and the note flipped to
  // "Another project already uses PA" for the last ~300ms before the dialog
  // closed (owner screenshot, 2026-09-07). Live again once a refused submit
  // has settled, so a collision that appeared meanwhile is still shown.
  const [keysAtSubmit, setKeysAtSubmit] = useState<string[]>([]);
  const keyPool = busy || fetcher.data?.ok ? keysAtSubmit : existingKeys ?? [];
  // Q26-3: does the resolved key already belong to another project? (Only once
  // it is a valid 2+-letter key; case-insensitive, since keys are upper-cased.)
  const keyInUse =
    effKey.length >= 2 &&
    keyPool.some((k) => k.toUpperCase() === effKey.toUpperCase());
  const effRepo = repo || slugify(name);
  const slug = slugify(name);
  // Name ↔ repo AUTOCOMPLETE (not a persistent two-way lock — pass-8 P1 ruling):
  // typing into an empty/untouched field fills the OTHER, but once a field has
  // been edited by hand it is `*Touched` and the other's derive no longer
  // overwrites it. This lets a project bind to an existing repo under a distinct
  // name (e.g. repo `viberr`, name "Viberr QA") without the two fighting.
  // `effRepo` still falls back to the derived slug for the grey placeholder.
  const editName = (v: string) => {
    setName(v);
    setNameTouched(true);
    if (!repoTouched) setRepo(slugify(v));
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
  // LV-07: name the FIRST unmet requirement so a refused Create is never
  // unexplained (the previous modal offered no message anywhere). The field
  // is derived once and the copy from it, so the flagged input and the
  // visible reason can never disagree.
  const blocked: BlockedField | null =
    name.trim().length <= 1
      ? "name"
      : effKey.length < 2
        ? "key"
        : effOwner.length === 0
          ? "conn"
          : effRepo.length === 0
            ? "repo"
            : null;
  const blockedReason =
    blocked === "name"
      ? "Enter a project name (2+ characters)."
      : blocked === "key"
        ? "Task key needs at least 2 letters."
        : blocked === "conn"
          ? "Pick a GitHub connection."
          : blocked === "repo"
            ? "Enter a repository name."
            : null;
  const invalidField = attempted ? blocked : null;
  const serverError =
    fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  useEffect(() => {
    if (fetcher.data?.ok && !closedRef.current) {
      closedRef.current = true;
      push(
        fetcher.data.key +
          " initialized. Task store created at " +
          fetcher.data.storePath,
      );
      // UI-09: the repo probe's outcome, when it wasn't clean. Creation used to
      // report unqualified success even for a repo GitHub has never heard of.
      if (fetcher.data.repoWarning) push(fetcher.data.repoWarning, "error");
      // Instant on purpose (ruling 459): the page navigates to the new board,
      // so there is nothing for an exit to leave toward.
      onClose();
      // F15-04: land IN the project you just made. Creation used to drop the
      // modal and leave you on the home grid, hunting for the new card.
      if (fetcher.data.slug) navigate(`/projects/${fetcher.data.slug}/board`);
    }
  }, [fetcher.data, onClose, push, navigate]);

  const submit = () => {
    if (busy) return;
    if (!ok) {
      // The primary is no longer hard-disabled while the form is invalid, so
      // the click reaches this guard: the blocker becomes an alert, the field
      // it names is marked, and focus moves to it ("conn" has no input; the
      // alert beside the button is what a reader hears then).
      setAttempted((n) => n + 1);
      const target =
        blocked === "name" ? nameRef : blocked === "key" ? keyRef : blocked === "repo" ? repoRef : null;
      target?.current?.focus();
      return;
    }
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "create-project");
    fd.set("name", name.trim());
    fd.set("key", effKey);
    fd.set("owner", effOwner);
    fd.set("repoName", effRepo);
    fd.set("policy", policy);
    // The list the collision note keeps reading until this request settles.
    setKeysAtSubmit(existingKeys ?? []);
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
            One board and one repository, with agents under policy from the start
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
          keyRef={keyRef}
          invalidField={invalidField}
          name={name}
          setName={editName}
          effKey={effKey}
          setKey={setKey}
          keyTouched={keyTouched}
          setKeyTouched={setKeyTouched}
          keyStripped={keyStripped}
          setKeyStripped={setKeyStripped}
          keyInUse={keyInUse}
          submit={submit}
        />
        <NewProjectConnectionField
          connections={connections}
          health={connectionHealth}
          connOwner={connOwner}
          setConnOwner={setConnOwner}
          isAdmin={admin}
        />
        <NewProjectRepoField
          repoRef={repoRef}
          invalidField={invalidField}
          repo={repo}
          setRepo={editRepo}
          derived={!repoTouched}
          effOwner={effOwner}
          effRepo={effRepo}
        />
        <NewProjectWorkflowField />
        <NewProjectPolicyField policy={policy} setPolicy={setPolicy} />
        {/* Pass-19 UX coherence audit, finding #20: the two other outcomes of
            this same button already reach an announcer — success pushes a toast
            (role="status", ui/toast.tsx) and the pre-submit blocker hint below
            carries role="status" — while the SERVER's refusal rendered here
            silently. A screen-reader user pressed Create, heard nothing, and
            the dialog sat there looking unchanged. `role="alert"` is the app's
            own idiom for a submission failure (routes/login.tsx). */}
        {serverError && (
          <div className="form-err" role="alert">
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
        blockedReason={blockedReason}
        attempted={attempted}
        busy={busy}
        onClose={close}
        submit={submit}
      />
    </dialog>
  );
}
