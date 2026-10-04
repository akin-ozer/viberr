import { Fragment, useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import {
  BLOCK_REASON_ID,
  NewProjectConnectionField,
  NewProjectNameFields,
  NewProjectRepoField,
  type BlockedField,
} from "~/features/home/project-fields";
import { keyFromName, projectNameFromRepo } from "~/features/home/project-name";
import type { BoardExportSummary } from "~/server/org/board-export.server";
import type {
  BoardImportAgent,
  BoardImportPreview,
  BoardImportResource,
  BoardResourceChoice,
} from "~/server/org/board-import.server";
import { slugify } from "~/shared/ids/slugify";
import { countLabel } from "~/shared/text/plural";
import { GlyphSwap } from "~/ui/copy-glyph";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon, type IconName } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { Pill } from "~/ui/pill";
import { RadioSeg, RadioSegOption } from "~/ui/radio-seg";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useRefusalShake } from "~/ui/use-refusal-shake";
import type { OrgActionData } from "./use-org-action";

/**
 * Ruling 653: the board import dialog. It opens on the server's preview of
 * the file (nothing has been written) and shows, top to bottom, what the
 * person decides and then what they get: the new project's name, key and
 * repository (the New project dialog's own fields, so the two read and
 * refuse alike), the workflow as a row of stages with the rule into each,
 * the agents, and every knowledge base, skill, MCP server and agent template
 * the file carries with what happens to it here. A resource this instance
 * holds differently under the same name offers its one choice inline:
 * import the file's as a copy (the default) or use this instance's.
 *
 * A file with problems shows them all instead of the form, with the way out:
 * choose the fixed file.
 */

/** The resource kinds in the order the dialog lists them, with their panel's
 *  glyph on Agent resources and their name. */
const KIND = {
  kb: { icon: "memory", noun: "Knowledge base" },
  skill: { icon: "bolt", noun: "Skill" },
  mcp: { icon: "cpu", noun: "MCP server" },
  agent: { icon: "agents", noun: "Agent template" },
} satisfies Record<BoardImportResource["kind"], { icon: IconName; noun: string }>;

/** What the rule into a stage is, said as the policy page says it. */
const BOUNDARY = {
  auto: { icon: "arrow", label: "the operator moves it on" },
  approval: { icon: "hand", label: "a person approves the move" },
  human: { icon: "lock", label: "a person makes the move" },
} satisfies Record<"auto" | "approval" | "human", { icon: IconName; label: string }>;

/** "4 Oct 2026" for an export stamp, in the reader's zone. */
function exportedOn(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function BoardFlow({ preview }: { preview: BoardImportPreview }) {
  return (
    <div className="field">
      <span className="flabel">
        Workflow <span className="fhint">{countLabel(preview.stages.length, "stage")}, as the file sets them</span>
      </span>
      <div className="flow-map">
        {preview.stages.map((stage, i) => {
          const rule = preview.workflow.find((w) => w.to === stage.id);
          const gate = BOUNDARY[rule?.boundary ?? "approval"];
          return (
            <Fragment key={stage.id}>
              {i > 0 && (
                <span className="flow-arr" role="img" aria-label={`then ${gate.label}`} title={`Into ${stage.name}: ${gate.label}`}>
                  <Icon name={gate.icon} />
                </span>
              )}
              <span className="stage-chip elig">
                <span className="sdot" data-stage-color={stage.color}></span>
                {stage.name}
              </span>
            </Fragment>
          );
        })}
      </div>
      <span className="fhint flush">
        {[
          countLabel(preview.guardrails, "guardrail"),
          preview.requiredReviewers.length > 0
            ? `required ${preview.requiredReviewers.length === 1 ? "reviewer" : "reviewers"}: ${preview.requiredReviewers.join(", ")}`
            : "no required reviewer",
          preview.gates.length > 0 ? `${countLabel(preview.gates.length, "gate")}: ${preview.gates.join(", ")}` : "no gates",
          preview.rulingsKb ? `rulings in ${preview.rulingsKb}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </div>
  );
}

function BoardAgents({ agents }: { agents: BoardImportAgent[] }) {
  return (
    <div className="field">
      <span className="flabel">
        Agents <span className="fhint">{countLabel(agents.length, "agent")} with their capabilities and settings</span>
      </span>
      <div className="rsrc-list">
        {agents.map((agent) => (
          <div className="rsrc-row" key={agent.profileId}>
            <AgentGlyph op={agent.operator} backend={agent.backend ?? undefined} decorative />
            <span className="rsrc-main">
              <b>{agent.name}</b>
              <span className="sub">
                {[agent.role, agent.model].filter(Boolean).join(" · ") || (agent.operator ? "Built in" : agent.profileId)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** What a resource row says happens to it here, where its pill does not
 *  already say it all: a new one under another name, and one held
 *  differently here. */
function resourceOutcome(resource: BoardImportResource, choice: BoardResourceChoice): string | null {
  if (resource.status === "same") return null;
  if (resource.status === "new") {
    if (resource.createAs === resource.key) return null;
    return resource.kind === "agent"
      ? `Added to the agent library as ${resource.createAs}, because ${resource.key} is taken here`
      : `Comes in as ${resource.createAs}, because ${resource.key} is taken here`;
  }
  if (resource.kind === "agent") {
    return "This instance's template differs: the library keeps it, and the board's agent keeps the file's settings";
  }
  return choice === "copy"
    ? `This instance has a different one: the file's comes in as ${resource.createAs}`
    : "This instance has a different one: the board uses this instance's";
}

/** "2 new · 7 already here · 2 different here". */
function resourceTally(resources: readonly BoardImportResource[]): string {
  const count = (status: BoardImportResource["status"]) => resources.filter((r) => r.status === status).length;
  return [
    count("new") > 0 ? `${count("new")} new` : null,
    count("same") > 0 ? `${count("same")} already here` : null,
    count("differs") > 0 ? `${count("differs")} different here` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function BoardResources({
  resources,
  choices,
  onChoice,
}: {
  resources: BoardImportResource[];
  choices: ReadonlyMap<string, BoardResourceChoice>;
  onChoice: (id: string, choice: BoardResourceChoice) => void;
}) {
  if (resources.length === 0) {
    return (
      <div className="field">
        <span className="flabel">What comes with it</span>
        <span className="fhint flush">No knowledge bases, skills, MCP servers or agent templates: the board alone.</span>
      </div>
    );
  }
  return (
    <div className="field">
      <span className="flabel">
        What comes with it <span className="fhint">{resourceTally(resources)}; nothing here is overwritten</span>
      </span>
      <div className="rsrc-list">
        {resources.map((resource) => {
          const id = `${resource.kind}:${resource.key}`;
          const choice = choices.get(id) ?? "copy";
          const kind = KIND[resource.kind];
          const outcome = resourceOutcome(resource, choice);
          return (
            <div className="rsrc-row board-res" key={id}>
              <span className="board-res-ico" title={kind.noun}>
                <Icon name={kind.icon} />
              </span>
              <span className="rsrc-main">
                <b>
                  {resource.label}
                  {resource.label !== resource.key && <code className="mono"> {resource.key}</code>}
                </b>
                <span className="sub">
                  {kind.noun} · {resource.detail}
                  {resource.usedBy.length > 0 && ` · used by ${resource.usedBy.join(", ")}`}
                </span>
                {outcome && <span className="sub">{outcome}</span>}
              </span>
              <span className="rsrc-acts">
                {resource.status === "differs" && resource.kind !== "agent" ? (
                  <RadioSeg
                    className="mini-seg"
                    label={`What to do with ${resource.label}`}
                    value={choice}
                    onChange={(next) => onChoice(id, next === "existing" ? "existing" : "copy")}
                  >
                    <RadioSegOption value="copy" className={choice === "copy" ? "on" : ""}>
                      Import a copy
                    </RadioSegOption>
                    <RadioSegOption value="existing" className={choice === "existing" ? "on" : ""}>
                      Use this instance's
                    </RadioSegOption>
                  </RadioSeg>
                ) : (
                  <Pill kind={resource.status === "same" ? "neutral" : resource.status === "new" ? "info" : "input"} sm>
                    {resource.status === "same" ? "Already here" : resource.status === "new" ? "New" : "Differs"}
                  </Pill>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BoardImportDialog({
  file,
  preview,
  boards,
  connections,
  connectionHealth,
  onChooseAnother,
  onClose,
}: {
  file: File;
  preview: BoardImportPreview;
  /** Every project: the names and keys already taken. */
  boards: BoardExportSummary[];
  /** Connection owners, as the New project dialog lists them. */
  connections: string[];
  connectionHealth: Record<string, "valid" | "unvalidated" | "failed">;
  /** Opens the file picker again, for a file with problems. */
  onChooseAnother: () => void;
  onClose: () => void;
}) {
  const fileKey = /^[A-Z]{2,4}$/.test(preview.taskPrefix) ? preview.taskPrefix : "";
  const [name, setName] = useState(preview.suggestedName);
  const [nameTouched, setNameTouched] = useState(true);
  // The file's key stands while the name changes; without one the key
  // follows the name, as in the New project dialog.
  const [key, setKey] = useState(fileKey);
  const [keyTouched, setKeyTouched] = useState(fileKey !== "");
  const [keyStripped, setKeyStripped] = useState(false);
  const [repo, setRepo] = useState(() => slugify(preview.suggestedName));
  const [repoTouched, setRepoTouched] = useState(false);
  const [createRepo, setCreateRepo] = useState(false);
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [connOwner, setConnOwner] = useState(() => connections[0] ?? "");
  const [choices, setChoices] = useState<ReadonlyMap<string, BoardResourceChoice>>(() => new Map());
  const [attempted, setAttempted] = useState(0);
  const refusalShake = useRefusalShake(attempted);
  const nameRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const repoRef = useRef<HTMLInputElement>(null);
  const fetcher = useFetcher<OrgActionData>();
  const csrf = useCsrfToken();
  const push = useToast();
  const navigate = useNavigate();
  const { ref: panelRef, close } = useDialog(onClose);
  const busy = fetcher.state !== "idle";
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useFetcherResult(fetcher, (d) => {
    if (!d.ok) {
      setServerError(d.error);
      return;
    }
    if (d.toast) push(d.toast);
    if (d.repoNote) push(d.repoNote);
    if (d.repoWarning) push(d.repoWarning, "error");
    // Instant on purpose (ruling 459), as New project: the page goes to the
    // new board, so there is nothing for an exit to leave toward.
    onClose();
    if (d.slug) navigate(`/projects/${d.slug}/board`);
  });

  const effKey = keyTouched ? key : keyFromName(name);
  const effRepo = repo || slugify(name);
  const slug = slugify(name);
  const slugTaken = slug !== "" && boards.some((b) => b.slug === slug);
  const keyInUse = effKey.length >= 2 && boards.some((b) => b.taskPrefix.toUpperCase() === effKey);
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
  const blocked: BlockedField | null =
    name.trim().length <= 1 || slugTaken
      ? "name"
      : effKey.length < 2
        ? "key"
        : connOwner.length === 0
          ? "conn"
          : effRepo.length === 0
            ? "repo"
            : null;
  const blockedReason =
    blocked === "name"
      ? slugTaken
        ? `A project at projects/${slug} already exists. Give the board another name.`
        : "Enter a project name (2+ characters)."
      : blocked === "key"
        ? "Task key needs at least 2 letters."
        : blocked === "conn"
          ? "Pick a GitHub connection."
          : blocked === "repo"
            ? "Enter a repository name."
            : null;
  const invalidField = attempted ? blocked : null;
  const hasProblems = preview.problems.length > 0;
  const differing = preview.resources.filter((r) => r.status === "differs" && r.kind !== "agent");

  const submit = () => {
    if (busy) return;
    if (blocked) {
      setAttempted((n) => n + 1);
      const target = blocked === "name" ? nameRef : blocked === "key" ? keyRef : blocked === "repo" ? repoRef : null;
      target?.current?.focus();
      return;
    }
    setServerError(null);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "board-import");
    fd.set("file", file);
    fd.set("name", name.trim());
    fd.set("key", effKey);
    fd.set("owner", connOwner);
    fd.set("repoName", effRepo);
    if (createRepo) fd.set("createRepository", repoPrivate ? "private" : "public");
    fd.set("choices", JSON.stringify(Object.fromEntries(differing.map((r) => [`${r.kind}:${r.key}`, choices.get(`${r.kind}:${r.key}`) ?? "copy"]))));
    fetcher.submit(fd, { method: "post", action: "/org/settings", encType: "multipart/form-data" });
  };

  const exported = exportedOn(preview.exportedAt);
  return (
    <dialog className="modal-card" aria-label={`Import ${preview.name}`} data-screen-label="Import board dialog" ref={panelRef}>
      <div className="modal-head">
        <span className="pj-mark draft">{(preview.name.trim()[0] || "•").toUpperCase()}</span>
        <span className="mh-main">
          <h2>Import {preview.name}</h2>
          <div className="mh-sub">
            {preview.fileName}
            {exported ? ` · exported ${exported}` : ""}
            {preview.exportedFrom ? ` from projects/${preview.exportedFrom}` : ""}
            {preview.viberrVersion ? ` · Viberr ${preview.viberrVersion}` : ""}
          </div>
        </span>
        <button type="button" className="icon-btn modal-close" onClick={close} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body">
        {hasProblems ? (
          <div className="form-err" role="alert">
            <Icon name="alert" />
            <div>
              <b>
                {preview.problems.length === 1
                  ? "One problem in this file stops the import. Fix it and choose the file again:"
                  : `${preview.problems.length} problems in this file stop the import. Fix them and choose the file again:`}
              </b>
              <ul className="board-problems">
                {preview.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <>
            {preview.description && <p className="board-desc">{preview.description}</p>}
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
              isAdmin
            />
            <NewProjectRepoField
              repoRef={repoRef}
              invalidField={invalidField}
              repo={repo}
              setRepo={editRepo}
              derived={!repoTouched}
              effOwner={connOwner}
              effRepo={effRepo}
              createRepo={createRepo}
              setCreateRepo={setCreateRepo}
              repoPrivate={repoPrivate}
              setRepoPrivate={setRepoPrivate}
            />
          </>
        )}
        <BoardFlow preview={preview} />
        <BoardAgents agents={preview.agents} />
        <BoardResources
          resources={preview.resources}
          choices={choices}
          onChoice={(id, choice) => setChoices((prev) => new Map(prev).set(id, choice))}
        />
        {preview.notes.map((note) => (
          <div className="def-note" key={note}>
            <Icon name="alert" />
            <span>{note}</span>
          </div>
        ))}
        {serverError && (
          <div className="form-err" role="alert">
            <Icon name="alert" />
            <span>{serverError}</span>
          </div>
        )}
      </div>
      <div className="modal-foot">
        <span className="foot-hint mono">{hasProblems ? "nothing is written" : `creates projects/${slug || "…"}/`}</span>
        <span className="foot-actions">
          {!hasProblems && blockedReason && (
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
          <button type="button" className="btn ghost" onClick={close}>
            Cancel
          </button>
          {hasProblems ? (
            <button type="button" className="btn primary" onClick={onChooseAnother}>
              <Icon name="upload" />
              Choose the fixed file
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={busy} aria-busy={busy} onClick={submit}>
              <GlyphSwap rest="board" alt="loader" on={busy} spinAlt />
              {busy ? "Importing board…" : "Import board"}
            </button>
          )}
        </span>
      </div>
    </dialog>
  );
}
