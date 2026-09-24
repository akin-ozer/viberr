import { useContext } from "react";
import {
  UNSAFE_DataRouterContext,
  type DataRouter,
  type RouterState,
  type ShouldRevalidateFunction,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

/**
 * Ruling 454: WHEN a loader re-runs, in one home. Every route with a loader
 * exports `shouldRevalidate = revalidateWhen("<its route id>")`, and the rule
 * table below says what that loader reads.
 *
 * React Router's single fetch asks every route on screen to re-run after every
 * navigation, action and `revalidate()` (it passes
 * `defaultShouldRevalidate: true` unless an action failed). Viberr paid for it
 * on every keystroke in the board filter (root, layout and board, BOARD-1),
 * twice per action of the person's own (once for the action, again for the
 * SSE echo of the same write, RF-5), twice per task open (the navigation, then
 * the re-scoped stream's catch-up, RF-1), and with root's theme and csrf on
 * every live event (RF-7).
 *
 * THE LEDGER. The policy keeps, per tab, the obligations nothing has loaded
 * yet, each with a sequence number:
 *
 *   - a live event the stream delivered (recorded by `useLiveUpdates` the
 *     moment it arrives: `LiveLedger.recordLive`);
 *   - an action (recorded when React Router shows its submission);
 *   - a `revalidate()` that is not the live hook's own (the F22 net, a
 *     settle, a panel's poll): an obligation on every route but root.
 *
 * and, per route, the sequence number its current data covers: when a route's
 * loader data lands, it covers everything recorded before the load that
 * brought it STARTED (the smallest start among the loads in flight, so an
 * interrupted load can only under-claim). React Router's subscriber runs
 * synchronously inside the state update that precedes each request, so a load
 * that starts after an obligation was recorded was sent after it.
 *
 * WHY A LOAD THAT STARTED LATER COVERS AN EVENT. The server publishes an event
 * after the write it announces has committed (projection events leave
 * `collectProjectionEvents` only after the transaction; the run, controller
 * and resource publishers write first). The browser received the frame, THEN
 * sent the request, so the server answered that request after the event was
 * published, from data that already holds its write. That is the whole
 * watermark: no clock and no id comparison, only "received before this load
 * was sent". It is why the echo of one's own action (published while the
 * action ran, received before its response) is covered by the action's own
 * revalidation and is skipped, while an operator's reaction, received after
 * that revalidation started, still revalidates. An echo that arrives after the
 * post-action load was sent is not provably covered, and revalidates as
 * before.
 *
 * A route re-runs when (a) something it reads is owed (an obligation recorded
 * after its data's coverage, whose facts it reads), (b) a navigation changed a
 * path param or a search param its loader reads, (c) an action it reads just
 * ran, or (d) the navigation is to the URL already on screen (a link to where
 * you are reloads, as React Router's default does). Nothing else skips an
 * obligation: a trigger that interrupts an in-flight load finds the obligation
 * still in the ledger and loads it. No optimistic UI for governed state
 * follows from this: every change the server announced reaches the page
 * through a loader, only the reloads of data already carrying it are gone.
 *
 * Tracked in tests: a loader that returns the SAME object every time never
 * shows a landing, so its route stays owed and keeps revalidating (the old
 * behaviour, never a skipped change). Decoded single-fetch data is always a
 * fresh object.
 */

/** What a loader's answer can depend on, as the triggers that change it. */
export type Fact =
  /** Project, task, goal, policy and org resource data (most events). */
  | "domain"
  /** A run's lifecycle (`run.state-changed`). */
  | "run"
  /** The viewer's notifications: the bell's counts and lists. */
  | "bell"
  /** A controller conversation (`controller.updated`). */
  | "conversation"
  /** The theme preference cookie (`/prefs/theme`). */
  | "theme"
  /** The signed-in session (sign-in, sign-out, the profile's account). */
  | "session";

/** Everything a live event or a `revalidate()` can bring. */
const EVENT_FACTS: readonly Fact[] = ["domain", "run", "bell", "conversation"];
const EVERY_FACT: readonly Fact[] = [...EVENT_FACTS, "theme", "session"];

/** A shell: the workspace layout and the standalone header draw the project
 *  chrome, the rail's counts and the bell's counts, and no run state. */
const SHELL: readonly Fact[] = ["domain", "bell"];
/** A page: its own data and the run state it shows. */
const PAGE: readonly Fact[] = ["domain", "run"];

interface RouteRule {
  /** Path params the loader reads; `"pathname"` when it reads the path. */
  params: readonly string[] | "pathname";
  /** Search params the loader reads; `"any"` for a loader that reads many. */
  search: readonly string[] | "any";
  /** The facts its answer depends on. */
  reads: readonly Fact[];
}

/**
 * What each loader reads. Checked against the loaders by
 * `revalidation-policy.test.tsx` (every route module with a loader exports its
 * rule) and by reading them: a loader that starts reading a search param must
 * add it here, or a navigation that changes it will not re-run the loader.
 */
export const REVALIDATION_RULES = {
  // Theme and csrf, plus the SSR stream position. Nothing a live event or a
  // navigation carries changes them (RF-7).
  root: { params: [], search: [], reads: ["theme", "session"] },
  "routes/_index": { params: [], search: [], reads: [...PAGE, "bell"] },
  "routes/login": { params: [], search: ["returnTo"], reads: ["session"] },
  // Decides its header from the pathname (`pagePathname`).
  "routes/palette-shell": { params: "pathname", search: [], reads: SHELL },
  "routes/org.settings": { params: [], search: [], reads: PAGE },
  "routes/controller": { params: [], search: ["c", "all"], reads: [...PAGE, "conversation"] },
  "routes/insights": { params: [], search: [], reads: PAGE },
  "routes/profile": { params: [], search: [], reads: [...PAGE, "theme"] },
  "routes/notifications": { params: [], search: [], reads: ["domain", "bell"] },
  "routes/project": { params: ["slug"], search: [], reads: SHELL },
  "routes/project.board": { params: ["slug"], search: [], reads: PAGE },
  "routes/project.review": { params: ["slug"], search: [], reads: PAGE },
  "routes/project.controller": {
    params: ["slug"],
    search: ["c", "all"],
    reads: [...PAGE, "conversation"],
  },
  "routes/project.agents": { params: ["slug"], search: [], reads: PAGE },
  "routes/project.policy": { params: ["slug"], search: [], reads: PAGE },
  "routes/project.github": { params: ["slug"], search: [], reads: PAGE },
  // Paging limits and a dozen filters, all URL-driven.
  "routes/project.activity": { params: ["slug"], search: "any", reads: PAGE },
  "routes/project.settings": { params: ["slug"], search: [], reads: PAGE },
  // `?events` is the timeline window.
  "routes/project.task": { params: ["slug", "key"], search: ["events"], reads: PAGE },
} satisfies Record<string, RouteRule>;

export type RevalidationRouteId = keyof typeof REVALIDATION_RULES;

const RULES_BY_ID = new Map<string, RouteRule>(Object.entries(REVALIDATION_RULES));

function ruleOf(routeId: string): RouteRule | null {
  return RULES_BY_ID.get(routeId) ?? null;
}

/** The facts a live event can change. */
export function liveEventFacts(name: string): readonly Fact[] {
  switch (name) {
    case "run.state-changed":
      return ["run"];
    case "controller.updated":
      return ["conversation"];
    case "notification.created":
    case "notification.read":
      return ["bell"];
    case "stream.resync":
      return EVENT_FACTS;
    default:
      return ["domain"];
  }
}

/** Actions whose writes are narrower than a page's data. */
const NARROW_ACTIONS = new Map<string, readonly Fact[]>([
  ["/notifications/read", ["bell"]],
  ["/prefs/theme", ["theme"]],
  // The dock's send (ruling 121); it also opts out at the call site.
  ["/resources/controller", ["conversation"]],
  ["/login", EVERY_FACT],
  ["/logout", EVERY_FACT],
  ["/profile", EVERY_FACT],
]);

function pathOf(formAction: string | undefined): string {
  if (!formAction) return "";
  return new URL(formAction, "http://viberr.invalid").pathname;
}

/** The facts an action can change, by the path it posts to. */
export function actionFacts(formAction: string | undefined): readonly Fact[] {
  const path = pathOf(formAction);
  if (path.startsWith("/api/auth/")) return EVERY_FACT;
  return NARROW_ACTIONS.get(path) ?? PAGE;
}

function overlaps(a: readonly Fact[], b: readonly Fact[]): boolean {
  return a.some((fact) => b.includes(fact));
}

function isMutation(method: string | undefined): boolean {
  return method !== undefined && method.toUpperCase() !== "GET";
}

// ------------------------------------------------------------- the ledger

interface Obligation {
  seq: number;
  facts: readonly Fact[];
  kind: "live" | "action" | "revalidate";
  /** A live event already handed to a revalidation; dropped when it settles. */
  flushed: boolean;
  /** An action's path, so one React Router refused is withdrawn. */
  path: string;
}

/** The loads whose answer can land: a navigation's, a `revalidate()`'s and
 *  each action's own revalidation (a fetcher showing `loading` after its
 *  submission). A plain `fetcher.load` never changes route data. */
function loadsInFlight(state: RouterState): string[] {
  const keys: string[] = [];
  if (state.navigation.state === "loading") keys.push("navigation");
  if (state.revalidation === "loading") keys.push("revalidation");
  for (const [key, fetcher] of state.fetchers) {
    if (fetcher.state === "loading" && isMutation(fetcher.formMethod)) keys.push(`fetcher:${key}`);
  }
  return keys;
}

/** A submission or a route load is in flight. */
function busy(state: RouterState): boolean {
  if (state.navigation.state !== "idle" || state.revalidation !== "idle") return true;
  for (const fetcher of state.fetchers.values()) {
    if (fetcher.state !== "idle" && isMutation(fetcher.formMethod)) return true;
  }
  return false;
}

const RECENT_EVENTS = 256;

/**
 * One tab's live-update state (one router per tab): the ledger of what its
 * loaders owe, the events it has recorded, and where its streams stand in the
 * broker's event ids.
 */
export class LiveLedger {
  readonly router: DataRouter;
  /**
   * Ruling 454 (RF-1): the broker event id this tab stands at, for the first
   * stream a surface opens (a surface's reopens use their own position). Seeded
   * from root's `liveHead` on the document load, then moved by every stream's
   * hello and events.
   */
  position: number | null = null;
  private seq = 0;
  private obligations: Obligation[] = [];
  private readonly coverage = new Map<string, number>();
  private readonly loads = new Map<string, number>();
  private readonly recent = new Set<string>();
  private last: RouterState;
  /** True while the live hook's own `revalidate()` call runs. */
  private ownCall = false;
  private flushWanted = false;

  constructor(router: DataRouter) {
    this.router = router;
    this.last = router.state;
    for (const key of loadsInFlight(router.state)) this.loads.set(key, 0);
    router.subscribe((state) => this.observe(state));
  }

  /**
   * A live data event arrived (before any load it could be in was sent).
   * Recorded once per tab: two streams whose scopes both carry an event (the
   * project controller page: the layout's and the page's own) both deliver it,
   * with the same id and body. The id alone could match an event from before a
   * server restart (the broker's ids start over); the id with the body cannot.
   */
  recordLive(name: string, event: MessageEvent<string>): void {
    if (event.lastEventId) {
      const key = `${event.lastEventId}|${event.data}`;
      if (this.recent.has(key)) return;
      this.recent.add(key);
      if (this.recent.size > RECENT_EVENTS) {
        const oldest = this.recent.values().next().value;
        if (oldest !== undefined) this.recent.delete(oldest);
      }
    }
    this.record({ kind: "live", facts: liveEventFacts(name), path: "" });
  }

  /** A stream could not be caught up by replay (`stream.resync`). */
  recordResync(): void {
    this.record({ kind: "live", facts: EVENT_FACTS, path: "" });
  }

  /** Does `routeId`, reading `reads`, owe a load? */
  owes(routeId: string, reads: readonly Fact[]): boolean {
    const covered = this.coverage.get(routeId) ?? 0;
    return this.obligations.some((o) => o.seq > covered && overlaps(o.facts, reads));
  }

  /** React Router declined to revalidate after this action (it failed, or its
   *  caller opted out): it changed nothing a loader reads. The newest action
   *  on that path is the one React Router just answered for. */
  withdraw(formAction: string | undefined): void {
    const path = pathOf(formAction);
    const newest = this.obligations.findLast((o) => o.kind === "action" && o.path === path);
    if (newest) this.obligations = this.obligations.filter((o) => o !== newest);
  }

  /** The routes on screen that owe `o`: they read what it changed, and their
   *  data was requested before it was recorded. */
  private routesOwing(o: Obligation): string[] {
    const owing: string[] = [];
    for (const match of this.router.state.matches) {
      const id = match.route.id;
      const rule = ruleOf(id);
      // A route with no rule keeps React Router's defaults: only live events
      // are the ledger's to trigger for it.
      if (!rule && o.kind !== "live") continue;
      if (!rule && !(id in this.router.state.loaderData)) continue;
      const reads = rule ? rule.reads : EVENT_FACTS;
      if (!overlaps(o.facts, reads)) continue;
      if ((this.coverage.get(id) ?? 0) < o.seq) owing.push(id);
    }
    return owing;
  }

  /**
   * The live hook's debounced flush: one `revalidate()` if a route on screen
   * owes a live event, none when every event is already covered (the echo of
   * one's own action). Waits for any load or submission in flight, whose
   * landing may cover the events, and decides when the router is idle.
   */
  flushLive(): void {
    if (busy(this.router.state)) {
      this.flushWanted = true;
      return;
    }
    this.flushWanted = false;
    const due = this.obligations.filter(
      (o) => o.kind === "live" && !o.flushed && this.routesOwing(o).length > 0,
    );
    this.prune();
    if (due.length === 0) return;
    for (const o of due) o.flushed = true;
    this.ownCall = true;
    let settled: Promise<void>;
    try {
      settled = this.router.revalidate();
    } finally {
      this.ownCall = false;
    }
    void settled.then(() => {
      this.obligations = this.obligations.filter((o) => !due.includes(o));
    });
  }

  private record(o: Omit<Obligation, "seq" | "flushed">): void {
    this.seq += 1;
    // A newer `revalidate()` subsumes an older one: a route owes the older only
    // if its coverage is below both. (Live events stay apart, each flushed
    // once; actions too, each withdrawn on its own answer.)
    if (o.kind === "revalidate") {
      this.obligations = this.obligations.filter((x) => x.kind !== "revalidate");
    }
    this.obligations.push({ ...o, seq: this.seq, flushed: false });
  }

  private observe(state: RouterState): void {
    const prev = this.last;
    this.last = state;

    // 1. Data that landed was requested by a load already in flight: it
    //    covers what was recorded before the earliest of them started.
    if (this.loads.size > 0) {
      const start = Math.min(...this.loads.values());
      for (const match of state.matches) {
        const id = match.route.id;
        if (!(id in state.loaderData) || state.loaderData[id] === prev.loaderData[id]) continue;
        this.coverage.set(id, Math.max(this.coverage.get(id) ?? 0, start));
      }
    }

    // 2. Obligations that start now, before any load they cause is sent.
    const nav = state.navigation;
    if (nav.state === "submitting" && nav !== prev.navigation) {
      this.record({ kind: "action", facts: actionFacts(nav.formAction), path: pathOf(nav.formAction) });
    }
    for (const [key, fetcher] of state.fetchers) {
      if (fetcher.state !== "submitting" || prev.fetchers.get(key) === fetcher) continue;
      if (!isMutation(fetcher.formMethod)) continue;
      this.record({
        kind: "action",
        facts: actionFacts(fetcher.formAction),
        path: pathOf(fetcher.formAction),
      });
    }
    if (state.revalidation === "loading" && prev.revalidation !== "loading" && !this.ownCall) {
      this.record({ kind: "revalidate", facts: EVENT_FACTS, path: "" });
    }

    // 3. Loads that start now cover everything recorded so far.
    const inFlight = new Set(loadsInFlight(state));
    for (const key of this.loads.keys()) if (!inFlight.has(key)) this.loads.delete(key);
    for (const key of inFlight) if (!this.loads.has(key)) this.loads.set(key, this.seq);

    this.prune();
    if (this.flushWanted && !busy(state)) queueMicrotask(() => this.flushLive());
  }

  /** Drops obligations every route on screen has loaded past, unless a load
   *  in flight started before them (its route may land without them). */
  private prune(): void {
    const earliestLoad = this.loads.size > 0 ? Math.min(...this.loads.values()) : Infinity;
    this.obligations = this.obligations.filter((o) => {
      if (o.kind === "live" && o.flushed) return true;
      if (earliestLoad < o.seq) return true;
      return this.routesOwing(o).length > 0;
    });
  }
}

const ledgers = new WeakMap<DataRouter, LiveLedger>();
/** The ledger `shouldRevalidate` consults: the tab's router (tests make one
 *  router per test, and the latest to render decides). */
let current: LiveLedger | null = null;

/** The ledger of `router`, started on first use. Idempotent, so it may run
 *  during render: it must exist before the first stream opens and before the
 *  first submission, both of which follow the first render. */
function ledgerOf(router: DataRouter): LiveLedger | null {
  let ledger = ledgers.get(router);
  if (!ledger) {
    try {
      ledger = new LiveLedger(router);
    } catch {
      // A static router (a server render, or a test rendering one) refuses
      // `subscribe`: nothing navigates or revalidates there.
      return null;
    }
    ledgers.set(router, ledger);
  }
  current = ledger;
  return ledger;
}

/**
 * This tab's live ledger. Root holds it for every surface and seeds the stream
 * position from its `liveHead`; the live hook holds it to record into. Null
 * outside a data router.
 */
export function useLiveLedger(seedPosition: number | null = null): LiveLedger | null {
  const router = useContext(UNSAFE_DataRouterContext)?.router ?? null;
  // The server render's static router cannot be subscribed to (it throws),
  // and a server render has no stream and no revalidation to decide.
  if (!router || !("document" in globalThis)) return null;
  const ledger = ledgerOf(router);
  // Only the first reading: a later root revalidation's head (after a theme
  // change) must not jump the tab past events its streams have not delivered.
  if (ledger && ledger.position === null && seedPosition !== null) ledger.position = seedPosition;
  return ledger;
}

/** True when the URL is the same place (path and search). */
function samePlace(a: URL, b: URL): boolean {
  return a.pathname === b.pathname && a.search === b.search;
}

function sameValues(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A navigation changed something this loader reads from the URL. */
function urlConcerns(rule: RouteRule, args: ShouldRevalidateFunctionArgs): boolean {
  const { currentUrl, nextUrl, currentParams, nextParams } = args;
  if (rule.params === "pathname") {
    if (currentUrl.pathname !== nextUrl.pathname) return true;
  } else if (rule.params.some((p) => currentParams[p] !== nextParams[p])) {
    return true;
  }
  if (rule.search === "any") return currentUrl.search !== nextUrl.search;
  return rule.search.some(
    (name) =>
      !sameValues(currentUrl.searchParams.getAll(name), nextUrl.searchParams.getAll(name)),
  );
}

function decide(
  routeId: RevalidationRouteId,
  args: ShouldRevalidateFunctionArgs,
): boolean {
  const ledger = current;
  // Without a ledger the policy cannot know what is owed: never skip.
  if (!ledger) return args.defaultShouldRevalidate;
  const rule = REVALIDATION_RULES[routeId];
  if (isMutation(args.formMethod)) {
    // A 403 is how a stale CSRF token answers (`csrf-result.server.ts`): the
    // session under this tab changed (a sign-in in another tab), and root
    // stopped re-reading it on every live event. Re-read it, so the next try
    // carries a good token instead of "reload the page".
    if (args.actionStatus === 403 && overlaps(["session"], rule.reads)) return true;
    // React Router says no after a failed action or when the caller opted out
    // (the dock's send): nothing a loader reads changed.
    if (!args.defaultShouldRevalidate) ledger.withdraw(args.formAction);
    else if (overlaps(actionFacts(args.formAction), rule.reads)) return true;
  } else if (
    samePlace(args.currentUrl, args.nextUrl) &&
    ledger.router.state.revalidation === "idle"
  ) {
    // A navigation to the URL on screen (not a `revalidate()`, which shows
    // `revalidation: "loading"` first) reloads, as React Router's default.
    return true;
  }
  if (ledger.owes(routeId, rule.reads)) return true;
  return urlConcerns(rule, args);
}

/** The `shouldRevalidate` of the route `routeId` (ruling 454). */
export function revalidateWhen(routeId: RevalidationRouteId): ShouldRevalidateFunction {
  return (args) => decide(routeId, args);
}
