/**
 * Pure board filter/search predicates (board spec §3.3, contracts §2.3).
 * Canonical readiness enum values here — the mock's short values live only
 * in pill CSS via app/ui/pill.tsx.
 */

export type BoardFilterId = "all" | "human" | "agent" | "risk";

export interface FilterableTask {
  waiting: string;
  /** Personalized responsibility computed from explicit project role + owner. */
  waitingOnMe?: boolean;
  readiness: string;
  validation: string;
  urgent: boolean;
}

/** Personalized human responsibility plus canonical agent/risk predicates. */
export function matchesBoardFilter(
  task: FilterableTask,
  filter: BoardFilterId,
): boolean {
  if (filter === "human") return task.waitingOnMe === true;
  if (filter === "agent") return task.waiting === "agent";
  if (filter === "risk") {
    return (
      task.readiness === "inconsistency_risk_detected" ||
      task.readiness === "blocked" ||
      task.validation === "failing" ||
      task.urgent
    );
  }
  return true;
}

export interface SearchableTask {
  key: string;
  title: string;
  branch: string | null;
  owner: { name: string } | null;
  specialist: { name: string; role: string } | null;
  reviewers: { name: string; role: string }[];
  operator: { name: string } | null;
}

/** Topbar search: case-insensitive substring over key, title, branch and
 * agent/owner identities ("Search tasks, branches, agents…"). */
export function matchesSearch(task: SearchableTask, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    task.key,
    task.title,
    task.branch ?? "",
    task.owner?.name ?? "",
    task.specialist ? `${task.specialist.name} ${task.specialist.role}` : "",
    ...task.reviewers.map((c) => `${c.name} ${c.role}`),
    task.operator?.name ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

export function isBoardFilterId(value: string | null): value is BoardFilterId {
  return (
    value === "all" || value === "human" || value === "agent" || value === "risk"
  );
}

/** Branch chip truncation — exact mock rule (>16 chars → 15 + "…"). */
export function shortBranch(branch: string): string {
  return branch.length > 16 ? branch.slice(0, 15) + "…" : branch;
}
