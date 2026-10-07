import { useMemo, useRef, useState } from "react";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { sseScopes } from "~/features/live-updates/event-types";
import { useSearchParams } from "react-router";
import type { OrgSettingsView } from "~/server/org/org-view.server";
import type { S3AuditConfigView } from "~/server/audit/s3-config.server";
import type { AuditBrowseRow } from "~/server/audit/audit-browse.server";
import { LocalDayDotTime } from "~/ui/local-time";
import { countLabel } from "~/shared/text/plural";
import { Icon, type IconName } from "~/ui/icon";
import { inFlightIntent } from "~/ui/in-flight";
import { ConnectionsPanel } from "./connections-panel";
import { MiniModal } from "./mini-modal";
import { useModalAction } from "./resource-helpers";
import { ResourcesPanel } from "./resources-panel";
import { BoardsPanel } from "./boards-panel";
import type { BoardExportSummary } from "~/server/org/board-export.server";
import { SsoPanel } from "./sso-panel";
import { useOrgAction } from "./use-org-action";
import { UsersPanel } from "./users-panel";
import {
  ControllerAdminPanel,
  type ControllerGrantRequestView,
  type ControllerConfigView,
} from "./controller-admin-panel";
import type { ControllerSectionLocks } from "~/shared/controller-locks";
import { useRefusalShake } from "~/ui/use-refusal-shake";

/**
 * /org/settings page shell (org-settings spec §4.0, markup 1:1): back
 * button + title, tab rail with live counts, active panel. The tab rides
 * the URL (?tab=connections|users|resources — the Home tiles already link
 * this shape); default "connections". Admin-only (route-enforced).
 */

export type OrgSettingsTab =
  | "connections"
  | "users"
  | "sso"
  | "resources"
  | "boards"
  | "controller";

const SETTINGS_TABS: { id: OrgSettingsTab; label: string; icon: IconName }[] = [
  { id: "connections", label: "GitHub connections", icon: "github" },
  { id: "users", label: "Users & access", icon: "user" },
  // R19-16: sits next to Users & access — the whitelist decides WHO may sign
  // in, this decides HOW they can.
  { id: "sso", label: "Sign-in & SSO", icon: "lock" },
  { id: "resources", label: "Agent resources", icon: "memory" },
  // Ruling 653: a board's workflow out as a file, and a file in as a new
  // board. Beside Agent resources: an import brings some in.
  { id: "boards", label: "Import & export", icon: "board" },
  // Ruling 99: only org admins modify the controller itself (profile,
  // resources, prompt) — this is that surface.
  { id: "controller", label: "Controller", icon: "cpu" },
];

function resolveOrgTab(raw: string | null): OrgSettingsTab {
  return raw === "users" ||
    raw === "resources" ||
    raw === "boards" ||
    raw === "sso" ||
    raw === "controller"
    ? raw
    : "connections";
}

/** The instance run-concurrency snapshot the admin control reads/edits. */
export interface RunConcurrencyView {
  /** Configured cap (0 = unlimited). */
  cap: number;
  /** Ruling 152(b): the extra slots operator and controller turns may take
   *  beyond the cap (one per four of it, minimum one; 0 when the cap is 0). */
  lane: number;
  /** Runs executing right now. */
  live: number;
  /** Runs waiting on a slot right now. */
  queued: number;
}

export function OrgSettingsPage({
  view,
  meId,
  callbackOrigin,
  runConcurrency,
  runSpendCapUsd,
  s3Audit,
  auditEvents,
  auditEventsOrgScoped,
  controllerConfig,
  controllerLocks,
  controllerRequests,
  boards,
}: {
  view: OrgSettingsView;
  meId: string;
  /** This deployment's origin — the callback URL an OAuth app must carry. */
  callbackOrigin: string;
  runConcurrency: RunConcurrencyView;
  /** Ruling 175: the instance's spending cap per Claude run, USD (null = none). */
  runSpendCapUsd: number | null;
  /** The S3 audit-export target (null when none is configured). */
  s3Audit: S3AuditConfigView | null;
  /** PG26-A: recent audit events for the in-app browse panel. */
  auditEvents: AuditBrowseRow[];
  auditEventsOrgScoped: AuditBrowseRow[];
  /** Ruling 99: the live controller configuration this admin surface edits. */
  controllerConfig: ControllerConfigView;
  /** Ruling 108: per-section deployment locks the panel renders read-only. */
  controllerLocks: ControllerSectionLocks;
  /** Ruling 390: open grant requests the controller raised for itself. */
  controllerRequests: ControllerGrantRequestView[];
  /** Ruling 653: every board, for the Import & export tab. */
  boards: BoardExportSummary[];
}) {
  // F32-2 (pass 32): a `user`-scoped stream also receives broadcasts — the
  // `resource.updated` fact a KB re-index (watcher or manual), a skill/MCP
  // save or delete publishes — so this page revalidates instead of showing a
  // stale "re-scanned just now" until a manual reload.
  useLiveUpdates([sseScopes.user()]);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = resolveOrgTab(searchParams.get("tab"));
  // The badge counts RESOURCES — knowledge bases, MCP servers, skills. It used
  // to fold agent templates in too, so the same concept was counted two ways one
  // click apart: the Home tile presents "N agent profiles" separately from the
  // KB/MCP/skill line. Profiles are disclosed in the tooltip instead of being
  // silently added to a number labelled "Agent resources".
  const resourceCount = view.kbs.length + view.mcps.length + view.skills.length;
  const counts = {
    connections: view.connections.length,
    users: view.users.length,
    // The count is LIVE methods, not configured rows: a provider saved but not
    // switched on grants nothing, and a badge that counted it would say the
    // opposite of the card underneath.
    sso: view.authProviders.filter((p) => p.active).length,
    resources: resourceCount,
    boards: boards.length,
    // One controller per instance, definitionally.
    controller: 1,
  } satisfies Record<OrgSettingsTab, number>;
  const countHint = {
    connections: countLabel(view.connections.length, "GitHub connection"),
    users: countLabel(view.users.length, "user"),
    sso: countLabel(
      view.authProviders.filter((p) => p.active).length,
      "live sign-in method",
    ),
    // The KB/MCP/skill triple was hardcoded plural, so a one-of-each instance
    // advertised "1 knowledge bases · 1 MCP · 1 skills" — the same disagreement
    // as the Users tab's "1 instance accounts", three times in one string.
    resources: [
      countLabel(view.kbs.length, "knowledge base"),
      countLabel(view.mcps.length, "MCP server"),
      countLabel(view.skills.length, "skill"),
    ].join(" · ") +
      `, plus ${countLabel(view.gagents.length, "agent profile")}`,
    boards: `${countLabel(boards.length, "board")} to export`,
    controller: "the instance controller",
  } satisfies Record<OrgSettingsTab, string>;

  return (
    <main className="home-shell" data-screen-label="Instance settings">
      {/* Ruling 145: the way back is the header's brand and its Home crumb, as
          it is on the board's own settings page. The button that used to sit
          here was this surface's only navigation, and a third control for the
          same trip once the header arrived. */}
      <div className="set-head">
        <div>
          {/* R15-13: was "Viberr settings", which collides with a PROJECT
              named Viberr — the surface that is not about that project was the
              one saying its name. Every other surface in the app names its own
              scope; these two were the exception in both directions. */}
          <h1>Instance settings</h1>
          <p className="sub">
            Instance level, shared by every project and board. Board-level workflow
            &amp; policy live inside each project.
          </p>
        </div>
      </div>
      <div className="set-layout">
        <nav className="set-nav" aria-label="Settings sections">
          {SETTINGS_TABS.map((t) => (
            <button
              type="button"
              key={t.id}
              className={"nav-item" + (tab === t.id ? " active" : "")}
              aria-current={tab === t.id ? "true" : undefined}
              onClick={() => setSearchParams({ tab: t.id })}
            >
              <Icon name={t.icon} className="ico" />
              {t.label}
              <span className="count" title={countHint[t.id]}>
                {counts[t.id]}
              </span>
            </button>
          ))}
        </nav>
        {/* Design pass 2026-09-08: Run concurrency, the audit card and the
            storage line used to be siblings OF `.set-layout`, so they never
            entered its content column. Two cards with identical treatment —
            same hairline, radius and shadow — sat at two different left edges
            and two different widths, stacked directly on each other, and the
            page read as an indented column on top and a different page
            underneath. Inside `.set-main` they share the column with
            everything above them, and one flex gap replaces the margins that
            were standing in for a column they were never part of. */}
        <div className="set-main">
        <div className="set-content">
          {tab === "connections" && <ConnectionsPanel connections={view.connections} />}
          {tab === "users" && (
            <UsersPanel
              users={view.users}
              domains={view.domains}
              meId={meId}
              providers={view.providers}
            />
          )}
          {tab === "sso" && (
            <SsoPanel
              providers={view.authProviders}
              callbackOrigin={callbackOrigin}
            />
          )}
          {tab === "resources" && (
            <ResourcesPanel
              kbs={view.kbs}
              mcps={view.mcps}
              skills={view.skills}
              gagents={view.gagents}
              projectGrants={view.projectGrants}
              templateGrants={view.templateGrants}
              stages={view.stages}
              projectStages={view.projectStages}
            />
          )}
          {tab === "boards" && (
            <BoardsPanel boards={boards} connections={view.connections} />
          )}
          {tab === "controller" && (
            <ControllerAdminPanel
              config={controllerConfig}
              locks={controllerLocks}
              requests={controllerRequests}
              // KB grants are stored and resolved by store DIR; the picker
              // shows the display name, like the global-profile editor.
              kbs={view.kbs.map((k) => ({ dir: k.dir, name: k.name, uri: k.uri }))}
              skills={view.skills.map((k) => k.name)}
              mcps={view.mcps.map((m) => m.name)}
            />
          )}
        </div>
        {/* The instance's two run limits outside the tabs, one well, one row
            each (ruling 175 added the second): how many runs at once, and what
            one Claude run may spend. */}
        <div className="conc-well">
          <RunConcurrencyControl runConcurrency={runConcurrency} />
          <RunSpendCapControl spendCapUsd={runSpendCapUsd} />
        </div>
      {/* Review F7 (pass 32): the card's open state is seeded from the target
          once; keying it on the stored target resets it when a save or clear
          lands from elsewhere, so an open target modal never outlives the target
          its fields were seeded from. (A save of its own closes on the server's
          result, which a secret-only rotation leaves this key blind to.) */}
      <AuditExportCard
        key={s3Audit ? `${s3Audit.bucket}|${s3Audit.region}|${s3Audit.prefix}|${s3Audit.endpoint}|${s3Audit.accessKeyId}` : "none"}
        s3Audit={s3Audit}
        events={auditEvents}
        orgScopedEvents={auditEventsOrgScoped}
      />
        <StorageLine storage={view.storage} />
        </div>
      </div>
    </main>
  );
}

/**
 * Audit-log export: download the log as CSV/JSON, and configure + fire an
 * export to an S3 bucket. Admin-only (the whole page is). The secret access key
 * is write-only here — stored sealed, never rendered — so the field shows a
 * "leave blank to keep" placeholder once one is on file.
 */
/**
 * PG26-A — the in-app audit browse. Recent events, newest first, with a text
 * filter and an "Org-scoped" toggle that isolates the class this feature exists
 * for: `project_slug`-less events (sign-ins, PAT changes, user admin) that the
 * project Activity page can't show.
 *
 * Ruling 234: the toggle SWAPS between two server-fetched windows rather than
 * filtering one. It used to narrow whatever the unscoped query returned, so a
 * poller heartbeat that filled that window pushed every sign-in out of reach —
 * measured at 2 org-scoped rows visible against 96 on file. Two lists keep the
 * toggle instant (no round trip) and keep the text filter working over whichever
 * one is showing. The export is still the path to the full record.
 */
function AuditBrowse({
  events,
  orgScopedEvents,
}: {
  events: AuditBrowseRow[];
  orgScopedEvents: AuditBrowseRow[];
}) {
  const [q, setQ] = useState("");
  const [orgOnly, setOrgOnly] = useState(false);
  const shown = orgOnly ? orgScopedEvents : events;
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return shown;
    return shown.filter((e) =>
      [e.action, e.actorLabel, e.subjectId ?? "", e.projectSlug ?? ""].some((v) =>
        v.toLowerCase().includes(needle),
      ),
    );
  }, [shown, q]);
  return (
    <div className="audit-browse">
      <div className="audit-browse-bar">
        <label className="board-filter-input">
          <Icon name="filter" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder="Filter recent events…"
            aria-label="Filter audit events"
          />
        </label>
        <button
          type="button"
          className={"fchip" + (orgOnly ? " on" : "")}
          aria-pressed={orgOnly}
          onClick={() => setOrgOnly((v) => !v)}
          title="Show only org / instance-scoped events (sign-ins, PAT changes, user administration). These are the events the project Activity page cannot show."
        >
          Org-scoped
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="fine">
          {shown.length === 0
            ? orgOnly
              ? "No instance-scoped events recorded yet."
              : "No audit events recorded yet."
            : "No events match this filter."}
        </p>
      ) : (
        <ul
          className="audit-list"
          // The list caps at 15rem and scrolls (app.css .audit-list). A
          // scrollable region must be reachable by keyboard or its overflowed
          // rows are mouse-only (WCAG 2.1.1 / axe scrollable-region-focusable
          // — surfaced by the e2e org-settings audit the first time the seed
          // log grew past the cap).
          tabIndex={0}
          aria-label="Recent audit events"
        >
          {filtered.map((e) => (
            <li key={e.id} className="audit-row">
              <span className="audit-when">
                <LocalDayDotTime iso={e.occurredAt} />
              </span>
              {/* Truncated cells carry their full value in `title` — a clipped
                  email/id was unrecoverable by hover before. */}
              <span className="audit-actor" title={e.actorLabel}>{e.actorLabel}</span>
              <span className="audit-action" title={e.action}>{e.action}</span>
              <span className="audit-scope">
                <span className="audit-scope-tag" title={e.projectSlug ?? "org"}>
                  {e.projectSlug ?? "org"}
                </span>
                {e.subjectId ? (
                  <span className="audit-subject" title={e.subjectId}>
                    {e.subjectId}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="fine audit-browse-foot">
        Showing {filtered.length} of {shown.length} most-recent
        {orgOnly ? " instance-scoped " : " "}events. Download or push to S3 for the
        full log.
      </p>
    </div>
  );
}

/** The S3 target fields a save requires — the ones a refusal can name. */
type S3Field = "bucket" | "region" | "accessKeyId" | "secret";

/** Ruling 147: what is still missing, named field by field. */
const S3_UNMET = {
  bucket: "Enter the bucket name.",
  region: "Enter the bucket's region.",
  accessKeyId: "Enter the access key ID.",
  secret: "Enter the secret access key.",
} satisfies Record<S3Field, string>;

/** Ruling 147: the first field a save still lacks, in the form's order (the
 *  secret only until one is on file), or null once the target is complete.
 *  Ruling 689(e): read off the modal's fields as a pure function, so the
 *  modal itself holds no chain of conditions. */
function missingS3Field(
  fields: Record<S3Field, string>,
  configured: boolean,
): S3Field | null {
  if (!fields.bucket.trim()) return "bucket";
  if (!fields.region.trim()) return "region";
  if (!fields.accessKeyId.trim()) return "accessKeyId";
  if (!configured && !fields.secret.trim()) return "secret";
  return null;
}

/**
 * Ruling 148(b): the S3 target is a button that opens a modal, never a form
 * served inline. Six fields (one of them a secret) for a target set once per
 * instance and rotated rarely sat open at the foot of EVERY Instance-settings
 * tab until someone configured one — an unconfigured instance had no control
 * that could fold it.
 *
 * The refusal contract is MiniModal's (ruling 147) and is not re-implemented
 * here: it counts the refusals, keys its own foot alert and disables the
 * primary only while busy. This caller supplies the named sentence
 * (`unmetHint`), where focus lands (`focusUnmet`) and the per-field
 * `aria-invalid` mark, the way profile's ChangePasswordModal does.
 */
function S3TargetModal({
  s3Audit,
  onClose,
}: {
  s3Audit: S3AuditConfigView | null;
  onClose: () => void;
}) {
  const configured = s3Audit !== null;
  const [bucket, setBucket] = useState(s3Audit?.bucket ?? "");
  const [region, setRegion] = useState(s3Audit?.region ?? "");
  const [prefix, setPrefix] = useState(s3Audit?.prefix ?? "");
  const [endpoint, setEndpoint] = useState(s3Audit?.endpoint ?? "");
  const [accessKeyId, setAccessKeyId] = useState(s3Audit?.accessKeyId ?? "");
  const [secret, setSecret] = useState("");
  /** The field a refused save named; null on a pristine form (147(c)). */
  const [flagged, setFlagged] = useState<S3Field | null>(null);
  // Ruling 459: a save plays the modal's exit, then onClose unmounts it.
  // Closing on the result is what folds the form: a secret-only rotation
  // changes no summary field, so the card's remount key cannot see it.
  const [done, setDone] = useState(false);
  const { action: { submit, busy }, err, setErr } = useModalAction(() => setDone(true));
  const missing = missingS3Field({ bucket, region, accessKeyId, secret }, configured);
  const refs = {
    bucket: useRef<HTMLInputElement>(null),
    region: useRef<HTMLInputElement>(null),
    accessKeyId: useRef<HTMLInputElement>(null),
    secret: useRef<HTMLInputElement>(null),
  };
  // No `aria-describedby`: MiniModal's foot alert carries no id, and the
  // sentence it prints is the disclosure (one alert per refusal, not two).
  const mark = (field: S3Field) => ({
    "aria-invalid": flagged === field || undefined,
  });
  const edit = (field: S3Field, set: (v: string) => void) => (value: string) => {
    set(value);
    setErr(null);
    setFlagged((f) => (f === field ? null : f));
  };
  return (
    <MiniModal
      icon={<Icon name="file" />}
      title={configured ? "Edit S3 export target" : "Set up S3 export target"}
      sub="Where an audit export is pushed. The secret key is stored sealed and never shown"
      onClose={onClose}
      canSave={!missing}
      busy={busy}
      done={done}
      saveLabel="Save target"
      unmetHint={missing ? S3_UNMET[missing] : undefined}
      focusUnmet={() => {
        if (!missing) return;
        setFlagged(missing);
        refs[missing].current?.focus();
      }}
      onSave={() => {
        setFlagged(null);
        setErr(null);
        submit({
          intent: "s3-config-save",
          bucket,
          region,
          prefix,
          endpoint,
          accessKeyId,
          secretAccessKey: secret,
        });
      }}
      screen="S3 export target dialog"
    >
      <div className="audit-s3-grid">
        <label className="field">
          <span className="flabel">Bucket</span>
          <input
            ref={refs.bucket}
            type="text"
            value={bucket}
            data-autofocus
            {...mark("bucket")}
            onChange={(e) => edit("bucket", setBucket)(e.currentTarget.value)}
            placeholder="my-audit-bucket"
          />
        </label>
        <label className="field">
          <span className="flabel">Region</span>
          <input
            ref={refs.region}
            type="text"
            value={region}
            {...mark("region")}
            onChange={(e) => edit("region", setRegion)(e.currentTarget.value)}
            placeholder="eu-central-1"
          />
        </label>
        <label className="field">
          <span className="flabel">Key prefix</span>
          <input
            type="text"
            value={prefix}
            onChange={(e) => {
              setPrefix(e.currentTarget.value);
              setErr(null);
            }}
            placeholder="audit/ (optional)"
          />
        </label>
        <label className="field">
          <span className="flabel">Endpoint</span>
          <input
            type="text"
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.currentTarget.value);
              setErr(null);
            }}
            placeholder="optional, for S3-compatible stores"
          />
        </label>
        <label className="field">
          <span className="flabel">Access key ID</span>
          <input
            ref={refs.accessKeyId}
            type="text"
            value={accessKeyId}
            {...mark("accessKeyId")}
            onChange={(e) =>
              edit("accessKeyId", setAccessKeyId)(e.currentTarget.value)
            }
            placeholder="AKIA…"
          />
        </label>
        <label className="field">
          <span className="flabel">Secret access key</span>
          <input
            ref={refs.secret}
            type="password"
            value={secret}
            {...mark("secret")}
            onChange={(e) => edit("secret", setSecret)(e.currentTarget.value)}
            placeholder={configured ? "leave blank to keep" : "required"}
            aria-label="S3 secret access key"
          />
        </label>
      </div>
      {err && (
        <div className="form-err" role="alert">
          <Icon name="alert" />
          <span>{err}</span>
        </div>
      )}
    </MiniModal>
  );
}

function AuditExportCard({
  s3Audit,
  events,
  orgScopedEvents,
}: {
  s3Audit: S3AuditConfigView | null;
  events: AuditBrowseRow[];
  orgScopedEvents: AuditBrowseRow[];
}) {
  const { submit, busy, fetcher } = useOrgAction();
  // Ruling 368: the export and the removal share this fetcher; the one that
  // started the request shows it, the other only waits.
  const inFlight = inFlightIntent(fetcher);
  const exporting = inFlight === "audit-export-s3";
  const removing = inFlight === "s3-config-clear";
  const configured = s3Audit !== null;
  // D04-U7 (pass 32) + ruling 148(b): the target is ONE fact row in both states
  // — the summary with "Edit target", or "No S3 target" with "Set up S3 target"
  // — and the fields it opens live in the modal. The page then shows one solid
  // primary (the active tab's own), and the card's own actions stay put.
  const [open, setOpen] = useState(false);
  return (
    <section className="panel" data-screen-label="Audit log">
      <div className="panel-head">
        <Icon name="file" />
        <h2>Audit log</h2>
      </div>
      <p className="fine">
        {/* F26-9: state the two real bounds instead of claiming "the full log" —
            events past the 90-day retention sweep are gone from this download
            (AUDIT_RETENTION_DAYS), and one export carries at most 100,000 rows
            (AUDIT_EXPORT_MAX_ROWS).

            Owner decision 2026-08-31: those events are no longer GONE, so the
            sentence that used to send an admin to a backup schedule for any
            longer record would now be false. The retention pass writes every
            expiring row to the data root before deleting it
            (db/retention.server.ts), and this says where it lands. */}
        Download the audit log, or push it to an S3 bucket. An export carries every
        recorded field (actor, action, subject, details) for the events still on
        file: the most recent 100,000 rows, within the 90-day retention window.
        Entries that pass 90 days are written to audit-exports/ in the instance
        data root, one JSON object per line, before the retention sweep deletes
        them. For a copy off the box, export on a schedule.
      </p>
      {/* PG26-A: browse the recent log in-app. Org/instance-scoped events
          (sign-ins, PAT changes, user admin) have no other in-app view — the
          project Activity page is project-scoped. */}
      <AuditBrowse events={events} orgScopedEvents={orgScopedEvents} />
      <div className="audit-dl">
        {/* A real file response (Content-Disposition) — the browser saves it. */}
        <a className="btn sm" href="/org/settings/audit-export?format=csv">
          <Icon name="file" />
          Download CSV
        </a>
        <a className="btn sm" href="/org/settings/audit-export?format=json">
          <Icon name="file" />
          Download JSON
        </a>
      </div>
      <div className="audit-s3">
        {/* Ruling 625: one fact row needs no eyebrow over it; the label
            names the whole fact. */}
        <div className="kv-row">
          <span className="k">S3 export</span>
          {configured ? (
            <>
              <span className="v mono">
                s3://{s3Audit.bucket}/{s3Audit.prefix}
                {s3Audit.region ? ` · ${s3Audit.region}` : ""}
                {s3Audit.endpoint ? ` · ${s3Audit.endpoint}` : ""} · key{" "}
                {s3Audit.accessKeyId}
              </span>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setOpen(true)}
              >
                <Icon name="sliders" />
                Edit target
              </button>
            </>
          ) : (
            <>
              <span className="v light">No S3 target</span>
              <button
                type="button"
                className="btn sm"
                onClick={() => setOpen(true)}
              >
                <Icon name="sliders" />
                Set up S3 target
              </button>
            </>
          )}
        </div>
        <div className="audit-s3-actions">
          <button
            type="button"
            className="btn sm"
            disabled={busy || !configured}
            aria-busy={exporting || undefined}
            onClick={() =>
              submit({ intent: "audit-export-s3", format: "json" })
            }
            title={
              configured ? "Upload the audit log to S3 now" : "Save a target first"
            }
          >
            {exporting && <Icon name="loader" className="spin" />}
            {exporting ? "Exporting…" : "Export to S3 now"}
          </button>
          {configured && (
            <button
              type="button"
              className="btn sm danger"
              disabled={busy}
              aria-busy={removing || undefined}
              onClick={() => submit({ intent: "s3-config-clear" })}
            >
              {removing && <Icon name="loader" className="spin" />}
              {removing ? "Removing…" : "Remove"}
            </button>
          )}
        </div>
        {open && (
          <S3TargetModal s3Audit={s3Audit} onClose={() => setOpen(false)} />
        )}
      </div>
    </section>
  );
}

/**
 * Instance run-concurrency cap — the max agent runs executing at once. 0 means
 * unlimited (the default). A positive N caps live provider processes at N and
 * queues the rest (run-service gate); this control shows the live/queued counts
 * so an admin can see the cap biting. Admin-only, like the whole page.
 *
 * Ruling 152(b): a cap also carries a coordination lane (`lane` extra slots for
 * operator and controller turns), and the sentence under the field says so,
 * because "capped at 4" alone would make five live runs look like a broken cap.
 * It prints the `lane` the server derived, never the rule it came from: the
 * lane is `max(1, ceil(cap / 4))`, so "one extra slot per four" named the wrong
 * number at every cap that is not a multiple of four (zero at a cap of 2, one
 * at a cap of 5 where the instance grants two).
 *
 * Design pass 2026-09-08: this was a `.pol-note` — twelve-pixel fine print
 * with the number field pushed to the far end of the line by
 * `margin-left: auto`, unframed between two panels. It is the one
 * instance-wide knob outside the tabs, so it takes the shape Policy already
 * gives a numeric guardrail (a `.guard-row`: name and reading on the left,
 * the field and its Save on the right) on a tinted well, which gives the row
 * edges without promoting it to a titled section. The field is
 * `.guard-ctl input[type="number"]` itself now, not a twin rule.
 */
function RunConcurrencyControl({
  runConcurrency,
}: {
  runConcurrency: RunConcurrencyView;
}) {
  const { submit, busy } = useOrgAction();
  const [value, setValue] = useState(String(runConcurrency.cap));
  const [refused, setRefused] = useState(0);
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(refused);
  const capRef = useRef<HTMLInputElement>(null);
  // Re-seed the field when the server value changes (a save round-trips a fresh
  // loader value through this prop), and drop any standing refusal with it.
  // During render, so the field never paints the old value against the new cap.
  const [seededCap, setSeededCap] = useState(runConcurrency.cap);
  if (seededCap !== runConcurrency.cap) {
    setSeededCap(runConcurrency.cap);
    setValue(String(runConcurrency.cap));
    setRefused(0);
  }
  // Ruling 147(d): nothing-changed is the ONLY gate that keeps Save disabled.
  // Validity used to be folded into `dirty`, so a typed "-1", "1.5" or an
  // emptied box was a changed value that left Save dead with no explanation.
  // An empty field is invalid, not zero: `Number("")` is 0, so clearing the box
  // used to submit "" and silently set the cap to unlimited.
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  const valid = trimmed !== "" && Number.isInteger(parsed) && parsed >= 0;
  const changed = trimmed !== String(runConcurrency.cap);
  const invalid = refused > 0 && !valid;
  const errId = "max-concurrent-runs-err";
  const save = () => {
    if (busy || !changed) return;
    if (!valid) {
      setRefused((n) => n + 1);
      capRef.current?.focus();
      return;
    }
    submit({ intent: "set-concurrency", maxConcurrentRuns: trimmed });
  };
  return (
    <div className="guard-row" role="group" aria-labelledby="run-concurrency-name">
        <div className="guard-main">
          <span className="guard-name" id="run-concurrency-name">
            <Icon name="cpu" />
            Run concurrency
          </span>
          <span className="guard-desc">
            {runConcurrency.cap === 0
              ? "Unlimited"
              : `Capped at ${runConcurrency.cap}`}
            {" · "}
            {countLabel(runConcurrency.live, "run")} live
            {runConcurrency.queued > 0 && `, ${runConcurrency.queued} queued`}
          </span>
        </div>
        <span className="guard-ctl">
          <label className="flabel" htmlFor="max-concurrent-runs">Max at once</label>
          <input
            ref={capRef}
            id="max-concurrent-runs"
            type="number"
            min={0}
            step={1}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errId : undefined}
            aria-label="Maximum concurrent agent runs (0 means unlimited)"
          />
          <button
            type="button"
            className="btn sm"
            disabled={busy || !changed}
            aria-busy={busy}
            onClick={save}
          >
            Save
          </button>
          <span className="fhint flush">0 = unlimited</span>
        </span>
        {runConcurrency.cap > 0 && (
          <span className="conc-lane">
            Cap {runConcurrency.cap}: up to{" "}
            {countLabel(runConcurrency.cap, "agent run")} at once, plus{" "}
            {countLabel(runConcurrency.lane, "slot")} for operator and controller
            turns so a decision is not stuck behind the builds it is about.
          </span>
        )}
        {invalid && (
          <span
            className={"form-err" + (refusalShake.shake ? " refused" : "")}
            onAnimationEnd={refusalShake.onAnimationEnd}
            role="alert"
            id={errId}
            key={`refused-${refused}`}
          >
            <Icon name="alert" />
            <span>Enter a whole number (0 = unlimited).</span>
          </span>
        )}
    </div>
  );
}

/** A spending-cap entry the action accepts: blank (no cap), or dollars above
 *  zero with at most two decimals. */
function spendCapEntryValid(entry: string): boolean {
  return entry === "" || (/^\d+(?:\.\d{1,2})?$/.test(entry) && Number(entry) > 0);
}

/**
 * Ruling 175: the instance's spending cap per Claude run (owner decision D4: an
 * instance ceiling only, no profile field, none by default). The SDK stops a
 * Claude run once it has spent this much, and the run is reported as cut off
 * by its spending cap. Codex has no budget option, and the sentence under the
 * field says so rather than implying a limit that does not exist there. Blank
 * means no cap. Same row shape and refusal rules as the concurrency cap above
 * (ruling 147(d): only "nothing changed" disables Save).
 */
function RunSpendCapControl({ spendCapUsd }: { spendCapUsd: number | null }) {
  const { submit, busy } = useOrgAction();
  const current = spendCapUsd === null ? "" : spendCapUsd.toFixed(2);
  const [value, setValue] = useState(current);
  const [refused, setRefused] = useState(0);
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(refused);
  const capRef = useRef<HTMLInputElement>(null);
  const [seeded, setSeeded] = useState(current);
  if (seeded !== current) {
    setSeeded(current);
    setValue(current);
    setRefused(0);
  }
  const trimmed = value.trim();
  const valid = spendCapEntryValid(trimmed);
  const changed = trimmed !== current;
  const invalid = refused > 0 && !valid;
  const errId = "max-run-spend-usd-err";
  const save = () => {
    if (busy || !changed) return;
    if (!valid) {
      setRefused((n) => n + 1);
      capRef.current?.focus();
      return;
    }
    submit({ intent: "set-run-spend-cap", maxRunSpendUsd: trimmed });
  };
  return (
    <div className="guard-row" role="group" aria-labelledby="run-spend-cap-name">
      <div className="guard-main">
        <span className="guard-name" id="run-spend-cap-name">
          <Icon name="shield" />
          Spending cap
        </span>
        <span className="guard-desc">
          {spendCapUsd === null ? "No cap" : `$${spendCapUsd.toFixed(2)} per Claude run`}
        </span>
      </div>
      <span className="guard-ctl">
        <label className="flabel" htmlFor="max-run-spend-usd">Max spend per Claude run, USD</label>
        <input
          ref={capRef}
          id="max-run-spend-usd"
          type="number"
          min={0.01}
          step={0.01}
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errId : undefined}
        />
        <button
          type="button"
          className="btn sm"
          disabled={busy || !changed}
          aria-busy={busy}
          aria-label="Save spending cap"
          onClick={save}
        >
          Save
        </button>
        <span className="fhint flush">blank = no cap</span>
      </span>
      <span className="conc-lane">
        Claude stops a run once it has spent this much and reports it as cut off by its spending
        cap. Codex has no budget option, so a Codex run is bounded by its idle timer only.
      </span>
      {invalid && (
        <span
          className={"form-err" + (refusalShake.shake ? " refused" : "")}
          onAnimationEnd={refusalShake.onAnimationEnd}
          role="alert"
          id={errId}
          key={`refused-${refused}`}
        >
          <Icon name="alert" />
          <span>
            Enter a dollar amount above zero with at most two decimals, or leave it blank for no cap.
          </span>
        </span>
      )}
    </div>
  );
}

/** Bytes → a short human string (GB/MB), for the storage line only. */
function fmtBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

/**
 * C9 (pass 23): instance storage health, in the UI at last. The periodic
 * maintenance scheduler reclaims finished-task clones and reports to
 * `/resources/health`, but that ops probe is JSON only, so an admin had no in-app
 * view of free space or whether the cleanup is alive. A low/critical disk status
 * is called out; a healthy one stays quiet.
 */
function StorageLine({
  storage,
}: {
  storage: OrgSettingsView["storage"];
}) {
  const { disk, maintenance } = storage;
  // D32-1 (pass 32): this fragment follows a full stop ("… · low. Automatic
  // cleanup …"), so it opens a sentence and is capitalised like one.
  const cleanup = maintenance.scheduled
    ? maintenance.lastPassAt
      ? `Automatic cleanup runs every ${Math.round(maintenance.intervalMs / 3_600_000)}h; last freed ${fmtBytes(maintenance.lastFreedBytes)}`
      : `Automatic cleanup runs every ${Math.round(maintenance.intervalMs / 3_600_000)}h`
    : "Automatic cleanup is not scheduled";
  return (
    <div className="pol-note after last">
      <Icon name="memory" />
      <span>
        {disk ? (
          <>
            <strong>{fmtBytes(disk.freeBytes)}</strong> free of{" "}
            {fmtBytes(disk.totalBytes)} on the{" "}
            {disk.source === "host" ? "host disk" : "data volume"} (
            {disk.usedPercent}% used)
            {disk.status !== "ok" && (
              <strong>
                {" "}
                {disk.status === "critical" ? "· critically low" : "· low"}
              </strong>
            )}
            . {cleanup}.
          </>
        ) : (
          <>Data-volume free space is unavailable. {cleanup}.</>
        )}
      </span>
    </div>
  );
}
