import { data } from "react-router";
import type { Route } from "./+types/project.review";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { getDb } from "~/server/db/sqlite.server";
import { getProject } from "~/server/projections/board-query.server";
import { getReviewQueue } from "~/server/projections/review-queue.server";
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
  return [{ title: `Review queue · ${params.slug} · Viberr` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const db = getDb();
  // Members only (R4): the review queue exposes task detail + owner assignments;
  // unlike the app-wide board/task read surfaces it's project-scoped, like
  // policy/agents/settings/github. Guard membership FIRST (matching those
  // siblings), then the 404 — a non-member must not learn a project exists (WI-13).
  const ctx = await requireProjectMember(request, params.slug, "view the review queue");
  const project = getProject(db, params.slug);
  if (!project) {
    throw data(`No project at projects/${params.slug}.`, { status: 404 });
  }
  // R8-3: "Waiting on your acceptance" is member-scoped by acceptance authority
  // (maintainer+ / owner), computed per review-stage task inside getReviewQueue.
  const queue = getReviewQueue(db, params.slug, { viewerUserId: ctx.user.id });
  // UI-49: the page used to hardcode "Review → Done". Stages are per-project and
  // renameable (a Lightweight board's review role is `doing`), and the queue
  // itself resolves them from the workflow graph — so ship the RESOLVED names.
  const roles = resolveStageRoles(project.stages, project.workflow);
  const nameOf = (id: string | null) =>
    project.stages.find((s) => s.id === id)?.name ?? null;
  // P13-D-9: the page used to promise "always a human action" unconditionally
  // while an `auto`-preset operator with an explicit
  // `completion-for-acceptance: direct` grant closes tasks itself. No policy or
  // autonomy signal reached the page at all — now it does.
  const acceptance = resolveAcceptanceAuthority(params.slug);
  return {
    slug: params.slug,
    ...queue,
    stageNames: {
      review: nameOf(roles.reviewId) ?? "the review stage",
      terminal: nameOf(roles.terminalId) ?? "the final stage",
    },
    acceptance,
  };
}

export default function ReviewView({ loaderData }: Route.ComponentProps) {
  const { slug, ready, working, total, stageNames, acceptance } = loaderData;
  return (
    <ReviewQueuePage
      projectSlug={slug}
      ready={ready}
      working={working}
      total={total}
      stageNames={stageNames}
      acceptance={acceptance}
    />
  );
}
