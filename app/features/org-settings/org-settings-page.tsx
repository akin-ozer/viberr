import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { sseScopes } from "~/features/live-updates/event-types";
import { useSearchParams } from "react-router";
import type { OrgSettingsView } from "~/server/org/org-view.server";
import type { S3AuditConfigView } from "~/server/audit/s3-config.server";
import type { AuditBrowseRow } from "~/server/audit/audit-browse.server";
import { LocalDayDotTime } from "~/ui/local-time";
import { countLabel } from "~/shared/text/plural";
import { Icon, type IconName } from "~/ui/icon";
import { ConnectionsPanel } from "./connections-panel";
import { ResourcesPanel } from "./resources-panel";
import { SsoPanel } from "./sso-panel";
import { useOrgAction } from "./use-org-action";
import { UsersPanel } from "./users-panel";
import {
  ControllerAdminPanel,
  type ControllerConfigView,
  type ControllerSectionLocks,
} from "./controller-admin-panel";

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
  | "controller";

const SETTINGS_TABS: { id: OrgSettingsTab; label: string; icon: IconName }[] = [
  { id: "connections", label: "GitHub connections", icon: "github" },
  { id: "users", label: "Users & access", icon: "user" },
  // R19-16: sits next to Users & access — the whitelist decides WHO may sign
  // in, this decides HOW they can.
  { id: "sso", label: "Sign-in & SSO", icon: "lock" },
  { id: "resources", label: "Agent resources", icon: "memory" },
  // Ruling 99: only org admins modify the controller itself (profile,
  // resources, prompt) — this is that surface.
  { id: "controller", label: "Controller", icon: "cpu" },
];

function resolveOrgTab(raw: string | null): OrgSettingsTab {
  return raw === "users" ||
    raw === "resources" ||
    raw === "sso" ||
    raw === "controller"
    ? raw
    : "connections";
}

/** The instance run-concurrency snapshot the admin control reads/edits. */
export interface RunConcurrencyView {
  /** Configured cap (0 = unlimited). */
  cap: number;
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
  s3Audit,
  auditEvents,
  controllerConfig,
  controllerLocks,
}: {
  view: OrgSettingsView;
  meId: string;
  /** This deployment's origin — the callback URL an OAuth app must carry. */
  callbackOrigin: string;
  runConcurrency: RunConcurrencyView;
  /** The S3 audit-export target (null when none is configured). */
  s3Audit: S3AuditConfigView | null;
  /** PG26-A: recent audit events for the in-app browse panel. */
  auditEvents: AuditBrowseRow[];
  /** Ruling 99: the live controller configuration this admin surface edits. */
  controllerConfig: ControllerConfigView;
  /** Ruling 108: per-section deployment locks the panel renders read-only. */
  controllerLocks: ControllerSectionLocks;
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
            />
          )}
          {tab === "controller" && (
            <ControllerAdminPanel
              config={controllerConfig}
              locks={controllerLocks}
              // KB grants are stored and resolved by store DIR; the picker
              // shows the display name, like the global-profile editor.
              kbs={view.kbs.map((k) => ({ dir: k.dir, name: k.name, uri: k.uri }))}
              skills={view.skills.map((k) => k.name)}
              mcps={view.mcps.map((m) => m.name)}
            />
          )}
        </div>
      </div>
      <RunConcurrencyControl runConcurrency={runConcurrency} />
      {/* Review F7 (pass 32): the card's `editing` and field state are seeded
          from the target once; keying it on the stored target resets both when a
          save or clear lands, so the form folds after a save and never shows a
          cleared target's values. */}
      <AuditExportCard
        key={s3Audit ? `${s3Audit.bucket}|${s3Audit.region}|${s3Audit.prefix}|${s3Audit.endpoint}|${s3Audit.accessKeyId}` : "none"}
        s3Audit={s3Audit}
        events={auditEvents}
      />
      <StorageLine storage={view.storage} />
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
 * project Activity page can't show. Filtering is client-side over the ~150 rows
 * the loader already fetched — the export is the path to the full record.
 */
function AuditBrowse({ events }: { events: AuditBrowseRow[] }) {
  const [q, setQ] = useState("");
  const [orgOnly, setOrgOnly] = useState(false);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return events.filter((e) => {
      if (orgOnly && e.projectSlug) return false;
      if (!needle) return true;
      return [e.action, e.actorLabel, e.subjectId ?? "", e.projectSlug ?? ""].some(
        (v) => v.toLowerCase().includes(needle),
      );
    });
  }, [events, q, orgOnly]);
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
          {events.length === 0
            ? "No audit events recorded yet."
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
                <span className={e.projectSlug ? "audit-scope-tag" : "audit-scope-tag org"}>
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
        Showing {filtered.length} of {events.length} most-recent events. Download or
        push to S3 for the full log.
      </p>
    </div>
  );
}

function AuditExportCard({
  s3Audit,
  events,
}: {
  s3Audit: S3AuditConfigView | null;
  events: AuditBrowseRow[];
}) {
  const { submit, busy } = useOrgAction();
  const [bucket, setBucket] = useState(s3Audit?.bucket ?? "");
  const [region, setRegion] = useState(s3Audit?.region ?? "");
  const [prefix, setPrefix] = useState(s3Audit?.prefix ?? "");
  const [endpoint, setEndpoint] = useState(s3Audit?.endpoint ?? "");
  const [accessKeyId, setAccessKeyId] = useState(s3Audit?.accessKeyId ?? "");
  const [secret, setSecret] = useState("");
  const configured = s3Audit !== null;
  // D04-U7 (pass 32): with a target on file the five-field form stays folded
  // behind a summary line — the page then shows ONE solid primary (the active
  // tab's own), not this card's "Save target" beside it. An unconfigured
  // instance still opens on the form, since there is nothing to summarise.
  const [editing, setEditing] = useState(false);
  const formOpen = !configured || editing;
  // Ruling 147: the save stays enabled; a refused save names the first field
  // still missing, marks it and moves focus there (counted, so each refusal
  // re-inserts the alert).
  const missing: "bucket" | "region" | "accessKeyId" | "secret" | null = !bucket.trim()
    ? "bucket"
    : !region.trim()
      ? "region"
      : !accessKeyId.trim()
        ? "accessKeyId"
        : !configured && !secret.trim()
          ? "secret"
          : null;
  const [refused, setRefused] = useState(0);
  const flagged = refused > 0 ? missing : null;
  const fieldRefs = {
    bucket: useRef<HTMLInputElement>(null),
    region: useRef<HTMLInputElement>(null),
    accessKeyId: useRef<HTMLInputElement>(null),
    secret: useRef<HTMLInputElement>(null),
  };
  const saveTarget = () => {
    if (busy) return;
    if (missing) {
      setRefused((n) => n + 1);
      fieldRefs[missing].current?.focus();
      return;
    }
    submit({
      intent: "s3-config-save",
      bucket,
      region,
      prefix,
      endpoint,
      accessKeyId,
      secretAccessKey: secret,
    });
  };
  const unmet = (field: typeof missing) => ({
    "aria-invalid": flagged === field || undefined,
    "aria-describedby": flagged === field ? "s3-unmet" : undefined,
  });
  return (
    <section className="panel audit-export">
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
      <AuditBrowse events={events} />
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
        <h3>S3 export target</h3>
        {configured && !editing && (
          <div className="kv-row">
            <span className="k">Target</span>
            <span className="v mono">
              s3://{s3Audit.bucket}/{s3Audit.prefix}
              {s3Audit.region ? ` · ${s3Audit.region}` : ""}
              {s3Audit.endpoint ? ` · ${s3Audit.endpoint}` : ""} · key {s3Audit.accessKeyId}
            </span>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setEditing(true)}
            >
              <Icon name="sliders" />
              Edit target
            </button>
          </div>
        )}
        {formOpen && (
        <div className="audit-s3-grid">
          <label className="field">
            <span className="flabel">Bucket</span>
            <input
              ref={fieldRefs.bucket}
              type="text"
              value={bucket}
              {...unmet("bucket")}
              onChange={(e) => setBucket(e.currentTarget.value)}
              placeholder="my-audit-bucket"
            />
          </label>
          <label className="field">
            <span className="flabel">Region</span>
            <input
              ref={fieldRefs.region}
              type="text"
              value={region}
              {...unmet("region")}
              onChange={(e) => setRegion(e.currentTarget.value)}
              placeholder="eu-central-1"
            />
          </label>
          <label className="field">
            <span className="flabel">Key prefix</span>
            <input
              type="text"
              value={prefix}
              onChange={(e) => setPrefix(e.currentTarget.value)}
              placeholder="audit/ (optional)"
            />
          </label>
          <label className="field">
            <span className="flabel">Endpoint</span>
            <input
              type="text"
              value={endpoint}
              onChange={(e) => setEndpoint(e.currentTarget.value)}
              placeholder="optional, for S3-compatible stores"
            />
          </label>
          <label className="field">
            <span className="flabel">Access key ID</span>
            <input
              ref={fieldRefs.accessKeyId}
              type="text"
              value={accessKeyId}
              {...unmet("accessKeyId")}
              onChange={(e) => setAccessKeyId(e.currentTarget.value)}
              placeholder="AKIA…"
            />
          </label>
          <label className="field">
            <span className="flabel">Secret access key</span>
            <input
              ref={fieldRefs.secret}
              type="password"
              value={secret}
              {...unmet("secret")}
              onChange={(e) => setSecret(e.currentTarget.value)}
              placeholder={configured ? "leave blank to keep" : "required"}
              aria-label="S3 secret access key"
            />
          </label>
        </div>
        )}
        {formOpen && flagged && (
          <div className="form-err" role="alert" id="s3-unmet" key={"refused-" + refused}>
            <Icon name="alert" />
            <span>
              {flagged === "bucket"
                ? "Enter the bucket name."
                : flagged === "region"
                  ? "Enter the bucket's region."
                  : flagged === "accessKeyId"
                    ? "Enter the access key ID."
                    : "Enter the secret access key."}
            </span>
          </div>
        )}
        <div className="audit-s3-actions">
          {formOpen && (
          <button
            type="button"
            // D04-U7: secondary — the tab's own action keeps the one primary.
            className="btn sm"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={saveTarget}
          >
            Save target
          </button>
          )}
          {configured && editing && (
            <button type="button" className="btn ghost sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn sm"
            disabled={busy || !configured}
            onClick={() =>
              submit({ intent: "audit-export-s3", format: "json" })
            }
            title={
              configured ? "Upload the audit log to S3 now" : "Save a target first"
            }
          >
            Export to S3 now
          </button>
          {configured && (
            <button
              type="button"
              className="btn sm danger"
              disabled={busy}
              onClick={() => submit({ intent: "s3-config-clear" })}
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Instance run-concurrency cap — the max agent runs executing at once. 0 means
 * unlimited (the default). A positive N caps live provider processes at N and
 * queues the rest (run-service gate); this control shows the live/queued counts
 * so an admin can see the cap biting. Admin-only, like the whole page.
 */
function RunConcurrencyControl({
  runConcurrency,
}: {
  runConcurrency: RunConcurrencyView;
}) {
  const { submit, busy } = useOrgAction();
  const [value, setValue] = useState(String(runConcurrency.cap));
  // Re-seed the field when the server value changes (a save round-trips a fresh
  // loader value through this prop).
  useEffect(() => {
    setValue(String(runConcurrency.cap));
  }, [runConcurrency.cap]);
  const parsed = Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 0;
  const dirty = valid && parsed !== runConcurrency.cap;
  return (
    <div className="pol-note after conc">
      <Icon name="cpu" />
      <span className="conc-body">
        <span className="conc-lead">
          <strong>Run concurrency</strong> ·{" "}
          {runConcurrency.cap === 0
            ? "unlimited"
            : `capped at ${runConcurrency.cap}`}
          {" · "}
          {countLabel(runConcurrency.live, "run")} live
          {runConcurrency.queued > 0 && `, ${runConcurrency.queued} queued`}
        </span>
        <span className="conc-edit">
          <label htmlFor="max-concurrent-runs" className="conc-label">
            Max at once
          </label>
          <input
            id="max-concurrent-runs"
            type="number"
            min={0}
            step={1}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            aria-label="Maximum concurrent agent runs (0 means unlimited)"
          />
          <button
            type="button"
            className="btn sm"
            disabled={busy || !dirty}
            onClick={() =>
              submit({ intent: "set-concurrency", maxConcurrentRuns: value })
            }
          >
            Save
          </button>
          <span className="conc-hint fine sm">0 = unlimited</span>
        </span>
      </span>
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
            {fmtBytes(disk.totalBytes)} on the data volume ({disk.usedPercent}%
            used)
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
