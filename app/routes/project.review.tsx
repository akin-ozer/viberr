import { data } from "react-router";
import type { Route } from "./+types/project.review";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { getDb } from "~/server/db/sqlite.server";
import { getProject } from "~/server/projections/board-query.server";
import { getReviewQueue } from "~/server/projections/review-queue.server";
import { ReviewQueuePage } from "~/features/review/review-page";

/**
 * /projects/:slug/review — the Review queue (Phase 9C, review-queue.md).
 * Read-only projection loader; the shell's SSE revalidation (Phase 6)
 * refreshes it live, so accepted tasks leave panel 1 without any local
 * state. The rail badge and this loader read the same projection.
 */

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Review queue · ${params.slug} · Viberr` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const db = getDb();
  if (!getProject(db, params.slug)) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  // Members only (R4): the review queue exposes task detail + owner assignments;
  // unlike the app-wide board/task read surfaces it's project-scoped, like
  // policy/agents/settings/github.
  await requireProjectMember(request, params.slug, "view the review queue");
  const queue = getReviewQueue(db, params.slug);
  return { slug: params.slug, ...queue };
}

export default function ReviewView({ loaderData }: Route.ComponentProps) {
  const { slug, ready, working, total } = loaderData;
  return (
    <ReviewQueuePage
      projectSlug={slug}
      ready={ready}
      working={working}
      total={total}
    />
  );
}
