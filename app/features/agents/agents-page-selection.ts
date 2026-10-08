import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

/**
 * The Agents page's selection (ruling 700(e), the split of `agents-page.tsx`
 * along the task-page recipe): the open profile and the tab, held in the URL,
 * with the pick a roster click makes before its navigation lands. The page
 * calls it right after its fetcher, where this state and its effect always
 * registered. `useSearchParams` used to run just before the fetcher and now
 * runs just after it, which nothing can observe: only the fetcher calls
 * `useId`, so its key is unchanged, and the one has only a layout effect and
 * the other only a passive one, so no effect changes order. No component
 * lives here, so the module is not a Fast Refresh boundary.
 */
export interface ProfileSelection {
  /** The open profile's id: the pending pick, else the URL's. */
  sel: string;
  tab: "profiles" | "live";
  setSel: (profileId: string) => void;
  setTab: (next: "profiles" | "live") => void;
}

export function useProfileSelection(): ProfileSelection {
  const [searchParams, setSearchParams] = useSearchParams();
  // P13-UI-58 residual: `?profile=`/`?tab=` were READ once at mount and never
  // written back, so the selection was unlinkable, un-bookmarkable and lost on
  // reload — and a pasted `?tab=live` did nothing at all. The URL is the state:
  // selection reads from it and every click replaces it (replace: true keeps
  // one history entry per visit, the same rule the topbar search follows).
  const urlSel = searchParams.get("profile") ?? "operator";
  // U33-5: `setSearchParams` is a NAVIGATION — `useSearchParams` keeps handing
  // back the COMMITTED location until the router (and this route's
  // revalidation) lands, so for a beat after a roster click the whole detail
  // pane — including the profile object "Edit profile" passes to the editor —
  // was still the PREVIOUS selection. Live, clicking a roster entry and then
  // Edit without a pause opened the editor for the profile selected before it,
  // and saving wrote that form's grants onto the wrong profile (confirmed in
  // project.md). The pick is recorded synchronously here and the URL follows,
  // so the roster highlight, the detail pane and the editor's binding all
  // resolve from ONE value in the SAME render. Deliberately not a debounce:
  // the failure was silent and landed on governance data, so the shape has to
  // make the stale read impossible rather than unlikely.
  const [pendingSel, setPendingSel] = useState<string | null>(null);
  const sel = pendingSel ?? urlSel;
  const tab = searchParams.get("tab") === "live" ? "live" : "profiles";
  // A committed URL is the authority again: whatever put it there (this page's
  // own navigation landing, a Back, a pasted link) supersedes the pending pick.
  useEffect(() => {
    setPendingSel(null);
  }, [urlSel]);
  const setSel = (profileId: string) => {
    setPendingSel(profileId);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("profile", profileId);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };
  const setTab = (next: "profiles" | "live") => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === "live") params.set("tab", "live");
        else params.delete("tab");
        return params;
      },
      { replace: true, preventScrollReset: true },
    );
  };
  return { sel, tab, setSel, setTab };
}
