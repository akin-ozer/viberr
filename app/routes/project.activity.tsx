import { data } from "react-router";
import type { Route } from "./+types/project.activity";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { getProject } from "~/server/projections/board-query.server";
import {
  countActivityStream,
  countAuditLog,
  listActivityStream,
  listAuditLog,
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
  requireUser(request);
  const db = getDb();
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
  return {
    slug: params.slug,
    projectName: project.name,
    stream: listActivityStream(db, params.slug, { limit: streamLimit }),
    streamTotal: countActivityStream(db, params.slug),
    audit: listAuditLog(db, params.slug, { limit: auditLimit }),
    auditTotal: countAuditLog(db, params.slug),
  };
}

export default function ActivityView({ loaderData }: Route.ComponentProps) {
  const { slug, projectName, stream, streamTotal, audit, auditTotal } =
    loaderData;
  return (
    <ActivityPage
      projectSlug={slug}
      projectName={projectName}
      stream={stream}
      streamTotal={streamTotal}
      audit={audit}
      auditTotal={auditTotal}
    />
  );
}
