import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { OrgSettingsView } from "~/server/org/org-view.server";
import { countLabel } from "~/shared/text/plural";
import { Icon, type IconName } from "~/ui/icon";
import { ConnectionsPanel } from "./connections-panel";
import { ResourcesPanel } from "./resources-panel";
import { SsoPanel } from "./sso-panel";
import { useOrgAction } from "./use-org-action";
import { UsersPanel } from "./users-panel";

/**
 * /org/settings page shell (org-settings spec §4.0, markup 1:1): back
 * button + title, tab rail with live counts, active panel. The tab rides
 * the URL (?tab=connections|users|resources — the Home tiles already link
 * this shape); default "connections". Admin-only (route-enforced).
 */

export type OrgSettingsTab = "connections" | "users" | "sso" | "resources";

const SETTINGS_TABS: { id: OrgSettingsTab; label: string; icon: IconName }[] = [
  { id: "connections", label: "GitHub connections", icon: "github" },
  { id: "users", label: "Users & access", icon: "user" },
  // R19-16: sits next to Users & access — the whitelist decides WHO may sign
  // in, this decides HOW they can.
  { id: "sso", label: "Sign-in & SSO", icon: "lock" },
  { id: "resources", label: "Agent resources", icon: "memory" },
];

function resolveOrgTab(raw: string | null): OrgSettingsTab {
  return raw === "users" || raw === "resources" || raw === "sso"
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
}: {
  view: OrgSettingsView;
  meId: string;
  /** This deployment's origin — the callback URL an OAuth app must carry. */
  callbackOrigin: string;
  runConcurrency: RunConcurrencyView;
}) {
  const navigate = useNavigate();
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
  } satisfies Record<OrgSettingsTab, string>;

  return (
    <main className="home-shell" data-screen-label="Instance settings">
      <div className="set-head">
        <button type="button" className="btn ghost sm" onClick={() => navigate("/")}>
          <Icon name="arrow" className="r180" />
          Projects
        </button>
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
              stages={view.stages}
            />
          )}
        </div>
      </div>
      <RunConcurrencyControl runConcurrency={runConcurrency} />
      <StorageLine storage={view.storage} />
    </main>
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
  const cleanup = maintenance.scheduled
    ? maintenance.lastPassAt
      ? `automatic cleanup runs every ${Math.round(maintenance.intervalMs / 3_600_000)}h; last freed ${fmtBytes(maintenance.lastFreedBytes)}`
      : `automatic cleanup runs every ${Math.round(maintenance.intervalMs / 3_600_000)}h`
    : "automatic cleanup is not scheduled";
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
