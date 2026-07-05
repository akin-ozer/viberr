import { data } from "react-router";
import type { Route } from "./+types/project.activity";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { getProject } from "~/server/projections/board-query.server";
import {
  listActivityStream,
  listAuditLog,
} from "~/server/projections/activity-feed.server";
import { ActivityPage } from "~/features/activity/activity-page";

/**
 * /projects/:slug/activity — cross-task activity stream + audit logs
 * (Phase 9C, activity.md). Read-only projection loader; the workspace
 * shell's SSE revalidation keeps it fresh. Stream is capped at the most
 * recent events (activity-feed.server.ts limits) — pagination is a
 * Phase 10 question.
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
  return {
    slug: params.slug,
    projectName: project.name,
    stream: listActivityStream(db, params.slug),
    audit: listAuditLog(db, params.slug),
  };
}

export default function ActivityView({ loaderData }: Route.ComponentProps) {
  const { slug, projectName, stream, audit } = loaderData;
  return (
    <ActivityPage
      projectSlug={slug}
      projectName={projectName}
      stream={stream}
      audit={audit}
    />
  );
}
