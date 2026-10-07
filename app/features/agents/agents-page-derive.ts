import { inFlightIntent } from "~/ui/in-flight";
import type {
  AgentDeploymentView,
  AgentProfileView,
  LibraryProfileView,
} from "./agent-types";
import type { BackendConnectionSummary, BackendHealthMap } from "./agents-page";

/**
 * What the Agents page reads off its props before it draws (ruling 689(e), the
 * split of `agents-page.tsx` along the task-page recipe): which backend a
 * profile's runs resolve and whether the viewer connected it, the roster's
 * operator, agents and open profile, each profile's live runs, the stats'
 * engagement tallies, and the library deploy in flight. Pure functions of the
 * loader data, no React; the page or one of its regions calls each at most
 * once per render.
 */

/** The backend a run would actually resolve — the profile's FIRST (the
 *  "a run uses the first" rule the runtime row already states). */
export function primaryBackend(a: AgentProfileView): "codex" | "claude" | null {
  return a.backends[0] ?? null;
}

/** The health entry for a profile's primary backend, or null when the page has
 *  no health data (or the profile has no backend — the operator's
 *  orchestration runtime). */
export function primaryBackendHealth(
  a: AgentProfileView,
  health: BackendHealthMap | undefined,
): BackendConnectionSummary | null {
  const backend = primaryBackend(a);
  if (!backend || !health) return null;
  return health[backend] ?? null;
}

/** Ruling 127: the profile editor's advisory note, from the same probe the
 *  roster reads. Undefined when connections were not probed on this surface,
 *  so the editor claims nothing rather than inventing a second answer. */
export function viewerConnections(
  backendHealth: BackendHealthMap | undefined,
): { claude: boolean; codex: boolean } | undefined {
  return backendHealth
    ? {
        claude: backendHealth.claude?.viewerConnected === true,
        codex: backendHealth.codex?.viewerConnected === true,
      }
    : undefined;
}

/** The roster as the page lays it out: the operator on its own, the agents
 *  under it, the library's undeployed templates, and the open profile. */
export interface AgentRoster {
  operator: AgentProfileView | null;
  /** The backend an operator run starts on (ruling 479(e)). */
  operatorBackend: "codex" | "claude";
  specialists: AgentProfileView[];
  libraryProfiles: LibraryProfileView[];
  /** The selected profile, or the first one when the selection names none
   *  here; null on an empty roster. */
  current: AgentProfileView | null;
}

export function rosterOf(
  profiles: AgentProfileView[],
  library: LibraryProfileView[] | undefined,
  sel: string,
): AgentRoster {
  const operator = profiles.find((p) => p.kind === "operator") ?? null;
  // Ruling 479(e): the backend an operator run starts on, by the rule the run
  // resolves it with (`resolveOperatorAuthority`): the first backend the
  // profile names, Claude when it names none or no operator is deployed.
  const operatorBackend = (operator && primaryBackend(operator)) ?? "claude";
  const specialists = profiles.filter((p) => p.kind !== "operator");
  const libraryProfiles = library ?? [];
  const current = profiles.find((a) => a.id === sel) ?? profiles[0] ?? null;
  return { operator, operatorBackend, specialists, libraryProfiles, current };
}

/** Per profile, the tasks it has a run in flight on (the roster's pulse). */
export function runningTaskCounts(deployments: AgentDeploymentView[]) {
  const sets = new Map<string, Set<string>>();
  for (const d of deployments) {
    // F26-2: the sidebar's "working" pulse is a claim about LIVE runs, not
    // engagements — count only tasks with an actual running row (`d.running`),
    // exactly like the profile hero does (1cd86c8). Without this, a profile
    // assigned to N tasks it is executing nothing on pulsed "working · N" here
    // while the hero on the same page said "idle · engaged on N".
    if (!d.running) continue;
    let keys = sets.get(d.profileId);
    if (!keys) {
      keys = new Set();
      sets.set(d.profileId, keys);
    }
    keys.add(d.taskKey);
  }
  const out: Record<string, number> = {};
  for (const [k, v] of sets) out[k] = v.size;
  return out;
}

/** The three engagement counts over the roster (`AgentStats`). */
export function engagementTallies(deployments: AgentDeploymentView[]) {
  const operators = deployments.filter((d) => d.engagement === "operator").length;
  // F34-5: runs in flight, the same claim the sidebar pulse and the profile
  // hero make (`runningTaskCounts` above, F26-2). This counted
  // `status === "working"` back when the projection derived that word from
  // the task's `waiting` flag, so the card read "5 agent threads in a working
  // state" with one run alive; the status is run-derived now, and `running`
  // is the fact itself.
  const running = deployments.filter((d) => d.running).length;
  // The waiting count is TASK-level on purpose: an engagement whose run is in
  // flight on a human-waiting task now says "working" (F34-5), and counting
  // by status would silently drop it here. `taskWaiting` is the task's own
  // flag, and the label says whose waiting it is.
  const waiting = deployments.filter((d) => d.taskWaiting === "human").length;
  return { operators, running, waiting };
}

/** The library template whose deploy the page's fetcher is posting, so its
 *  row names the work while the others wait (ruling 368, ruling 638). */
export function deployingProfileId(fetcher: {
  state: "idle" | "loading" | "submitting";
  formData?: FormData | undefined;
}): string | null {
  return inFlightIntent(fetcher) === "deploy-profile"
    ? String(fetcher.formData?.get("profileId") ?? "")
    : null;
}
