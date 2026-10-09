import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { data } from "react-router";
import { pageTitle } from "~/shared/page-title";
import type { Route } from "./+types/project.review";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { getDb } from "~/server/db/sqlite.server";
import { getProject } from "~/server/projections/board-query.server";
import { getReviewQueue } from "~/server/projections/review-queue.server";
import { waitingOnViewer } from "~/server/projections/decisions.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { resolveAcceptanceAuthority } from "~/features/review/review-acceptance-authority.server";
import { ReviewQueuePage } from "~/features/review/review-page";

/**
 * /projects/:slug/review — the Review queue (Phase 9C, review-queue.md).
 * Read-only projection loader; the shell's SSE revalidation (Phase 6)
 * refreshes it live, so accepted tasks leave panel 1 without any local
 * state. The rail badge and this loader read the same projection.
 */

export function meta({ params }: Route.MetaArgs) {
  return [{ title: pageTitle("Review queue", params.slug) }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const db = getDb();
  // R15-4 on THIS loader, not only the layout's (F19-28): single-fetch honors a
  // client-supplied `?_routes=` filter, so
  // `GET /projects/<slug>/review.data?_routes=routes/project.review` runs this
  // loader ALONE and the layout's membership refusal never executes. The guard
  // answers a non-member with the byte-identical unknown-slug 404 — a 403 here
  // would confirm the project exists (WI-13).
  const ctx = await requireProjectMember(request, params.slug, "view the review queue");
  const project = getProject(db, params.slug);
  if (!project) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  // R8-3: "Waiting on your acceptance" is member-scoped by acceptance authority
  // (maintainer+ / owner), computed per review-stage task inside getReviewQueue.
  const queue = getReviewQueue(db, params.slug, { viewerUserId: ctx.user.id });
  // UI-49: the page used to hardcode "Review → Done". Stages are per-project and
  // renameable (a board's review stage need not be named `review`), and the queue
  // itself resolves them from the workflow graph — so ship the RESOLVED names.
  const roles = resolveStageRoles(project.stages, project.workflow);
  const nameOf = (id: string | null) =>
    project.stages.find((s) => s.id === id)?.name ?? null;
  // P13-D-9: the page used to promise "always a human action" unconditionally
  // while an `auto`-preset operator with an explicit
  // `completion-for-acceptance: direct` grant closes tasks itself. No policy or
  // autonomy signal reached the page at all — now it does.
  const acceptance = resolveAcceptanceAuthority(params.slug);
  // Interface review 2026-09-24 (writ-3): a row's "waiting on you" is the
  // board's own answer (`waitingOnViewer`, the one helper both loaders call),
  // so the queue and the board cannot disagree about the same task.
  const waitingOnMe = [
    ...waitingOnViewer(db, ctx.user.id, params.slug, queue.ready.map((r) => r.key)),
  ];
  return {
    slug: params.slug,
    ...queue,
    waitingOnMe,
    stageNames: {
      review: nameOf(roles.reviewId) ?? "the review stage",
      terminal: nameOf(roles.terminalId) ?? "the final stage",
    },
    acceptance,
  };
}

export default function ReviewView({ loaderData }: Route.ComponentProps) {
  const { slug, ready, working, total, stageNames, acceptance } = loaderData;
  const waitingOnMe = new Set(loaderData.waitingOnMe);
  return (
    <ReviewQueuePage
      projectSlug={slug}
      ready={ready}
      working={working}
      total={total}
      stageNames={stageNames}
      acceptance={acceptance}
      waitingOnMe={waitingOnMe}
    />
  );
}

/** Ruling 11: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/project.review");
