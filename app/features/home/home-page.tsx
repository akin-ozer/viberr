import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import type { SessionUser } from "~/server/auth/require-user.server";
import type { HomePrefs } from "~/server/prefs/user-prefs.server";
import { countLabel } from "~/shared/text/plural";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { SkipLink } from "~/ui/skip-link";
import { useCsrfToken } from "~/ui/csrf-input";
import { useToast } from "~/ui/toast";
import type { NotificationView } from "~/features/notifications/notification-item";
import { CommandPalette } from "~/features/shell/command-palette";
import { useCommandPaletteShortcut } from "~/features/shell/use-command-palette";
import type { HomeOrgSummary, HomeProjectCard } from "./home-query.server";
import {
  EmptyHero,
  HomeHero,
  HomeTopBar,
  ProjectSections,
  RebuildConfirm,
  SettingsPanel,
  StoreStrip,
} from "./home-sections";
import { NewProjectModal } from "./new-project-modal";

/**
 * Multi-project home. Uses loader data,
 * per-user DB prefs instead of localStorage, real routes instead of hash
 * hops, per-project board links instead of the single WORKSPACE page.
 *
 * Pass 16 split this file (1739 lines) along its own seams — a pure structural
 * refactor, no behaviour or copy change. What stayed here is the page's state
 * and the four fetchers that own it (prefs/pin/view, re-scan, rebuild, and the
 * ⌘K palette), plus the composition below. The pieces live in
 * `project-cards.tsx`, `home-sections.tsx` and `new-project-modal.tsx`.
 */

export interface HomePageData {
  user: SessionUser;
  greet: string;
  projects: HomeProjectCard[];
  prefs: HomePrefs;
  org: HomeOrgSummary;
  notifications: NotificationView[];
  unread: number;
  /** B-FD4: the host data root, org admins only (null otherwise). */
  storeRoot: string | null;
  /** F18-5: the single-writer lock holder, org admins only (null otherwise). */
  lockHolder?: { pid: number; hostname: string; startedAt: string } | null;
}

export function HomePage({
  data,
  theme,
  livePaused = false,
  onReconnect,
}: {
  data: HomePageData;
  theme: ThemePreference;
  /** UI-03: SSE stream state, surfaced in the header. */
  livePaused?: boolean;
  onReconnect?: () => void;
}) {
  const { user, projects, org } = data;
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const csrf = useCsrfToken();
  const push = useToast();
  const prefsFetcher = useFetcher<{
    ok: boolean;
    intent?: "pin" | "view";
    pinned?: boolean;
    error?: string;
  }>();
  const rescanFetcher = useFetcher<{
    ok: boolean;
    projects?: number;
    changed?: number;
    removed?: number;
    errors?: number;
    error?: string;
  }>();

  // R15-5: ⌘K is ONE shortcut app-wide — it opens the palette here exactly as it
  // does inside a project. Home's own box stays what it says it is ("Find a
  // project…"), a filter over the grid on screen.
  //
  // F20-30: "app-wide" is now literally true. Home and the workspace `Topbar`
  // mount the shortcut themselves (here and there); the three top-level overlay
  // routes that render outside both — /profile, /notifications, /org/settings —
  // get it from the shared `routes/palette-shell.tsx` layout instead. No route
  // mounts it twice.
  //
  // …and ONE implementation of it: this effect was a second copy of the
  // topbar's, free to drift from it. Both surfaces call the shared hook, which
  // also stops swallowing ⌥⌘K / Ctrl-Alt-K (OS and IDE combinations these
  // hand-rolled handlers claimed by matching on metaKey||ctrlKey alone).
  const [palette, setPalette] = useState(false);
  useCommandPaletteShortcut(() => setPalette(true));

  // Optimistic prefs: reflect an in-flight pin/view submit immediately.
  const optimistic = prefsFetcher.formData;
  const pendingView =
    optimistic?.get("intent") === "view" ? optimistic.get("view") : null;
  const view: "grid" | "list" =
    pendingView === "grid" || pendingView === "list"
      ? pendingView
      : data.prefs.view;
  const stars = useMemo(() => {
    const s = { ...data.prefs.stars };
    if (optimistic?.get("intent") === "pin") {
      s[String(optimistic.get("slug"))] = optimistic.get("pinned") === "1";
    }
    return s;
  }, [data.prefs.stars, optimistic]);

  const setView = (v: "grid" | "list") => {
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "view");
    fd.set("view", v);
    prefsFetcher.submit(fd, { method: "post" });
  };
  const toggleStar = (slug: string) => {
    const next = !stars[slug];
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "pin");
    fd.set("slug", slug);
    fd.set("pinned", next ? "1" : "0");
    prefsFetcher.submit(fd, { method: "post" });
  };

  // UI-06: the pin/view toasts settle on the RESULT (the shared
  // `useFetcherResult` contract the bell/user-menu/profile already use). A
  // rejected submit now reports the failure instead of claiming success and
  // silently reverting on the next revalidation.
  useFetcherResult(prefsFetcher, (d) => {
    if (!d.ok) {
      push(d.error ?? "Couldn't save that preference — please try again", "error");
      return;
    }
    if (d.intent === "pin") {
      push(d.pinned ? "Pinned — it will stay at the top" : "Unpinned");
    }
  });

  const scanning = rescanFetcher.state !== "idle";
  // UI-07: a failed re-scan (403 for a non-admin, or an app error) used to
  // render NOTHING — the spinner just stopped and the page looked as if the
  // scan had succeeded. Both outcomes toast now, mirroring the rebuild handler.
  useFetcherResult(rescanFetcher, (d) => {
    if (!d.ok) {
      push(d.error ?? "Re-scan failed — check the server log", "error");
      return;
    }
    const drift = (d.changed ?? 0) + (d.removed ?? 0) + (d.errors ?? 0);
    push(
      "Store re-scanned — " +
        d.projects +
        " project dirs, " +
        (drift === 0 ? "no drift found" : drift + " changed"),
    );
  });
  const rescan = () => {
    if (scanning) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "rescan");
    rescanFetcher.submit(fd, { method: "post" });
  };

  // Full projection rebuild (Phase 10 recovery) — admin-only, confirmed.
  // ADDITION over the mock: the mock's store strip has only Re-scan; the
  // recovery hammer lives beside it per the Phase-10 plan.
  const rebuildFetcher = useFetcher<{
    ok: boolean;
    projects?: number;
    tasks?: number;
    error?: string;
  }>();
  const [rebuildConfirm, setRebuildConfirm] = useState(false);
  const rebuilding = rebuildFetcher.state !== "idle";
  const rebuildDone = useRef(false);
  useEffect(() => {
    if (rebuildFetcher.state === "submitting") rebuildDone.current = false;
    if (
      rebuildFetcher.state === "idle" &&
      rebuildFetcher.data &&
      !rebuildDone.current
    ) {
      rebuildDone.current = true;
      const d = rebuildFetcher.data;
      push(
        d.ok
          ? `Projections rebuilt from files — ${countLabel(d.projects ?? 0, "project")}, ${countLabel(d.tasks ?? 0, "task")} re-projected`
          : (d.error ?? "Rebuild failed — check the server log"),
        // D5: the failure branch borrowed the success tick — the sibling rescan
        // handler already passes the kind, this one did not.
        d.ok ? "success" : "error",
      );
    }
  }, [rebuildFetcher.state, rebuildFetcher.data, push]);
  const rebuild = () => {
    setRebuildConfirm(false);
    if (rebuilding) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "rebuild-projections");
    rebuildFetcher.submit(fd, { method: "post" });
  };

  const matchesQuery = (p: HomeProjectCard) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (p.name + " " + p.key + " " + (p.repo ?? "")).toLowerCase().includes(q);
  };
  // Archived projects are lifted out of the active grid into their own section.
  const active = projects.filter((p) => !p.archived);
  const archivedList = projects.filter((p) => p.archived && matchesQuery(p));
  const filtered = active.filter(matchesQuery);
  const pinned = filtered.filter((p) => stars[p.slug]);
  const rest = filtered.filter((p) => !stars[p.slug]);

  const totalRunning = active.reduce((a, p) => a + p.running, 0);
  const totalWaiting = active.reduce((a, p) => a + p.waiting, 0);
  const activeIn = active.filter((p) => p.running > 0).length;
  const firstName = user.name.split(" ")[0];

  return (
    <div
      className="home"
      data-density="comfortable"
      data-screen-label="Home — project selection"
    >
      {/* UI-12: bypass block ahead of the brand/search/bell/avatar header. */}
      <SkipLink />
      <HomeTopBar
        searchRef={searchRef}
        onOpenPalette={() => setPalette(true)}
        query={query}
        onQuery={setQuery}
        notifications={data.notifications}
        unread={data.unread}
        user={user}
        theme={theme}
        livePaused={livePaused}
        {...(onReconnect ? { onReconnect } : {})}
      />

      <main className="home-shell" id="main-content" tabIndex={-1}>
        <HomeHero
          greet={data.greet}
          firstName={firstName}
          projectCount={projects.length}
          totalRunning={totalRunning}
          activeIn={activeIn}
          totalWaiting={totalWaiting}
          view={view}
          onView={setView}
          onNew={() => setModal(true)}
        />

        {projects.length === 0 ? (
          <EmptyHero onNew={() => setModal(true)} />
        ) : (
          <ProjectSections
            view={view}
            stars={stars}
            onStar={toggleStar}
            pinned={pinned}
            rest={rest}
            archivedList={archivedList}
            query={query}
            onNew={() => setModal(true)}
          />
        )}

        <SettingsPanel org={org} isAdmin={user.role === "admin"} />

        <StoreStrip
          scanning={scanning}
          onRescan={rescan}
          isAdmin={user.role === "admin"}
          rebuilding={rebuilding}
          onRebuild={() => setRebuildConfirm(true)}
          lockHolder={data.lockHolder ?? null}
        />
      </main>

      {rebuildConfirm && (
        <RebuildConfirm
          onCancel={() => setRebuildConfirm(false)}
          onConfirm={rebuild}
        />
      )}

      {modal && (
        <NewProjectModal
          connections={org.connectionOwners}
          connectionHealth={org.connectionHealth}
          storeRoot={data.storeRoot}
          // UX19-14: a member may create a project but may NOT add a PAT, so the
          // zero-connections note must name who can instead of linking them into
          // an org-settings 403.
          isAdmin={user.role === "admin"}
          onClose={() => setModal(false)}
        />
      )}

      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}
