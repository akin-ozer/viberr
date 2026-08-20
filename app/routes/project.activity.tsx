import { data } from "react-router";
import type { Route } from "./+types/project.activity";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { getDb } from "~/server/db/sqlite.server";
import { getProject } from "~/server/projections/board-query.server";
import {
  auditFilterActors,
  countActivityStream,
  countAuditLog,
  listActivityStream,
  listAuditLog,
  streamFilterOptions,
  type AuditFilters,
  type StreamFilters,
} from "~/server/projections/activity-feed.server";
import { ActivityPage } from "~/features/activity/activity-page";
import {
  AUDIT_MAX,
  AUDIT_STEP,
  clampFeedLimit,
  STREAM_MAX,
  STREAM_STEP,
} from "~/features/activity/feed-limits";

/**
 * /projects/:slug/activity — cross-task activity stream + audit logs
 * (Phase 9C, activity.md; Phase 10 deepened the audit panel + added
 * loader-driven pagination). Read-only projection loader; the workspace
 * shell's SSE revalidation keeps it fresh. Both panels serve a bounded
 * newest-first slice — `?stream=` / `?audit=` raise the limits ("Show
 * older", the task-detail `?events=` pattern).
 */

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Activity · ${params.slug} · Viberr` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const db = getDb();
  // R15-4 on THIS loader, not only the layout's (F19-28): single-fetch honors a
  // client-supplied `?_routes=` filter, so
  // `GET /projects/<slug>/activity.data?_routes=routes/project.activity` runs
  // this loader ALONE and the layout's membership refusal never executes. The
  // guard answers a non-member with the byte-identical unknown-slug 404 — a 403
  // here would confirm the project exists (WI-13).
  await requireProjectMember(request, params.slug, "view project activity");
  const project = getProject(db, params.slug);
  if (!project) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  const url = new URL(request.url);
  const streamLimit = clampFeedLimit(
    url.searchParams.get("stream"),
    STREAM_STEP,
    STREAM_MAX,
  );
  const auditLimit = clampFeedLimit(
    url.searchParams.get("audit"),
    AUDIT_STEP,
    AUDIT_MAX,
  );
  // Per-panel filters (owner request 2026-08-20), URL-driven like the limits so
  // they survive revalidation and are shareable. A param is a filter only when
  // non-blank; bounds keep a pasted novel out of a LIKE clause.
  const param = (name: string, max = 200): string | undefined => {
    const value = url.searchParams.get(name)?.trim().slice(0, max);
    return value ? value : undefined;
  };
  const streamFilters: StreamFilters = {};
  {
    const q = param("sq");
    const actorRef = param("sac");
    const type = param("sty", 40);
    const task = param("stk", 40);
    const from = param("sfrom", 10);
    const to = param("sto", 10);
    if (q) streamFilters.q = q;
    if (actorRef) streamFilters.actorRef = actorRef;
    if (type) streamFilters.type = type;
    if (task) streamFilters.task = task;
    if (from) streamFilters.from = from;
    if (to) streamFilters.to = to;
  }
  const auditFilters: AuditFilters = {};
  {
    const q = param("aq");
    const kind = param("aky", 20);
    const actor = param("aac");
    const task = param("atk", 40);
    const from = param("afrom", 10);
    const to = param("ato", 10);
    if (q) auditFilters.q = q;
    if (
      kind === "violation" ||
      kind === "blockedact" ||
      kind === "change" ||
      kind === "audit"
    ) {
      auditFilters.kind = kind;
    }
    if (actor) auditFilters.actor = actor;
    if (task) auditFilters.task = task;
    if (from) auditFilters.from = from;
    if (to) auditFilters.to = to;
  }
  return {
    slug: params.slug,
    projectName: project.name,
    stream: listActivityStream(db, params.slug, {
      limit: streamLimit,
      filters: streamFilters,
    }),
    streamTotal: countActivityStream(db, params.slug, streamFilters),
    audit: listAuditLog(db, params.slug, {
      limit: auditLimit,
      filters: auditFilters,
    }),
    auditTotal: countAuditLog(db, params.slug, auditFilters),
    // The dropdown vocabularies — refs/labels/types that actually occur, so a
    // filter is a pick, never a guess.
    streamOptions: streamFilterOptions(db, params.slug),
    auditActors: auditFilterActors(db, params.slug),
  };
}

export default function ActivityView({ loaderData }: Route.ComponentProps) {
  const {
    slug,
    projectName,
    stream,
    streamTotal,
    audit,
    auditTotal,
    streamOptions,
    auditActors,
  } = loaderData;
  return (
    <ActivityPage
      projectSlug={slug}
      projectName={projectName}
      stream={stream}
      streamTotal={streamTotal}
      audit={audit}
      auditTotal={auditTotal}
      streamOptions={streamOptions}
      auditActors={auditActors}
    />
  );
}
