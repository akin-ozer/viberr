import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { useCsrfToken } from "~/ui/csrf-input";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import { slugify } from "~/shared/ids/slugify";
import { projectNameFromRepo } from "./project-name";
import type { BoardDelivers } from "~/shared/board-delivers";
import { resolveNewProject } from "./new-project-modal-derive";
import {
  BLOCK_REASON_ID,
  NewProjectConnectionField,
  NewProjectDeliversField,
  NewProjectNameFields,
  NewProjectRepoField,
} from "./project-fields";
import { useRefusalShake } from "~/ui/use-refusal-shake";

/**
 * The new-project dialog (home spec §4.9) and its fields: name + task key,
 * what the board delivers (ruling 667), GitHub connection, repository (those
 * in `project-fields.tsx`, which the board import dialog shares, ruling 653),
 * workflow, policy preset, footer. Split out of `home-page.tsx` (pass 16, pure structural refactor — no
 * behaviour or copy change); the name ↔ repo autocomplete and the create
 * submit stay together here in `NewProjectModal`, which owns all of the
 * dialog's state. Ruling 689(e): what the fields resolve to (the key, the
 * repository, the first unmet requirement) is `resolveNewProject` in
 * `new-project-modal-derive.ts`, and a made project's landing is
 * `useLandInNewProject` below.
 */

/** The create-project action's reply. */
interface CreateProjectReply {
  ok: boolean;
  key?: string;
  slug?: string;
  storePath?: string;
  repoWarning?: string | null;
  repoNote?: string | null;
  error?: string;
}

/**
 * A made project, once: the success toast says what became of it and of its
 * repository, the dialog goes at once, and the page lands on the new board.
 */
function useLandInNewProject(data: CreateProjectReply | undefined, onClose: () => void) {
  const push = useToast();
  const navigate = useNavigate();
  const closedRef = useRef(false);
  useEffect(() => {
    if (data?.ok && !closedRef.current) {
      closedRef.current = true;
      // Ruling 462: a requested repository says what became of it (created,
      // or an existing one used as it is) in the same success toast.
      push(
        data.key +
          " initialized. Task store created at " +
          data.storePath +
          (data.repoNote ? ". " + data.repoNote : ""),
      );
      // UI-09: the repo probe's outcome, when it wasn't clean. Creation used to
      // report unqualified success even for a repo GitHub has never heard of.
      if (data.repoWarning) push(data.repoWarning, "error");
      // Instant on purpose (ruling 459): the page navigates to the new board,
      // so there is nothing for an exit to leave toward.
      onClose();
      // F15-04: land IN the project you just made. Creation used to drop the
      // modal and leave you on the home grid, hunting for the new card.
      if (data.slug) navigate(`/projects/${data.slug}/board`);
    }
  }, [data, onClose, push, navigate]);
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
  const [createRepo, setCreateRepo] = useState(false);
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [policy, setPolicy] = useState<"strict" | "balanced" | "auto">(
    "balanced",
  );
  const [connOwner, setConnOwner] = useState(() => connections[0] ?? "");
  // Ruling 667: what the board delivers. An instance with no GitHub
  // connection opens on the kind it can create.
  const [delivers, setDelivers] = useState<BoardDelivers>(() =>
    connections.length > 0 ? "software" : "results",
  );
  const [attachRepo, setAttachRepo] = useState(false);
  // Ruling 672: a software board may start with no repository.
  const [repoLater, setRepoLater] = useState(false);
  // Which field is flagged: only after a submit was refused (the dialog must
  // not open with a red field, the same rule as the new-task title). Counted,
  // so every refusal re-inserts the alert (see NewProjectFooter).
  const [attempted, setAttempted] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const repoRef = useRef<HTMLInputElement>(null);
  const fetcher = useFetcher<CreateProjectReply>();
  const csrf = useCsrfToken();
  const { ref: panelRef, close } = useDialog(onClose);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

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
  const { effKey, keyInUse, effRepo, slug, effOwner, needsRepo, ok, blocked, blockedReason } =
    resolveNewProject({ name, key, keyTouched, repo, connOwner, delivers, repoLater, attachRepo }, keyPool);
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
  const invalidField = attempted ? blocked : null;
  const serverError =
    fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  useLandInNewProject(fetcher.data, onClose);

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
    fd.set("delivers", delivers);
    fd.set("owner", needsRepo ? effOwner : "");
    fd.set("repoName", needsRepo ? effRepo : "");
    fd.set("policy", policy);
    if (needsRepo && createRepo) fd.set("createRepository", repoPrivate ? "private" : "public");
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
            One board, with agents under policy from the start
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
        <NewProjectDeliversField
          delivers={delivers}
          setDelivers={setDelivers}
          attachRepo={attachRepo}
          setAttachRepo={setAttachRepo}
          repoLater={repoLater}
          setRepoLater={setRepoLater}
        />
        {needsRepo && (
          <>
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
              createRepo={createRepo}
              setCreateRepo={setCreateRepo}
              repoPrivate={repoPrivate}
              setRepoPrivate={setRepoPrivate}
              readOnly={delivers === "results"}
            />
          </>
        )}
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
          (useLandInNewProject) keeps the raw onClose. */}
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
