import type { RefObject } from "react";
import { Link } from "react-router";
import type { BoardDelivers } from "~/shared/board-delivers";
import { Icon } from "~/ui/icon";

/**
 * Ruling 653: the fields that say what a new project is called and where its
 * repository lives, shared by the New project dialog and Instance settings'
 * board import dialog, so the two read, derive and refuse alike. Split out of
 * `new-project-modal.tsx` with no change to either.
 */

/** The footer's blocker line; the field a refused submit flags points at it.
 *  The board import dialog (ruling 653) prints its own under the same id. */
export const BLOCK_REASON_ID = "np-block-reason";
/** Which field the FIRST unmet requirement belongs to (`conn` has no input). */
export type BlockedField = "name" | "key" | "conn" | "repo";

/** Project name and task key, shared with the board import dialog (ruling 653). */
export function NewProjectNameFields({
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

/**
 * Ruling 667: what the board delivers. A results board needs no repository;
 * its second control attaches one anyway, for agents that read a repository
 * and never write it. Ruling 672: a software board may start without one too,
 * and its second control says so.
 */
export function NewProjectDeliversField({
  delivers,
  setDelivers,
  attachRepo,
  setAttachRepo,
  repoLater,
  setRepoLater,
}: {
  delivers: BoardDelivers;
  setDelivers: (v: BoardDelivers) => void;
  /** Results only: attach a repository for the agents to read. */
  attachRepo: boolean;
  setAttachRepo: (v: boolean) => void;
  /** Software only: start with no repository and connect it later. */
  repoLater: boolean;
  setRepoLater: (v: boolean) => void;
}) {
  return (
    <div className="field">
      <span className="flabel">This board delivers</span>
      <div className="pick-chips">
        <button
          type="button"
          className={"pick-chip" + (delivers === "software" ? " on" : "")}
          aria-pressed={delivers === "software"}
          onClick={() => setDelivers("software")}
        >
          <Icon name="github" />
          Software
        </button>
        <button
          type="button"
          className={"pick-chip" + (delivers === "results" ? " on" : "")}
          aria-pressed={delivers === "results"}
          onClick={() => setDelivers("results")}
        >
          <Icon name="file" />
          Results · no code
        </button>
      </div>
      <span className="fhint flush">
        {delivers === "software"
          ? repoLater
            ? SOFTWARE_REPO_LATER_HINT
            : "Agents change a repository and each task ships as a pull request."
          : "You file a task with an input, agents work on it, and the result comes back as files on the task. No repository needed."}
      </span>
      {delivers === "results" ? (
        <AttachRepoLine attachRepo={attachRepo} setAttachRepo={setAttachRepo} />
      ) : (
        <RepoLaterLine repoLater={repoLater} setRepoLater={setRepoLater} />
      )}
    </div>
  );
}

/** Ruling 672: what a software board that starts with no repository does
 *  until it has one. Shared with the board import dialog. */
export const SOFTWARE_REPO_LATER_HINT =
  "The board starts with no repository. Tasks come back as files until one is connected, and the operator asks for it the first time a task needs a pull request.";

/** Ruling 672: a software board's way to start with no repository, shared
 *  with the board import dialog. */
export function RepoLaterLine({
  repoLater,
  setRepoLater,
}: {
  repoLater: boolean;
  setRepoLater: (v: boolean) => void;
}) {
  return (
    <label className="check-line">
      <input
        type="checkbox"
        checked={repoLater}
        onChange={(e) => setRepoLater(e.target.checked)}
      />
      Connect the repository later
    </label>
  );
}

/** Ruling 667: a results board's one repository control, shared with the
 *  board import dialog, where the file decides what the board delivers. */
export function AttachRepoLine({
  attachRepo,
  setAttachRepo,
}: {
  attachRepo: boolean;
  setAttachRepo: (v: boolean) => void;
}) {
  return (
    <label className="check-line">
      <input
        type="checkbox"
        checked={attachRepo}
        onChange={(e) => setAttachRepo(e.target.checked)}
      />
      Attach a repository for the agents to read
    </label>
  );
}

/** The GitHub connection chips, shared with the board import dialog. */
export function NewProjectConnectionField({
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
              No GitHub connections yet, and a repository needs one. Add a
              PAT in{" "}
              <Link to="/org/settings?tab=connections">
                <b>Instance settings → GitHub connections</b>
              </Link>
              , then come back.
            </span>
          ) : (
            <span>
              No GitHub connections yet, and a repository needs one. An org
              admin adds the PAT under{" "}
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

/** The repository field and its create option, shared with the board import
 *  dialog. */
export function NewProjectRepoField({
  repoRef,
  invalidField,
  repo,
  setRepo,
  derived,
  effOwner,
  effRepo,
  createRepo,
  setCreateRepo,
  repoPrivate,
  setRepoPrivate,
  readOnly = false,
}: {
  repoRef: RefObject<HTMLInputElement | null>;
  invalidField: BlockedField | null;
  repo: string;
  setRepo: (v: string) => void;
  /** The value on screen came from the project name, not from the typist. */
  derived: boolean;
  effOwner: string;
  effRepo: string;
  /** Ruling 462: create the repository on GitHub when it does not exist. */
  createRepo: boolean;
  setCreateRepo: (v: boolean) => void;
  /** Ruling 462: the created repository's visibility, private by default. */
  repoPrivate: boolean;
  setRepoPrivate: (v: boolean) => void;
  /** Ruling 667: a results board's repository, which its agents read and
   *  never write. */
  readOnly?: boolean;
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
              : readOnly
                ? "an existing repository"
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
          {/* Ruling 667: a results board's repository is reference material. */}
          {readOnly && " The agents read it and commit nothing to it."}
        </span>
      )}
      {/* Ruling 462: the server creates the repository with the connection's
          token before it writes the project, and a refusal names what the
          token lacks and creates nothing. Off by default: an existing
          repository is the usual case, and a typo must not become one. */}
      {effOwner && (
        <label className="check-line">
          <input
            type="checkbox"
            checked={createRepo}
            onChange={(e) => setCreateRepo(e.target.checked)}
          />
          Create this repository on GitHub if it does not exist
        </label>
      )}
      {effOwner && createRepo && (
        <label className="check-line">
          <input
            type="checkbox"
            checked={repoPrivate}
            onChange={(e) => setRepoPrivate(e.target.checked)}
          />
          Create it as a private repository
        </label>
      )}
    </div>
  );
}
