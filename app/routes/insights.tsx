import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import type { Route } from "./+types/insights";
import { pageTitle } from "~/shared/page-title";
import { getDb } from "~/server/db/sqlite.server";
import { requireRole } from "~/server/auth/require-user.server";
import { getInsightsSummary } from "~/server/insights/insights-query.server";
import { InsightsPage } from "~/features/insights/insights-page";

/**
 * /insights — instance-wide agent-run analytics. Org-admin only (run cost and
 * token totals across every project are an instance-owner view). Read-only: the
 * loader runs one aggregate query and the page formats it.
 */
export function meta() {
  return [{ title: pageTitle("Insights") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireRole(request, "admin");
  return { summary: getInsightsSummary(getDb(), new Date().toISOString()) };
}

export default function Insights({ loaderData }: Route.ComponentProps) {
  return <InsightsPage summary={loaderData.summary} />;
}

/** Ruling 457: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/insights");
